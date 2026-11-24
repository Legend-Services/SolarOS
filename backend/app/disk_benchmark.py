"""Storage benchmark: four classic fio profiles (SEQ1M Q8T1, SEQ128K Q32T1, RND4K Q32T1, RND4K Q1T1), read and write.

Runs on the PVE host over the root SSH bridge. Read-only runs skip the write tests; physical disks are opened read-only (`fio --readonly`) unless the disk is
unused and the caller confirms its device path. Mountpoints use a temporary `.proxmoxos-bench.tmp` file that is
removed when the run ends. Finished runs are kept in data/benchmarks.json for side-by-side comparison.
"""
import asyncio
import json
import re
import shlex
import time
import uuid
from contextlib import suppress
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import host_ssh
from .auth import require_user
from .config import settings
from .storage_admin import _dev, disk_info, ensure_tool, probe_host_disks

router = APIRouter(prefix="/api/pve/disks/benchmark", tags=["disk-benchmark"], dependencies=[Depends(require_user)])

PROFILES = {
    "SEQ1M_Q8T1": {"bs": "1m", "iodepth": 8, "seq": True},
    "SEQ128K_Q32T1": {"bs": "128k", "iodepth": 32, "seq": True},
    "RND4K_Q32T1": {"bs": "4k", "iodepth": 32, "seq": False},
    "RND4K_Q1T1": {"bs": "4k", "iodepth": 1, "seq": False},
}
Profile = Literal["SEQ1M_Q8T1", "SEQ128K_Q32T1", "RND4K_Q32T1", "RND4K_Q1T1"]
RUNTIME_S = 5  # per pass, like the classic desktop tools
TMP_NAME = ".proxmoxos-bench.tmp"
MOUNT_RE = r"^/[A-Za-z0-9_./ -]{0,200}$"
HISTORY_MAX = 200
history_file = settings.schedules_file.parent / "benchmarks.json"

jobs: dict[str, dict] = {}
_running: asyncio.Task | None = None


def fio_command(filename: str, profile: str, rw: Literal["read", "write"], size_mb: int, readonly: bool) -> str:
    p = PROFILES[profile]
    mode = ("" if p["seq"] else "rand") + rw
    return " ".join([
        "fio --name=proxmoxos --ioengine=libaio --direct=1 --numjobs=1 --group_reporting --output-format=json",
        f"--filename={shlex.quote(filename)} --size={size_mb}M --bs={p['bs']} --iodepth={p['iodepth']} --rw={mode}",
        f"--runtime={RUNTIME_S} --time_based --norandommap --randrepeat=0", "--readonly" if readonly else "",
    ]).strip()


def parse_fio(out: str, rw: str) -> dict:
    """fio JSON (possibly preceded by warnings) → MB/s (decimal, like the desktop tools), IOPS, mean latency in µs."""
    start = out.find("{")
    if start < 0:
        raise ValueError(out.strip().splitlines()[-1] if out.strip() else "fio printed nothing")
    j = json.loads(out[start:])["jobs"][0][rw]
    lat = (j.get("lat_ns") or j.get("clat_ns") or {}).get("mean", 0)
    return {"mbps": round(j["bw_bytes"] / 1e6, 2) if "bw_bytes" in j else round(j["bw"] * 1024 / 1e6, 2),
            "iops": round(j["iops"], 1), "lat_us": round(lat / 1000, 1)}


def best(results: list[dict]) -> dict:
    return max(results, key=lambda r: r["mbps"])


def load_history() -> list[dict]:
    try:
        return json.loads(history_file.read_text())
    except (OSError, ValueError):
        return []


def save_result(entry: dict) -> None:
    items = (load_history() + [entry])[-HISTORY_MAX:]
    history_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = history_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    tmp.replace(history_file)


class BenchBody(BaseModel):
    target_type: Literal["disk", "mountpoint"]
    target: str = Field(max_length=200)
    mode: Literal["readonly", "readwrite"] = "readonly"
    test_size_mb: Literal[256, 1024, 4096] = 1024
    passes: Literal[1, 3, 5] = 1
    profiles: list[Profile] = Field(default_factory=lambda: list(PROFILES), min_length=1, max_length=4)
    confirm_device: str | None = Field(None, max_length=200)  # required to write to a raw (unused) disk
    label: str | None = Field(None, max_length=120)


async def resolve_target(body: BenchBody) -> tuple[str, str]:
    """(fio filename, human label); refuses anything that could overwrite data."""
    if body.target_type == "disk":
        path = _dev(body.target)
        disk = await disk_info(path)
        if body.mode == "readwrite":
            members, _ = await probe_host_disks()
            if disk["used"] or path in members:
                raise HTTPException(409, f"{path} is in use ({disk['used'] or 'ZFS'}); raw disks in use are only tested read-only")
            if body.confirm_device != path:
                raise HTTPException(400, "Writing to a raw disk destroys its contents; confirm_device must match the device path")
        return path, body.label or f"{disk['model'] or path} ({path})"
    if ".." in body.target or not re.fullmatch(MOUNT_RE, body.target):
        raise HTTPException(422, "Invalid mountpoint path")
    root = body.target.rstrip("/") or "/"
    q = shlex.quote(root)
    if (await host_ssh.run(f"test -d {q} && test -w {q} && echo ok || true")).strip() != "ok":
        raise HTTPException(404, f"{root} is not a writable directory on the host")
    return f"{root.rstrip('/')}/{TMP_NAME}", body.label or root


async def run_job(job: dict, filename: str, cleanup: bool, body: BenchBody) -> None:
    readonly = body.mode == "readonly"
    try:
        await ensure_tool("fio", "fio")
        if body.target_type == "mountpoint":
            # Lay the test file out once so read passes measure the medium, not file creation.
            job["phase"] = "Preparing test file"
            await host_ssh.run(f"fio --name=proxmoxos-prep --filename={shlex.quote(filename)} --size={body.test_size_mb}M "
                               f"--rw=write --bs=1m --direct=1 --ioengine=libaio --output-format=json >/dev/null", timeout=900)
        for step in job["steps"]:
            for rw in ("read", "write"):
                if rw == "write" and readonly:
                    continue
                step["status"] = f"running {rw}"
                job["phase"] = f"{step['profile']} {rw}"
                runs = []
                for n in range(body.passes):
                    job["pass"] = n + 1
                    out = await host_ssh.run(fio_command(filename, step["profile"], rw, body.test_size_mb, readonly),
                                             timeout=RUNTIME_S + 600, check=False)
                    runs.append(parse_fio(out, rw))
                step[rw] = best(runs)
                job["done_steps"] += 1
            step["status"] = "done"
        job["status"] = "done"
    except asyncio.CancelledError:
        job["status"], job["error"] = "cancelled", "Cancelled"
        raise
    except (HTTPException, ValueError, KeyError) as e:
        job["status"], job["error"] = "error", getattr(e, "detail", None) or str(e)
    finally:
        job["phase"], job["finished_at"] = None, time.time()
        if cleanup:
            with suppress(Exception):
                await host_ssh.run(f"rm -f {shlex.quote(filename)}", timeout=60)
        if job["status"] == "done":
            save_result({k: job[k] for k in ("id", "label", "target_type", "target", "mode", "test_size_mb", "passes",
                                             "started_at", "finished_at", "steps")})


@router.post("")
async def start(body: BenchBody):
    global _running
    if _running and not _running.done():
        raise HTTPException(409, "A benchmark is already running; parallel runs would distort both results")
    filename, label = await resolve_target(body)
    readonly = body.mode == "readonly"
    job = {"id": uuid.uuid4().hex[:12], "label": label, "target_type": body.target_type, "target": body.target,
           "mode": body.mode, "test_size_mb": body.test_size_mb, "passes": body.passes,
           "status": "running", "phase": "Checking fio", "pass": 0, "error": None, "started_at": time.time(),
           "finished_at": None, "done_steps": 0, "total_steps": len(body.profiles) * (1 if readonly else 2),
           "steps": [{"profile": p, "status": "queued", "read": None, "write": None} for p in body.profiles]}
    jobs[job["id"]] = job
    # shortcut: jobs live in memory, so a backend restart loses a running benchmark (the temp file is removed by the
    # next run on that mountpoint at worst); move to a host job if runs ever need to survive restarts.
    _running = asyncio.create_task(run_job(job, filename, body.target_type == "mountpoint", body))
    return job


@router.get("/history")
async def history():
    return load_history()


@router.get("/{job_id}")
async def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "No such benchmark job")
    return jobs[job_id]


@router.delete("/{job_id}")
async def cancel(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "No such benchmark job")
    if _running and not _running.done() and jobs[job_id]["status"] == "running":
        _running.cancel()
        # The fio process on the host outlives a cancelled SSH channel only briefly; stop it explicitly.
        with suppress(Exception):
            await host_ssh.run("pkill -f -- '--name=proxmoxos' || true", timeout=30)
    return jobs[job_id]
