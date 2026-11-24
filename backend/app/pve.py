import asyncio
import re
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import host
from .auth import require_user
from .config import settings
from providers.registry import get_provider

router = APIRouter(prefix="/api/v1", tags=["pve"], dependencies=[Depends(require_user)])
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
    if settings.hypervisor_driver == "native_ubuntu":
        # Proxmox-only features (cluster log, PVE storage backends, API tokens, ACME, ...) on the standalone driver.
        # _safe() callers degrade to their default; direct callers get a clear 501.
        raise HTTPException(501, "This feature needs a Proxmox VE host; it is not available on SolarOS")
    try:
        r = await client().request(method, path, **kw)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Proxmox API unreachable: {e}")
    if r.status_code >= 400:
        raise HTTPException(502 if r.status_code >= 500 else r.status_code, f"Proxmox API error: {r.text[:300]}")
    return r.json().get("data")


async def _safe(path: str, default=None, **kw):
    try:
        return await pve("GET", path, **kw)
    except HTTPException:
        return default


def _node(path: str = "") -> str:
    return f"/nodes/{settings.pve_node}{path}"


class ActionBody(BaseModel):
    action: Literal["start", "shutdown", "stop", "reboot"]


# Compute & telemetry go through the active hypervisor driver (providers/); the Proxmox driver holds the logic.
@router.get("/overview")
async def overview():
    return await get_provider().get_node_metrics()


@router.get("/guests")
async def guests():
    return await get_provider().list_guests()


@router.post("/guests/{guest_type}/{vmid}/action")
async def guest_action(guest_type: Literal["qemu", "lxc"], vmid: int, body: ActionBody):
    return await get_provider().guest_power_action(guest_type, vmid, body.action)


@router.delete("/guests/{guest_type}/{vmid}")
async def guest_delete(guest_type: Literal["qemu", "lxc"], vmid: int, purge: bool = True):
    return await get_provider().delete_guest(guest_type, vmid, purge)


async def zfs_helper(cmd: str) -> str | None:
    """Helper output, or None on a host with no ZFS pools (LVM/LVM-Thin/Directory storage) instead of an error."""
    try:
        return await host.run([cmd])
    except HTTPException:
        if await _safe(_node("/disks/zfs"), []):
            raise  # ZFS exists, so this is a real helper failure
        return None


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
        "zfs_available": bool(pools),
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
    out = await zfs_helper("zfs-list")
    return {**parse_zfs_list(out or ""), "zfs_available": out is not None}


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


# ---------------------------------------------------------------- Guest resource editor

QEMU_DISK_RE = re.compile(r"^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$")
LXC_DISK_RE = re.compile(r"^(rootfs|mp\d+)$")


def guest_disks(guest_type: str, cfg: dict) -> list[dict]:
    out = []
    for key, val in cfg.items():
        is_disk = (QEMU_DISK_RE if guest_type == "qemu" else LXC_DISK_RE).match(key)
        if not is_disk or not isinstance(val, str) or "media=cdrom" in val:
            continue
        size = re.search(r"(?:^|,)size=([0-9.]+[KMGT]?)", val)
        out.append({"key": key, "volume": val.split(",", 1)[0], "size": size.group(1) if size else None,
                    # EFI vars / TPM state disks have a fixed size; bind mounts (no size) can't be resized.
                    "resizable": bool(size) and not key.startswith(("efidisk", "tpmstate"))})
    return sorted(out, key=lambda d: d["key"])


@router.get("/guests/{guest_type}/{vmid}/config")
async def guest_config(guest_type: Literal["qemu", "lxc"], vmid: int):
    cfg = await pve("GET", _node(f"/{guest_type}/{vmid}/config")) or {}
    return {
        "name": cfg.get("name") or cfg.get("hostname") or f"{guest_type}-{vmid}",
        "cores": int(cfg.get("cores") or 1), "sockets": int(cfg.get("sockets") or 1),
        "memory": int(cfg.get("memory") or 512), "swap": int(cfg["swap"]) if "swap" in cfg else None,
        "onboot": bool(int(cfg.get("onboot") or 0)), "description": cfg.get("description") or "",
        "tags": cfg.get("tags") or "", "disks": guest_disks(guest_type, cfg),
    }


class GuestConfigBody(BaseModel):
    cores: int | None = Field(None, ge=1, le=512)
    memory: int | None = Field(None, ge=16, le=4 * 1024 * 1024)  # MB
    swap: int | None = Field(None, ge=0, le=1024 * 1024)  # MB, containers only
    onboot: bool | None = None
    description: str | None = Field(None, max_length=8000)
    tags: str | None = Field(None, pattern=r"^[A-Za-z0-9_.;, -]*$", max_length=500)
    resize_disk: str | None = Field(None, pattern=r"^(scsi|virtio|sata|ide)\d+$|^(rootfs|mp\d+)$")
    resize_to: str | None = Field(None, pattern=r"^\+?[0-9]+(\.[0-9]+)?[KMGT]$")  # "+10G" grows, "64G" sets


@router.patch("/guests/{guest_type}/{vmid}/config")
async def guest_config_update(guest_type: Literal["qemu", "lxc"], vmid: int, body: GuestConfigBody):
    if body.swap is not None and guest_type != "lxc":
        raise HTTPException(400, "Swap is a container setting")
    if bool(body.resize_disk) != bool(body.resize_to):
        raise HTTPException(400, "resize_disk and resize_to go together")
    data: dict = {k: v for k, v in body.model_dump(include={"cores", "memory", "swap"}).items() if v is not None}
    if body.onboot is not None:
        data["onboot"] = int(body.onboot)
    deletes = []
    for k in ("description", "tags"):
        v = getattr(body, k)
        if v is not None:
            if v.strip():
                data[k] = v
            else:
                deletes.append(k)  # PVE rejects empty strings; deleting the key clears it
    if deletes:
        data["delete"] = ",".join(deletes)
    if data:
        await pve("PUT", _node(f"/{guest_type}/{vmid}/config"), data=data)
    task = None
    if body.resize_disk:
        # PVE only grows disks; a smaller absolute size is refused by the API.
        task = await pve("PUT", _node(f"/{guest_type}/{vmid}/resize"),
                         data={"disk": body.resize_disk, "size": body.resize_to})
    return {"ok": True, "task": task}
