"""Unified stage-based progress for long-running jobs: GPU driver installs and mode switches, App Center installs,
OS package upgrades, Local AI model pulls and app uninstalls. Every job is reported in one shape, shown by the frontend's
OperationProgressCard and the Task Center:

    {job_id, kind, subject, status: running|completed|failed, progress_percent: 0..100, current_stage, stage_key,
     stage_index, stages: [{key, label, percent}], logs: [...], error_message}

Sources: GPU host-job scripts echo `@@stage gpu <i>@@` markers (see marker()), App Center jobs carry a phase, and apt
output is parsed. Labels are English; the UI translates them by stage key (progress.<kind>.<key>).
"""
import re
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path

from . import host, host_ssh
from .auth import require_user

router = APIRouter(tags=["tasks"], dependencies=[Depends(require_user)])

STAGES: dict[str, list[tuple[int, str, str]]] = {
    "gpu": [(10, "check", "Checking PCI hardware, kernel headers & active driver bindings"),
            (30, "repos", "Updating package repositories & resolving driver dependencies"),
            (60, "install", "Installing GPU drivers & container runtime toolkit"),
            (85, "initramfs", "Updating initramfs kernel modules & device permissions"),
            (95, "verify", "Verifying GPU availability (nvidia-smi / renderD128)"),
            (100, "done", "GPU configuration completed")],
    "app": [(10, "validate", "Validating resources, network bridge & storage mount"),
            (30, "download", "Downloading container template / image assets"),
            (55, "provision", "Provisioning container & configuring GPU / storage mounts"),
            (80, "install", "Installing application services"),
            (95, "health", "Running health check & registering app shortcut"),
            (100, "ready", "Application ready")],
    "os": [(15, "lists", "Fetching package lists"),
           (45, "download", "Downloading packages"),
           (75, "unpack", "Unpacking & configuring packages"),
           (95, "cleanup", "Cleaning up & checking reboot requirement"),
           (100, "done", "OS packages up to date")],
    "ai": [(0, "pull", "Downloading model"),
           (100, "done", "Model ready")],
    "uninstall": [(15, "stop", "Stopping application container"),
                  (45, "remove", "Removing container and virtual network interfaces"),
                  (75, "cleanup", "Cleaning up reverse proxy routes and application metadata"),
                  (90, "retention", "Applying storage retention policy"),
                  (100, "done", "Application instance removed")],
    "migrate": [(5, "precheck", "Checking the workload, source and target host"),
                (15, "sync", "Pre-syncing disks and replicas to the target host"),
                (30, "transfer", "Transferring disk and memory state"),
                (90, "switchover", "Switching the workload over to the target host"),
                (100, "done", "Migration completed")],
    "drain": [(0, "evacuate", "Live-migrating workloads off the host"),
              (100, "done", "Host drained for maintenance")],
    "failover": [(10, "detect", "Active host lost; quorum confirmed"),
                 (40, "promote", "Starting the workload from its latest replica"),
                 (80, "register", "Registering the workload on its new active host"),
                 (100, "done", "Failover completed")],
    "cluster": [(10, "prepare", "Checking prerequisites and backing up host configuration"),
                (40, "cluster", "Updating cluster membership"),
                (80, "sync", "Synchronizing cluster state, keys and inventory"),
                (100, "done", "Cluster membership updated")],
    "zerotouch": [(10, "validate", "Checking the image, storage and network"),
                  (30, "create", "Creating the VM and its disk from the image"),
                  (60, "seed", "Injecting cloud-init: host name, admin user, keys and network"),
                  (85, "boot", "Starting the VM and waiting for the guest agent"),
                  (100, "done", "VM provisioned")],
    "sandbox": [(10, "restore", "Restoring the backup into a temporary guest"),
                (35, "isolate", "Attaching it to an air-gapped isolated lab network"),
                (55, "boot", "Booting the guest"),
                (75, "heartbeat", "Waiting for the guest agent heartbeat"),
                (90, "teardown", "Removing the sandbox guest and lab"),
                (100, "done", "Restore verification finished")],
    "offsite": [(10, "prepare", "Preparing the offsite target"),
                (30, "upload", "Uploading backups to the offsite target"),
                (90, "verify", "Checking the uploaded copies"),
                (100, "done", "Offsite copy completed")],
    "onboarding": [(5, "features", "Applying features and services"),
                   (20, "cluster", "Preparing standalone or cluster mode"),
                   (30, "apps", "Installing the selected applications"),
                   (100, "done", "Server setup completed")],
}
MARK = re.compile(r"^@@stage (\w+) (\d+)@@$")
JOB_ID = r"^(os-upgrade|gpu-[a-z-]{1,40}|app-\d{1,9}|uninstall-\d{1,9}|ai-[0-9a-f]{12}|cluster-[0-9a-f]{12}|mod-[0-9a-f]{12})$"
KEEP_FINISHED = 600  # seconds a finished job stays in the Task Center feed


def marker(kind: str, index: int) -> str:
    """Shell line that moves a host job to stage `index` of STAGES[kind]."""
    return f"echo '@@stage {kind} {index}@@'"


def view(job_id: str, kind: str, status: str, index: int, logs: list[str], subject: str = "",
         error: str | None = None, percent: float | None = None) -> dict:
    stages = STAGES[kind]
    last = len(stages) - 1
    i = last if status == "completed" else min(max(index, 0), last - 1)  # the final stage means "done"
    pct = 100 if status == "completed" else stages[i][0] if percent is None else max(0.0, min(99.0, percent))
    return {"job_id": job_id, "kind": kind, "subject": subject, "status": status, "progress_percent": round(pct),
            "current_stage": stages[i][2], "stage_key": f"{kind}.{stages[i][1]}", "stage_index": i,
            "stages": [{"key": f"{kind}.{k}", "label": label, "percent": p} for p, k, label in stages],
            "logs": logs[-400:], "error_message": error}


def _failure(logs: list[str], exit_code: int | None) -> str:
    """Last `!!` line the scripts print on a problem, else the exit code."""
    hint = next((x.strip("! ").strip() for x in reversed(logs) if x.startswith("!!")), None)
    return hint or (f"Exited with code {exit_code}" if exit_code is not None else "Stopped before it finished")


def from_host_job(job_id: str, kind: str, st: dict, subject: str = "") -> dict | None:
    """host_ssh.job_status() result (stage markers in the log) → progress view; None if the job never ran."""
    index, logs = 0, []
    for line in st["log"]:
        m = MARK.match(line.strip())
        if m:
            index = int(m.group(2)) if m.group(1) == kind else index
        else:
            logs.append(line)
    if not logs and not st["running"] and index == 0:
        return None
    status = "running" if st["running"] else "completed" if st["exit_code"] == 0 else "failed"
    return view(job_id, kind, status, index, logs, subject,
                _failure(logs, st["exit_code"]) if status == "failed" else None)


def apt_stage(logs: list[str]) -> int:
    """Stage index of an `apt-get update && apt-get dist-upgrade` run from its output so far."""
    stage, planned = 0, False
    for x in logs:
        if re.match(r"^\d+ upgraded, \d+ newly installed", x):
            planned = True
            stage = max(stage, 3 if x.startswith("0 upgraded, 0 newly installed") else 1)
        elif planned and x.startswith("Get:"):
            stage = max(stage, 1)
        elif x.startswith(("Preparing to unpack", "Unpacking ", "Setting up ")):
            stage = 2
        elif x.startswith("Processing triggers") and stage == 2:
            stage = 3
    return stage


def from_apt(job_id: str, st: dict) -> dict | None:
    if not st["log"] and not st["running"]:
        return None
    status = "running" if st["running"] else "completed" if st["exit_code"] == 0 else "failed"
    err = None
    if status == "failed":
        err = next((x.strip() for x in reversed(st["log"]) if x.startswith(("E:", "dpkg: error"))), None) \
            or _failure(st["log"], st["exit_code"])
    return view(job_id, "os", status, apt_stage(st["log"]), st["log"], "", err)


# App Center phases (both drivers) → stage index; "creating" covers validation (no output yet) and the download.
APP_PHASE = {"creating": 1, "configuring": 2, "starting": 2, "installing": 3, "registering": 4}


def from_app(job: dict) -> dict:
    from . import apps  # lazy: apps imports this module
    phase = job["phase"]
    status = "completed" if phase == "done" else "failed" if phase == "error" else "running"
    at = job.get("failed_phase", "creating") if phase == "error" else phase
    index = 0 if at == "creating" and not job["log"] else APP_PHASE.get(at, 1)
    name = apps.BY_ID.get(job["app_id"], {}).get("name", job["app_id"])
    return view(f"app-{job['vmid']}", "app", status, index, job["log"], name, job.get("error"))


def from_uninstall(job: dict) -> dict:
    return view(f"uninstall-{job['vmid']}", "uninstall", job["status"], job["stage"], job["log"], job["subject"],
                job["error"])


def from_pull(job: dict) -> dict:
    status = {"done": "completed", "error": "failed"}.get(job["state"], "running")
    return view(f"ai-{job['id']}", "ai", status, 0, [job["status"]] if job.get("status") else [], job["model"],
                job.get("error"), job.get("percent") or 0)


# shortcut: watched host jobs live in memory, so after a backend restart a still-running GPU / OS job only shows in
# its own panel (which asks for it by id), not in the Task Center feed. Persist _watch if that matters.
_watch: dict[str, dict] = {}


def watch(job_id: str, subject: str = "") -> None:
    """List a host job that was just started in the Task Center feed."""
    _watch[job_id] = {"subject": subject, "ended": None}


async def resolve(job_id: str) -> dict | None:
    if job_id == "os-upgrade":
        return from_apt(job_id, host_ssh.parse_job_status(await host.run(["apt-upgrade-status"])))
    if job_id.startswith("gpu-"):
        return from_host_job(job_id, "gpu", await host_ssh.job_status(job_id), _watch.get(job_id, {}).get("subject", ""))
    if job_id.startswith("app-"):
        from . import apps
        job = apps._jobs.get(int(job_id[4:]))
        return from_app(job) if job else None
    if job_id.startswith("uninstall-"):
        from . import apps
        job = apps._removals.get(int(job_id[10:]))
        return from_uninstall(job) if job else None
    if job_id.startswith("ai-"):
        from . import local_ai
        job = local_ai._pulls.get(job_id[3:])
        return from_pull(job) if job else None
    if job_id.startswith("mod-"):
        job = module_jobs.get(job_id)
        return from_cluster(job) if job else None
    if job_id.startswith("cluster-"):
        from . import cluster
        job = cluster._jobs.get(job_id)
        return from_cluster(job) if job else None
    return None


# Background jobs of the optional platform modules (zero-touch VMs, sandbox restore checks, offsite copies).
# shortcut: in memory like the other job registries; a backend restart forgets finished and running module jobs.
module_jobs: dict[str, dict] = {}
_bg: set = set()


def start_job(kind: str, subject: str, work) -> dict:
    """Run `work(job)` in the background; it advances job["stage"] and appends to job["logs"]."""
    import asyncio
    import secrets
    job = {"id": f"mod-{secrets.token_hex(6)}", "kind": kind, "subject": subject, "status": "running", "stage": 0,
           "logs": [], "error": None, "percent": None, "result": None}
    module_jobs[job["id"]] = job

    async def runner():
        try:
            job["result"] = await work(job)
            job["status"] = "completed"
        except Exception as e:  # noqa: BLE001 - surfaced in the progress card
            job["status"], job["error"] = "failed", getattr(e, "detail", None) or str(e) or type(e).__name__
            job["logs"].append(f"!! {job['error']}")

    t = asyncio.create_task(runner())
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return job


def from_cluster(job: dict) -> dict:
    return view(job["id"], job["kind"], job["status"], job["stage"], job["logs"], job["subject"], job["error"],
                job["percent"])


def _recent(v: dict, w: dict) -> bool:
    """Running, or finished less than KEEP_FINISHED ago (`w["ended"]` is stamped the first time it is seen finished)."""
    if v["status"] == "running":
        return True
    w["ended"] = w.get("ended") or time.time()
    return time.time() - w["ended"] < KEEP_FINISHED


async def feed(kind: str | None = None) -> list[dict]:
    """Running jobs plus those finished in the last KEEP_FINISHED seconds; `kind` limits it to gpu / app / os / ai / uninstall."""
    from . import apps, local_ai
    out = []
    for job_id, w in list(_watch.items()):
        if kind and not job_id.startswith(kind):  # job ids start with their kind (os-upgrade, gpu-…)
            continue
        try:
            v = await resolve(job_id)
        except Exception:  # noqa: BLE001 - host unreachable: skip this poll, keep watching
            continue
        if not v or not _recent(v, w):
            _watch.pop(job_id, None)
            continue
        out.append(v)
    if kind in (None, "app"):
        out += [v for job in list(apps._jobs.values()) if _recent(v := from_app(job), job)]
    if kind in (None, "uninstall"):
        out += [v for job in list(apps._removals.values()) if _recent(v := from_uninstall(job), job)]
    if kind in (None, "ai"):
        out += [v for job in list(local_ai._pulls.values()) if _recent(v := from_pull(job), job)]
    if kind in (None, "cluster"):
        from . import cluster
        out += [v for job in list(cluster._jobs.values()) if _recent(v := from_cluster(job), job)]
    if kind is None:
        out += [v for job in list(module_jobs.values()) if _recent(v := from_cluster(job), job)]
    return out


@router.get("/api/system/tasks")
async def tasks(kind: Literal["gpu", "app", "os", "ai", "uninstall", "cluster"] | None = None):
    return {"tasks": await feed(kind)}


@router.get("/api/tasks/{job_id}")
async def task(job_id: str = Path(pattern=JOB_ID)):
    v = await resolve(job_id)
    if v is None:
        raise HTTPException(404, "No such job (it never ran, or the backend restarted)")
    return v
