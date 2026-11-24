import asyncio
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException

from .auth import require_user
from .pve import _node, pve

router = APIRouter(prefix="/api/pve/tasks", tags=["tasks"], dependencies=[Depends(require_user)])


def _upid_path(upid: str, suffix: str) -> str:
    # UPID:<node>:...; the task lives on the node that ran it.
    parts = upid.split(":")
    if len(parts) < 8 or parts[0] != "UPID":
        raise HTTPException(400, "Invalid UPID")
    return f"/nodes/{parts[1]}/tasks/{quote(upid, safe='')}/{suffix}"


def normalize(t: dict) -> dict:
    status = t.get("status")
    state = "running" if not t.get("endtime") and not status else "ok" if status == "OK" else "error"
    return {"upid": t["upid"], "type": t.get("type", ""), "id": t.get("id", ""), "user": t.get("user", ""),
            "status": status or "running", "state": state, "starttime": t.get("starttime", 0),
            "endtime": t.get("endtime")}


@router.get("")
async def tasks():
    # source=all includes tasks that are still running (the default lists only finished ones).
    items = await pve("GET", _node("/tasks"), params={"limit": 30, "source": "all"})
    return [normalize(t) for t in items or []]


@router.get("/{upid}/status")
async def task_status(upid: str):
    s = await pve("GET", _upid_path(upid, "status"))
    running = s.get("status") == "running"
    return {"upid": upid, "running": running, "exitstatus": s.get("exitstatus"),
            "state": "running" if running else "ok" if s.get("exitstatus") == "OK" else "error"}


@router.get("/{upid}/log")
async def task_log(upid: str, start: int = 0):
    lines = await pve("GET", _upid_path(upid, "log"), params={"start": start, "limit": 1000})
    return {"start": start, "lines": [line.get("t", "") for line in lines or []]}


async def wait_task(upid: str, timeout: float = 900) -> None:
    """Block until a PVE task stops; raise if it did not end with OK."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        s = await task_status(upid)
        if not s["running"]:
            if s["state"] != "ok":
                raise HTTPException(502, f"Task failed: {s['exitstatus']}")
            return
        await asyncio.sleep(2)
    raise HTTPException(504, "Task timed out")
