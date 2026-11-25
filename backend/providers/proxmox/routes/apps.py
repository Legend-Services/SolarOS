"""Proxmox App Center: one-click unprivileged LXC provisioning from the curated catalog."""
import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException

from app import host
from app.apps import BY_ID, CATALOG, DATA, TAG, DeployBody, _jobs, installed_map
from app.auth import require_user
from app.config import settings

from ..api import _node, _safe, pve
from .tasks import wait_task

router = APIRouter(prefix="/api/apps", tags=["apps"], dependencies=[Depends(require_user)])


_bg: set[asyncio.Task] = set()


def _natural(s: str) -> list:
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]


@router.get("/catalog")
async def catalog():
    installed = installed_map(await pve("GET", _node("/lxc")) or [])
    return [{**a, "installed": installed.get(a["id"], [])} for a in CATALOG]


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
        "onboot": 1, "net0": f"name=eth0,bridge={settings.default_bridge},{ip}", "tags": f"{TAG};pos-{app['id']}",
        "description": f"Installed by SolarDeck App Center: {app['name']}",
    }


def configure_opts(app: dict, body: DeployBody) -> list[str]:
    """Root-only container options, applied by the host helper while the container is still stopped."""
    return ([*(["storage"] if body.mount_storage and app["supports_storage_mount"] else []),
             *(["igpu"] if body.enable_igpu and app["supports_igpu"] else []),
             *(["keyctl"] if app["keyctl"] else [])])


async def _finish(vmid: int, upid: str, app: dict, body: DeployBody) -> None:
    job = _jobs[vmid]
    log = job["log"].append
    opts = configure_opts(app, body)
    local_ai = None
    if app["id"] == "local-ai":
        from app import local_ai  # lazy: local_ai.before_start below is the Proxmox hook (routes/local_ai.py)
        from . import local_ai as pve_local_ai
    try:
        await wait_task(upid)
        pre = b""
        if local_ai:
            job["phase"] = "configuring"
            pre = await pve_local_ai.before_start(vmid, body, log)
        if opts:
            job["phase"] = "configuring"
            log(f"==> Applying host options: {', '.join(opts)}")
            await host.run(["app-configure", str(vmid), *opts], on_line=log)
        job["phase"] = "starting"
        log("==> Starting container")
        await wait_task(await pve("POST", _node(f"/lxc/{vmid}/status/start")), 120)
        job["phase"] = "installing"
        script = (DATA / "apps/_common.sh").read_bytes() + b"\n" + pre + (DATA / f"apps/{app['id']}.sh").read_bytes()
        await host.run(["app-provision", str(vmid)], stdin=script, on_line=log, timeout=3600)
        job["phase"] = "registering"
        ifaces = await _safe(_node(f"/lxc/{vmid}/interfaces"), []) or []
        inet = next((i.get("inet", "") for i in ifaces if i.get("name") == "eth0"), "")
        job["ip"] = inet.split("/")[0] or None
        if local_ai:
            await local_ai.after_install(vmid, body, job["ip"], log)
        job["phase"] = "done"
        log("==> Installation complete")
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        job["failed_phase"], job["phase"] = job["phase"], "error"
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
                   "web_port": 11434 if app["id"] == "local-ai" and not body.install_open_webui else app["web_port"],
                   "web_scheme": app["web_scheme"], "log": []}
    t = asyncio.create_task(_finish(vmid, upid, app, body))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return {"vmid": vmid, "upid": upid}
