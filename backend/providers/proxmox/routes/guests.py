"""Proxmox guest details: storage overview and the guest resource editor (cores, memory, disks)."""
import asyncio
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException

from app.auth import require_user
from app.hypervisor import GuestConfigBody

from ..api import _node, _safe, pve

router = APIRouter(prefix="/api/v1", tags=["proxmox"], dependencies=[Depends(require_user)])


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
