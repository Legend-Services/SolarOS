"""Spotlight search index and the ProxmoxOS self-updater."""
import asyncio
import json
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query

from . import apps, shares
from .auth import require_user
from .config import settings
from .pve import _node, _safe
from .storage_admin import datasets
from .system import parse_upgrade_status

router = APIRouter(tags=["system-extra"], dependencies=[Depends(require_user)])

APP_DIR = Path(__file__).resolve().parents[2]
UNIT = "proxmox-os-self-update"
LOG = Path("/var/log/proxmox-os-self-update.log")
PER_KIND = 8

# Control Panel sections, matched on title + keywords.
SECTIONS = [
    ("security", "User & Security", "password two-factor 2fa totp authenticator api token login"),
    ("network", "Network & DNS", "interfaces bridge vmbr dns resolver ip gateway"),
    ("appearance", "Appearance & Layout", "wallpaper widgets theme background layout grid list view icon size spacing dock"),
    ("power", "System & Power", "reboot shutdown version update upgrade kernel"),
]

# ---------------------------------------------------------------- Search

_ds_cache: tuple[float, list[dict]] = (0.0, [])


async def _datasets() -> list[dict]:
    """ZFS datasets via the host helper; cached briefly so typing in Spotlight doesn't hammer SSH."""
    global _ds_cache
    if time.monotonic() - _ds_cache[0] < 30:
        return _ds_cache[1]
    try:
        items = await asyncio.wait_for(datasets(), 5)
    except Exception:  # noqa: BLE001 - no ZFS / helper: search the rest
        items = []
    _ds_cache = (time.monotonic(), items)
    return items


def _shares() -> list[dict]:
    try:
        return shares.list_shares()
    except OSError:
        return []


def build_results(q: str, qemu: list, lxc: list, pools: list, ds: list, share_list: list) -> list[dict]:
    q = q.lower().strip()
    hit = lambda *fields: any(q in str(f).lower() for f in fields if f)  # noqa: E731
    out: list[dict] = []

    def add(kind: str, items: list[dict]):
        out.extend({"kind": kind, **i} for i in items[:PER_KIND])

    for kind, label, items in (("qemu", "VM", qemu), ("lxc", "Container", lxc)):
        add(kind, [{"title": g.get("name") or f"{kind}-{g['vmid']}", "subtitle": f"{label} {g['vmid']} · {g.get('status', '')}",
                    "target": {"type": kind, "vmid": int(g["vmid"]), "name": g.get("name") or "", "status": g.get("status", "")}}
                   for g in items if hit(g.get("name"), g["vmid"], g.get("tags"))])
    add("pool", [{"title": p["name"], "subtitle": f"ZFS pool · {p.get('health', '')}", "target": {"pool": p["name"]}}
                 for p in pools if hit(p.get("name"))])
    add("dataset", [{"title": d["name"], "subtitle": f"Dataset · {d.get('mountpoint', '')}", "target": {"path": "/" + d["name"]}}
                    for d in ds if d.get("type") == "filesystem" and not d.get("guest_volume") and hit(d["name"])])
    add("share", [{"title": s["name"], "subtitle": f"SMB share · {s['path']}", "target": {"path": s["path"]}}
                  for s in share_list if hit(s["name"], s.get("comment"), s.get("path"))])
    add("app", [{"title": a["name"], "subtitle": f"App Center · {a['category']}", "target": {"app_id": a["id"]}}
                for a in apps.CATALOG if hit(a["name"], a["category"], a["description"])])
    add("section", [{"title": t, "subtitle": "Control Panel", "target": {"section": sid}}
                    for sid, t, kw in SECTIONS if hit(t, kw)])
    return out


@router.get("/api/search")
async def search(q: str = Query(min_length=1, max_length=100)):
    qemu, lxc, pools, ds = await asyncio.gather(
        _safe(_node("/qemu"), []), _safe(_node("/lxc"), []), _safe(_node("/disks/zfs"), []), _datasets())
    return {"query": q, "results": build_results(q, qemu or [], lxc or [], pools or [], ds, _shares())}


# ---------------------------------------------------------------- Self-update


async def _cmd(*args: str, timeout: float = 30) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, cwd=APP_DIR)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except FileNotFoundError:
        return 127, f"{args[0]} not found"
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timed out"
    return proc.returncode, out.decode(errors="replace").strip()


async def _source() -> dict:
    """Current commit and update source.

    .build-commit (written by deploy.sh and self-update.sh) wins over git HEAD: deploy.sh copies files over an existing
    checkout without touching .git, so HEAD can be stale.
    """
    git = (APP_DIR / ".git").is_dir()
    commit = branch = remote = None
    if git:
        rc, out = await _cmd("git", "rev-parse", "HEAD")
        commit = out if rc == 0 else None
        rc, out = await _cmd("git", "rev-parse", "--abbrev-ref", "HEAD")
        branch = out if rc == 0 and out != "HEAD" else None
        rc, out = await _cmd("git", "remote", "get-url", "origin")
        remote = out if rc == 0 else None
    f = APP_DIR / ".build-commit"
    if f.exists():
        commit = f.read_text().strip() or commit
    try:
        version = json.loads((APP_DIR / "frontend/package.json").read_text()).get("version")
    except (OSError, ValueError):
        version = None
    return {"git": git, "commit": commit, "branch": branch or settings.repo_branch, "remote": remote or settings.repo_url,
            "version": version}


@router.get("/api/system/update/status")
async def update_status(check: bool = False):
    src = await _source()
    remote_commit, check_error = None, None
    if check:
        rc, out = await _cmd("git", "ls-remote", src["remote"], f"refs/heads/{src['branch']}", timeout=30)
        if rc == 0 and out:
            remote_commit = out.split()[0]
        else:
            check_error = out[-300:] or "Branch not found on remote"
    _, state = await _cmd("systemctl", "is-active", UNIT)
    try:
        log = LOG.read_text(errors="replace").splitlines()[-300:]
    except OSError:
        log = []
    job = parse_upgrade_status("\n".join([f"state:{state}", *log]))
    return {**src, "remote_commit": remote_commit, "check_error": check_error,
            "update_available": bool(remote_commit) and remote_commit != src["commit"], **job}


@router.post("/api/system/update/apply")
async def update_apply():
    src = await _source()
    _, state = await _cmd("systemctl", "is-active", UNIT)
    if state in ("active", "activating"):
        raise HTTPException(409, "An update is already running")
    # Run a copy: git reset rewrites deploy/self-update.sh while bash is still reading it.
    script = Path("/tmp/proxmox-os-self-update.sh")
    shutil.copy(APP_DIR / "deploy/self-update.sh", script)
    await _cmd("systemctl", "reset-failed", UNIT)
    # Detached transient unit: the script restarts this backend, which must not kill the update midway.
    rc, out = await _cmd("systemd-run", "--quiet", f"--unit={UNIT}", "--collect",
                         "-p", f"StandardOutput=truncate:{LOG}", "-p", "StandardError=inherit",
                         "bash", str(script), str(APP_DIR), src["remote"], src["branch"])
    if rc:
        raise HTTPException(500, f"Could not start the updater: {out[-300:]}")
    return {"ok": True}
