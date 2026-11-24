"""Host administration: APT repositories, package updates, power. Needs the Administrator role (Sys.Modify)."""
import re
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import host
from .auth import require_user
from .pve import _node, pve

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_user)])


def repo_handle(uri: str, components: list[str]) -> str | None:
    """Map a configured repository to its PVE standard-repo handle (e.g. "no-subscription"), if it is one."""
    if re.search(r"/debian/pve/?$", uri):
        return next((c[4:] for c in components if c.startswith("pve-")), None)
    m = re.search(r"/debian/(ceph-[a-z]+)/?$", uri)
    return f"{m.group(1)}-{components[0]}" if m and components else None


def flatten(data: dict) -> dict:
    repos = []
    for f in data.get("files") or []:
        for i, r in enumerate(f.get("repositories") or []):
            uris, comps = r.get("URIs") or [], r.get("Components") or []
            repos.append({"path": f["path"], "index": i, "enabled": bool(r.get("Enabled")), "types": r.get("Types") or [],
                          "uris": uris, "suites": r.get("Suites") or [], "components": comps,
                          "handle": repo_handle(uris[0], comps) if uris else None})
    std = data.get("standard-repos") or []
    return {
        "digest": data.get("digest"),
        "repositories": repos,
        "names": {s["handle"]: s["name"] for s in std},
        # Standard repos with no "status" are not configured in any file yet.
        "available": [{"handle": s["handle"], "name": s["name"], "description": s.get("description", "")}
                      for s in std if "status" not in s],
        "errors": [e.get("error", str(e)) for e in data.get("errors") or []],
    }


@router.get("/repositories")
async def repositories():
    return flatten(await pve("GET", _node("/apt/repositories")) or {})


class RepoToggle(BaseModel):
    path: str = Field(pattern=r"^/etc/apt/[A-Za-z0-9_./-]+$", max_length=200)
    index: int = Field(ge=0, le=1000)
    enabled: bool
    digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{1,128}$")


class RepoAdd(BaseModel):
    handle: str = Field(pattern=r"^[a-z0-9-]+$", max_length=64)
    digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{1,128}$")


@router.post("/repositories/toggle")
async def toggle_repository(body: RepoToggle):
    data = {"path": body.path, "index": body.index, "enabled": int(body.enabled)}
    await pve("POST", _node("/apt/repositories"), data={**data, **({"digest": body.digest} if body.digest else {})})
    return {"ok": True}


@router.post("/repositories/add")
async def add_repository(body: RepoAdd):
    await pve("PUT", _node("/apt/repositories"), data={"handle": body.handle, **({"digest": body.digest} if body.digest else {})})
    return {"ok": True}


@router.get("/updates")
async def updates():
    return await pve("GET", _node("/apt/update")) or []


@router.post("/updates/refresh")
async def refresh_updates():
    return {"task": await pve("POST", _node("/apt/update"))}


def parse_upgrade_status(out: str) -> dict:
    lines = out.splitlines()
    state = lines[0].removeprefix("state:") if lines and lines[0].startswith("state:") else "unknown"
    log = lines[1:]
    m = next((re.match(r"proxmox-os: exit (\d+)", x) for x in reversed(log) if x.startswith("proxmox-os: exit")), None)
    return {"running": state in ("active", "activating"), "exit_code": int(m.group(1)) if m else None, "log": log}


@router.get("/upgrade")
async def upgrade_status():
    return parse_upgrade_status(await host.run(["apt-upgrade-status"]))


@router.post("/upgrade")
async def start_upgrade():
    # The helper starts apt in a transient systemd unit on the host, so a dropped SSH session can't interrupt dpkg.
    await host.run(["apt-upgrade"])
    return {"ok": True}


class PowerBody(BaseModel):
    command: Literal["reboot", "shutdown"]


@router.post("/power")
async def power(body: PowerBody):
    await pve("POST", _node("/status"), data={"command": body.command})
    return {"ok": True}
