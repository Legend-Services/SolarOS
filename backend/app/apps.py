"""App Center: curated catalog + one-click unprivileged LXC provisioning."""
import asyncio
import ipaddress
import json
import re
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from . import host
from .auth import require_user
from .config import settings
from .pve import _node, _safe, pve
from .tasks import wait_task

router = APIRouter(prefix="/api/apps", tags=["apps"], dependencies=[Depends(require_user)])

DATA = Path(__file__).resolve().parent.parent / "data"
CATALOG: list[dict] = json.loads((DATA / "app_catalog.json").read_text())
BY_ID = {a["id"]: a for a in CATALOG}
TAG = "proxmox-os-app"
# shortcut: deployment jobs live in memory and are lost on backend restart; the PVE tasks + container remain.
_jobs: dict[int, dict] = {}
_bg: set[asyncio.Task] = set()


def _natural(s: str) -> list:
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


def installed_map(lxc: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in lxc:
        tags = set(re.split(r"[;, ]+", c.get("tags", "")))
        if TAG not in tags:
            continue
        for t in tags:
            if t.startswith("pos-") and t[4:] in BY_ID:
                out.setdefault(t[4:], []).append(
                    {"vmid": int(c["vmid"]), "name": c.get("name", ""), "status": c.get("status", "")})
    return out


@router.get("/catalog")
async def catalog():
    installed = installed_map(await pve("GET", _node("/lxc")) or [])
    return [{**a, "installed": installed.get(a["id"], [])} for a in CATALOG]


class StaticIP(BaseModel):
    cidr: str
    gateway: str

    @field_validator("cidr")
    @classmethod
    def _cidr(cls, v: str) -> str:
        if "/" not in v:
            raise ValueError("CIDR needs a prefix, e.g. 192.168.1.50/24")
        return str(ipaddress.IPv4Interface(v))

    @field_validator("gateway")
    @classmethod
    def _gw(cls, v: str) -> str:
        return str(ipaddress.IPv4Address(v))


class DeployBody(BaseModel):
    app_id: str
    hostname: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    cores: int = Field(ge=1, le=64)
    memory: int = Field(ge=256, le=262144, description="MB")
    disk_gb: int = Field(ge=2, le=4096)
    ip_config: Literal["dhcp"] | StaticIP = "dhcp"
    mount_storage: bool = False
    enable_igpu: bool = False


async def _template() -> str:
    """volid of the newest debian-12-standard template, downloading it if no template storage has one."""
    stores = [s["storage"] for s in await pve("GET", _node("/storage"), params={"content": "vztmpl"}) or []
              if s.get("active")]
    if not stores:
        raise HTTPException(400, "No active storage supports container templates (vztmpl)")
    store = "local" if "local" in stores else stores[0]
    content = await pve("GET", _node(f"/storage/{store}/content"), params={"content": "vztmpl"}) or []
    have = sorted((c["volid"] for c in content if "debian-12-standard_" in c["volid"]), key=_natural)
    if have:
        return have[-1]
    apl = await pve("GET", _node("/aplinfo")) or []
    cands = sorted((a["template"] for a in apl if a.get("template", "").startswith("debian-12-standard_")), key=_natural)
    if not cands:
        raise HTTPException(502, "No debian-12-standard template in the Proxmox appliance index")
    await wait_task(await pve("POST", _node("/aplinfo"), data={"storage": store, "template": cands[-1]}))
    return f"{store}:vztmpl/{cands[-1]}"


async def _rootfs_storage() -> str:
    """Same preference as install.sh: ZFS, then local-lvm, then local, then anything with rootdir."""
    active = [s for s in await pve("GET", _node("/storage"), params={"content": "rootdir"}) or [] if s.get("active")]
    if not active:
        raise HTTPException(400, "No active storage supports container root disks (rootdir)")
    return min(active, key=lambda s: (s.get("type") != "zfspool", s["storage"] != "local-lvm",
                                      s["storage"] != "local"))["storage"]


def create_params(vmid: int, app: dict, body: DeployBody, template: str, rootfs: str) -> dict:
    ip = "ip=dhcp" if body.ip_config == "dhcp" else f"ip={body.ip_config.cidr},gw={body.ip_config.gateway}"
    return {
        "vmid": vmid, "hostname": body.hostname, "ostemplate": template, "rootfs": f"{rootfs}:{body.disk_gb}",
        "cores": body.cores, "memory": body.memory, "swap": 512, "unprivileged": 1, "features": "nesting=1",
        "onboot": 1, "net0": f"name=eth0,bridge={settings.pve_bridge},{ip}", "tags": f"{TAG};pos-{app['id']}",
        "description": f"Installed by ProxmoxOS App Center: {app['name']}",
    }


def configure_opts(app: dict, body: DeployBody) -> list[str]:
    """Root-only container options, applied by the host helper while the container is still stopped."""
    return ([*(["storage"] if body.mount_storage and app["supports_storage_mount"] else []),
             *(["igpu"] if body.enable_igpu and app["supports_igpu"] else []),
             *(["keyctl"] if app["keyctl"] else [])])


async def _finish(vmid: int, upid: str, app: dict, opts: list[str]) -> None:
    job = _jobs[vmid]
    log = job["log"].append
    try:
        await wait_task(upid)
        if opts:
            job["phase"] = "configuring"
            log(f"==> Applying host options: {', '.join(opts)}")
            await host.run(["app-configure", str(vmid), *opts], on_line=log)
        job["phase"] = "starting"
        log("==> Starting container")
        await wait_task(await pve("POST", _node(f"/lxc/{vmid}/status/start")), 120)
        job["phase"] = "installing"
        script = (DATA / "apps/_common.sh").read_bytes() + b"\n" + (DATA / f"apps/{app['id']}.sh").read_bytes()
        await host.run(["app-provision", str(vmid)], stdin=script, on_line=log, timeout=3600)
        ifaces = await _safe(_node(f"/lxc/{vmid}/interfaces"), []) or []
        inet = next((i.get("inet", "") for i in ifaces if i.get("name") == "eth0"), "")
        job["ip"] = inet.split("/")[0] or None
        job["phase"] = "done"
        log("==> Installation complete")
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        job["phase"] = "error"
        job["error"] = e.detail if isinstance(e, HTTPException) else str(e)
        log(f"==> Failed: {job['error']}")


@router.post("/deploy")
async def deploy(body: DeployBody):
    app = BY_ID.get(body.app_id)
    if not app:
        raise HTTPException(404, "Unknown app")
    template = await _template()
    rootfs = await _rootfs_storage()
    vmid = int(await pve("GET", "/cluster/nextid"))
    upid = await pve("POST", _node("/lxc"), data=create_params(vmid, app, body, template, rootfs))
    _jobs[vmid] = {"vmid": vmid, "app_id": app["id"], "upid": upid, "phase": "creating", "error": None, "ip": None,
                   "web_port": app["web_port"], "web_scheme": app["web_scheme"], "log": []}
    t = asyncio.create_task(_finish(vmid, upid, app, configure_opts(app, body)))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return {"vmid": vmid, "upid": upid}


@router.get("/deployments/{vmid}")
async def deployment(vmid: int):
    job = _jobs.get(vmid)
    if not job:
        raise HTTPException(404, "No deployment job for this container (backend restarted?)")
    return {**job, "log": job["log"][-500:]}
