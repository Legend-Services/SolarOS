"""Proxmox backup & disaster recovery: vzdump archives, immediate backups, restores and cluster backup jobs."""
import asyncio
import re

from fastapi import APIRouter, Depends, Path

from app.auth import require_user
from app.backups import JOB_ID_RE, RestoreBody, RunBody, ScheduleBody, ScheduleToggle, check_schedule
from app.provisioning import volume

from ..api import _node, _safe, pve

router = APIRouter(prefix="/api/v1/backups", tags=["backups"], dependencies=[Depends(require_user)])


def archive_type(v: dict) -> str | None:
    if v.get("subtype") in ("qemu", "lxc"):
        return v["subtype"]
    m = re.search(r"vzdump-(qemu|lxc|openvz)-", v["volid"])
    return ("lxc" if m.group(1) == "openvz" else m.group(1)) if m else None


def job(j: dict) -> dict:
    prune = j.get("prune-backups") or {}
    if isinstance(prune, str):  # "keep-last=3,keep-daily=7"
        prune = dict(kv.split("=", 1) for kv in prune.split(",") if "=" in kv)
    return {"id": j.get("id", ""), "enabled": bool(int(j.get("enabled", 1))), "schedule": j.get("schedule", ""),
            "storage": j.get("storage", ""), "all": bool(int(j.get("all", 0))), "vmid": j.get("vmid", ""),
            "mode": j.get("mode", "snapshot"), "compress": j.get("compress", ""), "comment": j.get("comment", ""),
            "keep_last": int(prune["keep-last"]) if str(prune.get("keep-last", "")).isdigit() else None,
            "next_run": j.get("next-run")}


@router.get("")
async def backups():
    stores, qemu, lxc, jobs = await asyncio.gather(
        pve("GET", _node("/storage"), params={"content": "backup"}),
        _safe(_node("/qemu"), []), _safe(_node("/lxc"), []), _safe("/cluster/backup", []),
    )
    ids = [s["storage"] for s in stores or [] if s.get("active")]
    contents = await asyncio.gather(*[_safe(_node(f"/storage/{s}/content"), [], params={"content": "backup"})
                                      for s in ids])
    names = {int(g["vmid"]): g.get("name", "") for g in [*(qemu or []), *(lxc or [])]}
    archives = []
    for store, items in zip(ids, contents):
        for v in items or []:
            if v.get("content") != "backup":
                continue
            a = volume(v, store)
            archives.append({**a, "type": archive_type(v), "name": names.get(a["vmid"], "")})
    archives.sort(key=lambda a: a["ctime"], reverse=True)
    return {"storages": ids, "archives": archives, "schedules": [job(j) for j in jobs or []]}


@router.post("/run")
async def run_backup(body: RunBody):
    target = {"all": 1} if body.vmid == "all" else {"vmid": body.vmid}
    data = {**target, "storage": body.storage, "mode": body.mode, "compress": body.compress}
    return {"upid": await pve("POST", _node("/vzdump"), data=data)}


def restore_params(b: RestoreBody) -> dict:
    archive = {"archive": b.volid} if b.type == "qemu" else {"ostemplate": b.volid, "restore": 1}
    return {"vmid": b.vmid, "storage": b.storage, **archive, **({"force": 1} if b.force else {})}


@router.post("/restore")
async def restore(body: RestoreBody):
    return {"upid": await pve("POST", _node(f"/{body.type}"), data=restore_params(body))}


def schedule_params(b: ScheduleBody) -> dict:
    check_schedule(b)
    target = {"all": 1} if b.vmids == "all" else {"vmid": ",".join(map(str, b.vmids))}
    return {**target, "schedule": b.schedule, "storage": b.storage, "mode": b.mode, "compress": b.compress,
            "prune-backups": f"keep-last={b.keep_last}", "enabled": int(b.enabled),
            **({"comment": b.comment} if b.comment else {})}


@router.post("/schedules")
async def create_schedule(body: ScheduleBody):
    await pve("POST", "/cluster/backup", data=schedule_params(body))
    return {"ok": True}


@router.put("/schedules/{job_id}")
async def toggle_schedule(body: ScheduleToggle, job_id: str = Path(pattern=JOB_ID_RE)):
    await pve("PUT", f"/cluster/backup/{job_id}", data={"enabled": int(body.enabled)})
    return {"ok": True}


@router.delete("/schedules/{job_id}")
async def delete_schedule(job_id: str = Path(pattern=JOB_ID_RE)):
    await pve("DELETE", f"/cluster/backup/{job_id}")
    return {"ok": True}
