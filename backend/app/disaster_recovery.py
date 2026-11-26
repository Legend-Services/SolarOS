"""Host disaster recovery: encrypted SolarDeck host snapshots, 3-2-1 offsite copies and sandbox restore verification.

Host snapshot: one archive with everything needed to rebuild this SolarDeck host's configuration — the backend data
folder (settings, reverse proxy rules and certificates, RBAC users, multi-seat bindings, cluster state, module profiles,
the secrets-vault key) and .env, plus the host-side network state (switches, VLANs, DHCP, DNS, domains, firewall, as
/etc/<prefix>/net) with the interfaces file and DHCP leases for reference. It is sealed with AES-256-GCM under a key
derived from your passphrase (scrypt), so the archive is safe to keep offsite. Format: b"SDDR1" | salt(16) | nonce(12) | ct.

Offsite targets (S3-compatible, SFTP, WebDAV) are copied with rclone, in the isolated backup worker container or on the
host (platform module "offsite_backup"); credentials are passed as environment variables, never written to disk.

Sandbox restore verification restores a hypervisor backup to a temporary guest, puts it on a new air-gapped isolated
lab, boots it, waits for the guest agent heartbeat (containers: a command inside), records the result and tears
everything down again.
"""
import asyncio
import base64
import io
import json
import os
import re
import secrets
import shlex
import tarfile
import time
from pathlib import Path as FsPath
from typing import Literal

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from fastapi import APIRouter, Depends, File, HTTPException, Path, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import audit_log, config, host_ssh, platform_modules as pm, secrets_vault, task_progress
from .apps import _wait  # waits for a driver task (TaskInfo)
from .auth import client_ip, require_step_up_auth, require_user
from .config import settings
from .storage_admin import STORAGE_RE
from providers.registry import get_provider

MODULE = "offsite_backup"
router = APIRouter(prefix="/api/dr", tags=["disaster_recovery"], dependencies=[Depends(require_user)])
gated = [Depends(pm.require_module(MODULE))]
DATA = FsPath(__file__).resolve().parent.parent / "data"
TARGETS = DATA / "dr_offsite.json"
RESULTS = DATA / "dr_verifications.json"
MAGIC = b"SDDR1"
P = settings.system_prefix
NAME_RE = r"^[0-9]{8}-[0-9]{6}(-[a-z0-9-]{1,40})?\.sddr$"
HOST_PATHS = (f"etc/{P}/net", "etc/network/interfaces", "etc/network/interfaces.d", "var/lib/misc/dnsmasq.leases")
SKIP_DATA = {"audit_log.jsonl", "network_scans.json", "themes"}  # large or rebuilt automatically
SECRET_FIELDS = ("secret_access_key", "password")


def dr_dir() -> FsPath:
    d = settings.storage_root / "backups" / f"{P}-dr"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------------------------------------------------------- Sealing (pure, tests/test_core_modules.py)


def _key(passphrase: str, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(passphrase.encode())


def seal(data: bytes, passphrase: str) -> bytes:
    salt, nonce = os.urandom(16), os.urandom(12)
    return MAGIC + salt + nonce + AESGCM(_key(passphrase, salt)).encrypt(nonce, data, MAGIC)


def unseal(blob: bytes, passphrase: str) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < 50:
        raise HTTPException(400, "This is not a SolarDeck host snapshot")
    salt, nonce = blob[5:21], blob[21:33]
    try:
        return AESGCM(_key(passphrase, salt)).decrypt(nonce, blob[33:], MAGIC)
    except Exception:  # noqa: BLE001 - InvalidTag: wrong passphrase or damaged file
        raise HTTPException(400, "Wrong passphrase, or the archive is damaged")


def pack_local(data_dir: FsPath, env_file: FsPath) -> bytes:
    """tar.gz of the backend data folder (minus SKIP_DATA) and .env."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in sorted(data_dir.iterdir()):
            if p.name not in SKIP_DATA and p.is_file() and not p.name.endswith(".tmp"):
                tar.add(p, arcname=f"data/{p.name}")
        if env_file.exists():
            tar.add(env_file, arcname="env/.env")
    return buf.getvalue()


def bundle(local: bytes, host: bytes, meta: dict) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, blob in (("local.tar.gz", local), ("host.tar.gz", host), ("meta.json", json.dumps(meta).encode())):
            info = tarfile.TarInfo(name)
            info.size, info.mtime = len(blob), int(time.time())
            tar.addfile(info, io.BytesIO(blob))
    return buf.getvalue()


def unbundle(raw: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        return {m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}


def safe_members(tar: tarfile.TarFile, prefixes: tuple[str, ...]) -> list[tarfile.TarInfo]:
    """Members that stay inside the allowed folders (no absolute paths, .. or links)."""
    out = []
    for m in tar.getmembers():
        n = m.name.lstrip("./")
        if (m.isfile() or m.isdir()) and ".." not in n.split("/") and not n.startswith("/") and n.startswith(prefixes):
            out.append(m)
    return out


# ---------------------------------------------------------------- Host snapshot & restore


class SnapshotBody(BaseModel):
    passphrase: str = Field(min_length=12, max_length=256)
    label: str = Field("", max_length=40, pattern=r"^[a-z0-9-]*$")


class RestoreBody(BaseModel):
    name: str = Field(pattern=NAME_RE)
    passphrase: str = Field(min_length=12, max_length=256)
    restore_host_network: bool = True


@router.post("/host-snapshot")
async def host_snapshot(body: SnapshotBody, request: Request, user: str = Depends(require_user)):
    local = await asyncio.to_thread(pack_local, DATA, config.ENV_FILE)
    paths = " ".join(HOST_PATHS)
    host_b64 = await host_ssh.run(f"cd / && tar -czf - --ignore-failed-read {paths} 2>/dev/null | base64 -w0", timeout=300, check=False)
    host = base64.b64decode(host_b64.strip() or b"")
    meta = {"created": int(time.time()), "node": settings.node_name, "driver": settings.hypervisor_driver, "prefix": P}
    blob = await asyncio.to_thread(seal, bundle(local, host, meta), body.passphrase)
    name = time.strftime("%Y%m%d-%H%M%S") + (f"-{body.label}" if body.label else "") + ".sddr"
    path = dr_dir() / name
    path.write_bytes(blob)
    path.chmod(0o600)
    audit_log.record("dr.snapshot", user=user, ip=client_ip(request), name=name, size=len(blob))
    return {"name": name, "size": len(blob), "created": meta["created"]}


@router.get("/host-snapshots")
async def host_snapshots():
    rows = [{"name": p.name, "size": p.stat().st_size, "created": int(p.stat().st_mtime)}
            for p in dr_dir().glob("*.sddr") if re.fullmatch(NAME_RE, p.name)]
    return {"module": pm.profile(MODULE), "snapshots": sorted(rows, key=lambda r: -r["created"]), "folder": str(dr_dir())}


@router.get("/host-snapshots/{name}")
async def download_snapshot(name: str = Path(pattern=NAME_RE)):
    p = dr_dir() / name
    if not p.is_file():
        raise HTTPException(404, "No such snapshot")
    return FileResponse(p, filename=name, media_type="application/octet-stream")


@router.delete("/host-snapshots/{name}")
async def delete_snapshot(name: str = Path(pattern=NAME_RE), user: str = Depends(require_step_up_auth)):
    (dr_dir() / name).unlink(missing_ok=True)
    audit_log.record("dr.snapshot.delete", user=user, name=name)
    return {"ok": True}


@router.post("/host-snapshots/upload")
async def upload_snapshot(file: UploadFile = File(...)):
    blob = await file.read(200 * 1024 * 1024 + 1)
    if len(blob) > 200 * 1024 * 1024 or not blob.startswith(MAGIC):
        raise HTTPException(400, "This is not a SolarDeck host snapshot (or it is larger than 200 MB)")
    name = time.strftime("%Y%m%d-%H%M%S") + "-uploaded.sddr"
    (dr_dir() / name).write_bytes(blob)
    return {"name": name, "size": len(blob)}


@router.post("/host-restore")
async def host_restore(body: RestoreBody, request: Request, user: str = Depends(require_step_up_auth)):
    """Put the archived configuration back. The backend restarts afterwards so every module reloads it."""
    p = dr_dir() / body.name
    if not p.is_file():
        raise HTTPException(404, "No such snapshot")
    parts = unbundle(await asyncio.to_thread(unseal, p.read_bytes(), body.passphrase))
    restored = []
    with tarfile.open(fileobj=io.BytesIO(parts["local.tar.gz"])) as tar:
        for m in safe_members(tar, ("data/", "env/")):
            if not m.isfile():
                continue
            dest = DATA / m.name[5:] if m.name.startswith("data/") else config.ENV_FILE
            tmp = dest.with_suffix(dest.suffix + ".restore")
            tmp.write_bytes(tar.extractfile(m).read())
            tmp.chmod(0o600)
            tmp.replace(dest)
            restored.append(m.name)
    if body.restore_host_network and parts.get("host.tar.gz"):
        # Network state JSON goes back in place; the interfaces file is staged next to it for a manual check.
        b64 = base64.b64encode(parts["host.tar.gz"]).decode()
        await host_ssh.run(f"d=$(mktemp -d) && base64 -d | tar -xz -C $d && mkdir -p /etc/{P}/net && "
                           f"cp -a $d/etc/{P}/net/. /etc/{P}/net/ 2>/dev/null; "
                           f"[ -f $d/etc/network/interfaces ] && cp $d/etc/network/interfaces /etc/{P}/net/restored-interfaces; "
                           f"rm -rf $d", input=b64, timeout=120)
        restored.append(f"/etc/{P}/net")
    audit_log.record("dr.restore", user=user, ip=client_ip(request), name=body.name, files=len(restored))
    asyncio.get_running_loop().call_later(2, lambda: os._exit(0))  # systemd restarts the backend with the restored files
    return {"ok": True, "restored": restored, "restarting": True}


# ---------------------------------------------------------------- Offsite targets (rclone)


class TargetBody(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern=r"^[^\n\r\"'`$\\<>]*$")
    type: Literal["s3", "sftp", "webdav"]
    endpoint: str = Field("", max_length=300, pattern=r"^[^\s\"'`$\\]*$")  # S3 endpoint URL, SFTP host or WebDAV URL
    bucket: str = Field("", max_length=200, pattern=r"^[A-Za-z0-9._/-]*$")  # S3 bucket[/prefix] or remote folder
    region: str = Field("", max_length=40, pattern=r"^[a-z0-9-]*$")
    access_key_id: str = Field("", max_length=200, pattern=r"^[^\s\"'`$\\]*$")
    secret_access_key: str | None = Field(None, max_length=200)
    username: str = Field("", max_length=100, pattern=r"^[^\s\"'`$\\]*$")
    password: str | None = Field(None, max_length=200)
    port: int = Field(22, ge=1, le=65535)
    include_hypervisor_backups: bool = True
    retention_days: int = Field(30, ge=0, le=3650)


def load_targets() -> list[dict]:
    try:
        return json.loads(TARGETS.read_text())
    except (OSError, ValueError):
        return []


def save_targets(t: list[dict]) -> None:
    TARGETS.write_text(json.dumps(t, indent=1))
    TARGETS.chmod(0o600)


def target_view(t: dict) -> dict:
    return {k: v for k, v in t.items() if k not in SECRET_FIELDS} | {f"{k}_set": bool(t.get(k)) for k in SECRET_FIELDS}


def rclone_env(t: dict) -> dict[str, str]:
    """rclone remote "sd" as environment variables (passwords obscured by rclone in the script)."""
    if t["type"] == "s3":
        return {"TYPE": "s3", "PROVIDER": "Other", "ENDPOINT": t["endpoint"], "REGION": t["region"] or "us-east-1",
                "ACCESS_KEY_ID": t["access_key_id"], "SECRET_ACCESS_KEY": secrets_vault.decrypt(t.get("secret_access_key")) or ""}
    if t["type"] == "sftp":
        return {"TYPE": "sftp", "HOST": t["endpoint"], "USER": t["username"], "PORT": str(t["port"])}
    return {"TYPE": "webdav", "URL": t["endpoint"], "VENDOR": "other", "USER": t["username"]}


def offsite_script(t: dict, sources: list[str]) -> str:
    env = "".join(f"export RCLONE_CONFIG_SD_{k}={shlex.quote(v)}\n" for k, v in rclone_env(t).items())
    pw = secrets_vault.decrypt(t.get("password")) or ""
    if t["type"] in ("sftp", "webdav") and pw:
        env += f"export RCLONE_CONFIG_SD_PASS=$(rclone obscure {shlex.quote(pw)})\n"
    dest = f"sd:{t['bucket'].strip('/')}" if t["bucket"] else "sd:"
    lines = ["set -e", "command -v rclone >/dev/null || (DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
             "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone >/dev/null)", env.rstrip(), "echo '@@stage offsite 1@@'"]
    for src in sources:
        sub = f"{dest}/{FsPath(src).name}"
        lines += [f"[ -d {shlex.quote(src)} ] && rclone copy {shlex.quote(src)} {shlex.quote(sub)} --transfers 4 --stats-one-line -v || true"]
    lines.append("echo '@@stage offsite 2@@'")
    for src in sources:
        lines.append(f"[ -d {shlex.quote(src)} ] && rclone check {shlex.quote(src)} {shlex.quote(f'{dest}/{FsPath(src).name}')} --one-way --size-only")
    if t.get("retention_days"):
        lines.append(f"rclone delete {shlex.quote(dest)} --min-age {t['retention_days']}d -v || true")
    return "\n".join(lines) + "\n"


def sources_for(t: dict, runtime: str) -> list[str]:
    if runtime == "container":  # the worker sees the storage root at /mnt/storage
        src = [f"/mnt/storage/backups/{P}-dr"]
        return src + (["/mnt/storage/backups/dump"] if t["include_hypervisor_backups"] else [])
    src = [f"/var/lib/{P}/dr-outbox"]
    return src + ([pm.driver().BACKUP_DIR] if t["include_hypervisor_backups"] else [])


@router.get("/offsite-targets")
async def list_targets():
    return {"module": pm.profile(MODULE), "targets": [target_view(t) for t in load_targets()]}


@router.post("/offsite-targets", dependencies=gated)
async def add_target(body: TargetBody):
    targets = load_targets()
    t = {"id": secrets.token_hex(4), **body.model_dump(), "last_run": None}
    for k in SECRET_FIELDS:
        t[k] = secrets_vault.encrypt(getattr(body, k) or "")
    targets.append(t)
    save_targets(targets)
    return target_view(t)


@router.put("/offsite-targets/{target_id}", dependencies=gated)
async def update_target(body: TargetBody, target_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    targets = load_targets()
    t = next((x for x in targets if x["id"] == target_id), None)
    if not t:
        raise HTTPException(404, "No such target")
    t.update(body.model_dump(exclude=set(SECRET_FIELDS)))
    for k in SECRET_FIELDS:
        if getattr(body, k) is not None:
            t[k] = secrets_vault.encrypt(getattr(body, k))
    save_targets(targets)
    return target_view(t)


@router.delete("/offsite-targets/{target_id}", dependencies=gated)
async def delete_target(target_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    save_targets([x for x in load_targets() if x["id"] != target_id])
    return {"ok": True}


async def _offsite(t: dict, job: dict) -> dict:
    runtime = pm.profile(MODULE)["runtime_mode"]
    if runtime == "host_native":  # stage the DR archives on the host, where rclone runs
        outbox = f"/var/lib/{P}/dr-outbox"
        await host_ssh.run(f"mkdir -p {outbox} && chmod 700 {outbox}")
        for f in dr_dir().glob("*.sddr"):
            await host_ssh.run(f"base64 -d > {outbox}/{f.name}.tmp && mv {outbox}/{f.name}.tmp {outbox}/{f.name}",
                               input=base64.b64encode(f.read_bytes()).decode(), timeout=600)

    def on_line(line: str) -> None:
        if m := re.match(r"^@@stage offsite (\d)@@$", line.strip()):
            job["stage"] = int(m.group(1))
        else:
            job["logs"].append(line)

    ok = False
    try:
        await pm.run(MODULE, offsite_script(t, sources_for(t, runtime)), timeout=6 * 3600, log=on_line)
        ok = True
    finally:  # a failed copy must replace the last success, or the 3-2-1 status lies
        targets = load_targets()
        for x in targets:
            if x["id"] == t["id"]:
                x["last_run"] = {"at": int(time.time()), "ok": ok}
        save_targets(targets)
    return {"target": t["id"]}


@router.post("/offsite-targets/{target_id}/sync", dependencies=gated)
async def sync_target(target_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    t = next((x for x in load_targets() if x["id"] == target_id), None)
    if not t:
        raise HTTPException(404, "No such target")
    job = task_progress.start_job("offsite", t["name"], lambda j: _offsite(t, j))
    return {"job_id": job["id"]}


@router.get("/status")
async def status():
    """3-2-1 overview: copies on this host, offsite targets and their last run, last sandbox checks."""
    snaps = (await host_snapshots())["snapshots"]
    targets = load_targets()
    return {"module": pm.profile(MODULE), "local_snapshots": len(snaps), "latest_snapshot": snaps[0] if snaps else None,
            "offsite_targets": len(targets), "offsite_ok": sum(1 for t in targets if (t.get("last_run") or {}).get("ok")),
            "verifications": load_results()[:10]}


# ---------------------------------------------------------------- Sandbox restore verification


class VerifyBody(BaseModel):
    storage: str = Field(pattern=STORAGE_RE)
    heartbeat_timeout_seconds: int = Field(300, ge=30, le=1800)


def load_results() -> list[dict]:
    try:
        return json.loads(RESULTS.read_text())
    except (OSError, ValueError):
        return []


async def _heartbeat(kind: str, vmid: int) -> bool:
    ok, _, _ = await host_ssh.run_host_cmd(pm.driver().heartbeat_command(kind, vmid), timeout=15)
    return ok


async def _verify(backup: dict, body: VerifyBody, job: dict) -> dict:
    from . import virtual_hardware as vhw
    p, log = get_provider(), job["logs"].append
    kind = backup["type"]
    used = {int(g["vmid"]) for g in await p.guest_rows()}
    vmid = next(v for v in range(9900, 999_999) if v not in used)
    result = {"backup": backup["volid"], "vmid": vmid, "type": kind, "started": int(time.time()), "booted": False,
              "heartbeat": False, "ok": False, "seconds_to_heartbeat": None}
    lab_id = None
    try:
        log(f"Restoring {backup['volid']} as temporary {kind} {vmid}")
        await _wait(p, await p.restore_backup({"volid": backup["volid"], "type": kind, "vmid": vmid, "storage": body.storage}))
        job["stage"] = 1
        octet = 200 + secrets.randbelow(50)
        lab = await vhw.create_lab(vhw.LabBody(name=f"Restore check {vmid}", gateway_cidr=f"10.{octet}.{vmid % 250}.1/24",
                                               range_start=f"10.{octet}.{vmid % 250}.100", range_end=f"10.{octet}.{vmid % 250}.150",
                                               guests=[vhw.LabGuest(guest_type="vm" if kind == "qemu" else "lxc", guest_id=vmid)]))
        lab_id = lab["lab"]["id"]
        log(f"Air-gapped lab {lab['lab']['bridge']} attached")
        job["stage"] = 2
        await _wait(p, await p.guest_power_action(kind, vmid, "start"))
        result["booted"] = True
        job["stage"] = 3
        t0 = time.time()
        while time.time() - t0 < body.heartbeat_timeout_seconds:
            if await _heartbeat(kind, vmid):
                result["heartbeat"], result["seconds_to_heartbeat"] = True, int(time.time() - t0)
                break
            await asyncio.sleep(5)
        result["ok"] = result["heartbeat"]
        log("Guest agent answered" if result["heartbeat"] else "No guest agent heartbeat before the timeout")
    finally:
        job["stage"] = 4

        async def quietly(step) -> None:  # tear down as much as possible, whatever failed before
            try:
                r = await step()
                if getattr(r, "task", None):
                    await _wait(p, r)
            except Exception as e:  # noqa: BLE001
                log(f"Cleanup: {getattr(e, 'detail', e)}")

        await quietly(lambda: p.guest_power_action(kind, vmid, "stop"))
        if lab_id:
            await quietly(lambda: vhw.delete_lab(lab_id))
        await quietly(lambda: p.delete_guest(kind, vmid, purge=True))
        result["finished"] = int(time.time())
        RESULTS.write_text(json.dumps([result, *load_results()][:100], indent=1))
    if not result["ok"]:
        raise HTTPException(500, "The restored guest booted but never answered" if result["booted"] else "The backup could not be restored")
    return result


@router.post("/verify-sandbox/{backup_id:path}", dependencies=gated)
async def verify_sandbox(body: VerifyBody, backup_id: str):
    b = next((x for x in [x.model_dump() if hasattr(x, "model_dump") else x for x in await get_provider().list_backups()]
              if x.get("volid") == backup_id), None)
    if not b:
        raise HTTPException(404, "No such backup")
    b["type"] = b.get("type") or ("lxc" if "vzdump-lxc" in backup_id else "qemu")
    job = task_progress.start_job("sandbox", backup_id.rsplit("/", 1)[-1], lambda j: _verify(b, body, j))
    return {"job_id": job["id"]}


@router.get("/verifications")
async def verifications():
    return load_results()
