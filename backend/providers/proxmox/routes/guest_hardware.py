"""Proxmox guest hardware routes: device passthrough (PCI/GPU/USB), NICs, cloud-init, snapshots and options.

hostpciN / usbN are root-only in PVE and go through `qm set` over the SSH bridge; everything else uses the API token.
"""
import asyncio
import re
from contextlib import suppress
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path

from app import pci
from app.auth import require_user
from app.guest_hardware import (LXC_OPTS, QEMU_OPTS, VMID, CdromBody, CloudInitBody, GuestType, NetBody, OptionsBody,
                                SnapshotBody, SNAP_RE, cdrom_iso, cloudinit_view, list_devices)
from app.provisioning import PciPassthrough, UsbPassthrough

from ..api import _node, pve
from .provisioning import hostpci_value, qm_set, usb_value

router = APIRouter(prefix="/api/v1/guests", tags=["guest_hardware"], dependencies=[Depends(require_user)])


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


def net_value(guest_type: str, idx: int, b: NetBody) -> str:
    tail = [f"bridge={b.bridge}", f"firewall={int(b.firewall)}", *([f"tag={b.tag}"] if b.tag else []),
            *([f"trunks={b.trunks}"] if b.trunks else []), *([f"rate={b.rate:g}"] if b.rate else []),
            *(["link_down=1"] if b.link_down else [])]
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
