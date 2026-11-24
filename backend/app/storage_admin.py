"""Full storage administration: physical disks, SMART, wipe/GPT, Directory/LVM storages, ZFS pools, datasets and ZVOLs.

Disk and pool operations use the Proxmox API (they return task UPIDs, visible in the Task Center). ZFS datasets have
no PVE API, so they go through the root-only host helper, which re-validates every argument.
"""
import re
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import host
from .auth import require_user
from .pve import DATASET_RE, _node, pve
from .telemetry import smart_temp

router = APIRouter(prefix="/api/pve", tags=["storage-admin"], dependencies=[Depends(require_user)])

DEV_RE = r"^/dev/[A-Za-z0-9][A-Za-z0-9/_.:-]*$"
POOL_RE = r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$"
STORAGE_RE = r"^[a-z][a-z0-9_.-]{0,38}[a-z0-9]$"
# Only datasets below a pool root; pools themselves are created/destroyed through the PVE API.
CHILD_DATASET_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*/[A-Za-z0-9_.:/-]*[A-Za-z0-9_.:-]$"
SIZE_RE = r"^[0-9]+[KMGTP]?$"


def _dev(d: str) -> str:
    if ".." in d or not re.fullmatch(DEV_RE, d):
        raise HTTPException(422, "Invalid device path")
    return d


# ---------------------------------------------------------------- Physical disks


def bus_type(d: dict) -> str:
    path, kind = d.get("devpath", ""), (d.get("type") or "").lower()
    if "nvme" in path or kind == "nvme":
        return "NVMe"
    if kind == "usb":
        return "USB"
    return "SAS" if "sas" in (d.get("by_id_link") or "").lower() else "SATA"


@router.get("/disks")
async def disks():
    items = await pve("GET", _node("/disks/list")) or []
    return [{
        "devpath": d.get("devpath"), "by_id": d.get("by_id_link") or "", "model": d.get("model") or "",
        "serial": d.get("serial") or "", "vendor": (d.get("vendor") or "").strip(), "size": d.get("size") or 0,
        "type": d.get("type") or "", "bus": bus_type(d), "rpm": d.get("rpm"),
        # PVE "used": partitions / LVM / ZFS / mounted / etc. Empty means the disk is free to use.
        "used": d.get("used") or "", "gpt": bool(d.get("gpt")), "health": d.get("health") or "UNKNOWN",
        # PVE wearout = % of rated life remaining; "N/A" for spinning disks.
        "wearout": d.get("wearout") if isinstance(d.get("wearout"), int) else None,
    } for d in items]


def _attr_raw(attrs: list[dict], *names: str) -> int | None:
    for a in attrs:
        if a.get("name") in names:
            m = re.match(r"\d+", str(a.get("raw", "")).strip())
            if m:
                return int(m.group())
    return None


WEAR_ATTRS = ("Media_Wearout_Indicator", "Wear_Leveling_Count", "Percent_Lifetime_Remain", "SSD_Life_Left")


def parse_smart(s: dict) -> dict:
    """Normalize a PVE /disks/smart result (ATA attribute table or NVMe/SAS text) into a summary + attribute list."""
    attrs = s.get("attributes") or []
    text = s.get("text") or ""
    fields = {k.strip(): v.strip() for k, v in re.findall(r"^([A-Za-z][^:\n]{1,60}):\s+(.+)$", text, re.M)}
    num = lambda k: int(re.sub(r"[^\d]", "", fields[k]) or 0) if k in fields else None  # noqa: E731
    used_pct = num("Percentage Used")
    # ATA wear attributes: the normalized value counts down from 100 (% of rated life remaining).
    wear = next((a.get("value") for a in attrs if a.get("name") in WEAR_ATTRS), None)
    return {
        "health": s.get("health") or "UNKNOWN",
        "type": s.get("type") or ("ata" if attrs else "text"),
        "temperature_c": smart_temp(s),
        "power_on_hours": _attr_raw(attrs, "Power_On_Hours") if attrs else num("Power On Hours"),
        "unsafe_shutdowns": _attr_raw(attrs, "Unexpect_Power_Loss_Ct", "Unsafe_Shutdown_Count",
                                      "Power-Off_Retract_Count") if attrs else num("Unsafe Shutdowns"),
        "media_errors": _attr_raw(attrs, "Reallocated_Sector_Ct") if attrs else num("Media and Data Integrity Errors"),
        # % of rated life used: NVMe reports it directly; for ATA, normalized wear values count down from 100.
        "wearout_used_pct": used_pct if used_pct is not None else (100 - int(wear) if str(wear).isdigit() else None),
        "attributes": [{k: a.get(k) for k in ("id", "name", "value", "worst", "threshold", "raw", "flags", "fail")}
                       for a in attrs] or [{"name": k, "raw": v} for k, v in fields.items()],
        "text": text,
    }


@router.get("/disks/{disk:path}/smart")
async def disk_smart(disk: str):
    """Accepts "sda", "dev/sda" or "/dev/sda" (also URL-encoded)."""
    path = disk if disk.startswith("/dev/") else f"/dev/{disk.removeprefix('dev/').lstrip('/')}"
    return parse_smart(await pve("GET", _node(f"/disks/smart?disk={quote(_dev(path), safe='')}")) or {})


class DeviceConfirm(BaseModel):
    disk: str = Field(max_length=200)
    confirm_device: str = Field(max_length=200)


@router.post("/disks/wipe")
async def disk_wipe(body: DeviceConfirm):
    if body.confirm_device != body.disk:
        raise HTTPException(400, "Confirmation does not match the device path")
    return {"task": await pve("PUT", _node("/disks/wipedisk"), data={"disk": _dev(body.disk)})}


class DeviceBody(BaseModel):
    disk: str = Field(max_length=200)


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


# ---------------------------------------------------------------- ZFS pools


class PoolBody(BaseModel):
    name: str = Field(pattern=POOL_RE)
    raidlevel: Literal["single", "mirror", "raid10", "raidz", "raidz2", "raidz3"]
    devices: list[str] = Field(min_length=1, max_length=64)
    ashift: int = Field(12, ge=9, le=16)
    compression: Literal["lz4", "zstd", "on", "off"] = "lz4"
    add_storage: bool = True


MIN_DEVICES = {"single": 1, "mirror": 2, "raid10": 4, "raidz": 3, "raidz2": 4, "raidz3": 5}


@router.post("/zfs/pools")
async def pool_create(body: PoolBody):
    devs = [_dev(d) for d in body.devices]
    if len(set(devs)) != len(devs):
        raise HTTPException(400, "Duplicate device")
    if len(devs) < MIN_DEVICES[body.raidlevel] or (body.raidlevel == "single" and len(devs) != 1) \
            or (body.raidlevel == "raid10" and len(devs) % 2):
        raise HTTPException(400, f"{body.raidlevel} needs {MIN_DEVICES[body.raidlevel]}"
                                 f"{'' if body.raidlevel == 'single' else '+'} devices"
                                 f"{' (an even number)' if body.raidlevel == 'raid10' else ''}")
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


@router.post("/zfs/pools/{name}/scrub")
async def pool_scrub(name: str):
    if not re.fullmatch(POOL_RE, name):
        raise HTTPException(422, "Invalid pool name")
    await host.run(["zpool-scrub", name])
    return {"ok": True}


# ---------------------------------------------------------------- ZFS datasets & volumes

DATASET_COLS = ("name", "type", "used", "available", "refer", "mountpoint", "compression", "recordsize", "quota",
                "atime", "volsize")


def parse_datasets(out: str) -> list[dict]:
    items = []
    for line in out.splitlines():
        cols = line.split("\t")
        if len(cols) != len(DATASET_COLS):
            continue
        d = dict(zip(DATASET_COLS, cols))
        for k in ("used", "available", "refer", "quota", "volsize"):
            d[k] = int(d[k]) if d[k].isdigit() else 0
        d["pool"] = d["name"].split("/", 1)[0]
        # PVE guest disks (vm-100-disk-0, subvol-101-disk-0) are managed by Compute Manager.
        d["guest_volume"] = bool(re.search(r"/(vm|base|subvol|basevol)-\d+-", d["name"]))
        items.append(d)
    return items


@router.get("/zfs/datasets")
async def datasets():
    return parse_datasets(await host.run(["zfs-datasets"]))


Compression = Literal["on", "off", "lz4", "zstd", "gzip", "zle"]
RecordSize = Literal["4K", "8K", "16K", "32K", "64K", "128K", "256K", "512K", "1M"]


class DatasetProps(BaseModel):
    compression: Compression | None = None
    recordsize: RecordSize | None = None
    quota: str | None = Field(None, pattern=r"^(none|[0-9]+[KMGTP]?)$")
    atime: Literal["on", "off"] | None = None
    mountpoint: str | None = Field(None, pattern=r"^(none|legacy|/[A-Za-z0-9_./-]*)$", max_length=200)

    def args(self) -> list[str]:
        props = self.model_dump(include=set(DatasetProps.model_fields), exclude_none=True)
        return [f"{k}={v}" for k, v in props.items()]


class DatasetCreate(DatasetProps):
    name: str = Field(pattern=CHILD_DATASET_RE, max_length=200)
    kind: Literal["filesystem", "volume"] = "filesystem"
    volsize: str | None = Field(None, pattern=SIZE_RE)
    auto_mount: bool = True  # map into /mnt/storage (File Station, SMB shares)


@router.post("/zfs/datasets")
async def dataset_create(body: DatasetCreate):
    props = body.args()
    if body.kind == "volume":
        if not body.volsize:
            raise HTTPException(400, "A ZVOL needs a volsize")
        props = [f"volsize={body.volsize}", *[p for p in props if not p.startswith(("recordsize=", "mountpoint=",
                                                                                     "atime="))]]
    await host.run(["zfs-create", body.name, *props])
    mapped = body.kind == "filesystem" and body.auto_mount
    if mapped:
        await host.run(["storage-map", body.name], timeout=600)
    return {"ok": True, "name": body.name, "path": f"/{body.name}" if mapped else None}


class DatasetPatch(DatasetProps):
    name: str = Field(pattern=DATASET_RE, max_length=200)


@router.patch("/zfs/datasets")
async def dataset_update(body: DatasetPatch):
    props = body.args()
    if not props:
        raise HTTPException(400, "Nothing to change")
    await host.run(["zfs-set", body.name, *props])
    return {"ok": True}


@router.post("/zfs/datasets/map")
async def dataset_map(name: str = Query(pattern=DATASET_RE, max_length=200)):
    """Bind-mount an existing dataset into the ProxmoxOS container under /mnt/storage/<dataset>."""
    return {"ok": True, "output": await host.run(["storage-map", name], timeout=600), "path": f"/{name}"}


@router.delete("/zfs/datasets")
async def dataset_destroy(name: str = Query(pattern=CHILD_DATASET_RE, max_length=200),
                          confirm: str = Query(max_length=200), recursive: bool = False):
    if confirm != name:
        raise HTTPException(400, "Confirmation does not match the dataset name")
    await host.run(["zfs-destroy-dataset", name, *(["recursive"] if recursive else [])], timeout=600)
    return {"ok": True}
