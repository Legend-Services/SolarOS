"""Guest provisioning: ISO / template / backup volumes, URL downloads, PCIe discovery, VM and LXC creation.

Guests created here are tagged "proxmox-os-guest". Raw PCI/USB passthrough needs root@pam (the API token cannot set
it), so it is applied with `qm set` over the root SSH bridge; host bind mounts still go through the host helper.
"""
import re
import shlex
from typing import Literal
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from . import host, host_ssh, pci
from .apps import StaticIP
from .auth import require_user
from .pve import DATASET_RE, _node, pve
from .storage_admin import STORAGE_RE
from .tasks import wait_task

router = APIRouter(prefix="/api/pve", tags=["provisioning"], dependencies=[Depends(require_user)])

GUEST_TAG = "proxmox-os-guest"
CONTENT = ("iso", "vztmpl", "backup")
# No commas or whitespace: a volid is embedded in PVE property strings ("<volid>,media=cdrom").
VOLID_RE = r"^[a-z][a-z0-9_.-]*:(iso|vztmpl|backup)/[^,\s]+$"
ISO_RE = r"^[a-z][a-z0-9_.-]*:iso/[^,\s]+$"
TMPL_RE = r"^[a-z][a-z0-9_.-]*:vztmpl/[^,\s]+$"
PCI_RE = r"^([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}(\.[0-7])?$"
BRIDGE_RE = r"^[A-Za-z][A-Za-z0-9_.-]{0,14}$"
USB_HOST_RE = r"^([0-9a-f]{4}:[0-9a-f]{4}|\d+-[\d.]+)$"
FILENAME_RE =r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,200}\.(iso|img|tar\.(gz|xz|zst))$"


def volume(v: dict, storage: str) -> dict:
    return {"volid": v.get("volid", ""), "storage": storage, "content": v.get("content", ""),
            "format": v.get("format", ""), "size": v.get("size") or 0, "ctime": v.get("ctime") or 0,
            "vmid": int(v["vmid"]) if str(v.get("vmid", "")).isdigit() else None, "notes": v.get("notes") or "",
            "subtype": v.get("subtype") or "", "protected": bool(v.get("protected"))}


@router.get("/storage/{storage}/content")
async def storage_content(storage: str = Path(pattern=STORAGE_RE),
                          content: Literal["iso", "vztmpl", "backup"] | None = None):
    items = await pve("GET", _node(f"/storage/{storage}/content"), params={"content": content} if content else None)
    return sorted((volume(v, storage) for v in items or [] if v.get("content") in CONTENT),
                  key=lambda v: v["ctime"], reverse=True)


class DownloadBody(BaseModel):
    url: str = Field(max_length=2000)
    content: Literal["iso", "vztmpl"] = "iso"
    filename: str | None = Field(None, pattern=FILENAME_RE)
    checksum: str | None = Field(None, pattern=r"^[0-9a-fA-F]{32,128}$")
    checksum_algorithm: Literal["md5", "sha1", "sha224", "sha256", "sha384", "sha512"] | None = None
    verify_certificates: bool = True


def download_params(body: DownloadBody) -> dict:
    u = urlparse(body.url)
    if u.scheme not in ("http", "https") or not u.netloc:
        raise HTTPException(422, "URL must start with http:// or https://")
    name = body.filename or u.path.rsplit("/", 1)[-1]
    if not re.fullmatch(FILENAME_RE, name):
        raise HTTPException(422, "Cannot derive a valid file name (.iso, .img, .tar.gz/.xz/.zst) from the URL; set filename")
    if bool(body.checksum) != bool(body.checksum_algorithm):
        raise HTTPException(422, "checksum and checksum_algorithm go together")
    data = {"url": body.url, "content": body.content, "filename": name,
            "verify-certificates": int(body.verify_certificates)}
    if body.checksum:
        data |= {"checksum": body.checksum.lower(), "checksum-algorithm": body.checksum_algorithm}
    return data


@router.post("/storage/{storage}/download-url")
async def download_url(body: DownloadBody, storage: str = Path(pattern=STORAGE_RE)):
    return {"upid": await pve("POST", _node(f"/storage/{storage}/download-url"), data=download_params(body))}


@router.delete("/storage/{storage}/content")
async def delete_content(storage: str = Path(pattern=STORAGE_RE), volume: str = Query(pattern=VOLID_RE, max_length=500)):
    if volume.split(":", 1)[0] != storage:
        raise HTTPException(400, "Volume does not belong to this storage")
    return {"upid": await pve("DELETE", _node(f"/storage/{storage}/content/{quote(volume, safe='')}"))}


def pci_category(cls: str) -> str:
    """PCI class code ("0x030000" from PVE or "0300" from lspci) → passthrough category."""
    c = cls.removeprefix("0x")
    return ("gpu" if c.startswith("03") else "audio" if c.startswith(("0401", "0403")) else "nvme" if c.startswith("0108")
            else "usb-controller" if c.startswith("0c03") else "network" if c.startswith("02") else "other")


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


@router.get("/hardware/gpus")
async def gpus():
    return [pci.gpu_view(d) for d in (await pci.probe())["devices"] if d["gpu"]]


@router.get("/hardware/usb")
async def usb_devices():
    items = await pve("GET", _node("/hardware/usb")) or []
    devices = [{"host": f"{d['vendid']}:{d['prodid']}", "port": f"{d['busnum']}-{d['usbpath']}" if d.get("usbpath") else None,
                "product": (d.get("product") or "").strip(), "manufacturer": (d.get("manufacturer") or "").strip(),
                "speed": d.get("speed", ""), "usb3": float(d.get("speed") or 0) >= 5000}
               for d in items if d.get("class") != 9 and d.get("vendid")]  # class 9 = hubs / root controllers
    return {"devices": devices, "ports": sorted({d["port"] for d in devices if d["port"]})}


class PciPassthrough(BaseModel):
    id: str = Field(pattern=PCI_RE)
    pcie: bool = True
    rombar: bool = True
    x_vga: bool = False
    include_audio: bool = True  # pass the whole slot (01:00 = GPU + HDMI audio function)


class UsbPassthrough(BaseModel):
    host: str = Field(pattern=USB_HOST_RE)
    usb3: bool = False


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


class QemuBody(BaseModel):
    vmid: int = Field(ge=100, le=999_999_999)
    name: str = Field(pattern=r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$")
    cores: int = Field(2, ge=1, le=512)
    sockets: int = Field(1, ge=1, le=8)
    memory: int = Field(2048, ge=64, le=4 * 1024 * 1024)  # MB
    bios: Literal["ovmf", "seabios"] = "ovmf"
    efidisk: bool = True
    iso_volume: str | None = Field(None, pattern=ISO_RE, max_length=500)
    storage: str = Field(pattern=STORAGE_RE)
    disk_gb: int = Field(32, ge=1, le=65536)
    bridge: str = Field("vmbr0", pattern=BRIDGE_RE)
    ostype: Literal["l26", "win11", "win10", "win8", "win7", "w2k8", "solaris", "other"] = "l26"
    start_on_boot: bool = False
    hostpci: list[PciPassthrough] = Field([], max_length=8)
    usb: list[UsbPassthrough] = Field([], max_length=5)


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


class LxcBody(BaseModel):
    vmid: int = Field(ge=100, le=999_999_999)
    hostname: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    cores: int = Field(1, ge=1, le=512)
    memory: int = Field(1024, ge=64, le=4 * 1024 * 1024)  # MB
    swap: int = Field(512, ge=0, le=1024 * 1024)  # MB
    ostemplate: str = Field(pattern=TMPL_RE, max_length=500)
    storage: str = Field(pattern=STORAGE_RE)
    disk_gb: int = Field(8, ge=1, le=65536)
    bridge: str = Field("vmbr0", pattern=BRIDGE_RE)
    ip_config: Literal["dhcp"] | StaticIP = "dhcp"
    password: str = Field(min_length=5, max_length=128)
    nesting: bool = True
    bind_dataset: str | None = Field(None, pattern=DATASET_RE, max_length=200)


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
