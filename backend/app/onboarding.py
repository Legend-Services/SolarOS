"""Server Setup Wizard and Desktop Tour state (data/onboarding_state.json) plus the one-shot setup job.

The file is written with onboarding_completed=false when the first administrator is created (auth.setup), so only a
fresh installation opens the wizard; an installation without the file (an upgrade) counts as already set up.
"""
import asyncio
import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import apps, features, task_progress
from .auth import require_user

router = APIRouter(prefix="/api/onboarding", tags=["onboarding"], dependencies=[Depends(require_user)])

DATA = Path(__file__).resolve().parent.parent / "data"
STATE = DATA / "onboarding_state.json"
Intent = Literal["standalone", "create_cluster", "join_cluster"]
DONE = {"onboarding_completed": True, "tour_completed": True, "selected_roles": [], "cluster_intent": "standalone"}


def load() -> dict:
    try:
        return {**DONE, **json.loads(STATE.read_text())}
    except (OSError, ValueError):
        return dict(DONE)


def save(**changes) -> dict:
    st = {**load(), **changes}
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1))
    tmp.replace(STATE)
    return st


def first_run() -> None:
    """Called when the first administrator is created: the next desktop load opens the wizard."""
    save(onboarding_completed=False, tour_completed=False, selected_roles=[], cluster_intent="standalone")


class ApplyBody(BaseModel):
    selected_roles: list[str] = Field([], max_length=20)
    cluster_intent: Intent = "standalone"
    enabled_features: dict[str, bool] = Field({}, max_length=len(features.KEYS))
    selected_app_ids: list[str] = Field([], max_length=len(apps.CATALOG))
    skip_tour: bool = False


def deploy_body(app_id: str) -> apps.DeployBody:
    a = apps.BY_ID[app_id]
    return apps.DeployBody(app_id=app_id, cores=a["cores"], memory=a["memory_mb"], disk_gb=a["disk_gb"],
                           install_open_webui=app_id == "local-ai")


async def install_one(app_id: str, log) -> None:
    res = await apps.install(app_id, deploy_body(app_id))
    while (job := apps._jobs.get(res["vmid"])) and job["phase"] not in ("done", "error"):
        await asyncio.sleep(2)
    if job and job["phase"] == "error":
        raise RuntimeError(job.get("error") or "install failed")


async def run_setup(body: ApplyBody, job: dict) -> dict:
    log = job["logs"].append
    job["stage"] = 0
    log("Applying the selected features and services")
    res = await features.apply(body.enabled_features)
    for w in res["warnings"]:
        log(f"Warning: {w}")
    job["stage"], job["percent"] = 1, 20
    if body.cluster_intent == "standalone":
        log("Standalone server: no cluster membership")
    else:
        from . import cluster
        pre = await cluster.preflight()
        failed = [c["id"] for c in pre["checks"] if c.get("required") and not c["ok"]]
        log("Cluster prerequisites met" if not failed else f"Cluster prerequisites still missing: {', '.join(failed)}")
    job["stage"], job["percent"] = 2, 30
    installed, failed_apps = [], []
    for n, app_id in enumerate(body.selected_app_ids):
        log(f"Installing {apps.BY_ID[app_id]['name']} ({n + 1} of {len(body.selected_app_ids)})")
        try:
            await install_one(app_id, log)
            installed.append(app_id)
        except Exception as e:  # noqa: BLE001 - one failed app does not stop the others
            failed_apps.append(app_id)
            log(f"!! {apps.BY_ID[app_id]['name']}: {getattr(e, 'detail', None) or e}")
        job["percent"] = 30 + 65 * (n + 1) / len(body.selected_app_ids)
    job["stage"] = 3
    save(onboarding_completed=True, tour_completed=body.skip_tour, selected_roles=body.selected_roles,
         cluster_intent=body.cluster_intent)
    log("Setup complete")
    return {"installed": installed, "failed": failed_apps}


@router.get("/state")
def state():
    return load()


@router.post("/apply")
async def apply(body: ApplyBody):
    bad = [a for a in body.selected_app_ids if a not in {x["id"] for x in apps.CATALOG}]
    if bad:
        raise HTTPException(422, f"Unknown app: {', '.join(bad)}")
    if any(j["kind"] == "onboarding" and j["status"] == "running" for j in task_progress.module_jobs.values()):
        raise HTTPException(409, "Server setup is already running")
    job = task_progress.start_job("onboarding", "Server setup", lambda j: run_setup(body, j))
    return {"job_id": job["id"]}


@router.post("/skip")
def skip():
    """Skip Setup & Use Defaults: every feature stays as it is, no tour."""
    return save(onboarding_completed=True, tour_completed=True)


@router.post("/tour-complete")
def tour_complete():
    return save(tour_completed=True)

