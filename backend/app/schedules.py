"""Automated ZFS snapshot and scrub schedules, persisted to JSON and run by an in-process asyncio loop."""
import asyncio
import json
import logging
import os
import time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from . import host
from .auth import require_user
from .config import settings
from .pve import DATASET_RE, parse_zfs_list

router = APIRouter(prefix="/api/schedules", tags=["schedules"], dependencies=[Depends(require_user)])
log = logging.getLogger("proxmox-os.schedules")

POOL_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
PERIOD = {"hourly": 3600, "daily": 86400, "weekly": 7 * 86400, "monthly": 30 * 86400}
AUTO_PREFIX = "solardeck-auto-"
LEGACY_AUTO_PREFIX = "proxmoxos-auto-"  # pre-rename snapshots still count toward retention and get pruned
TICK_S = 60
_lock = asyncio.Lock()


class ScheduleBody(BaseModel):
    kind: Literal["snapshot", "scrub"]
    target: str = Field(pattern=DATASET_RE, max_length=200)  # dataset for snapshots, pool for scrubs
    interval: Literal["hourly", "daily", "weekly", "monthly"] = "daily"
    retention: int = Field(default=7, ge=1, le=1000)
    enabled: bool = True

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "scrub":
            if "/" in self.target:
                raise ValueError("scrub target must be a pool, not a dataset")
            self.interval = "monthly"
        elif self.interval == "monthly":
            raise ValueError("snapshot interval must be hourly, daily or weekly")
        return self


class TogglePatch(BaseModel):
    enabled: bool


def _load() -> list[dict]:
    try:
        return json.loads(settings.schedules_file.read_text())
    except FileNotFoundError:
        return []


def _save(items: list[dict]) -> None:
    settings.schedules_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.schedules_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    os.replace(tmp, settings.schedules_file)  # atomic: a crash never leaves a half-written file


@router.get("")
async def list_schedules():
    return _load()


@router.post("")
async def create_schedule(body: ScheduleBody):
    now = int(time.time())
    item = {"id": uuid.uuid4().hex[:12], **body.model_dump(), "created": now, "next_run": now + PERIOD[body.interval],
            "last_run": None, "last_status": None, "last_error": None}
    async with _lock:
        _save([*_load(), item])
    return item


@router.patch("/{sid}")
async def toggle_schedule(sid: str, body: TogglePatch):
    async with _lock:
        items = _load()
        item = next((i for i in items if i["id"] == sid), None)
        if not item:
            raise HTTPException(404, "Schedule not found")
        item["enabled"] = body.enabled
        if body.enabled:  # don't fire a burst of overdue runs right after re-enabling
            item["next_run"] = max(item["next_run"], int(time.time()) + PERIOD[item["interval"]])
        _save(items)
    return item


@router.delete("/{sid}")
async def delete_schedule(sid: str):
    async with _lock:
        items = _load()
        kept = [i for i in items if i["id"] != sid]
        if len(kept) == len(items):
            raise HTTPException(404, "Schedule not found")
        _save(kept)
    return {"ok": True}


async def execute(item: dict, now: int) -> None:
    if item["kind"] == "scrub":
        await host.run(["zpool-scrub", item["target"]])
        return
    prefix = f"{AUTO_PREFIX}{item['interval']}-"
    legacy = f"{LEGACY_AUTO_PREFIX}{item['interval']}-"
    await host.run(["zfs-snapshot", f"{item['target']}@{prefix}{time.strftime('%Y%m%d-%H%M%S', time.localtime(now))}"])
    snaps = [s for s in parse_zfs_list(await host.run(["zfs-list"]))["snapshots"]
             if s["dataset"] == item["target"] and s["snapshot"].startswith((prefix, legacy))]  # newest first
    for s in snaps[item["retention"]:]:
        await host.run(["zfs-destroy", s["name"]])


async def run_due(now: int | None = None) -> int:
    """Run every enabled schedule whose next_run has passed. Returns how many ran."""
    now = now or int(time.time())
    async with _lock:
        items = _load()
        due = [i for i in items if i["enabled"] and i["next_run"] <= now]
        for i in due:
            i["next_run"] = now + PERIOD[i["interval"]]  # missed runs while offline are skipped, not replayed
        if due:
            _save(items)
    results = {}
    for i in due:
        try:
            await execute(i, now)
            results[i["id"]] = ("ok", None)
        except Exception as e:  # noqa: BLE001 - one failing schedule must not stop the others
            detail = getattr(e, "detail", None) or str(e)
            log.warning("schedule %s (%s %s) failed: %s", i["id"], i["kind"], i["target"], detail)
            results[i["id"]] = ("error", str(detail)[:300])
    if results:
        async with _lock:
            items = _load()
            for i in items:
                if i["id"] in results:
                    i["last_run"], (i["last_status"], i["last_error"]) = now, results[i["id"]]
            _save(items)
    return len(due)


async def scheduler_loop() -> None:
    while True:
        try:
            await run_due()
        except Exception:  # noqa: BLE001 - keep the loop alive (e.g. unreadable schedules.json)
            log.exception("scheduler tick failed")
        await asyncio.sleep(TICK_S)
