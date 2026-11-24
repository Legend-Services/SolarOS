"""Full storage administration: physical disks, SMART, wipe/GPT, Directory/LVM storages, ZFS pools, datasets and ZVOLs.

Disk and pool operations use the Proxmox API (they return task UPIDs, visible in the Task Center). ZFS datasets have
no PVE API, so they go through the root-only host helper, which re-validates every argument.
"""
import asyncio
import json
import re
import shlex
from contextlib import suppress
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from . import host, host_ssh
from .auth import require_user
from .hardware_admin import split_sections
from .pve import DATASET_RE, _node, pve, zfs_helper
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


# Leaf vdev paths (as stored by ZFS) with their kernel device, plus the rotation rate of spinning disks.
DISK_PROBE = r"""echo @@zpool@@; zpool status -P 2>/dev/null
echo @@links@@; for p in $(zpool status -P 2>/dev/null | awk '$1 ~ "^/dev/" {print $1}'); do echo "$p $(readlink -f "$p")"; done
echo @@rpm@@; for d in /sys/block/sd*; do [ "$(cat "$d/queue/rotational" 2>/dev/null)" = 1 ] && echo "${d##*/} $(smartctl -i "/dev/${d##*/}" 2>/dev/null | sed -n 's/^Rotation Rate: *//p')"; done; true"""


def _count(v: str) -> int:
    m = re.fullmatch(r"([\d.]+)([KMGT]?)", v)
    return int(float(m.group(1)) * 1000 ** " KMGT".index(m.group(2) or " ")) if m else 0


def parse_zpool_status(out: str) -> dict[str, list[dict]]:
    """`zpool status -P` → {pool: rows}. Rows keep the tree as depth + parent; group is data/logs/cache/spares/…"""
    pools: dict[str, list[dict]] = {}
    rows, pool, in_cfg, stack, group = None, "", False, [], "data"
    for line in out.splitlines():
        if m := re.match(r"\s*pool:\s*(\S+)", line):
            pool, in_cfg, stack, group = m.group(1), False, [], "data"
            rows = pools.setdefault(pool, [])
        elif rows is None:
            continue
        elif re.match(r"\s*NAME\s+STATE", line):
            in_cfg = True
        elif re.match(r"\s*errors:", line):
            in_cfg = False
        elif in_cfg and line.strip():
            body = line.lstrip("\t")
            depth = (len(body) - len(body.lstrip(" "))) // 2
            cols = body.split()
            if depth == 0 and cols[0] != pool:  # "logs", "cache", "spares", "special" headers
                group = cols[0]
            del stack[depth:]
            stack.append(cols[0])
            rows.append({"name": cols[0], "state": cols[1] if len(cols) > 1 else "", "depth": depth, "group": group,
                         "parent": stack[depth - 1] if depth else None,
                         "read": _count(cols[2]) if len(cols) > 2 else 0, "write": _count(cols[3]) if len(cols) > 3 else 0,
                         "cksum": _count(cols[4]) if len(cols) > 4 else 0, "msg": " ".join(cols[5:])})
    return pools


def base_disk(path: str) -> str:
    """/dev/nvme0n1p3 → /dev/nvme0n1, /dev/sda1 → /dev/sda (whole-disk paths are returned unchanged)."""
    m = re.match(r"^(/dev/(?:nvme\d+n\d+|mmcblk\d+))p\d+$", path) or re.match(r"^(/dev/[a-z]+)\d+$", path)
    return m.group(1) if m else path


def zfs_members(pools: dict[str, list[dict]], links: dict[str, str]) -> dict[str, dict]:
    """Kernel disk (/dev/sda) → its ZFS membership. `member_device` is the vdev path ZFS knows it by."""
    out: dict[str, dict] = {}
    for pool, rows in pools.items():
        for r in rows:
            if not r["name"].startswith("/dev/"):
                continue
            disk = base_disk(links.get(r["name"], r["name"]))
            parent = r["parent"] if r["parent"] != pool else None
            out.setdefault(disk, {"pool_name": pool, "vdev_name": parent or pool, "member_device": r["name"],
                                  "member_state": r["state"], "read_errors": r["read"], "write_errors": r["write"],
                                  "cksum_errors": r["cksum"]})
    return out


def parse_rpm(text: str) -> int | None:
    m = re.search(r"(\d+)\s*rpm", text, re.I)
    return int(m.group(1)) if m else None


def normalize_disk(d: dict, member: dict | None, probed_rpm: int | None) -> dict:
    pve_rpm = d.get("rpm") if isinstance(d.get("rpm"), int) else 0
    # PVE: rpm 0 = solid state (also USB flash), -1 = spinning at an unknown speed, >0 = known speed.
    rotational = pve_rpm != 0 or d.get("type") == "hdd"
    rpm = pve_rpm if pve_rpm > 0 else probed_rpm if rotational else None
    wear = d.get("wearout")
    return {
        "devpath": d.get("devpath"), "by_id": d.get("by_id_link") or "", "model": d.get("model") or "",
        "serial": d.get("serial") or "", "vendor": (d.get("vendor") or "").strip(), "size": d.get("size") or 0,
        "type": d.get("type") or "", "bus": bus_type(d), "rotational": rotational, "rpm": rpm,
        "rpm_label": (f"{rpm} RPM" if rpm else "HDD") if rotational else "Flash (USB)" if bus_type(d) == "USB" else "SSD / NVMe",
        # PVE "used": partitions / LVM / ZFS / mounted / etc. Empty means the disk is free to use.
        "used": d.get("used") or "", "gpt": bool(d.get("gpt")), "health": d.get("health") or "UNKNOWN",
        # PVE wearout = % of rated life remaining; "N/A" (or -1) for spinning disks.
        "wearout_pct": wear if isinstance(wear, int) and wear >= 0 and not rotational else None,
        **(member or {"pool_name": None, "vdev_name": None, "member_device": None, "member_state": None,
                      "read_errors": None, "write_errors": None, "cksum_errors": None}),
    }


async def probe_host_disks() -> tuple[dict[str, dict], dict[str, int | None]]:
    """(ZFS membership by kernel disk, rpm by kernel name). Empty when the SSH bridge is down; the list still works."""
    try:
        s = split_sections(await host_ssh.run(DISK_PROBE, timeout=40, check=False))
    except HTTPException:
        return {}, {}
    links = dict(x.split(" ", 1) for x in s.get("links", "").splitlines() if " " in x)
    rpms = {n: parse_rpm(r) for n, _, r in (x.partition(" ") for x in s.get("rpm", "").splitlines())}
    return zfs_members(parse_zpool_status(s.get("zpool", "")), links), rpms


@router.get("/disks")
async def disks():
    items, (members, rpms) = await asyncio.gather(pve("GET", _node("/disks/list")), probe_host_disks())
    return [normalize_disk(d, members.get(d.get("devpath")), rpms.get((d.get("devpath") or "").removeprefix("/dev/")))
            for d in items or []]


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
    return parse_datasets(await zfs_helper("zfs-datasets") or "")  # [] on hosts without ZFS


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
    """Bind-mount an existing dataset into the SolarDeck container under /mnt/storage/<dataset>."""
    return {"ok": True, "output": await host.run(["storage-map", name], timeout=600), "path": f"/{name}"}


@router.delete("/zfs/datasets")
async def dataset_destroy(name: str = Query(pattern=CHILD_DATASET_RE, max_length=200),
                          confirm: str = Query(max_length=200), recursive: bool = False):
    if confirm != name:
        raise HTTPException(400, "Confirmation does not match the dataset name")
    await host.run(["zfs-destroy-dataset", name, *(["recursive"] if recursive else [])], timeout=600)
    return {"ok": True}


# ---------------------------------------------------------------- ZFS member control (offline / online / replace / detach)

MEMBER_RE = r"^[A-Za-z0-9/][A-Za-z0-9/_.:-]{0,250}$"
# How many failed children each redundant vdev type survives (mirror/replacing/spare: all but one).
PARITY = {"raidz": 1, "raidz1": 1, "raidz2": 2, "raidz3": 3}


def vdev_kind(name: str) -> str:
    return re.sub(r"-\d+$", "", name)


def find_member(rows: list[dict], device: str, links: dict[str, str]) -> dict | None:
    """Match a leaf vdev by the path ZFS stores, its short name, the kernel device it points at, or, for a pulled disk
    that `zpool status` lists by GUID ("1234… UNAVAIL was /dev/…"), the GUID or the old path."""
    parents = {r["parent"] for r in rows}
    for r in rows:
        n = r["name"]
        if r["depth"] == 0 or n in parents or r["state"] == "":
            continue
        was = r["msg"].removeprefix("was ") if r["msg"].startswith("was ") else None
        if device in (n, n.rsplit("/", 1)[-1], links.get(n), links.get(n, "").removeprefix("/dev/"), was):
            return r
    return None


def offline_problem(rows: list[dict], pool: str, member: dict) -> str | None:
    """Why taking `member` offline would fault the pool, or None when the vdev keeps enough redundancy."""
    if member["group"] != "data":
        return None  # cache / log / spare devices: ZFS itself decides
    parent = member["parent"]
    if parent == pool:
        return f"{member['name']} is a top-level disk with no redundancy; taking it offline would fault {pool}."
    siblings = [r for r in rows if r["parent"] == parent]
    kind = vdev_kind(parent)
    tolerated = PARITY.get(kind, len(siblings) - 1 if kind in ("mirror", "replacing", "spare") else 0)
    failed = sum(1 for r in siblings if r is not member and r["state"] != "ONLINE")
    if failed + 1 > tolerated:
        return (f"{parent} can lose {tolerated} disk(s) and {failed} already {'is' if failed == 1 else 'are'} not ONLINE; "
                f"taking {member['name']} offline would fault the pool.")
    return None


def _links(text: str) -> dict[str, str]:
    return dict(x.split(" ", 1) for x in text.splitlines() if " " in x)


async def _pool_rows(pool: str) -> tuple[list[dict], dict[str, str]]:
    if not re.fullmatch(POOL_RE, pool):
        raise HTTPException(422, "Invalid pool name")
    q = shlex.quote(pool)
    s = split_sections(await host_ssh.run(
        f"echo @@zpool@@; zpool status -P {q}; echo @@links@@; "
        f"for p in $(zpool status -P {q} | awk '$1 ~ \"^/dev/\" {{print $1}}'); do echo \"$p $(readlink -f \"$p\")\"; done"))
    rows = parse_zpool_status(s.get("zpool", "")).get(pool)
    if not rows:
        raise HTTPException(404, f"Pool {pool} not found")
    return rows, _links(s.get("links", ""))


async def _member(pool: str, device: str) -> tuple[list[dict], dict[str, str], dict]:
    if ".." in device or not re.fullmatch(MEMBER_RE, device):
        raise HTTPException(422, "Invalid device")
    rows, links = await _pool_rows(pool)
    m = find_member(rows, device, links)
    if not m:
        raise HTTPException(404, f"{device} is not a member of {pool}")
    return rows, links, m


class MemberBody(BaseModel):
    device: str = Field(max_length=250)
    temporary: bool = False  # offline -t: back online after the next reboot
    expand: bool = False  # online -e: grow onto a larger replacement disk


@router.post("/zfs/pools/{pool}/members/offline")
async def member_offline(pool: str, body: MemberBody):
    rows, _, m = await _member(pool, body.device)
    if problem := offline_problem(rows, pool, m):
        raise HTTPException(409, problem)
    await host_ssh.run(f"zpool offline {'-t ' if body.temporary else ''}{shlex.quote(pool)} {shlex.quote(m['name'])}")
    return {"ok": True}


@router.post("/zfs/pools/{pool}/members/online")
async def member_online(pool: str, body: MemberBody):
    _, _, m = await _member(pool, body.device)
    await host_ssh.run(f"zpool online {'-e ' if body.expand else ''}{shlex.quote(pool)} {shlex.quote(m['name'])}")
    return {"ok": True}


@router.post("/zfs/pools/{pool}/members/detach")
async def member_detach(pool: str, body: MemberBody):
    _, _, m = await _member(pool, body.device)
    if vdev_kind(m["parent"] or "") not in ("mirror", "replacing", "spare"):
        raise HTTPException(409, "Only members of a mirror (or of a running replacement) can be detached")
    await host_ssh.run(f"zpool detach {shlex.quote(pool)} {shlex.quote(m['name'])}")
    return {"ok": True}


def partition_number(path: str) -> str | None:
    """Partition path → its number (/dev/nvme0n1p3 → 3, /dev/sda2 → 2, by-id …-part3 → 3); None for whole disks."""
    if m := re.search(r"-part(\d+)$", path):
        return m.group(1)
    return path[len(base_disk(path)):].lstrip("p") or None if base_disk(path) != path else None


def partition_path(disk: str, number: str) -> str:
    """Partition N of a whole-disk path: by-id → -partN, nvme0n1 → nvme0n1pN, sda → sdaN."""
    if disk.startswith("/dev/disk/"):
        return f"{disk}-part{number}"
    return f"{disk}p{number}" if re.search(r"\d$", disk) else f"{disk}{number}"


class ReplaceBody(BaseModel):
    old_device: str = Field(max_length=250)
    new_device: str = Field(max_length=200)
    confirm_device: str = Field(max_length=200)
    # Copy the old disk's partition table onto the new disk (boot mirrors) and replace partition-for-partition.
    partition_match: bool = False


@router.post("/zfs/pools/{pool}/members/replace")
async def member_replace(pool: str, body: ReplaceBody):
    if body.confirm_device != body.new_device:
        raise HTTPException(400, "Confirmation does not match the new device path")
    new = _dev(body.new_device)
    rows, links, m = await _member(pool, body.old_device)
    real_new = (await host_ssh.run(f"readlink -f {shlex.quote(new)}")).strip()
    members, _ = await probe_host_disks()
    if base_disk(real_new) in members:
        raise HTTPException(409, f"{new} already belongs to pool {members[base_disk(real_new)]['pool_name']}")
    target = new
    if body.partition_match:
        # A pulled disk is listed by GUID with "was <path>"; its partition number comes from that path.
        old_path = links.get(m["name"]) or (m["msg"].removeprefix("was ") if m["msg"].startswith("was ") else m["name"])
        number = partition_number(old_path)
        if not number:
            raise HTTPException(400, "The old member is a whole disk; replace it with a whole disk instead")
        if base_disk(real_new) != real_new:
            raise HTTPException(400, "Partition matching needs the new device to be a whole disk")
        # Copy the layout from a healthy sibling: the old disk may be dead or already removed.
        src = next((base_disk(links[r["name"]]) for r in rows if r["parent"] == m["parent"] and r is not m
                    and r["state"] == "ONLINE" and r["name"] in links), None)
        if not src:
            raise HTTPException(409, "No ONLINE disk in this vdev to copy the partition layout from")
        # sgdisk -R copies the GPT, -G gives the copy new GUIDs so both disks can coexist.
        await host_ssh.run(f"sgdisk {shlex.quote(src)} -R {shlex.quote(real_new)} && "
                           f"sgdisk -G {shlex.quote(real_new)} && udevadm settle")
        target = partition_path(new, number)
    await host_ssh.run(f"zpool replace {shlex.quote(pool)} {shlex.quote(m['name'])} {shlex.quote(target)}", timeout=300)
    return {"ok": True, "new_member": target}


# ---------------------------------------------------------------- Per-disk tuning (hdparm / nvme-cli / smartctl)

RULES_FILE = "/etc/udev/rules.d/69-proxmoxos-disk-tuning.rules"


def _resolve(disk: str) -> str:
    """Accepts "sda", "dev/sda" or "/dev/sda" (also URL-encoded)."""
    return _dev(disk if disk.startswith("/dev/") else f"/dev/{disk.removeprefix('dev/').lstrip('/')}")


def spindown_value(minutes: int) -> int:
    """hdparm -S encoding: 1..240 = multiples of 5 s, 241..251 = multiples of 30 min."""
    return minutes * 12 if minutes <= 20 else 240 + minutes // 30


async def ensure_tool(cmd: str, package: str) -> None:
    """Install a Debian package on the host the first time one of its commands is needed."""
    await host_ssh.run(f"command -v {cmd} >/dev/null || {{ apt-get update -qq && DEBIAN_FRONTEND=noninteractive "
                       f"apt-get install -y -qq {package} >/dev/null; }}", timeout=600)


def parse_rules(text: str) -> dict[str, dict]:
    """Persisted tuning: each disk is a `# solardeck {json}` comment (legacy `# proxmoxos` still read) followed by its udev rule."""
    out = {}
    for line in text.splitlines():
        if line.startswith(("# solardeck ", "# proxmoxos ")):
            with suppress(ValueError, KeyError, TypeError):
                d = json.loads(line.split(" ", 2)[2])
                out[d["by_id"]] = d
    return out


def render_rules(entries: dict[str, dict]) -> str:
    lines = ["# Managed by SolarDeck (Storage Manager > Disks > Tune). Re-applies drive settings at boot and hotplug.", ""]
    for by_id, e in sorted(entries.items()):
        # DEVLINKS is a space-separated list; match the exact by-id link in any position.
        match = (f'ACTION=="add", SUBSYSTEM=="block", ENV{{DEVTYPE}}=="disk", '
                 f'ENV{{DEVLINKS}}=="{by_id}|{by_id} *|* {by_id}|* {by_id} *"')
        args = []
        if e.get("apm_level") is not None:
            args.append(f"-B {255 if e['apm_level'] == 'disabled' else int(e['apm_level'])}")
        if e.get("spindown_minutes") is not None:
            args.append(f"-S {spindown_value(int(e['spindown_minutes']))}")
        if e.get("write_cache") is not None:
            args.append(f"-W {int(e['write_cache'])}")
        runs = [f'RUN+="/usr/sbin/hdparm {" ".join(args)} /dev/%k"'] if args else []
        if e.get("power_state") is not None:
            runs.append(f'RUN+="/usr/sbin/nvme set-feature /dev/%k -f 2 -v {int(e["power_state"])}"')
        if runs:
            lines += [f"# solardeck {json.dumps(e, sort_keys=True)}", f"{match}, {', '.join(runs)}", ""]
    return "\n".join(lines)


def parse_settings(bus: str, rotational: bool, s: dict[str, str], persisted: dict | None, by_id: str) -> dict:
    """Probe sections (smartctl JSON, hdparm -B / -W, nvme get-feature) → current values + per-control support."""
    try:
        smart = json.loads(s.get("smart") or "{}")
    except ValueError:
        smart = {}
    nvme, ata = bus == "NVMe", bus in ("SATA", "SAS", "USB")
    apm = re.search(r"APM_level\s*=\s*(\d+|off|not supported)", s.get("apm", ""))
    wc = re.search(r"write-caching\s*=\s*(\d)", s.get("wcache", ""))
    ps = re.search(r"Current value:\s*(0x[0-9a-fA-F]+)", s.get("ps", ""))
    states = [{"id": i, "max_power_w": round(p["max_power"]["value"] / p["max_power"]["units_per_watt"], 4),
               "operational": not p.get("non_operational_state"), "entry_latency_us": p.get("entry_latency_us"),
               "exit_latency_us": p.get("exit_latency_us")} for i, p in enumerate(smart.get("nvme_power_states") or [])
              if isinstance(p.get("max_power"), dict) and p["max_power"].get("units_per_watt")]
    smart_on = (smart.get("smart_support") or {}).get("enabled")
    apm_ok = bool(apm) and apm.group(1) != "not supported"

    def cap(ok: bool, why: str) -> dict:
        return {"supported": ok, "reason": None if ok else why}

    no_ata = "NVMe drives use power states instead of ATA power management." if nvme else "Not an ATA drive."
    return {
        "bus": bus, "rotational": rotational, "by_id": by_id or None, "persist_supported": bool(by_id),
        "values": {
            "apm_level": None if not apm_ok else "disabled" if apm.group(1) == "off" else int(apm.group(1)),
            "spindown_minutes": (persisted or {}).get("spindown_minutes"),
            "write_cache": bool(int(wc.group(1))) if wc else None,
            "power_state": int(ps.group(1), 16) & 0x1F if ps else None,
            "smart_enabled": True if nvme else smart_on,
        },
        "power_states": states,
        "nvme_cli_installed": "nvme" not in s.get("missing", ""),
        "capabilities": {
            "apm_level": cap(ata and apm_ok, no_ata if not ata
                             else "The drive (or its USB bridge) does not support Advanced Power Management."),
            "spindown_minutes": cap(ata and rotational and bus != "USB",
                                    no_ata if not ata else "Only spinning SATA/SAS disks spin down." if not rotational
                                    else "Most USB bridges ignore ATA standby timers."),
            "write_cache": cap(ata and bool(wc), no_ata if not ata
                               else "The drive (or its USB bridge) does not report its write cache."),
            "power_state": cap(nvme and bool(states), "Only NVMe drives have selectable power states." if not nvme
                               else "The drive does not list any power states."),
            "smart_enabled": cap(not nvme and smart_on is not None,
                                 "NVMe drives always report SMART health; it cannot be switched off." if nvme
                                 else "The drive (or its USB bridge) does not expose SMART."),
        },
    }


async def disk_info(path: str) -> dict:
    d = next((x for x in await pve("GET", _node("/disks/list")) or [] if x.get("devpath") == path), None)
    if not d:
        raise HTTPException(404, f"{path} is not a physical disk on this node")
    return normalize_disk(d, None, None)


async def read_settings(path: str) -> dict:
    disk = await disk_info(path)
    q = shlex.quote(path)
    if disk["bus"] == "NVMe":
        probe = (f"echo @@smart@@; smartctl -j -i -c {q}; echo @@ps@@; nvme get-feature {q} -f 2 2>&1; "
                 "echo @@missing@@; command -v nvme >/dev/null || echo nvme")
    else:
        probe = f"echo @@smart@@; smartctl -j -i {q}; echo @@apm@@; hdparm -B {q} 2>&1; echo @@wcache@@; hdparm -W {q} 2>&1"
    s = split_sections(await host_ssh.run(f"{probe}; echo @@rules@@; cat {RULES_FILE} 2>/dev/null; true", check=False))
    persisted = parse_rules(s.get("rules", "")).get(disk["by_id"])
    return {"device": path, **parse_settings(disk["bus"], disk["rotational"], s, persisted, disk["by_id"])}


@router.get("/disks/{disk:path}/settings")
async def disk_settings(disk: str):
    return await read_settings(_resolve(disk))


class DiskSettings(BaseModel):
    apm_level: int | Literal["disabled"] | None = None
    spindown_minutes: Literal[0, 5, 10, 20, 30, 60, 120] | None = None
    write_cache: bool | None = None
    power_state: int | None = Field(None, ge=0, le=31)
    smart_enabled: bool | None = None
    persist: bool = True  # re-apply at boot / hotplug via the udev rules file


@router.put("/disks/{disk:path}/settings")
async def disk_settings_update(disk: str, body: DiskSettings):
    path = _resolve(disk)
    if isinstance(body.apm_level, int) and not 1 <= body.apm_level <= 254:
        raise HTTPException(422, "APM level must be 1..254 or 'disabled'")
    cur = await read_settings(path)
    caps, q = cur["capabilities"], shlex.quote(path)
    changes = body.model_dump(exclude_none=True, exclude={"persist"})
    for k in changes:
        if not caps[k]["supported"]:
            raise HTTPException(409, f"{k.replace('_', ' ')}: {caps[k]['reason']}")
    cmds = []
    if "apm_level" in changes:
        cmds.append(f"hdparm -B {255 if body.apm_level == 'disabled' else body.apm_level} {q}")
    if "spindown_minutes" in changes:
        cmds.append(f"hdparm -S {spindown_value(body.spindown_minutes)} {q}")
    if "write_cache" in changes:
        cmds.append(f"hdparm -W {int(body.write_cache)} {q}")
    if "smart_enabled" in changes:
        cmds.append(f"smartctl -s {'on' if body.smart_enabled else 'off'} {q}")
    if "power_state" in changes:
        if body.power_state >= len(cur["power_states"]):
            raise HTTPException(422, f"The drive has {len(cur['power_states'])} power states")
        await ensure_tool("nvme", "nvme-cli")
        cmds.append(f"nvme set-feature {q} -f 2 -v {body.power_state}")
    if not cmds:
        raise HTTPException(400, "Nothing to change")
    await host_ssh.run(" && ".join(cmds))
    persisted = False
    tunable = {k: v for k, v in changes.items() if k != "smart_enabled"}  # SMART on/off is stored on the drive itself
    if body.persist and cur["by_id"] and tunable:
        entries = parse_rules(await host_ssh.read_file(RULES_FILE))
        entries[cur["by_id"]] = {**entries.get(cur["by_id"], {}), **tunable, "by_id": cur["by_id"]}
        await host_ssh.write_file(RULES_FILE, render_rules(entries))
        await host_ssh.run("udevadm control --reload-rules")
        persisted = True
    return {**await read_settings(path), "persisted": persisted}


# ---------------------------------------------------------------- SMART self-tests & read-only surface scan

JOB_LOG = "/var/log/proxmox-os/jobs"
NVME_SHORT_MINUTES = 2  # NVMe short self-tests are capped at 2 minutes by the spec


def _scan_job(path: str) -> str:
    return "scan-" + re.sub(r"[^a-z0-9]+", "-", path.removeprefix("/dev/").lower()).strip("-")[:34]


def parse_selftest(smart: dict, kind: str = "") -> dict:
    """smartctl -j -c -l selftest (ATA or NVMe) → running test, progress, ETA and history. `kind` = last started test."""
    if "nvme_self_test_log" in smart:
        log = smart["nvme_self_test_log"]
        op = log.get("current_self_test_operation") or {}
        running = bool(op.get("value"))
        done = log.get("current_self_test_completion_percent") if running else None
        history = [{"type": (e.get("self_test_code") or {}).get("string", ""),
                    "status": (e.get("self_test_result") or {}).get("string", ""),
                    "passed": (e.get("self_test_result") or {}).get("value") == 0,
                    "lifetime_hours": e.get("power_on_hours"), "failing_lba": e.get("lba")}
                   for e in log.get("table") or []]
        minutes = NVME_SHORT_MINUTES if op.get("value") == 1 else None
        return {"running": running, "test": op.get("string") if running else None, "progress_pct": done,
                "eta_seconds": int(minutes * 60 * (100 - done) / 100) if minutes and done is not None else None,
                "history": history}
    st = (smart.get("ata_smart_data") or {}).get("self_test") or {}
    status = st.get("status") or {}
    running = (status.get("value", 0) >> 4) == 0xF  # 0xF_ = in progress, low nibble = tenths remaining
    rem = status.get("remaining_percent")
    minutes = (st.get("polling_minutes") or {}).get("extended" if kind == "long" else "short")
    history = [{"type": (e.get("type") or {}).get("string", ""), "status": (e.get("status") or {}).get("string", ""),
                "passed": bool((e.get("status") or {}).get("passed")), "lifetime_hours": e.get("lifetime_hours"),
                "failing_lba": e.get("lba")}
               for e in ((smart.get("ata_smart_self_test_log") or {}).get("standard") or {}).get("table") or []]
    return {"running": running, "test": ({"long": "Extended", "short": "Short"}.get(kind, "SMART") + " self-test") if running else None,
            "progress_pct": 100 - rem if running and rem is not None else None,
            "eta_seconds": int(minutes * 60 * rem / 100) if running and rem is not None and minutes else None,
            "history": history}


def parse_badblocks(state: str, tail: str, bad_count: str) -> dict:
    """Surface-scan job state + the last badblocks -s progress line ("12.34% done, 0:10 elapsed. (0/0/0 errors)")."""
    prog = re.findall(r"([\d.]+)% done, ([\d:]+) elapsed\. \((\d+)/(\d+)/(\d+) errors\)", tail)
    code = re.findall(r"proxmox-os: exit (\d+)", tail)
    running = state in ("active", "activating")
    last = prog[-1] if prog else None
    pct = float(last[0]) if last else None
    secs = 0
    for part in (last[1] if last else "0").split(":"):
        secs = secs * 60 + int(part)
    return {"running": running, "progress_pct": pct, "elapsed": last[1] if last else None,
            "eta_seconds": int(secs * (100 - pct) / pct) if running and pct else None,
            "errors": sum(map(int, last[2:])) if last else 0,
            "bad_blocks": int(bad_count) if bad_count.strip().isdigit() else 0,
            "exit_code": int(code[-1]) if code and not running else None}


@router.get("/disks/{disk:path}/scan")
async def disk_scan_status(disk: str):
    path = _resolve(disk)
    job, q = _scan_job(path), shlex.quote(path)
    s = split_sections(await host_ssh.run(
        f"echo @@smart@@; smartctl -j -c -l selftest {q}; echo @@kind@@; cat {JOB_LOG}/{job}.smart 2>/dev/null; "
        f"echo @@state@@; systemctl is-active proxmox-os-job-{job} 2>/dev/null; "
        f"echo @@tail@@; tail -c 700 {JOB_LOG}/{job}.log 2>/dev/null | tr '\\b' '\\n'; "
        f"echo @@bad@@; wc -l < {JOB_LOG}/{job}.bad 2>/dev/null; true", check=False))
    try:
        smart = json.loads(s.get("smart") or "{}")
    except ValueError:
        smart = {}
    return {"device": path, "smart": parse_selftest(smart, s.get("kind", "").strip()),
            "surface": parse_badblocks(s.get("state", "").strip(), s.get("tail", ""), s.get("bad", ""))}


class ScanBody(BaseModel):
    kind: Literal["short", "long", "surface"]


@router.post("/disks/{disk:path}/scan")
async def disk_scan_start(disk: str, body: ScanBody):
    path = _resolve(disk)
    await disk_info(path)
    job, q = _scan_job(path), shlex.quote(path)
    if body.kind == "surface":
        # badblocks without -n/-w only reads: safe on disks in use. Bad block numbers go to <job>.bad.
        await host_ssh.start_job(job, f"mkdir -p {JOB_LOG}; rm -f {JOB_LOG}/{job}.bad\n"
                                      f"badblocks -sv -b 4096 -o {JOB_LOG}/{job}.bad {q}\n")
        return {"ok": True, "job": job}
    out = await host_ssh.run(f"smartctl -t {body.kind} {q}", check=False)
    if not re.search(r"(testing|self-test|test) has begun", out, re.I):
        raise HTTPException(409, next((x for x in reversed(out.splitlines()) if x.strip()), "smartctl refused the test")[:300])
    await host_ssh.run(f"mkdir -p {JOB_LOG} && echo {body.kind} > {JOB_LOG}/{job}.smart")
    return {"ok": True}


@router.delete("/disks/{disk:path}/scan")
async def disk_scan_abort(disk: str):
    path = _resolve(disk)
    await host_ssh.run(f"systemctl stop proxmox-os-job-{_scan_job(path)} 2>/dev/null; smartctl -X {shlex.quote(path)} >/dev/null; true")
    return {"ok": True}
