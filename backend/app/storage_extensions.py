"""Storage extensions: NFS and WebDAV shares next to SMB, ZFS snapshot file browsing / single-file restore, USB drives.

Everything runs on the hypervisor host over the SSH bridge; share state lives with the other host state
(/etc/<prefix>/net/storage_ext.json).
  - NFS: /etc/exports.d/<prefix>.exports (nfs-kernel-server), applied with `exportfs -ra`.
  - WebDAV: an nginx server on its own HTTPS port (default 8090, the distribution's self-signed certificate) with one
    password-protected location per share; read-only shares refuse every write method.
  - Snapshots: `<mountpoint>/.zfs/snapshot/<name>` is read-only by design; a restore copies a file or folder back next
    to (or over) the live one.
  - USB: drives under /dev/disk/by-id/usb-*, mounted under /mnt/usb/<name> or attached to a VM as a disk.
"""
import json
import posixpath
import re
import shlex
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from . import host_ssh, platform_modules as pm
from .auth import require_user
from .config import settings
from .net_services import load as host_load, save as host_save
from .reverse_proxy import htpasswd_line

MODULE = "storage_protocols"
router = APIRouter(prefix="/api/storage", tags=["storage_extensions"], dependencies=[Depends(require_user)])
gated = [Depends(pm.require_module(MODULE))]
P = settings.system_prefix
EXPORTS = f"/etc/exports.d/{P}.exports"
DAV_CONF = f"/etc/nginx/conf.d/{P}-webdav.conf"
DAV_DIR = f"/etc/{P}/webdav"
HEADER = "# Managed by SolarDeck (Shared Folders & Protocols). Changes here are overwritten.\n"
NAME_RE = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$"
DATASET_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,200}$"
SNAP_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$"
FORBIDDEN_ROOTS = ("/", "/etc", "/root", "/boot", "/proc", "/sys", "/dev", "/run", "/usr", "/bin", "/sbin", "/lib", "/var", "/home")
DEFAULT = {"nfs": [], "webdav": [], "webdav_port": 8090}


def host_path(v: str) -> str:
    """An absolute data directory on the host: normalized, and never a system directory or its parent."""
    p = posixpath.normpath(v.strip())
    if not p.startswith("/") or ".." in p.split("/") or not re.fullmatch(r"[A-Za-z0-9_./ -]+", p):
        raise ValueError("Use an absolute folder path (letters, digits, - _ . / and spaces)")
    system = p in FORBIDDEN_ROOTS or p.startswith(tuple(r + "/" for r in FORBIDDEN_ROOTS[1:]))
    if system and not p.startswith(("/var/lib/vz/", f"/var/lib/{P}/")):
        raise ValueError("System folders cannot be shared; share a pool, dataset or folder under /mnt or /srv")
    return p


def rel_path(v: str) -> str:
    """A path inside a dataset or snapshot: relative, normalized, no way out."""
    p = posixpath.normpath("/" + v.strip()).lstrip("/")
    if ".." in p.split("/") or "\n" in p:
        raise ValueError("Invalid path")
    return "" if p == "." else p


class NfsClient(BaseModel):
    network: str = Field(pattern=r"^[0-9a-fA-F.:/*]{1,64}$")
    read_only: bool = False
    root_squash: bool = True


class NfsShare(BaseModel):
    name: str = Field(pattern=NAME_RE)
    path: str
    clients: list[NfsClient] = Field(min_length=1, max_length=50)

    @field_validator("path")
    @classmethod
    def _path(cls, v: str) -> str:
        return host_path(v)


class DavUser(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9._-]{1,32}$")
    password: str | None = Field(None, min_length=8, max_length=128, pattern=r"^[^\r\n:]*$")


class DavShare(BaseModel):
    name: str = Field(pattern=NAME_RE)
    path: str
    read_only: bool = True
    users: list[DavUser] = Field(min_length=1, max_length=50)

    @field_validator("path")
    @classmethod
    def _path(cls, v: str) -> str:
        return host_path(v)


class DavBody(BaseModel):
    port: int = Field(8090, ge=1024, le=65535)
    shares: list[DavShare] = Field(max_length=50)


class RestoreBody(BaseModel):
    dataset: str = Field(pattern=DATASET_RE)
    snapshot: str = Field(pattern=SNAP_RE)
    path: str = Field(min_length=1, max_length=1000)
    overwrite: bool = False

    @field_validator("path")
    @classmethod
    def _rel(cls, v: str) -> str:
        if not (p := rel_path(v)):
            raise ValueError("Pick a file or folder")
        return p


class UsbMountBody(BaseModel):
    device: str = Field(pattern=r"^/dev/disk/by-id/usb-[A-Za-z0-9_.:+-]+$")
    name: str = Field(pattern=NAME_RE)
    read_only: bool = False


class UsbUnmountBody(BaseModel):
    name: str = Field(pattern=NAME_RE)  # /mnt/usb/<name>


class UsbAttachBody(BaseModel):
    device: str = Field(pattern=r"^/dev/disk/by-id/usb-[A-Za-z0-9_.:+-]+$")
    vmid: int = Field(ge=100, le=999_999_999)


# ---------------------------------------------------------------- Rendering (pure, tests/test_core_modules.py)


def render_exports(shares: list[dict]) -> str:
    lines = [HEADER]
    for s in shares:
        clients = " ".join(f"{c['network']}({'ro' if c['read_only'] else 'rw'},sync,no_subtree_check,"
                           f"{'root_squash' if c['root_squash'] else 'no_root_squash'})" for c in s["clients"])
        lines.append(f'"{s["path"]}" {clients}')
    return "\n".join(lines) + "\n"


def render_webdav(port: int, shares: list[dict]) -> str:
    locs = []
    for s in shares:
        ro = ("    limit_except GET HEAD OPTIONS PROPFIND { deny all; }\n" if s["read_only"] else
              "    dav_methods PUT DELETE MKCOL COPY MOVE;\n    dav_access user:rw group:rw all:r;\n    create_full_put_path on;\n")
        locs.append(f"  location /{s['name']}/ {{\n    alias {s['path'].rstrip('/')}/;\n    autoindex on;\n{ro}"
                    "    dav_ext_methods PROPFIND OPTIONS;\n"
                    f'    auth_basic "SolarDeck WebDAV";\n    auth_basic_user_file {DAV_DIR}/{s["name"]}.htpasswd;\n  }}\n')
    return (f"{HEADER}server {{\n  listen {port} ssl;\n  listen [::]:{port} ssl;\n"
            "  ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;\n  ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;\n"
            "  client_max_body_size 0;\n" + "".join(locs) + "}\n")


def parse_listing(text: str) -> list[dict]:
    """`find -printf '%y\\t%s\\t%T@\\t%f\\n'` -> entries, folders first."""
    rows = []
    for line in text.splitlines():
        parts = line.split("\t", 3)
        if len(parts) == 4:
            rows.append({"name": parts[3], "type": "dir" if parts[0] == "d" else "file", "size": int(parts[1] or 0),
                         "mtime": int(float(parts[2] or 0))})
    return sorted(rows, key=lambda r: (r["type"] != "dir", r["name"].lower()))


def usb_drives(lsblk_json: str, by_id: str) -> list[dict]:
    """USB disks and partitions from `lsblk -J` joined with their /dev/disk/by-id/usb-* links."""
    links = {}
    for line in by_id.splitlines():
        link, _, target = line.partition(" ")
        if link.startswith("usb-"):
            links.setdefault(posixpath.basename(target), f"/dev/disk/by-id/{link}")
    out = []

    def walk(devs, parent_usb=False):
        for d in devs:
            usb = parent_usb or d.get("tran") == "usb"
            if usb and d.get("name") in links:
                out.append({"device": links[d["name"]], "name": d["name"], "size": d.get("size"), "fstype": d.get("fstype"),
                            "label": d.get("label"), "model": (d.get("model") or "").strip(), "mountpoint": d.get("mountpoint"),
                            "type": d.get("type")})
            walk(d.get("children") or [], usb)

    walk(json.loads(lsblk_json or "{}").get("blockdevices", []))
    return out


# ---------------------------------------------------------------- State


async def load() -> dict:
    return await host_load("storage_ext", DEFAULT)


async def _install(pkgs: str, probe: str) -> None:
    await host_ssh.run(f"{probe} || (DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
                       f"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq {pkgs} >/dev/null)", timeout=600)


async def _exists(path: str) -> None:
    if "1" not in await host_ssh.run(f"test -d {shlex.quote(path)} && echo 1 || echo 0", check=False):
        raise HTTPException(404, f"{path} does not exist on the host")


# ---------------------------------------------------------------- NFS


@router.get("/nfs")
async def get_nfs():
    s = await load()
    active = await host_ssh.run("exportfs -v 2>/dev/null || true", check=False)
    return {"module": pm.profile(MODULE), "shares": s["nfs"], "active": active}


@router.put("/nfs", dependencies=gated)
async def put_nfs(shares: list[NfsShare]):
    for sh in shares:
        await _exists(sh.path)
    s = await load()
    s["nfs"] = [x.model_dump() for x in shares]
    await host_save("storage_ext", s)
    await _install("nfs-kernel-server", "command -v exportfs >/dev/null")
    await host_ssh.write_file(EXPORTS, render_exports(s["nfs"]))
    out = await host_ssh.run("systemctl enable -q --now nfs-server 2>/dev/null || systemctl enable -q --now nfs-kernel-server; exportfs -ra 2>&1", timeout=60)
    return {"ok": True, "output": out}


# ---------------------------------------------------------------- WebDAV


def _dav_view(sh: dict) -> dict:
    return {**{k: v for k, v in sh.items() if k != "users"}, "users": [u["username"] for u in sh["users"]]}


@router.get("/webdav")
async def get_webdav():
    s = await load()
    return {"module": pm.profile(MODULE), "port": s["webdav_port"], "shares": [_dav_view(x) for x in s["webdav"]]}


@router.put("/webdav", dependencies=gated)
async def put_webdav(body: DavBody):
    s = await load()
    old = {sh["name"]: {u["username"]: u["hash"] for u in sh["users"]} for sh in s["webdav"]}
    shares = []
    for sh in body.shares:
        await _exists(sh.path)
        users = []
        for u in sh.users:
            h = htpasswd_line(u.username, u.password).split(":", 1)[1] if u.password else old.get(sh.name, {}).get(u.username)
            if not h:
                raise HTTPException(422, f"Set a password for {u.username} on {sh.name}")
            users.append({"username": u.username, "hash": h})
        shares.append({**sh.model_dump(exclude={"users"}), "users": users})
    s["webdav"], s["webdav_port"] = shares, body.port
    await host_save("storage_ext", s)
    await _install("nginx libnginx-mod-http-dav-ext ssl-cert", "command -v nginx >/dev/null && [ -e /usr/lib/nginx/modules/ngx_http_dav_ext_module.so ]")
    for sh in shares:
        await host_ssh.write_file(f"{DAV_DIR}/{sh['name']}.htpasswd", "".join(f"{u['username']}:{u['hash']}\n" for u in sh["users"]), "640")
    await host_ssh.write_file(DAV_CONF, render_webdav(body.port, shares) if shares else HEADER)
    out = await host_ssh.run(f"chgrp www-data {DAV_DIR}/*.htpasswd 2>/dev/null; nginx -t 2>&1 && (systemctl reload nginx || systemctl start nginx)",
                             check=False, timeout=60)
    if "test is successful" not in out:
        await host_ssh.run(f"rm -f {DAV_CONF}", check=False)
        raise HTTPException(400, f"nginx rejected the WebDAV configuration: {out.strip()[-300:]}")
    return {"ok": True, "url_port": body.port}


# ---------------------------------------------------------------- ZFS snapshot file browser & restore


async def _mountpoint(dataset: str) -> str:
    mp = (await host_ssh.run(f"zfs get -H -o value mountpoint {shlex.quote(dataset)}", timeout=30)).strip()
    if not mp.startswith("/"):
        raise HTTPException(400, f"{dataset} is not mounted")
    return mp


@router.get("/snapshots/datasets")
async def snapshot_datasets():
    out = await host_ssh.run("zfs list -H -p -t snapshot -o name,creation,used 2>/dev/null || true", check=False, timeout=60)
    by: dict[str, list] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and "@" in parts[0]:
            ds, snap = parts[0].split("@", 1)
            by.setdefault(ds, []).append({"name": snap, "created": int(parts[1]), "used": int(parts[2] or 0)})
    return [{"dataset": d, "snapshots": sorted(v, key=lambda x: -x["created"])} for d, v in sorted(by.items())]


@router.get("/snapshots/browse")
async def browse(dataset: str, snapshot: str, path: str = ""):
    if not re.fullmatch(DATASET_RE, dataset) or not re.fullmatch(SNAP_RE, snapshot):
        raise HTTPException(422, "Invalid dataset or snapshot")
    sub = rel_path(path)
    root = f"{await _mountpoint(dataset)}/.zfs/snapshot/{snapshot}"
    target = f"{root}/{sub}" if sub else root
    out = await host_ssh.run(f"find {shlex.quote(target)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | head -n 2000",
                             check=False, timeout=60)
    return {"dataset": dataset, "snapshot": snapshot, "path": sub, "entries": parse_listing(out)}


@router.post("/snapshots/restore-file", dependencies=gated)
async def restore_file(body: RestoreBody, user: str = Depends(require_user)):
    from . import audit_log
    mp = await _mountpoint(body.dataset)
    src, dst = f"{mp}/.zfs/snapshot/{body.snapshot}/{body.path}", f"{mp}/{body.path}"
    if "1" not in await host_ssh.run(f"test -e {shlex.quote(src)} && echo 1 || echo 0", check=False):
        raise HTTPException(404, "That file or folder is not in the snapshot")
    exists = "1" in await host_ssh.run(f"test -e {shlex.quote(dst)} && echo 1 || echo 0", check=False)
    if exists and not body.overwrite:
        dst = f"{dst}.restored-{time.strftime('%Y%m%d-%H%M%S')}"
    await host_ssh.run(f"mkdir -p {shlex.quote(posixpath.dirname(dst))} && cp -a --reflink=auto {shlex.quote(src)} "
                       f"{shlex.quote(dst) if not (exists and body.overwrite) else shlex.quote(posixpath.dirname(dst)) + '/'}", timeout=3600)
    audit_log.record("snapshot.restore_file", user=user, dataset=body.dataset, snapshot=body.snapshot, path=body.path)
    return {"ok": True, "restored_to": dst}


# ---------------------------------------------------------------- USB drives


@router.get("/usb")
async def usb():
    lsblk = await host_ssh.run("lsblk -J -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT,MODEL,TRAN,TYPE", check=False)
    links = await host_ssh.run("cd /dev/disk/by-id 2>/dev/null && for l in usb-*; do [ -e \"$l\" ] && echo \"$l $(readlink -f \"$l\")\"; done; true",
                               check=False)
    return {"module": pm.profile(MODULE), "drives": usb_drives(lsblk, links)}


@router.post("/usb/mount", dependencies=gated)
async def usb_mount(body: UsbMountBody):
    mnt = f"/mnt/usb/{body.name}"
    opts = "-o ro" if body.read_only else ""
    await host_ssh.run(f"mkdir -p {mnt} && mount {opts} {shlex.quote(body.device)} {mnt}", timeout=60)
    return {"ok": True, "mountpoint": mnt}


@router.post("/usb/unmount", dependencies=gated)
async def usb_unmount(body: UsbUnmountBody):
    await host_ssh.run(f"sync; umount /mnt/usb/{body.name} && rmdir /mnt/usb/{body.name}", timeout=120)
    return {"ok": True}


@router.post("/usb/attach", dependencies=gated)
async def usb_attach(body: UsbAttachBody):
    """Give a VM the whole USB drive as a disk (unmount it on the host first)."""
    return {"ok": True, "slot": await pm.driver().usb_attach(body.device, body.vmid)}
