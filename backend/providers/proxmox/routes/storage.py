"""Proxmox disk and pool operations through the API (they return task UPIDs, visible in the Task Center)."""
import asyncio
import re
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.auth import require_user
from app.storage_admin import (POOL_RE, STORAGE_RE, DeviceBody, DeviceConfirm, PoolBody, _dev, normalize_disk,
                               parse_smart, probe_host_disks, validate_pool)

from ..api import _node, pve

router = APIRouter(prefix="/api/v1", tags=["storage-admin"], dependencies=[Depends(require_user)])


@router.get("/disks")
async def disks():
    items, (members, rpms) = await asyncio.gather(pve("GET", _node("/disks/list")), probe_host_disks())
    return [normalize_disk(d, members.get(d.get("devpath")), rpms.get((d.get("devpath") or "").removeprefix("/dev/")))
            for d in items or []]


@router.get("/disks/{disk:path}/smart")
async def disk_smart(disk: str):
    """Accepts "sda", "dev/sda" or "/dev/sda" (also URL-encoded)."""
    path = disk if disk.startswith("/dev/") else f"/dev/{disk.removeprefix('dev/').lstrip('/')}"
    return parse_smart(await pve("GET", _node(f"/disks/smart?disk={quote(_dev(path), safe='')}")) or {})


@router.post("/disks/wipe")
async def disk_wipe(body: DeviceConfirm):
    if body.confirm_device != body.disk:
        raise HTTPException(400, "Confirmation does not match the device path")
    return {"task": await pve("PUT", _node("/disks/wipedisk"), data={"disk": _dev(body.disk)})}


@router.post("/disks/initgpt")
async def disk_initgpt(body: DeviceBody):
    return {"task": await pve("POST", _node("/disks/initgpt"), data={"disk": _dev(body.disk)})}


class DirectoryBody(BaseModel):
    device: str = Field(max_length=200)
    name: str = Field(pattern=STORAGE_RE)
    filesystem: Literal["ext4", "xfs"] = "ext4"
    add_storage: bool = True


@router.post("/disks/directory")
async def disk_directory(body: DirectoryBody):
    data = {"device": _dev(body.device), "name": body.name, "filesystem": body.filesystem,
            "add_storage": int(body.add_storage)}
    return {"task": await pve("POST", _node("/disks/directory"), data=data)}


class LvmBody(BaseModel):
    device: str = Field(max_length=200)
    name: str = Field(pattern=STORAGE_RE)
    thin: bool = False
    add_storage: bool = True


@router.post("/disks/lvm")
async def disk_lvm(body: LvmBody):
    data = {"device": _dev(body.device), "name": body.name, "add_storage": int(body.add_storage)}
    return {"task": await pve("POST", _node("/disks/lvmthin" if body.thin else "/disks/lvm"), data=data)}


@router.post("/zfs/pools")
async def pool_create(body: PoolBody):
    devs = validate_pool(body)
    data = {"name": body.name, "raidlevel": body.raidlevel, "devices": ",".join(devs), "ashift": body.ashift,
            "compression": body.compression, "add_storage": int(body.add_storage)}
    return {"task": await pve("POST", _node("/disks/zfs"), data=data)}


@router.delete("/zfs/pools/{name}")
async def pool_destroy(name: str, confirm: str = Query(max_length=64)):
    if not re.fullmatch(POOL_RE, name):
        raise HTTPException(422, "Invalid pool name")
    if confirm != name:
        raise HTTPException(400, "Confirmation does not match the pool name")
    # cleanup-config removes the matching PVE storage entry; cleanup-disks wipes the member disks' labels.
    return {"task": await pve("DELETE", _node(f"/disks/zfs/{name}"), params={"cleanup-config": 1, "cleanup-disks": 1})}
