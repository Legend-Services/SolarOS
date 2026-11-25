"""Proxmox guest provisioning: storage content, URL downloads, PCI/USB discovery, VM and LXC creation.

Raw PCI/USB passthrough needs root@pam (the API token cannot set it), so it is applied with `qm set` over the root
SSH bridge; host bind mounts still go through the host helper.
"""
import shlex
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app import host, host_ssh, pci
from app.auth import require_user
from app.provisioning import (CONTENT, GUEST_TAG, VOLID_RE, DownloadBody, LxcBody, PciPassthrough, QemuBody,
                              UsbPassthrough, download_params, pci_category, volume)
from app.storage_admin import STORAGE_RE

from ..api import _node, pve
from .tasks import wait_task

router = APIRouter(prefix="/api/v1", tags=["provisioning"], dependencies=[Depends(require_user)])


@router.get("/storage/{storage}/content")
async def storage_content(storage: str = Path(pattern=STORAGE_RE),
                          content: Literal["iso", "vztmpl", "backup"] | None = None):
    items = await pve("GET", _node(f"/storage/{storage}/content"), params={"content": content} if content else None)
    return sorted((volume(v, storage) for v in items or [] if v.get("content") in CONTENT),
                  key=lambda v: v["ctime"], reverse=True)


@router.post("/storage/{storage}/download-url")
async def download_url(body: DownloadBody, storage: str = Path(pattern=STORAGE_RE)):
    return {"upid": await pve("POST", _node(f"/storage/{storage}/download-url"), data=download_params(body))}


@router.delete("/storage/{storage}/content")
async def delete_content(storage: str = Path(pattern=STORAGE_RE), volume: str = Query(pattern=VOLID_RE, max_length=500)):
    if volume.split(":", 1)[0] != storage:
        raise HTTPException(400, "Volume does not belong to this storage")
    return {"upid": await pve("DELETE", _node(f"/storage/{storage}/content/{quote(volume, safe='')}"))}


@router.get("/hardware/pci")
async def pci_devices():
    items = await pve("GET", _node("/hardware/pci")) or []
    try:
        probed = {d["slot"]: d for d in (await pci.probe())["devices"]}
    except HTTPException:
        probed = {}  # SSH bridge unavailable: PVE's list without driver / warning details
    out = []
    for d in sorted(items, key=lambda d: d.get("id", "")):
        p = probed.get(d.get("id", ""), {})
        out.append({"id": d.get("id", ""), "iommugroup": d.get("iommugroup", -1), "vendor": d.get("vendor", ""),
                    "device": d.get("device", ""), "vendor_name": d.get("vendor_name", ""),
                    "device_name": d.get("device_name", ""), "class": d.get("class", ""),
                    # PCI class 0x03xxxx = display controller.
                    "gpu": str(d.get("class", "")).startswith("0x03"), "mdev": bool(d.get("mdev")),
                    "category": pci_category(str(d.get("class", ""))), "driver": p.get("driver"),
                    "iommu_shared_with": p.get("iommu_shared_with", []), "warnings": p.get("warnings", []),
                    "audio_function": p.get("audio_function")})
    return out


@router.get("/hardware/usb")
async def usb_devices():
    items = await pve("GET", _node("/hardware/usb")) or []
    devices = [{"host": f"{d['vendid']}:{d['prodid']}", "port": f"{d['busnum']}-{d['usbpath']}" if d.get("usbpath") else None,
                "product": (d.get("product") or "").strip(), "manufacturer": (d.get("manufacturer") or "").strip(),
                "speed": d.get("speed", ""), "usb3": float(d.get("speed") or 0) >= 5000}
               for d in items if d.get("class") != 9 and d.get("vendid")]  # class 9 = hubs / root controllers
    return {"devices": devices, "ports": sorted({d["port"] for d in devices if d["port"]})}


def hostpci_value(p: PciPassthrough) -> str:
    dev = p.id.rsplit(".", 1)[0] if p.include_audio else p.id
    return ",".join([dev, *(["pcie=1"] if p.pcie else []), f"rombar={int(p.rombar)}", *(["x-vga=1"] if p.x_vga else [])])


def usb_value(u: UsbPassthrough) -> str:
    return f"host={u.host}" + (",usb3=1" if u.usb3 else "")


async def qm_set(vmid: int, opts: dict[str, str]) -> None:
    """Root-only VM options (hostpciN, usbN, -delete) via `qm set` over the SSH bridge."""
    args = [x for k, v in opts.items() for x in (f"-{k}", v)]
    await host_ssh.run(shlex.join(["qm", "set", str(int(vmid)), *args]))


@router.get("/nextid")
async def next_id():
    return {"vmid": int(await pve("GET", "/cluster/nextid"))}


def qemu_params(b: QemuBody) -> dict:
    # Windows Setup has no virtio drivers: without an extra driver ISO it would see no disk and no network.
    windows = b.ostype.startswith("win")
    disk, opts = ("sata0", "discard=on,ssd=1") if windows else ("scsi0", "iothread=1,discard=on")
    p = {
        "vmid": b.vmid, "name": b.name, "cores": b.cores, "sockets": b.sockets, "memory": b.memory, "bios": b.bios,
        "ostype": b.ostype, "onboot": int(b.start_on_boot), "scsihw": "virtio-scsi-single", "agent": 1,
        disk: f"{b.storage}:{b.disk_gb},{opts}",
        "ide2": f"{b.iso_volume},media=cdrom" if b.iso_volume else "none,media=cdrom",
        "net0": f"{'e1000e' if windows else 'virtio'},bridge={b.bridge},firewall=1", "boot": f"order={disk};ide2;net0",
        "tags": GUEST_TAG,
    }
    if b.bios == "ovmf" or b.hostpci:
        p["machine"] = "q35"  # UEFI and PCIe passthrough (pcie=1) both want the q35 chipset
    if b.bios == "ovmf" and b.efidisk:
        p["efidisk0"] = f"{b.storage}:1,efitype=4m,pre-enrolled-keys=1"
    if b.ostype == "win11":
        p["tpmstate0"] = f"{b.storage}:1,version=v2.0"  # Windows 11 setup refuses to run without a TPM
    return p


@router.post("/guests/qemu")
async def create_qemu(body: QemuBody):
    upid = await pve("POST", _node("/qemu"), data=qemu_params(body))
    if body.hostpci or body.usb:
        await wait_task(upid, 600)
        await qm_set(body.vmid, {**{f"hostpci{i}": hostpci_value(p) for i, p in enumerate(body.hostpci)},
                                 **{f"usb{i}": usb_value(u) for i, u in enumerate(body.usb)}})
    return {"vmid": body.vmid, "upid": upid}


def lxc_params(b: LxcBody) -> dict:
    ip = "ip=dhcp" if b.ip_config == "dhcp" else f"ip={b.ip_config.cidr},gw={b.ip_config.gateway}"
    return {"vmid": b.vmid, "hostname": b.hostname, "ostemplate": b.ostemplate, "rootfs": f"{b.storage}:{b.disk_gb}",
            "cores": b.cores, "memory": b.memory, "swap": b.swap, "unprivileged": 1, "password": b.password,
            **({"features": "nesting=1"} if b.nesting else {}), "net0": f"name=eth0,bridge={b.bridge},{ip}",
            "tags": GUEST_TAG}


@router.post("/guests/lxc")
async def create_lxc(body: LxcBody):
    upid = await pve("POST", _node("/lxc"), data=lxc_params(body))
    if body.bind_dataset:
        await wait_task(upid, 900)
        await host.run(["guest-bindmount", str(body.vmid), body.bind_dataset])
    return {"vmid": body.vmid, "upid": upid}
