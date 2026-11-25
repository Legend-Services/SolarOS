"""Driver-neutral compute and ZFS snapshot routes: overview, guest list and power go through the active provider;
ZFS dataset snapshots go through the root-only host helper."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import host
from .auth import require_user
from providers.registry import get_provider

router = APIRouter(prefix="/api/v1", tags=["hypervisor"], dependencies=[Depends(require_user)])


class ActionBody(BaseModel):
    action: Literal["start", "shutdown", "stop", "reboot"]


# Compute & telemetry go through the active hypervisor driver (providers/).
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
        if await get_provider().zfs_pool_list():
            raise  # ZFS exists, so this is a real helper failure
        return None


# ZFS dataset snapshots go through the host helper.
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


class GuestConfigBody(BaseModel):
    cores: int | None = Field(None, ge=1, le=512)
    memory: int | None = Field(None, ge=16, le=4 * 1024 * 1024)  # MB
    swap: int | None = Field(None, ge=0, le=1024 * 1024)  # MB, containers only
    onboot: bool | None = None
    description: str | None = Field(None, max_length=8000)
    tags: str | None = Field(None, pattern=r"^[A-Za-z0-9_.;, -]*$", max_length=500)
    resize_disk: str | None = Field(None, pattern=r"^(scsi|virtio|sata|ide)\d+$|^(rootfs|mp\d+)$")
    resize_to: str | None = Field(None, pattern=r"^\+?[0-9]+(\.[0-9]+)?[KMGT]$")  # "+10G" grows, "64G" sets
