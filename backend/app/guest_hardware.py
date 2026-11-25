"""Guest hardware request models and config parsers shared by the drivers: device passthrough (PCI/GPU/USB), NICs,
cloud-init, snapshots and options. Guest configs use key=value property strings ("virtio=MAC,bridge=br0,tag=20")."""
import re
from typing import Annotated, Literal
from urllib.parse import unquote

from fastapi import Path
from pydantic import BaseModel, Field, StringConstraints

from .provisioning import BRIDGE_RE


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
    """Property string → dict; a bare leading value (e.g. hostpci "01:00") is stored under "_"."""
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
              "firewall": p.get("firewall") == "1", "rate": float(p["rate"]) if p.get("rate") else None,
              "trunks": p.get("trunks") or None, "link_down": p.get("link_down") == "1"}
    if guest_type == "qemu":
        model = next((m for m in QEMU_MODELS if m in p or p.get("_") == m), "virtio")
        return {"model": model, "macaddr": p.get(model) or p.get("macaddr"), **common}
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


class NetBody(BaseModel):
    bridge: str = Field(pattern=BRIDGE_RE)
    tag: int | None = Field(None, ge=1, le=4094)
    trunks: str | None = Field(None, pattern=r"^\d{1,4}(;\d{1,4}){0,63}$")  # tagged VLANs of a trunk NIC: "10;20"
    link_down: bool = False
    firewall: bool = True
    rate: float | None = Field(None, gt=0, le=100_000)  # MB/s
    macaddr: str | None = Field(None, pattern=MAC_RE)
    model: Literal["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"] = "virtio"  # QEMU
    name: str | None = Field(None, pattern=r"^eth\d{1,2}$")  # LXC
    ip: str | None = Field(None, pattern=r"^(dhcp|manual|\d{1,3}(\.\d{1,3}){3}/\d{1,2})$")
    gw: str | None = Field(None, pattern=IPV4_RE)
    ip6: Literal["auto", "dhcp", "manual"] | None = None


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


class SnapshotBody(BaseModel):
    name: str = Field(pattern=SNAP_RE)
    description: str = Field("", max_length=1000)
    vmstate: bool = False  # QEMU only: include RAM


class OptionsBody(BaseModel):
    name: str | None = Field(None, pattern=r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$")
    hostname: str | None = Field(None, pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    onboot: bool | None = None
    protection: bool | None = None
    startup: str | None = Field(None, pattern=r"^((order=\d+|up=\d+|down=\d+)(,(order=\d+|up=\d+|down=\d+))*)?$")
    boot: str | None = Field(None, pattern=r"^(order=[a-z0-9;]+)?$")
    agent: bool | None = None
    ostype: Literal["l26", "l24", "win11", "win10", "win8", "win7", "w2k8", "wxp", "solaris", "other"] | None = None
    machine: str | None = Field(None, pattern=r"^(q35|pc|pc-(q35|i440fx)-[0-9.]+(\+[a-z]+\d+)?)?$")
    bios: Literal["ovmf", "seabios"] | None = None
    cpu: str | None = Field(None, pattern=r"^[A-Za-z0-9_.-]+$", max_length=60)
    numa: bool | None = None
    hotplug: str | None = Field(None, pattern=r"^(0|1|[a-z]+(,[a-z]+)*)?$")
    tablet: bool | None = None
    features: str | None = Field(None, pattern=r"^([a-z]+=[01](,[a-z]+=[01])*)?$")
