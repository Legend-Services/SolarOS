"""Guest provisioning request models shared by the drivers: ISO / template / backup volumes, URL downloads, PCIe
discovery, VM and container creation. Guests created by SolarDeck are tagged "<prefix>-guest"."""
import re
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import pci
from .apps import StaticIP
from .auth import require_user
from .config import settings
from .hypervisor import DATASET_RE
from .storage_admin import STORAGE_RE

router = APIRouter(prefix="/api/v1", tags=["provisioning"], dependencies=[Depends(require_user)])


GUEST_TAG = settings.name("guest")
CONTENT = ("iso", "vztmpl", "backup")


# No commas or whitespace: a volid is embedded in guest property strings ("<volid>,media=cdrom").
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


def pci_category(cls: str) -> str:
    """PCI class code ("0x030000" from the management API or "0300" from lspci) → passthrough category."""
    c = cls.removeprefix("0x")
    return ("gpu" if c.startswith("03") else "audio" if c.startswith(("0401", "0403")) else "nvme" if c.startswith("0108")
            else "usb-controller" if c.startswith("0c03") else "network" if c.startswith("02") else "other")


@router.get("/hardware/gpus")
async def gpus():
    return [pci.gpu_view(d) for d in (await pci.probe())["devices"] if d["gpu"]]


class PciPassthrough(BaseModel):
    id: str = Field(pattern=PCI_RE)
    pcie: bool = True
    rombar: bool = True
    x_vga: bool = False
    include_audio: bool = True  # pass the whole slot (01:00 = GPU + HDMI audio function)


class UsbPassthrough(BaseModel):
    host: str = Field(pattern=USB_HOST_RE)
    usb3: bool = False


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
    bridge: str = Field(default_factory=lambda: settings.default_bridge, pattern=BRIDGE_RE)
    ostype: Literal["l26", "win11", "win10", "win8", "win7", "w2k8", "solaris", "other"] = "l26"
    start_on_boot: bool = False
    hostpci: list[PciPassthrough] = Field([], max_length=8)
    usb: list[UsbPassthrough] = Field([], max_length=5)


class LxcBody(BaseModel):
    vmid: int = Field(ge=100, le=999_999_999)
    hostname: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    cores: int = Field(1, ge=1, le=512)
    memory: int = Field(1024, ge=64, le=4 * 1024 * 1024)  # MB
    swap: int = Field(512, ge=0, le=1024 * 1024)  # MB
    ostemplate: str = Field(pattern=TMPL_RE, max_length=500)
    storage: str = Field(pattern=STORAGE_RE)
    disk_gb: int = Field(8, ge=1, le=65536)
    bridge: str = Field(default_factory=lambda: settings.default_bridge, pattern=BRIDGE_RE)
    ip_config: Literal["dhcp"] | StaticIP = "dhcp"
    password: str = Field(min_length=5, max_length=128)
    nesting: bool = True
    bind_dataset: str | None = Field(None, pattern=DATASET_RE, max_length=200)
