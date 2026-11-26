"""Built-in Docker Engine & Compose: status, install, containers and Compose stacks.

Docker is the `docker_engine` Security-by-Design module (platform_modules): it runs in an isolated runtime container
(the "docker-engine" system app, recommended) or natively on the hypervisor host, optionally pinned to a VLAN. Every
command goes through platform_modules.run, so the same routes work on both drivers and in both runtime modes.
"""
import json
import re
from pathlib import Path as FsPath
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel

from . import audit_log, features, platform_modules as pm, task_progress
from .auth import require_user

router = APIRouter(prefix="/api/docker", tags=["docker"], dependencies=[Depends(require_user)])
MODULE = "docker_engine"
INSTALL = (FsPath(__file__).resolve().parent.parent / "data" / "apps" / "docker-engine.sh").read_text()
gated = [Depends(pm.require_module(MODULE))]

STATUS_SH = """command -v docker >/dev/null 2>&1 || { echo installed=0; exit 0; }
echo installed=1
systemctl is-active -q docker && echo running=1 || echo running=0
echo version=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
echo compose=$(docker compose version --short 2>/dev/null)
"""
ACTIONS = {"start": "start", "stop": "stop", "restart": "restart", "pause": "pause", "unpause": "unpause",
           "remove": "rm -f"}


def parse_status(out: str) -> dict:
    kv = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return {"installed": kv.get("installed") == "1", "running": kv.get("running") == "1",
            "version": kv.get("version") or None, "compose_version": kv.get("compose") or None}


def parse_containers(out: str) -> list[dict]:
    """`docker ps -a --format '{{json .}}'` lines -> container rows; the Compose project names the stack."""
    rows = []
    for line in out.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        stack = re.search(r"(?:^|,)com\.docker\.compose\.project=([^,]+)", c.get("Labels", ""))
        rows.append({"id": c.get("ID", ""), "name": c.get("Names", ""), "image": c.get("Image", ""),
                     "state": c.get("State", ""), "status": c.get("Status", ""), "ports": c.get("Ports", ""),
                     "stack": stack.group(1) if stack else None})
    return rows


def parse_stacks(out: str) -> list[dict]:
    try:
        data = json.loads(out.strip() or "[]")
    except ValueError:
        return []
    return [{"name": s.get("Name", ""), "status": s.get("Status", ""), "config_files": s.get("ConfigFiles", "")}
            for s in data if isinstance(s, dict)]


async def _engine(script: str, timeout: float = 60) -> str:
    try:
        return await pm.run(MODULE, script, timeout=timeout)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - host or container unreachable
        raise HTTPException(502, f"Docker Engine is not reachable: {e}") from e


@router.get("/status")
async def status():
    p = pm.profile(MODULE)
    base = {"enabled": p["enabled"], "runtime_mode": p["runtime_mode"], "network_isolation_mode": p["network_isolation_mode"],
            "bound_vlan_id": p["bound_vlan_id"], "service_ip": p["service_ip"], "installed": False, "running": False,
            "version": None, "compose_version": None, "worker_vmid": None}
    if not p["enabled"]:
        return base
    if p["runtime_mode"] == "container":
        base["worker_vmid"] = await pm.worker(MODULE)
        if not base["worker_vmid"]:
            return base
    return {**base, **parse_status(await _engine(STATUS_SH))}


class EnableBody(BaseModel):
    runtime_mode: pm.Runtime | None = None  # empty: keep the module's current runtime


async def _install(job: dict) -> dict:
    job["stage"] = 1
    await pm.run(MODULE, INSTALL, timeout=900, log=job["logs"].append)
    job["stage"] = 2
    return parse_status(await pm.run(MODULE, STATUS_SH))


@router.post("/enable")
async def enable(body: EnableBody | None = None, user: str = Depends(require_user)):
    """Switch the module on and install Docker Engine & Compose where it runs. Returns the job to follow."""
    await features.apply({MODULE: True})  # the feature flag is the module's on/off state
    p = pm.update_profile(MODULE, **({"runtime_mode": body.runtime_mode} if body and body.runtime_mode else {}))
    audit_log.record("docker.enable", user=user, runtime=p["runtime_mode"])
    if p["runtime_mode"] == "container":
        w = await pm.ensure_worker(MODULE)
        if w["job_id"]:  # the runtime container installs Docker while it is deployed
            return {"job_id": w["job_id"], "runtime_mode": p["runtime_mode"]}
    job = task_progress.start_job("docker", "Docker Engine & Compose", _install)
    return {"job_id": job["id"], "runtime_mode": p["runtime_mode"]}


@router.get("/containers", dependencies=gated)
async def containers():
    return parse_containers(await _engine("docker ps -a --no-trunc --format '{{json .}}' 2>/dev/null"))


@router.post("/containers/{container_id}/{action}", dependencies=gated)
async def container_action(action: Literal["start", "stop", "restart", "pause", "unpause", "remove"],
                           container_id: str = Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"),
                           user: str = Depends(require_user)):
    await _engine(f"docker {ACTIONS[action]} {container_id} >/dev/null", timeout=120)  # id is pattern-checked
    audit_log.record("docker.container", user=user, container=container_id, action=action)
    return {"ok": True, "id": container_id, "action": action}


@router.get("/stacks", dependencies=gated)
async def stacks():
    return parse_stacks(await _engine("docker compose ls -a --format json 2>/dev/null || echo '[]'"))
