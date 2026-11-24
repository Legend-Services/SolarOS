"""SMB shares on STORAGE_ROOT. Samba runs in the ProxmoxOS container; this module owns SAMBA_CONF entirely."""
import configparser
import re
import subprocess
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import host
from .auth import require_user
from .config import settings
from .files import rel, safe_path

router = APIRouter(prefix="/api/shares", tags=["shares"], dependencies=[Depends(require_user)])

SHARE_RE = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$"
USER_RE = r"^[a-z_][a-z0-9_-]{0,31}$"
RESERVED = {"global", "homes", "printers", "print$", "ipc$"}


def _sh(args: list[str], stdin: str | None = None) -> str:
    try:
        r = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise HTTPException(503, f"{args[0]} not installed (re-run install.sh)")
    if r.returncode:
        raise HTTPException(502, f"{args[0]} failed: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


def _load() -> configparser.ConfigParser:
    cp = configparser.ConfigParser(interpolation=None)
    cp.read(settings.samba_conf)
    return cp


def _save(cp: configparser.ConfigParser) -> None:
    tmp = settings.samba_conf.with_suffix(".tmp")
    with tmp.open("w") as f:
        f.write("# Managed by ProxmoxOS (Network Shares). Manual edits are overwritten.\n")
        cp.write(f)
    tmp.replace(settings.samba_conf)
    _sh(["systemctl", "reload-or-restart", "smbd"])


def _share(name: str, sec) -> dict:
    p = sec.get("path", "")
    try:
        path = rel(Path(p))
    except ValueError:  # outside STORAGE_ROOT (hand-edited): show as-is
        path = p
    vfs = sec.get("vfs objects", "").split()
    return {"name": name, "path": path, "comment": sec.get("comment", ""),
            "read_only": sec.get("read only", "no") == "yes", "guest_ok": sec.get("guest ok", "no") == "yes",
            "browseable": sec.get("browseable", "yes") == "yes", "recycle_bin": "recycle" in vfs,
            "timemachine": sec.get("fruit:time machine", "no") == "yes", "users": sec.get("valid users", "").split()}


@router.get("")
def list_shares():
    cp = _load()
    return [_share(n, cp[n]) for n in cp.sections()]


class ShareBody(BaseModel):
    name: str = Field(pattern=SHARE_RE)
    path: str = Field("", max_length=1024, pattern=r"^[^\n\r]*$")
    comment: str = Field("", max_length=100, pattern=r"^[^\n\r\[\]]*$")
    read_only: bool = False
    guest_ok: bool = False
    browseable: bool = True
    recycle_bin: bool = False
    timemachine: bool = False
    users: list[Annotated[str, Field(pattern=USER_RE)]] = Field([], max_length=50)
    # Back the share with a ZFS dataset mapped to /mnt/storage/<dataset> (path is then ignored).
    dataset: str | None = Field(None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:/-]*$", max_length=200)
    create_dataset: bool = False


yn = lambda b: "yes" if b else "no"  # noqa: E731


def share_section(body: ShareBody, path: Path) -> dict:
    sec = {
        "path": str(path), "comment": body.comment, "browseable": yn(body.browseable),
        "read only": yn(body.read_only), "guest ok": yn(body.guest_ok),
        # Files on /mnt/storage are granted to container root via ACLs, so share I/O runs as root.
        "force user": "root", "force group": "root", "create mask": "0664", "directory mask": "0775",
    }
    vfs = []
    if body.timemachine:
        # fruit must come before streams_xattr.
        vfs += ["catia", "fruit", "streams_xattr"]
        sec.update({"fruit:time machine": "yes", "fruit:metadata": "stream", "fruit:encoding": "native"})
    if body.recycle_bin:
        vfs.append("recycle")
        sec.update({"recycle:repository": ".recycle", "recycle:keeptree": "yes", "recycle:versions": "yes",
                    "recycle:touch": "yes", "recycle:directory_mode": "0775"})
    if vfs:
        sec["vfs objects"] = " ".join(vfs)
    if body.users:
        sec["valid users"] = " ".join(body.users)
    return sec


@router.post("")
async def create_share(body: ShareBody):
    """Create or update a share; the directory (or a dedicated ZFS dataset) is created if missing."""
    if body.name.lower() in RESERVED:
        raise HTTPException(400, "Reserved share name")
    if body.dataset:
        if ".." in body.dataset or (body.create_dataset and "/" not in body.dataset):
            raise HTTPException(422, "Invalid dataset name")
        if body.create_dataset:
            await host.run(["zfs-create", body.dataset])
        await host.run(["storage-map", body.dataset], timeout=600)
        target = safe_path(f"/{body.dataset}")
    elif body.path:
        target = safe_path(body.path)
    else:
        raise HTTPException(422, "A folder path or a dataset is required")
    return await run_in_threadpool(_write_share, body, target)


def _write_share(body: ShareBody, target: Path) -> dict:
    target.mkdir(parents=True, exist_ok=True)
    cp = _load()
    cp[body.name] = share_section(body, target)
    _save(cp)
    return _share(body.name, cp[body.name])


@router.delete("/{name}")
def delete_share(name: str):
    cp = _load()
    if not cp.has_section(name):
        raise HTTPException(404, "Share not found")
    cp.remove_section(name)
    _save(cp)
    return {"ok": True}


@router.get("/users")
def list_users():
    return [{"username": line.split(":", 1)[0]} for line in _sh(["pdbedit", "-L"]).splitlines() if ":" in line]


class UserBody(BaseModel):
    username: str = Field(pattern=USER_RE)
    password: str = Field(min_length=4, max_length=128, pattern=r"^[^\n\r]*$")


@router.post("/users")
def upsert_user(body: UserBody):
    """Create the Samba user (and a login-less Unix account behind it) or change its password."""
    if subprocess.run(["id", "-u", body.username], capture_output=True).returncode:
        _sh(["useradd", "-M", "-s", "/usr/sbin/nologin", body.username])
    _sh(["smbpasswd", "-s", "-a", body.username], stdin=f"{body.password}\n{body.password}\n")
    return {"username": body.username}


@router.delete("/users/{username}")
def delete_user(username: str):
    if not re.fullmatch(USER_RE, username):
        raise HTTPException(400, "Invalid user name")
    _sh(["smbpasswd", "-x", username])
    return {"ok": True}
