"""Guest hardware: device passthrough (PCI/GPU/USB), NICs, cloud-init, snapshots and options.

hostpciN / usbN are root-only in PVE and go through `qm set` over the SSH bridge; everything else uses the API token.
"""
import asyncio
import re
from contextlib import suppress
from typing import Annotated, Literal
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, StringConstraints

from . import pci
from .auth import require_user
from .provisioning import BRIDGE_RE, PciPassthrough, UsbPassthrough, hostpci_value, qm_set, usb_value
from .pve import _node, pve

router = APIRouter(prefix="/api/v1/guests", tags=["guest_hardware"], dependencies=[Depends(require_user)])

GuestType = Literal["qemu", "lxc"]
VMID = Annotated[int, Path(ge=100, le=999_999_999)]
SNAP_RE = r"^[A-Za-z][A-Za-z0-9_-]{1,39}$"
MAC_RE = r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$"
IPV4_RE = r"^\d{1,3}(\.\d{1,3}){3}$"
QEMU_MODELS = ("virtio", "e1000", "e1000e", "rtl8139", "vmxnet3")
DEV_KEY_RE = re.compile(r"^(hostpci|usb|net)(\d+)$")
CI_KEYS = ("ciuser", "nameserver", "searchdomain", "citype", "ciupgrade")
QEMU_OPTS = ("name", "onboot", "startup", "protection", "boot", "agent", "ostype", "machine", "bios", "cpu", "numa",
             "hotplug", "tablet")
LXC_OPTS = ("hostname", "onboot", "startup", "protection", "unprivileged", "features")


def parse_props(v: str) -> dict:
    """PVE property string → dict; a bare leading value (e.g. hostpci "01:00") is stored under "_"."""
    out = {}
    for item in str(v).split(","):
        k, eq, val = item.partition("=")
        if item:
            out.update({k: val} if eq else {"_": item})
    return out


def parse_hostpci(v: str) -> dict:
    p = parse_props(v)
    dev = p.get("host") or p.get("_") or ""
    return {"id": dev or p.get("mapping", ""), "mapping": p.get("mapping"), "pcie": p.get("pcie") == "1",
            "rombar": p.get("rombar", "1") != "0", "x_vga": p.get("x-vga") == "1",
            # "01:00" without a function number passes every function of the slot (GPU + HDMI audio).
            "all_functions": bool(dev) and "." not in dev}


def parse_usb(v: str) -> dict:
    p = parse_props(v)
    return {"host": p.get("host") or p.get("mapping", ""), "usb3": p.get("usb3") == "1"}


def parse_net(guest_type: str, v: str) -> dict:
    p = parse_props(v)
    common = {"bridge": p.get("bridge", ""), "tag": int(p["tag"]) if p.get("tag", "").isdigit() else None,
              "firewall": p.get("firewall") == "1", "rate": float(p["rate"]) if p.get("rate") else None}
    if guest_type == "qemu":
        model = next((m for m in QEMU_MODELS if m in p or p.get("_") == m), "virtio")
        return {"model": model, "macaddr": p.get(model) or p.get("macaddr"), "link_down": p.get("link_down") == "1",
                **common}
    return {"name": p.get("name", ""), "macaddr": p.get("hwaddr"), "ip": p.get("ip"), "gw": p.get("gw"),
            "ip6": p.get("ip6"), "gw6": p.get("gw6"), **common}


def list_devices(guest_type: str, cfg: dict) -> dict:
    out: dict[str, list] = {"hostpci": [], "usb": [], "net": []}
    for key, val in cfg.items():
        m = DEV_KEY_RE.match(key)
        if not m:
            continue
        kind, idx = m.group(1), int(m.group(2))
        parsed = parse_hostpci(val) if kind == "hostpci" else parse_usb(val) if kind == "usb" else parse_net(guest_type, val)
        out[kind].append({"key": key, "index": idx, "raw": val, **parsed})
    for v in out.values():
        v.sort(key=lambda d: d["index"])
    return out


def cloudinit_view(cfg: dict) -> dict:
    return {**{k: cfg.get(k) for k in CI_KEYS}, "sshkeys": unquote(cfg.get("sshkeys") or ""),
            "password_set": bool(cfg.get("cipassword")),
            "ipconfig": {k: v for k, v in cfg.items() if re.fullmatch(r"ipconfig[0-7]", k)},
            "drive": next((k for k, v in cfg.items() if isinstance(v, str) and "cloudinit" in v), None)}


def cdrom_iso(cfg: dict) -> str | None:
    """ISO volume in the VM's install drive (ide2, the slot the creation wizard uses), or None when empty."""
    v = parse_props(cfg.get("ide2") or "").get("_", "")
    return v if v and v != "none" and "cloudinit" not in v else None


class CdromBody(BaseModel):
    iso_volume: str | None = Field(None, max_length=500)  # None ejects


@router.put("/qemu/{vmid}/cdrom")
async def set_cdrom(vmid: VMID, body: CdromBody):
    if body.iso_volume and not re.fullmatch(r"[a-z][a-z0-9_.-]*:iso/[^,;\s]+", body.iso_volume):
        raise HTTPException(422, f"Invalid ISO volume {body.iso_volume}")
    await pve("PUT", _node(f"/qemu/{vmid}/config"), data={"ide2": f"{body.iso_volume or 'none'},media=cdrom"})
    return {"ok": True}


async def _config(guest_type: str, vmid: int) -> dict:
    return await pve("GET", _node(f"/{guest_type}/{vmid}/config")) or {}


@router.get("/{guest_type}/{vmid}/hardware")
async def hardware(guest_type: GuestType, vmid: VMID):
    cfg = await _config(guest_type, vmid)
    pending = await pve("GET", _node(f"/{guest_type}/{vmid}/pending")) or []
    opts = QEMU_OPTS if guest_type == "qemu" else LXC_OPTS
    return {"devices": list_devices(guest_type, cfg),
            "cloudinit": cloudinit_view(cfg) if guest_type == "qemu" else None,
            "cdrom": {"iso": cdrom_iso(cfg)} if guest_type == "qemu" else None,
            "options": {k: cfg.get(k) for k in opts},
            "pending": sorted(p["key"] for p in pending if "pending" in p or "delete" in p)}


# ---------------------------------------------------------------- PCI / USB passthrough (QEMU, root via SSH)


@router.put("/qemu/{vmid}/hostpci/{idx}")
async def set_hostpci(vmid: VMID, body: PciPassthrough, idx: int = Path(ge=0, le=15)):
    cfg = await _config("qemu", vmid)
    opts = {f"hostpci{idx}": hostpci_value(body)}
    if body.pcie and "q35" not in str(cfg.get("machine", "")):
        opts["machine"] = "q35"  # pcie=1 needs the q35 chipset
    try:
        dev = next((d for d in (await pci.probe())["devices"] if d["id"] == body.id.removeprefix("0000:")), None)
        warnings = dev["warnings"] if dev else []
    except HTTPException:
        warnings = []  # warn-only probe; the qm set below reports real errors
    await qm_set(vmid, opts)
    return {"ok": True, "value": opts[f"hostpci{idx}"], "warnings": warnings}


@router.delete("/qemu/{vmid}/hostpci/{idx}")
async def delete_hostpci(vmid: VMID, idx: int = Path(ge=0, le=15)):
    await qm_set(vmid, {"delete": f"hostpci{idx}"})
    return {"ok": True}


@router.put("/qemu/{vmid}/usb/{idx}")
async def set_usb(vmid: VMID, body: UsbPassthrough, idx: int = Path(ge=0, le=4)):
    await qm_set(vmid, {f"usb{idx}": usb_value(body)})
    return {"ok": True}


@router.delete("/qemu/{vmid}/usb/{idx}")
async def delete_usb(vmid: VMID, idx: int = Path(ge=0, le=4)):
    await qm_set(vmid, {"delete": f"usb{idx}"})
    return {"ok": True}


# ---------------------------------------------------------------- Network interfaces


class NetBody(BaseModel):
    bridge: str = Field(pattern=BRIDGE_RE)
    tag: int | None = Field(None, ge=1, le=4094)
    firewall: bool = True
    rate: float | None = Field(None, gt=0, le=100_000)  # MB/s
    macaddr: str | None = Field(None, pattern=MAC_RE)
    model: Literal["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"] = "virtio"  # QEMU
    name: str | None = Field(None, pattern=r"^eth\d{1,2}$")  # LXC
    ip: str | None = Field(None, pattern=r"^(dhcp|manual|\d{1,3}(\.\d{1,3}){3}/\d{1,2})$")
    gw: str | None = Field(None, pattern=IPV4_RE)
    ip6: Literal["auto", "dhcp", "manual"] | None = None


def net_value(guest_type: str, idx: int, b: NetBody) -> str:
    tail = [f"bridge={b.bridge}", f"firewall={int(b.firewall)}", *([f"tag={b.tag}"] if b.tag else []),
            *([f"rate={b.rate:g}"] if b.rate else [])]
    if guest_type == "qemu":
        return ",".join([b.model + (f"={b.macaddr}" if b.macaddr else ""), *tail])
    return ",".join([f"name={b.name or f'eth{idx}'}", *tail, *([f"hwaddr={b.macaddr}"] if b.macaddr else []),
                     f"ip={b.ip or 'dhcp'}", *([f"gw={b.gw}"] if b.gw and b.ip not in (None, "dhcp", "manual") else []),
                     *([f"ip6={b.ip6}"] if b.ip6 else [])])


@router.put("/{guest_type}/{vmid}/net/{idx}")
async def set_net(guest_type: GuestType, vmid: VMID, body: NetBody, idx: int = Path(ge=0, le=7)):
    await pve("PUT", _node(f"/{guest_type}/{vmid}/config"), data={f"net{idx}": net_value(guest_type, idx, body)})
    return {"ok": True}


@router.delete("/{guest_type}/{vmid}/net/{idx}")
async def delete_net(guest_type: GuestType, vmid: VMID, idx: int = Path(ge=0, le=7)):
    await pve("PUT", _node(f"/{guest_type}/{vmid}/config"), data={"delete": f"net{idx}"})
    return {"ok": True}


# ---------------------------------------------------------------- Cloud-init (QEMU)

IPCONFIG = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9=,./:]*$", max_length=200)]


class CloudInitBody(BaseModel):
    ciuser: str | None = Field(None, pattern=r"^([a-z_][a-z0-9_-]{0,31})?$")
    cipassword: str | None = Field(None, max_length=128, pattern=r"^[^\r\n]*$")
    sshkeys: str | None = Field(None, max_length=16000)
    nameserver: str | None = Field(None, pattern=r"^[0-9a-fA-F.: ]*$", max_length=200)
    searchdomain: str | None = Field(None, pattern=r"^[A-Za-z0-9. -]*$", max_length=200)
    citype: Literal["nocloud", "configdrive2", "opennebula"] | None = None
    ciupgrade: bool | None = None
    ipconfig: dict[Annotated[str, StringConstraints(pattern=r"^ipconfig[0-7]$")], IPCONFIG] = {}
    add_drive_storage: str | None = Field(None, pattern=r"^[a-z][a-z0-9_.-]*$")


def cloudinit_params(b: CloudInitBody, cfg: dict) -> dict:
    data, deletes = {}, []
    fields = {**b.model_dump(include={"ciuser", "cipassword", "nameserver", "searchdomain", "citype"}), **b.ipconfig}
    if b.sshkeys is not None:
        fields["sshkeys"] = quote(b.sshkeys.strip(), safe="")  # PVE expects the key list URL-encoded
    for k, v in fields.items():
        if v is None or (k == "cipassword" and v == ""):
            continue  # untouched; an empty password field keeps the current one
        if v == "":
            deletes.append(k)
        else:
            data[k] = v
    if b.ciupgrade is not None:
        data["ciupgrade"] = int(b.ciupgrade)
    if b.add_drive_storage and not cloudinit_view(cfg)["drive"]:
        slot = next((s for s in ("ide0", "ide1", "ide3", "sata5") if s not in cfg), None)
        if not slot:
            raise HTTPException(400, "No free IDE/SATA slot for a cloud-init drive")
        data[slot] = f"{b.add_drive_storage}:cloudinit"
    if deletes:
        data["delete"] = ",".join(deletes)
    return data


@router.get("/qemu/{vmid}/cloudinit")
async def get_cloudinit(vmid: VMID):
    return cloudinit_view(await _config("qemu", vmid))


@router.put("/qemu/{vmid}/cloudinit")
async def set_cloudinit(vmid: VMID, body: CloudInitBody):
    data = cloudinit_params(body, await _config("qemu", vmid))
    if data:
        await pve("PUT", _node(f"/qemu/{vmid}/config"), data=data)
    return {"ok": True}


@router.post("/qemu/{vmid}/boot-iso")
async def boot_iso(vmid: VMID):
    """Restart (or start) the VM and press Enter every 0.5 s for 12 s: Windows installers boot from the ISO only
    when a key is pressed within ~5 s, which a console that reconnects after the reset almost always misses."""
    state = (await pve("GET", _node(f"/qemu/{vmid}/status/current")) or {}).get("status")
    await pve("POST", _node(f"/qemu/{vmid}/status/{'reset' if state == 'running' else 'start'}"))
    for _ in range(24):
        await asyncio.sleep(0.5)
        with suppress(HTTPException):
            await pve("PUT", _node(f"/qemu/{vmid}/sendkey"), data={"key": "ret"})
    return {"ok": True}


@router.post("/qemu/{vmid}/cloudinit/regenerate")
async def regenerate_cloudinit(vmid: VMID):
    await pve("PUT", _node(f"/qemu/{vmid}/cloudinit"))
    return {"ok": True}


# ---------------------------------------------------------------- Snapshots


class SnapshotBody(BaseModel):
    name: str = Field(pattern=SNAP_RE)
    description: str = Field("", max_length=1000)
    vmstate: bool = False  # QEMU only: include RAM


@router.get("/{guest_type}/{vmid}/snapshots")
async def snapshots(guest_type: GuestType, vmid: VMID):
    items = await pve("GET", _node(f"/{guest_type}/{vmid}/snapshot")) or []
    return [{"name": s["name"], "description": s.get("description", ""), "parent": s.get("parent"),
             "snaptime": s.get("snaptime"), "vmstate": bool(s.get("vmstate")), "current": s["name"] == "current"}
            for s in items]


@router.post("/{guest_type}/{vmid}/snapshots")
async def create_snapshot(guest_type: GuestType, vmid: VMID, body: SnapshotBody):
    data = {"snapname": body.name, "description": body.description}
    if guest_type == "qemu" and body.vmstate:
        data["vmstate"] = 1
    return {"upid": await pve("POST", _node(f"/{guest_type}/{vmid}/snapshot"), data=data)}


@router.delete("/{guest_type}/{vmid}/snapshots/{name}")
async def delete_snapshot(guest_type: GuestType, vmid: VMID, name: str = Path(pattern=SNAP_RE)):
    return {"upid": await pve("DELETE", _node(f"/{guest_type}/{vmid}/snapshot/{name}"))}


@router.post("/{guest_type}/{vmid}/snapshots/{name}/rollback")
async def rollback_snapshot(guest_type: GuestType, vmid: VMID, name: str = Path(pattern=SNAP_RE)):
    return {"upid": await pve("POST", _node(f"/{guest_type}/{vmid}/snapshot/{name}/rollback"))}


# ---------------------------------------------------------------- Options


class OptionsBody(BaseModel):
    name: str | None = Field(None, pattern=r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$")
    hostname: str | None = Field(None, pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    onboot: bool | None = None
    protection: bool | None = None
    startup: str | None = Field(None, pattern=r"^((order=\d+|up=\d+|down=\d+)(,(order=\d+|up=\d+|down=\d+))*)?$")
    boot: str | None = Field(None, pattern=r"^(order=[a-z0-9;]+)?$")
    agent: bool | None = None
    ostype: Literal["l26", "l24", "win11", "win10", "win8", "win7", "w2k8", "wxp", "solaris", "other"] | None = None
    machine: str | None = Field(None, pattern=r"^(q35|pc|pc-(q35|i440fx)-[0-9.]+(\+pve\d+)?)?$")
    bios: Literal["ovmf", "seabios"] | None = None
    cpu: str | None = Field(None, pattern=r"^[A-Za-z0-9_.-]+$", max_length=60)
    numa: bool | None = None
    hotplug: str | None = Field(None, pattern=r"^(0|1|[a-z]+(,[a-z]+)*)?$")
    tablet: bool | None = None
    features: str | None = Field(None, pattern=r"^([a-z]+=[01](,[a-z]+=[01])*)?$")


def options_params(guest_type: str, b: OptionsBody) -> dict:
    allowed = set(QEMU_OPTS if guest_type == "qemu" else LXC_OPTS) - {"unprivileged"}  # fixed at creation
    given = b.model_dump(exclude_none=True)
    bad = set(given) - allowed
    if bad:
        raise HTTPException(400, f"Not a {guest_type} option: {', '.join(sorted(bad))}")
    data = {k: int(v) if isinstance(v, bool) else v for k, v in given.items() if v != ""}
    deletes = [k for k, v in given.items() if v == ""]
    if deletes:
        data["delete"] = ",".join(deletes)
    return data


@router.patch("/{guest_type}/{vmid}/options")
async def set_options(guest_type: GuestType, vmid: VMID, body: OptionsBody):
    data = options_params(guest_type, body)
    if data:
        await pve("PUT", _node(f"/{guest_type}/{vmid}/config"), data=data)
    return {"ok": True}
