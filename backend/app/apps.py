"""App Center: curated catalog, deploy request model, deployment job tracking and the per-instance registry
(data/installed_apps.json) with its uninstaller, shared by the drivers."""
import asyncio
import ipaddress
import json
import re
import shutil
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path as PathParam
from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator

from . import task_progress
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/apps", tags=["apps"], dependencies=[Depends(require_user)])


DATA = Path(__file__).resolve().parent.parent / "data"
_ALL: list[dict] = json.loads((DATA / "app_catalog.json").read_text())
BY_ID = {a["id"]: a for a in _ALL}
CATALOG = [a for a in _ALL if not a.get("system")]  # "system" apps are module workers, deployed by platform_modules
TAG = settings.name("app")
ALIASES = {"ollama": "local-ai"}  # pre-v1.6 Ollama installs show up under Local AI Studio


# Local AI compute targets: "cpu", "nvidia:<index or PCI address>", "intel|amd:/dev/dri/renderD<N>".
TARGET_RE = r"^(cpu|nvidia:([0-9]{1,2}|([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])|(intel|amd):/dev/dri/renderD[0-9]{3})$"


MODEL_RE = r"^[a-z0-9][a-z0-9._/-]{0,100}(:[A-Za-z0-9._-]{1,60})?$"


# shortcut: deployment jobs live in memory and are lost on backend restart; the driver tasks + container remain.
_jobs: dict[int, dict] = {}


def app_of(c: dict) -> str | None:
    """Catalog id of an App Center container (tags "<TAG>;pos-<app_id>"), else None."""
    tags = set(re.split(r"[;, ]+", c.get("tags") or ""))
    if TAG not in tags:
        return None
    return next((a for t in tags if t.startswith("pos-") and (a := ALIASES.get(t[4:], t[4:])) in BY_ID), None)


def installed_map(lxc: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in lxc:
        if app_id := app_of(c):
            out.setdefault(app_id, []).append(
                {"vmid": int(c["vmid"]), "name": c.get("name", ""), "status": c.get("status", "")})
    return out


# ---------------------------------------------------------------- instance names
def clean_label(v: str) -> str:
    """Human suffix: printable characters only, single spaces, at most 40 characters."""
    return "".join(ch for ch in re.sub(r"\s+", " ", v) if ch.isprintable()).strip()[:40]


def hostname_for(app_id: str, label: str) -> str:
    """RFC 1123 host name: "<app_id>-<slug of label>" ("Dev" -> docker-portainer-dev), or the app id alone."""
    seg = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode().lower())
    return (f"{app_id}-{seg.strip('-')}" if seg.strip("-") else app_id)[:63].rstrip("-")


def display_name(app_id: str, label: str) -> str:
    name = BY_ID.get(app_id, {}).get("name", app_id)
    return f"{name} — {label}" if label else name


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
    # Empty: derived from instance_label (hostname_for).
    hostname: str = Field("", pattern=r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)?$")
    instance_label: str = Field("", max_length=80)
    cores: int = Field(ge=1, le=64)
    memory: int = Field(ge=256, le=262144, description="MB")
    disk_gb: int = Field(ge=2, le=4096)
    ip_config: Literal["dhcp"] | StaticIP = "dhcp"
    mount_storage: bool = False
    enable_igpu: bool = False
    # Local AI Studio only (app_id "local-ai").
    compute_target: str = Field("cpu", pattern=TARGET_RE)
    install_open_webui: bool = False
    starter_models: list[Annotated[str, StringConstraints(pattern=MODEL_RE)]] = Field([], max_length=5)

    @model_validator(mode="after")
    def _names(self):
        self.instance_label = clean_label(self.instance_label)
        self.hostname = self.hostname or hostname_for(self.app_id, self.instance_label)
        return self


@router.get("/deployments/{vmid}")
async def deployment(vmid: int):
    job = _jobs.get(vmid)
    if not job:
        raise HTTPException(404, "No deployment job for this container (backend restarted?)")
    return {**job, "log": job["log"][-500:], "progress": task_progress.from_app(job)}


@router.get("/jobs/{vmid}")
async def deployment_progress(vmid: int):
    """The deployment as a unified stage-progress view (same shape as /api/tasks/{job_id})."""
    return (await deployment(vmid))["progress"]


@router.post("/{app_id}/install")
async def install(app_id: str, body: DeployBody):
    """Install an app (same body as the driver's POST /api/apps/deploy; the path's app_id wins)."""
    from providers.registry import get_provider  # lazy: the provider modules import this one
    return await get_provider().deploy_app(body.model_copy(update={"app_id": app_id}))


# ---------------------------------------------------------------- instance registry (data/installed_apps.json)
REGISTRY = DATA / "installed_apps.json"
INSTANCE_RE = r"^[a-z0-9][a-z0-9-]{0,40}-\d{1,9}$"


def load_registry() -> dict[str, dict]:
    try:
        return json.loads(REGISTRY.read_text())
    except (OSError, ValueError):
        return {}


def save_registry(reg: dict[str, dict]) -> None:
    tmp = REGISTRY.with_suffix(".tmp")
    tmp.write_text(json.dumps(reg, indent=2))
    tmp.replace(REGISTRY)


def _web_url(app_id: str, ip: str | None, port: int | None = None) -> str | None:
    app = BY_ID.get(app_id, {})
    port = port or app.get("web_port")
    return f"{app.get('web_scheme', 'http')}://{ip}:{port}" if ip and port else None


def _record(vmid: int, app_id: str, label: str) -> dict:
    return {"instance_id": f"{app_id}-{vmid}", "app_id": app_id, "app_name": BY_ID[app_id]["name"],
            "instance_label": label, "display_name": display_name(app_id, label), "guest_id": vmid,
            "ip_address": None, "web_url": None, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def register_instance(vmid: int, body: DeployBody) -> dict:
    """Called by both drivers' deploy: records the new instance; returns the fields the install response adds."""
    rec = _record(vmid, body.app_id, body.instance_label)
    reg = load_registry()
    reg[rec["instance_id"]] = rec
    save_registry(reg)
    return {"instance_id": rec["instance_id"], "display_name": rec["display_name"], "job_id": f"app-{vmid}"}


def instance_ready(job: dict) -> None:
    """Called when an install finishes: stores the IP address and web URL."""
    reg = load_registry()
    for rec in reg.values():
        if rec["guest_id"] == job["vmid"]:
            rec["ip_address"], rec["web_url"] = job["ip"], _web_url(rec["app_id"], job["ip"], job.get("web_port"))
    save_registry(reg)


def _busy(vmid: int) -> bool:
    job, rm = _jobs.get(vmid), _removals.get(vmid)
    return bool(job and job["phase"] not in ("done", "error")) or bool(rm and rm["status"] == "running")


async def reconcile() -> list[dict]:
    """Registry joined with the live App Center containers: legacy installs (no record yet) are adopted, records
    whose container is gone are dropped, missing IPs are filled in. Returns the live instance views."""
    from providers.registry import get_provider
    p = get_provider()
    rows = [r for r in await p.guest_rows() if r.get("type") == "lxc"]
    if not rows:
        await p.list_guests()  # guest_rows hides errors: raise here rather than prune on an unreachable host
    reg = load_registry()
    by_vmid = {r["guest_id"]: r for r in reg.values()}
    keep: dict[str, dict] = {}
    out = []
    for c in rows:
        vmid, app_id = int(c["vmid"]), app_of(c)
        if not app_id:
            continue
        rec = by_vmid.get(vmid)
        rec = dict(rec) if rec and rec["app_id"] == app_id else _record(vmid, app_id, "")
        status = c.get("status") or "unknown"
        if not rec["ip_address"] and status == "running":
            rec["ip_address"] = await p.container_ip(vmid)
            rec["web_url"] = rec["web_url"] or _web_url(app_id, rec["ip_address"])
        keep[rec["instance_id"]] = rec
        out.append({**rec, "status": status, "cores": int(c.get("maxcpu") or c.get("cpus") or 0),
                    "memory_mb": int(c.get("maxmem") or 0) // 1048576})
    for iid, rec in reg.items():  # an install that has not created its container yet
        if iid not in keep and _busy(rec["guest_id"]):
            keep[iid] = rec
            out.append({**rec, "status": "installing", "cores": 0, "memory_mb": 0})
    if keep != reg:
        save_registry(keep)
    return sorted(out, key=lambda r: (r["app_name"], r["guest_id"]))


@router.get("/instances")
async def instances():
    return await reconcile()


# ---------------------------------------------------------------- uninstall
# shortcut: like _jobs, uninstall jobs live in memory; after a restart mid-removal the next reconcile tidies up.
_removals: dict[int, dict] = {}
_bg: set[asyncio.Task] = set()


async def _wait(p, task) -> None:
    if not task.task:
        return
    for _ in range(450):
        s = await p.get_task_status(task.task)
        if not s["running"]:
            if s["state"] != "ok":
                raise HTTPException(502, f"Task failed: {s['exitstatus']}")
            return
        await asyncio.sleep(2)
    raise HTTPException(504, "Task timed out")


def data_dir(instance_id: str) -> Path:
    return settings.storage_root / "apps" / instance_id


async def _uninstall(job: dict, rec: dict, delete_data: bool) -> None:
    from providers.registry import get_provider
    from . import local_ai
    p, vmid, log = get_provider(), rec["guest_id"], job["log"].append
    try:
        log(f"==> Stopping {rec['display_name']} (container {vmid})")
        if await p.container_status(vmid) == "running":
            await _wait(p, await p.guest_power_action("lxc", vmid, "stop"))
        job["stage"] = 1
        log("==> Removing container and virtual network interfaces")
        await _wait(p, await p.delete_guest("lxc", vmid, purge=True))
        job["stage"] = 2
        log("==> Cleaning up application metadata")
        reg = load_registry()
        reg.pop(rec["instance_id"], None)
        save_registry(reg)
        _jobs.pop(vmid, None)
        if local_ai.load_state().get("vmid") == vmid:
            local_ai.STATE_FILE.unlink(missing_ok=True)
        job["stage"] = 3
        d = data_dir(rec["instance_id"])
        if delete_data and d.is_dir():
            log(f"==> Deleting app data {d}")
            await asyncio.to_thread(shutil.rmtree, d)
        else:
            log(f"==> Keeping app data in {d}" if d.is_dir() else "==> No app data folder to keep or delete")
        job["stage"], job["status"] = 4, "completed"
        log("==> Application instance removed")
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        job["status"], job["error"] = "failed", e.detail if isinstance(e, HTTPException) else str(e)
        log(f"==> Failed: {job['error']}")


@router.delete("/instances/{instance_id}")
async def uninstall(instance_id: str = PathParam(pattern=INSTANCE_RE), delete_data: bool = False):
    rec = load_registry().get(instance_id) or next((r for r in await reconcile() if r["instance_id"] == instance_id), None)
    if not rec:
        raise HTTPException(404, "No such app instance")
    vmid = rec["guest_id"]
    if _busy(vmid):
        raise HTTPException(409, "This instance is still being installed or removed")
    job = _removals[vmid] = {"vmid": vmid, "subject": rec["display_name"], "status": "running", "stage": 0,
                             "error": None, "log": []}
    t = asyncio.create_task(_uninstall(job, rec, delete_data))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return {"job_id": f"uninstall-{vmid}", "instance_id": instance_id}
