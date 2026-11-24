import asyncio
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import host
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/pve", tags=["pve"], dependencies=[Depends(require_user)])
_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=f"{settings.pve_host.rstrip('/')}/api2/json",
            headers={"Authorization": f"PVEAPIToken={settings.pve_token_id}={settings.pve_token_secret}"},
            verify=settings.pve_verify_ssl,
            timeout=15,
        )
    return _client


async def close_client() -> None:
    if _client is not None:
        await _client.aclose()


async def pve(method: str, path: str, **kw):
    try:
        r = await client().request(method, path, **kw)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Proxmox API unreachable: {e}")
    if r.status_code >= 400:
        raise HTTPException(502 if r.status_code >= 500 else r.status_code, f"Proxmox API error: {r.text[:300]}")
    return r.json().get("data")


async def _safe(path: str, default=None):
    try:
        return await pve("GET", path)
    except HTTPException:
        return default


def _node(path: str = "") -> str:
    return f"/nodes/{settings.pve_node}{path}"


@router.get("/overview")
async def overview():
    status, qemu, lxc, rrd = await asyncio.gather(
        pve("GET", _node("/status")),
        _safe(_node("/qemu"), []),
        _safe(_node("/lxc"), []),
        # shortcut: network rate + ZFS ARC come from the 1-minute RRD average; upgrade to a host agent for per-second data.
        _safe(_node("/rrddata?timeframe=hour&cf=AVERAGE"), []),
    )
    last = next((p for p in reversed(rrd or []) if p.get("netin") is not None), {})
    count = lambda items, state: sum(1 for g in items if g.get("status") == state)  # noqa: E731
    mem, swap, cpuinfo = status.get("memory", {}), status.get("swap", {}), status.get("cpuinfo", {})
    return {
        "node": settings.pve_node,
        "cpu": round(status.get("cpu", 0) * 100, 2),
        "loadavg": [float(x) for x in status.get("loadavg", [])],
        "memory": {"used": mem.get("used", 0), "total": mem.get("total", 0), "free": mem.get("free", 0),
                   "arc": int(last.get("arcsize") or 0)},
        "swap": {"used": swap.get("used", 0), "total": swap.get("total", 0)},
        "uptime": status.get("uptime", 0),
        "kernel": status.get("kversion", ""),
        "pveversion": status.get("pveversion", ""),
        "cpuinfo": {"model": cpuinfo.get("model", ""), "cpus": cpuinfo.get("cpus", 0),
                    "sockets": cpuinfo.get("sockets", 0), "cores": cpuinfo.get("cores", 0)},
        "net": {"in": float(last.get("netin") or 0), "out": float(last.get("netout") or 0)},
        "vms": {"running": count(qemu, "running"), "stopped": count(qemu, "stopped"), "total": len(qemu)},
        "containers": {"running": count(lxc, "running"), "stopped": count(lxc, "stopped"), "total": len(lxc)},
    }


class ActionBody(BaseModel):
    action: Literal["start", "shutdown", "stop", "reboot"]


GUEST_FIELDS = ("cpu", "maxcpu", "mem", "maxmem", "disk", "maxdisk", "uptime", "netin", "netout")


def _normalize(g: dict, kind: str) -> dict:
    return {"vmid": int(g["vmid"]), "name": g.get("name", f"{kind}-{g['vmid']}"), "type": kind,
            "status": g.get("status", "unknown"), **{f: g.get(f, 0) for f in GUEST_FIELDS}}


@router.get("/guests")
async def guests():
    qemu, lxc = await asyncio.gather(pve("GET", _node("/qemu")), pve("GET", _node("/lxc")))
    items = [_normalize(g, "qemu") for g in qemu or []] + [_normalize(g, "lxc") for g in lxc or []]
    return sorted(items, key=lambda g: g["vmid"])


@router.post("/guests/{guest_type}/{vmid}/action")
async def guest_action(guest_type: Literal["qemu", "lxc"], vmid: int, body: ActionBody):
    upid = await pve("POST", _node(f"/{guest_type}/{vmid}/status/{body.action}"))
    return {"ok": True, "task": upid}


@router.get("/storage")
async def storage():
    pools, targets, disks = await asyncio.gather(
        _safe(_node("/disks/zfs"), []), _safe(_node("/storage"), []), _safe(_node("/disks/list"), []),
    )
    details = await asyncio.gather(*[_safe(_node(f"/disks/zfs/{p['name']}"), {}) for p in pools or []])
    return {
        "pools": [{**p, "detail": d} for p, d in zip(pools or [], details)],
        "targets": targets or [],
        "disks": disks or [],
    }


# ZFS dataset snapshots: there is no PVE API for these, so they go through the host helper.
DATASET_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:/-]*$"
SNAPNAME_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
SNAPSHOT_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:/-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*$"


def parse_zfs_list(out: str) -> dict:
    datasets, snapshots = [], []
    for line in out.splitlines():
        cols = line.split("\t")
        if len(cols) != 6:
            continue
        name, kind, used, refer, creation, mountpoint = cols
        num = lambda v: int(v) if v.isdigit() else 0  # noqa: E731
        if kind == "snapshot":
            ds, snap = name.split("@", 1)
            snapshots.append({"name": name, "dataset": ds, "snapshot": snap, "used": num(used), "refer": num(refer),
                              "creation": num(creation)})
        else:
            datasets.append({"name": name, "type": kind, "used": num(used), "refer": num(refer),
                             "mountpoint": mountpoint})
    snapshots.sort(key=lambda s: s["creation"], reverse=True)
    return {"datasets": datasets, "snapshots": snapshots}


@router.get("/zfs/snapshots")
async def zfs_snapshots():
    return parse_zfs_list(await host.run(["zfs-list"]))


class SnapshotBody(BaseModel):
    dataset: str = Field(pattern=DATASET_RE, max_length=200)
    name: str = Field(pattern=SNAPNAME_RE, max_length=100)


class RollbackBody(BaseModel):
    snapshot: str = Field(pattern=SNAPSHOT_RE, max_length=300)
    force: bool = False


@router.post("/zfs/snapshots")
async def zfs_snapshot_create(body: SnapshotBody):
    await host.run(["zfs-snapshot", f"{body.dataset}@{body.name}"])
    return {"ok": True}


@router.post("/zfs/snapshots/rollback")
async def zfs_snapshot_rollback(body: RollbackBody):
    await host.run(["zfs-rollback", body.snapshot, *(["force"] if body.force else [])], timeout=600)
    return {"ok": True}


@router.delete("/zfs/snapshots")
async def zfs_snapshot_delete(snapshot: str = Query(pattern=SNAPSHOT_RE, max_length=300)):
    await host.run(["zfs-destroy", snapshot])
    return {"ok": True}
