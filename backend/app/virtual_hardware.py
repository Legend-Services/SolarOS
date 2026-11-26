"""Virtual Hardware, Retro Throttling & Isolated Lab Forge.

Per guest (`vm` / `lxc`): emulated peripherals from CATALOG, a CPU limit + CPU model, and per-NIC link shaping with
Linux traffic control (netem) on the guest's host-side interface. Profiles persist in data/virtual_hardware.json.
Isolated lab sandboxes (an air-gapped switch with its own DHCP server, guests moved onto it) persist in
data/isolated_labs.json.

The guest config itself is written by the active driver's module (get_provider().vhw_driver()):
  attach(kind, vmid, dev) -> dict     add device `dev` ({id, type, options, state}); returns state to keep
  detach(kind, vmid, dev)             remove it again
  set_cpu(kind, vmid, percent, model) CPU limit (5-100 % of the guest's vCPUs) and CPU model (VMs, None = keep)
  host_ifaces(kind, vmid) -> dict     {net_id: host-side interface} of a running guest
  IMAGE_DIR(vmid) -> str              where emulated NVMe drives keep their image file
"""
import asyncio
import ipaddress
import json
import re
import secrets
import shlex
from datetime import datetime, timezone
from pathlib import Path as FsPath
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, model_validator

from . import cluster, host_ssh, network_switch as ns
from .auth import require_user
from .config import settings
from .guest_hardware import MAC_RE, QEMU_MODELS, NetBody
from providers.registry import get_provider

router = APIRouter(prefix="/api/virtual-hardware", tags=["virtual_hardware"], dependencies=[Depends(require_user)])
public = APIRouter(prefix="/api/virtual-hardware", tags=["virtual_hardware"])  # the static device catalog only

DATA = FsPath(__file__).resolve().parent.parent / "data"
PROFILES = DATA / "virtual_hardware.json"
LABS = DATA / "isolated_labs.json"
P = settings.system_prefix
HOST_DIR = f"/var/lib/{P}/vhw"
MODEM_PY = f"/usr/local/lib/{P}/vhw_modem.py"
VCAM_BASE = 40  # virtual cameras are /dev/video40 … /dev/video47
VCAM_SLOTS = 8
VCAM_LABEL = "SolarDeck-Camera"
_lock = asyncio.Lock()

GuestTypeT = Literal["vm", "lxc"]
GUEST_ID = Path(ge=100, le=999_999_999)

# ---------------------------------------------------------------- Catalog

HOST_RE = r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$"
CATALOG: dict[str, dict] = {
    "hd_audio": {"category": "audio", "bus": "PCIe", "guest_types": ["vm", "lxc"], "hotplug": False, "options": []},
    "legacy_audio": {"category": "audio", "bus": "ISA", "guest_types": ["vm"], "hotplug": False, "options": [
        {"key": "model", "kind": "select", "choices": ["ac97", "sb16"], "default": "ac97"}]},
    "virtual_camera": {"category": "video", "bus": "USB", "guest_types": ["lxc"], "hotplug": True, "options": [
        {"key": "source", "kind": "select", "choices": ["test_pattern", "rtsp_url", "video_file", "vnc_guest_capture"],
         "default": "test_pattern"},
        {"key": "url", "kind": "text", "pattern": r"^rtsps?://[^\s'\"`\\$]{1,400}$", "default": "", "when": ["source", "rtsp_url"]},
        {"key": "file", "kind": "text", "pattern": r"^/(?!.*\.\.)[A-Za-z0-9._/ -]{1,300}$", "default": "",
         "when": ["source", "video_file"]},
        {"key": "source_guest", "kind": "number", "min": 100, "max": 999_999_999, "default": 100,
         "when": ["source", "vnc_guest_capture"]},
        {"key": "resolution", "kind": "select", "choices": ["640x480", "1280x720", "1920x1080"], "default": "1280x720"},
        {"key": "fps", "kind": "number", "min": 1, "max": 60, "default": 30}]},
    "sas_hba": {"category": "storage", "bus": "PCIe", "guest_types": ["vm"], "hotplug": False, "options": [
        {"key": "model", "kind": "select", "choices": ["megasas", "mptsas1068", "lsi53c895a"], "default": "megasas"}]},
    "virtual_nvme": {"category": "storage", "bus": "PCIe", "guest_types": ["vm"], "hotplug": False, "options": [
        {"key": "size_gb", "kind": "number", "min": 1, "max": 4096, "default": 32},
        {"key": "serial", "kind": "text", "pattern": r"^[A-Za-z0-9-]{1,20}$", "default": ""}]},
    "hayes_modem": {"category": "legacy", "bus": "Serial", "guest_types": ["vm", "lxc"], "hotplug": False, "options": [
        {"key": "dial_host", "kind": "text", "pattern": HOST_RE, "default": ""},
        {"key": "dial_port", "kind": "number", "min": 1, "max": 65535, "default": 23}]},
    "legacy_nic": {"category": "legacy", "bus": "PCIe", "guest_types": ["vm"], "hotplug": False, "options": [
        {"key": "model", "kind": "select", "choices": ["ne2k_pci", "pcnet", "rtl8139", "e1000"], "default": "ne2k_pci"},
        {"key": "bridge", "kind": "text", "pattern": ns.IFACE_RE, "default": ""}]},
    "vtpm": {"category": "security", "bus": "Virtual", "guest_types": ["vm"], "hotplug": False, "single": True, "options": []},
    "smartcard": {"category": "security", "bus": "USB", "guest_types": ["vm"], "hotplug": False, "single": True, "options": []},
    "watchdog": {"category": "security", "bus": "PCIe", "guest_types": ["vm"], "hotplug": False, "single": True, "options": [
        {"key": "action", "kind": "select", "choices": ["reset", "shutdown", "poweroff", "pause"], "default": "reset"}]},
    "virtio_rng": {"category": "security", "bus": "Virtual", "guest_types": ["vm"], "hotplug": False, "single": True,
                   "options": []},
}
for _t in ("hd_audio", "legacy_audio"):
    CATALOG[_t]["single"] = True  # one sound card per guest
CPU_MODELS = ("host", "qemu64", "pentium3", "486")
# rate kbit/s, latency ms, jitter ms, loss %
PRESETS: dict[str, tuple[int, int, int, float] | None] = {
    "native": None, "100mbps": (100_000, 0, 0, 0), "10mbps": (10_000, 0, 0, 0), "56k": (56, 120, 0, 0),
    "4g": (25_000, 45, 10, 0)}


def clean_options(dtype: str, given: dict) -> dict:
    """Validate a device's options against CATALOG (defaults filled in, unknown keys refused)."""
    spec = CATALOG[dtype]["options"]
    known = {o["key"] for o in spec}
    if bad := set(given) - known:
        raise HTTPException(422, f"Unknown option(s) for {dtype}: {', '.join(sorted(bad))}")
    out: dict = {}
    for o in spec:
        v = given.get(o["key"], o["default"])
        if "when" in o and out.get(o["when"][0]) != o["when"][1]:
            continue
        if o["kind"] == "select" and v not in o["choices"]:
            raise HTTPException(422, f"{o['key']} must be one of {', '.join(o['choices'])}")
        if o["kind"] == "number":
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not o["min"] <= v <= o["max"]:
                raise HTTPException(422, f"{o['key']} must be a number from {o['min']} to {o['max']}")
            v = int(v)
        if o["kind"] == "text":
            v = str(v)
            if not (v == "" and "when" not in o) and not re.fullmatch(o["pattern"], v):
                raise HTTPException(422, f"Invalid {o['key']}: {v[:60]}")
        out[o["key"]] = v
    return out


# ---------------------------------------------------------------- Persistence


def _load(path: FsPath, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def _save(path: FsPath, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


def _key(guest_type: str, guest_id: int) -> str:
    return f"{guest_type}/{guest_id}"


def profile(guest_type: str, guest_id: int) -> dict:
    p = _load(PROFILES, {}).get(_key(guest_type, guest_id)) or {}
    return {"devices": p.get("devices", []), "throttling": p.get("throttling") or default_throttling(),
            "nic_labels": p.get("nic_labels", {})}


def _store(guest_type: str, guest_id: int, prof: dict) -> None:
    all_ = _load(PROFILES, {})
    all_[_key(guest_type, guest_id)] = prof
    _save(PROFILES, all_)


def default_throttling() -> dict:
    return {"cpu_limit_percent": 100, "cpu_model": None, "nics": {}}


# ---------------------------------------------------------------- Pure helpers (unit tested)


def shape_of(nic: dict) -> tuple[int, int, int, float] | None:
    """(rate kbit/s, latency ms, jitter ms, loss %) of a NIC setting, None = unthrottled."""
    if nic.get("preset", "native") != "custom":
        return PRESETS.get(nic.get("preset", "native"))
    s = (int(nic.get("rate_kbps") or 0), int(nic.get("latency_ms") or 0), int(nic.get("jitter_ms") or 0),
         float(nic.get("packet_loss_pct") or 0))
    return s if any(s) else None


def tc_script(iface: str, shape: tuple[int, int, int, float] | None) -> str:
    """Shell commands that shape (or unshape) one host-side guest interface. Egress of the host side is the guest's
    download (netem: rate, delay, jitter, loss); the guest's upload is policed at the same rate on ingress."""
    q = shlex.quote(iface)
    clear = f"tc qdisc del dev {q} root 2>/dev/null; tc qdisc del dev {q} ingress 2>/dev/null"
    if shape is None:
        return clear + "; true"
    rate, lat, jit, loss = shape
    netem = "netem limit 10000"
    if lat or jit:
        netem += f" delay {lat}ms" + (f" {jit}ms" if jit else "")
    if loss:
        netem += f" loss {loss:g}%"
    if rate:
        netem += f" rate {rate}kbit"
    out = f"{clear}; tc qdisc replace dev {q} root {netem}"
    if rate:
        burst = max(rate * 125 // 10, 3200)  # ~100 ms worth of bytes, at least two full frames
        out += (f" && tc qdisc add dev {q} handle ffff: ingress && tc filter add dev {q} parent ffff: protocol all prio 1 "
                f"u32 match u32 0 0 police rate {rate}kbit burst {burst} drop")
    return out


def vcam_command(opts: dict, nr: int, guest_capture: str = "") -> str:
    """The ffmpeg feed of /dev/video<nr> (bash)."""
    w, h = opts["resolution"].split("x")
    fps = int(opts["fps"])
    out = f"-vf scale={w}:{h},format=yuv420p -r {fps} -f v4l2 /dev/video{nr}"
    src = opts["source"]
    if src == "rtsp_url":
        inp = f"-rtsp_transport tcp -i {shlex.quote(opts['url'])}"
    elif src == "video_file":
        inp = f"-stream_loop -1 -re -i {shlex.quote(opts['file'])}"
    elif src == "vnc_guest_capture":
        # The source guest's display, grabbed a few times per second by the driver's screenshot command.
        return (f"while :; do ( {guest_capture} ) || sleep 1; sleep 0.2; done | "
                f"exec ffmpeg -hide_banner -loglevel warning -f image2pipe -c:v ppm -framerate 5 -i - {out}")
    else:
        inp = f"-re -f lavfi -i testsrc2=size={w}x{h}:rate={fps}"
    return f"exec ffmpeg -hide_banner -loglevel warning {inp} {out}"


def unit_file(desc: str, exec_start: str) -> str:
    return (f"[Unit]\nDescription={desc}\nAfter=network-online.target\n\n[Service]\nExecStart={exec_start}\n"
            "Restart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n")


def free_bridge(model: dict, prefix: str, pattern: str) -> str:
    """First unused virtual switch name from <prefix>50 up (lab switches stay clear of the usual low numbers)."""
    n = next(n for n in range(50, 10_000) if f"{prefix}{n}" not in model)
    name = f"{prefix}{n}"
    if not re.fullmatch(pattern, name):
        raise HTTPException(409, "No free virtual switch name")
    return name


def overlaps(cidr: str, model: dict) -> str | None:
    """Name of an existing interface whose subnet overlaps `cidr`, if any."""
    net = ipaddress.ip_interface(cidr).network
    for n, i in model.items():
        if i.get("address") and ipaddress.ip_interface(i["address"]).network.overlaps(net):
            return n
    return None


# ---------------------------------------------------------------- Hardware identity (Wireframe Node Architect)

# PCI vendor:device the guest sees for each emulated NIC model (fixed by the emulated chip).
NIC_PCI_IDS: dict[str, tuple[str, str]] = {
    "virtio": ("0x1af4", "0x1000"), "e1000": ("0x8086", "0x100e"), "e1000e": ("0x8086", "0x10d3"),
    "rtl8139": ("0x10ec", "0x8139"), "vmxnet3": ("0x15ad", "0x07b0"), "ne2k_pci": ("0x10ec", "0x8029"),
    "pcnet": ("0x1022", "0x2000")}
# Native vendor:device of the emulated virtual devices (option value or device type → ids).
NATIVE_IDS: dict[str, tuple[str, str]] = {
    "hd_audio": ("0x8086", "0x293e"), "ac97": ("0x8086", "0x2415"), "megasas": ("0x1000", "0x0060"),
    "mptsas1068": ("0x1000", "0x0054"), "lsi53c895a": ("0x1000", "0x0012"), "virtual_nvme": ("0x1b36", "0x0010"),
    "smartcard": ("0x08e6", "0x4433"), "watchdog": ("0x8086", "0x25ab"), "virtio_rng": ("0x1af4", "0x1005"),
    "ne2k_pci": NIC_PCI_IDS["ne2k_pci"], "pcnet": NIC_PCI_IDS["pcnet"], "rtl8139": NIC_PCI_IDS["rtl8139"],
    "e1000": NIC_PCI_IDS["e1000"]}
# Identity fields that reach the guest's own device list; every other field is a SolarDeck label.
GUEST_VISIBLE: dict[str, list[str]] = {"virtual_camera": ["device_name"], "virtual_nvme": ["serial_number"]}
IDENTITY_KEYS = ("device_name", "vendor_id", "device_id", "serial_number", "pci_or_usb_address")


def hex_id(v: str) -> str:
    """'8086' / '0X8086' → '0x8086' ('' stays '')."""
    return f"0x{v.lower().removeprefix('0x')}" if v else ""


def unicast_mac(mac: str) -> bool:
    """A usable guest MAC: well-formed, unicast (I/G bit clear) and not all zeros."""
    return bool(re.fullmatch(MAC_RE, mac)) and not int(mac[:2], 16) & 1 and mac.replace(":", "") != "0" * 12


def native_ids(dev: dict) -> tuple[str, str] | tuple[None, None]:
    key = dev["options"].get("model") if dev["type"] in ("legacy_audio", "sas_hba", "legacy_nic") else dev["type"]
    return NATIVE_IDS.get(key or "", (None, None))


def identity_view(dev: dict) -> dict:
    """A virtual device's identity: overrides with the native ids and NVMe serial filled in."""
    ident = {k: (dev.get("identity") or {}).get(k, "") for k in IDENTITY_KEYS}
    vid, did = native_ids(dev)
    if dev["type"] == "virtual_nvme":
        ident["serial_number"] = dev["options"].get("serial", "")
    if dev["type"] == "virtual_camera" and dev["state"].get("video_nr") is not None:
        ident["pci_or_usb_address"] = ident["pci_or_usb_address"] or f"/dev/video{dev['state']['video_nr']}"
    return {**ident, "bus_type": CATALOG[dev["type"]]["bus"], "native_vendor_id": vid, "native_device_id": did,
            "guest_visible": GUEST_VISIBLE.get(dev["type"], [])}


def nic_view(n: dict, label: str, vlan_map: dict, ips: list[str], lab: dict | None, dhcp: dict) -> dict:
    """One guest NIC with its endpoint (switch, VLAN with DHCP state, lab) for the wireframe."""
    model = n.get("model") or "veth"
    vid, did = NIC_PCI_IDS.get(model, (None, None))
    tag = n.get("tag")
    vkey = str(tag) if tag and str(tag) in vlan_map else next(
        (k for k, v in vlan_map.items() if v.get("lab") and v.get("bridge") == n.get("bridge")), None)
    v = vlan_map.get(vkey) if vkey else None
    vlan = None if v is None else {"vlan_id": int(vkey), "name": v.get("name"), "color": v.get("color"),
                                   "subnet_cidr": str(ipaddress.ip_interface(v["host_ipv4_cidr"]).network)
                                   if v.get("host_ipv4_cidr") else None,
                                   "gateway_ip": (v.get("dhcp_config") or {}).get("gateway_ip"),
                                   "dns_servers": (v.get("dhcp_config") or {}).get("dns_servers") or [],
                                   "dhcp_active": bool(dhcp.get(vkey))}
    rate = n.get("rate")
    return {"net_id": n["key"], "interface_name": n.get("name") or label or n["key"], "label": label,
            "mac_address": n.get("macaddr"), "model": model, "pci_slot": n.get("pci_slot"), "vendor_id": vid,
            "device_id": did, "bridge": n.get("bridge") or "", "switch_name": n.get("bridge") or "", "vlan_tag": tag,
            "trunks": [int(x) for x in str(n.get("trunks") or "").split(";") if x.isdigit()], "ipv4_addresses": ips,
            "link_up": not n.get("link_down"), "rate_mbps": round(rate * 8, 1) if rate else None,
            "firewall": bool(n.get("firewall")), "vlan": vlan,
            "lab": {"lab_id": lab["id"], "name": lab["name"], "subnet_cidr": str(ipaddress.ip_interface(lab["gateway_cidr"]).network)}
            if lab else None}


# ---------------------------------------------------------------- Host plumbing


def driver():
    d = get_provider().vhw_driver()
    if d is None:
        raise get_provider().not_available()
    return d


def _kind(guest_type: str) -> str:
    return "qemu" if guest_type == "vm" else "lxc"


async def _guest(guest_type: str, guest_id: int) -> dict:
    g = next((g for g in await get_provider().guest_rows()
              if g.get("type") == _kind(guest_type) and int(g.get("vmid", 0)) == guest_id), None)
    if g is None:
        raise HTTPException(404, f"{guest_type} {guest_id} does not exist")
    return g


async def need(cmd: str, hint: str) -> None:
    if "ok" not in await host_ssh.run(f"command -v {cmd} >/dev/null && echo ok; true"):
        raise HTTPException(409, hint)


async def snd_nodes() -> list[str]:
    """Load the ALSA loopback card (a virtual sound card with playback + capture) and list its /dev/snd nodes; the
    host's own sound cards are never handed to a container."""
    out = await host_ssh.run("modprobe snd-aloop 2>/dev/null; grep -qx snd-aloop /etc/modules-load.d/*.conf 2>/dev/null || "
                             f"echo snd-aloop > /etc/modules-load.d/{P}-vhw.conf; "
                             "c=$(readlink /proc/asound/Loopback 2>/dev/null); echo card:${c#card}; ls /dev/snd 2>/dev/null; true")
    card = next((w[5:] for w in out.split() if w.startswith("card:")), "")
    nodes = [f"/dev/snd/{n}" for n in out.split() if card.isdigit() and re.fullmatch(rf"controlC{card}|pcmC{card}D\d+[cp]|timer", n)]
    if not nodes:
        raise HTTPException(409, "The ALSA loopback module (snd-aloop) could not be loaded on the host")
    return nodes


def vcam_labels(profiles: dict) -> list[str]:
    """The card name of every camera slot: the device's chosen Device Manager name, else the default."""
    labels = [VCAM_LABEL] * VCAM_SLOTS
    for p in profiles.values():
        for d in p.get("devices", []):
            nr = (d.get("state") or {}).get("video_nr")
            name = (d.get("identity") or {}).get("device_name")
            if isinstance(nr, int) and 0 <= nr - VCAM_BASE < VCAM_SLOTS and name:
                labels[nr - VCAM_BASE] = name
    return labels


def vcam_opts(labels: list[str]) -> str:
    """v4l2loopback module options; labels match IdentityBody.device_name, so they carry no quotes or commas."""
    nrs = ",".join(str(VCAM_BASE + i) for i in range(VCAM_SLOTS))
    return f"devices={VCAM_SLOTS} video_nr={nrs} exclusive_caps=1 card_label=" + ",".join(f'"{x}"' for x in labels)


def _vcam_conf(opts: str) -> str:
    return f"printf '%s\\n' {shlex.quote('options v4l2loopback ' + opts)} > /etc/modprobe.d/{P}-vcam.conf"


async def vcam_relabel() -> bool:
    """Write the per-slot card names and reload the module; False while a guest holds a camera open (the names then
    apply at the next module load, e.g. a host reboot)."""
    opts = vcam_opts(vcam_labels(_load(PROFILES, {})))
    units = " ".join(settings.name(f"vcam-{VCAM_BASE + i}") for i in range(VCAM_SLOTS))
    out = await host_ssh.run(
        f"{_vcam_conf(opts)}; [ -e /dev/video{VCAM_BASE} ] || {{ echo reloaded; exit 0; }}\n"
        f"act=$(for u in {units}; do systemctl is-active -q $u && echo $u; done)\n"
        "[ -n \"$act\" ] && systemctl stop $act\n"
        f"modprobe -r v4l2loopback 2>/dev/null && modprobe v4l2loopback {shlex.quote(opts)} && echo reloaded\n"
        "[ -n \"$act\" ] && systemctl start $act; true", timeout=60)
    return "reloaded" in out


async def vcam_start(guest_type: str, guest_id: int, dev: dict, used: set[int], nr: int | None = None) -> int:
    """Start the ffmpeg feed of a free camera slot, or with `nr` rewrite and restart that slot's feed."""
    nr = nr or next((VCAM_BASE + i for i in range(VCAM_SLOTS) if VCAM_BASE + i not in used), None)
    if nr is None:
        raise HTTPException(409, f"All {VCAM_SLOTS} virtual camera slots are in use")
    await need("ffmpeg", "The virtual camera needs ffmpeg on the host: install it with apt install ffmpeg")
    opts = vcam_opts(vcam_labels(_load(PROFILES, {})))
    load = (f"[ -e /dev/video{VCAM_BASE} ] || modprobe v4l2loopback {shlex.quote(opts)}; "
            f"echo v4l2loopback > /etc/modules-load.d/{P}-vcam.conf; {_vcam_conf(opts)}; "
            f"[ -e /dev/video{nr} ] && echo ok; true")
    if "ok" not in await host_ssh.run(load):
        raise HTTPException(409, "The virtual camera needs the v4l2loopback kernel module on the host: install it with "
                                 "apt install v4l2loopback-dkms (plus the headers of the running kernel)")
    capture = ""
    if dev["options"]["source"] == "vnc_guest_capture":
        capture = driver().screenshot_cmd(int(dev["options"]["source_guest"]))
    script = f"{HOST_DIR}/vcam-{nr}.sh"
    await host_ssh.write_file(script, "#!/bin/bash\n" + vcam_command(dev["options"], nr, capture) + "\n", "700")
    unit = settings.name(f"vcam-{nr}")
    await host_ssh.write_file(f"/etc/systemd/system/{unit}.service",
                              unit_file(f"SolarDeck virtual camera /dev/video{nr} ({guest_type} {guest_id})", f"/bin/bash {script}"))
    await host_ssh.run(f"systemctl daemon-reload && systemctl enable -q --now {unit} && systemctl restart {unit}")
    return nr


async def vcam_stop(nr: int) -> None:
    unit = settings.name(f"vcam-{nr}")
    await host_ssh.run(f"systemctl disable -q --now {unit} 2>/dev/null; rm -f /etc/systemd/system/{unit}.service "
                       f"{HOST_DIR}/vcam-{nr}.sh; systemctl daemon-reload; true")


def _modem_args(opts: dict) -> str:
    return (f" --host {shlex.quote(opts['dial_host'])} --port {int(opts['dial_port'])}" if opts.get("dial_host") else "")


async def modem_vm_start(guest_id: int, dev: dict, socket_path: str) -> None:
    await host_ssh.write_file(MODEM_PY, (FsPath(__file__).parent / "vhw_modem.py").read_text(), "755")
    unit = settings.name(f"modem-{guest_id}-{dev['id']}")
    await host_ssh.write_file(f"/etc/systemd/system/{unit}.service", unit_file(
        f"SolarDeck virtual 56k modem of VM {guest_id}",
        f"/usr/bin/python3 {MODEM_PY} --unix {socket_path}{_modem_args(dev['options'])}"))
    await host_ssh.run(f"systemctl daemon-reload && systemctl enable -q --now {unit} && systemctl restart {unit}")


async def modem_vm_stop(guest_id: int, dev: dict) -> None:
    unit = settings.name(f"modem-{guest_id}-{dev['id']}")
    await host_ssh.run(f"systemctl disable -q --now {unit} 2>/dev/null; rm -f /etc/systemd/system/{unit}.service; "
                       "systemctl daemon-reload; true")


def modem_container_script(dev: dict, remove: bool = False) -> str:
    """Install (or remove) the modem inside a container: /dev/ttyS0 (or /dev/ttyVHW0 when ttyS0 exists) -> a pty."""
    unit = f"{P}-modem"
    if remove:
        return (f"systemctl disable -q --now {unit} 2>/dev/null; pkill -f /usr/local/lib/{P}/vhw_modem.py; "
                f"rm -f /etc/systemd/system/{unit}.service /usr/local/lib/{P}/vhw_modem.py; "
                "for l in /dev/ttyS0 /dev/ttyVHW0; do [ -L $l ] && rm -f $l; done; true\n")
    code = (FsPath(__file__).parent / "vhw_modem.py").read_text()
    link = "/dev/ttyS0"
    cmd = f"/usr/bin/python3 /usr/local/lib/{P}/vhw_modem.py --pty $LINK{_modem_args(dev['options'])}"
    return (f"set -e\ncommand -v python3 >/dev/null || {{ echo 'python3 is required inside the container' >&2; exit 7; }}\n"
            f"mkdir -p /usr/local/lib/{P}\ncat > /usr/local/lib/{P}/vhw_modem.py <<'MODEM_PY'\n{code}MODEM_PY\n"
            f"LINK={link}; [ -c {link} ] && LINK=/dev/ttyVHW0\n"
            f"if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then\n"
            f"cat > /etc/systemd/system/{unit}.service <<UNIT\n{unit_file('SolarDeck virtual 56k modem', cmd)}UNIT\n"
            f"systemctl daemon-reload; systemctl enable -q --now {unit}; systemctl restart {unit}\n"
            f"else nohup {cmd} >/dev/null 2>&1 & fi\necho $LINK\n")


# ---------------------------------------------------------------- Routes: catalog & profiles


@public.get("/catalog")
async def catalog():
    return {"devices": [{"type": t, **c, "driver_compat": "universal_inbox"} for t, c in CATALOG.items()],
            "cpu_models": list(CPU_MODELS), "net_presets": {k: (None if v is None else dict(
                zip(("rate_kbps", "latency_ms", "jitter_ms", "packet_loss_pct"), v))) for k, v in PRESETS.items()},
            "driver": settings.hypervisor_driver}


# ---------------------------------------------------------------- Isolated lab sandbox (before /{guest_type} routes)


class LabGuest(BaseModel):
    guest_type: GuestTypeT
    guest_id: int = Field(ge=100, le=999_999_999)


class LabBody(BaseModel):
    name: str = Field(pattern=r"^[^\n\r\"'`$\\<>]{1,40}$")
    gateway_cidr: ns.Cidr
    range_start: ns.IP4
    range_end: ns.IP4
    vlan_id: ns.Vid | None = None
    guests: list[LabGuest] = Field([], max_length=32)

    @model_validator(mode="after")
    def _check(self):
        i = ipaddress.ip_interface(self.gateway_cidr)
        if i.version != 4 or not i.network.is_private or i.network.prefixlen > 29:
            raise ValueError("Use a private IPv4 subnet of /29 or larger, e.g. 10.66.0.1/24")
        self.dhcp()  # range inside the subnet, gateway outside the range
        return self

    def dhcp(self) -> ns.DhcpBody:
        i = ipaddress.ip_interface(self.gateway_cidr)
        return ns.DhcpBody(enabled=True, gateway_ip=str(i.ip), subnet_mask=str(i.netmask), range_start=self.range_start,
                           range_end=self.range_end, lease_time="12h")


def _labs() -> list[dict]:
    return _load(LABS, [])


@router.get("/labs/sandbox")
async def list_labs():
    return {"labs": _labs()}


async def _dhcp_up(vid: int, iface: str, d: ns.DhcpBody) -> None:
    await host_ssh.write_file(f"{ns.DHCP_DIR}/{vid}.conf", ns.render_dhcp(vid, iface, d.model_dump()))
    await host_ssh.write_file(f"/etc/systemd/system/{ns.DHCP_UNIT}@.service", ns.DHCP_SERVICE)
    out = await host_ssh.run(f"dnsmasq --test --conf-file={ns.DHCP_DIR}/{vid}.conf 2>&1", check=False)
    if "syntax check OK" not in out:
        raise HTTPException(400, f"dnsmasq rejected the configuration: {out.strip()[-300:]}")
    unit = f"{ns.DHCP_UNIT}@{vid}"
    await host_ssh.run(f"systemctl daemon-reload && systemctl enable -q {unit} && systemctl restart {unit}")


async def _dhcp_down(vid: int) -> None:
    await host_ssh.run(f"systemctl disable -q --now {ns.DHCP_UNIT}@{vid} 2>/dev/null; rm -f {ns.DHCP_DIR}/{vid}.conf; true")


async def _move_nic(guest_type: str, guest_id: int, bridge: str) -> dict:
    """Put the guest's first NIC (or a new one) on `bridge`, untagged and on DHCP; returns how to undo it."""
    kind = _kind(guest_type)
    nets = await ns._nets(kind, guest_id)
    cur = nets[0] if nets else None
    idx = cur["index"] if cur else 0
    model = (cur or {}).get("model") or "virtio"
    await ns.driver().set_net(kind, guest_id, NetBody(
        bridge=bridge, model=model if model in QEMU_MODELS else "virtio",
        macaddr=(cur or {}).get("macaddr"), firewall=False, name=(cur or {}).get("name") or None,
        ip="dhcp" if kind == "lxc" else None), idx)
    return {"guest_type": guest_type, "guest_id": guest_id, "net_id": f"net{idx}", "previous": cur}


async def _restore_nic(m: dict) -> None:
    kind, idx = _kind(m["guest_type"]), int(m["net_id"][3:])
    cur = m.get("previous")
    try:
        if cur is None:
            await ns.driver().delete_net(kind, m["guest_id"], idx)
            return
        tag = cur.get("tag")
        await ns.driver().set_net(kind, m["guest_id"], NetBody(
            bridge=cur.get("bridge") or settings.default_bridge, tag=tag, trunks=cur.get("trunks"),
            model=cur.get("model") if cur.get("model") in QEMU_MODELS else "virtio",
            macaddr=cur.get("macaddr"), rate=cur.get("rate"), link_down=bool(cur.get("link_down")),
            firewall=bool(cur.get("firewall")), name=cur.get("name") or None, **ns._keep_ip(cur)), idx)
    except HTTPException as e:
        if e.status_code != 404:  # a guest deleted meanwhile has nothing to restore
            raise


@router.post("/labs/sandbox")
async def create_lab(body: LabBody):
    d = ns.driver()
    rows = await get_provider().guest_rows()
    have = {(("vm" if g["type"] == "qemu" else "lxc"), int(g["vmid"])) for g in rows if g.get("type") in ("qemu", "lxc")}
    for g in body.guests:
        if (g.guest_type, g.guest_id) not in have:
            raise HTTPException(404, f"{g.guest_type} {g.guest_id} does not exist")
    await need("dnsmasq", "dnsmasq_missing")
    async with _lock:
        model, pending = await ns.current()
        if pending:
            raise HTTPException(409, "Other network changes are pending: apply or discard them in Network & Virtual Switch first")
        if clash := overlaps(body.gateway_cidr, model):
            raise HTTPException(409, f"{ipaddress.ip_interface(body.gateway_cidr).network} overlaps the subnet of {clash}")
        vlan_map = await ns.vlans()
        vid = body.vlan_id or next(v for v in range(900, 4095) if str(v) not in vlan_map)
        if str(vid) in vlan_map:
            raise HTTPException(409, f"VLAN {vid} already exists")
        bridge = free_bridge(model, d.BRIDGE_PREFIX, d.BRIDGE_RE)
        lab_id = secrets.token_hex(4)
        b = model[bridge] = ns.blank(bridge, "bridge")
        b.update(mode="isolated", airgap=True, comment=f"Lab: {body.name}", method="static", address=body.gateway_cidr)
        await ns.apply_model(model)
        await ns.confirm()  # an added internal switch cannot cut the host off; this call reaching the host proves it
        dhcp = body.dhcp()
        vlan_map[str(vid)] = {"name": body.name, "color": "#f59e0b", "bridge": bridge, "host_ipv4_cidr": body.gateway_cidr,
                              "description": "Isolated lab sandbox", "dhcp_config": dhcp.model_dump(), "lab": lab_id}
        await ns.save_vlans(vlan_map)
        await _dhcp_up(vid, bridge, dhcp)
        lab = {"id": lab_id, "name": body.name, "bridge": bridge, "vlan_id": vid, "gateway_cidr": body.gateway_cidr,
               "range_start": body.range_start, "range_end": body.range_end, "members": [],
               "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        labs = _labs()
        labs.append(lab)
        _save(LABS, labs)
    errors = []
    for g in body.guests:
        try:
            lab["members"].append(await _move_nic(g.guest_type, g.guest_id, bridge))
        except HTTPException as e:
            errors.append(f"{g.guest_type} {g.guest_id}: {e.detail}")
        _save(LABS, [lab if x["id"] == lab_id else x for x in _labs()])
    return {"ok": True, "lab": lab, "errors": errors}


@router.delete("/labs/sandbox/{lab_id}")
async def delete_lab(lab_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    async with _lock:
        lab = next((x for x in _labs() if x["id"] == lab_id), None)
        if lab is None:
            raise HTTPException(404, "This lab does not exist")
        model, pending = await ns.current()
        if pending:
            raise HTTPException(409, "Other network changes are pending: apply or discard them in Network & Virtual Switch first")
        for m in lab["members"]:
            await _restore_nic(m)
        await _dhcp_down(lab["vlan_id"])
        vlan_map = await ns.vlans()
        if (vlan_map.get(str(lab["vlan_id"])) or {}).get("lab") == lab_id:
            del vlan_map[str(lab["vlan_id"])]
            await ns.save_vlans(vlan_map)
        if lab["bridge"] in model:
            for n in [n for n, i in model.items() if i["raw"] == lab["bridge"] or n == lab["bridge"]]:
                del model[n]
            await ns.apply_model(model)
            await ns.confirm()
        _save(LABS, [x for x in _labs() if x["id"] != lab_id])
    return {"ok": True}


# ---------------------------------------------------------------- Routes: per-guest devices


async def guest_view(guest_type: str, guest_id: int) -> dict:
    g = await _guest(guest_type, guest_id)
    prof = profile(guest_type, guest_id)
    try:
        nets = await ns._nets(_kind(guest_type), guest_id)
    except HTTPException:
        nets = []
    return {"guest_type": guest_type, "guest_id": guest_id, "running": g.get("status") == "running",
            "devices": [{**d, "bus": CATALOG[d["type"]]["bus"], "category": CATALOG[d["type"]]["category"],
                         "hotplug": CATALOG[d["type"]]["hotplug"], "driver_compat": "universal_inbox"}
                        for d in prof["devices"] if d["type"] in CATALOG],
            "throttling": prof["throttling"],
            "nics": [{"net_id": n["key"], "model": n.get("model") or "veth", "bridge": n.get("bridge") or "",
                      "macaddr": n.get("macaddr")} for n in nets]}


@router.get("/{guest_type}/{guest_id}")
async def get_guest(guest_type: GuestTypeT, guest_id: int = GUEST_ID):
    return await guest_view(guest_type, guest_id)


class DeviceBody(BaseModel):
    type: Literal[tuple(CATALOG)]  # type: ignore[valid-type]
    options: dict = {}


@router.post("/{guest_type}/{guest_id}/devices")
async def add_device(body: DeviceBody, guest_type: GuestTypeT, guest_id: int = GUEST_ID):
    spec = CATALOG[body.type]
    if guest_type not in spec["guest_types"]:
        raise HTTPException(422, f"{body.type} is not available for a {'VM' if guest_type == 'vm' else 'container'}")
    g = await _guest(guest_type, guest_id)
    opts = clean_options(body.type, body.options)
    if body.type == "virtual_nvme" and not opts["serial"]:
        opts["serial"] = f"SDNVME{secrets.token_hex(4).upper()}"
    if body.type == "legacy_nic" and not opts["bridge"]:
        opts["bridge"] = settings.default_bridge
    kind, d = _kind(guest_type), driver()
    async with _lock:
        prof = profile(guest_type, guest_id)
        if spec.get("single") and any(x["type"] == body.type for x in prof["devices"]):
            raise HTTPException(409, "This guest already has this device")
        if spec["category"] == "audio" and any(CATALOG[x["type"]]["category"] == "audio" for x in prof["devices"]):
            raise HTTPException(409, "This guest already has a sound card: remove it first")
        dev = {"id": secrets.token_hex(3), "type": body.type, "options": opts, "state": {},
               "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        if body.type == "virtual_camera":
            used = {x["state"].get("video_nr") for p in _load(PROFILES, {}).values() for x in p.get("devices", [])}
            dev["state"]["video_nr"] = await vcam_start(guest_type, guest_id, dev, used)
        if body.type == "hd_audio" and kind == "lxc":
            dev["state"]["snd"] = await snd_nodes()
        if body.type == "hayes_modem" and kind == "lxc":
            if g.get("status") != "running":
                raise HTTPException(409, "Start the container first: the modem is installed inside it")
            out = await get_provider().container_exec(guest_id, modem_container_script(dev), timeout=60)
            dev["state"]["tty"] = out.strip().splitlines()[-1] if out.strip() else "/dev/ttyS0"
        else:
            try:
                dev["state"].update(await d.attach(kind, guest_id, dev) or {})
            except Exception:
                if "video_nr" in dev["state"]:
                    await vcam_stop(dev["state"]["video_nr"])
                raise
            if body.type == "hayes_modem":
                await modem_vm_start(guest_id, dev, dev["state"]["socket"])
        prof["devices"].append(dev)
        _store(guest_type, guest_id, prof)
    # Container device nodes and in-container services apply live; VM hardware outside hot-plug waits for a power cycle.
    running = g.get("status") == "running" and kind == "qemu"
    return {"ok": True, "device": dev, "restart_required": running and not spec["hotplug"]}


@router.delete("/{guest_type}/{guest_id}/devices/{device_id}")
async def remove_device(guest_type: GuestTypeT, guest_id: int = GUEST_ID, device_id: str = Path(pattern=r"^[0-9a-f]{6}$")):
    kind = _kind(guest_type)
    async with _lock:
        prof = profile(guest_type, guest_id)
        dev = next((x for x in prof["devices"] if x["id"] == device_id), None)
        if dev is None:
            raise HTTPException(404, "This device does not exist")
        rows = await get_provider().guest_rows()
        exists = any(g.get("type") == kind and int(g.get("vmid", 0)) == guest_id for g in rows)
        running = any(g.get("type") == kind and int(g.get("vmid", 0)) == guest_id and g.get("status") == "running" for g in rows)
        if exists:
            if dev["type"] == "hayes_modem" and kind == "lxc":
                if running:
                    await get_provider().container_exec(guest_id, modem_container_script(dev, remove=True), timeout=60)
            else:
                await driver().detach(kind, guest_id, dev)
        if "video_nr" in dev["state"]:
            await vcam_stop(dev["state"]["video_nr"])
        if dev["type"] == "hayes_modem" and kind == "qemu":
            await modem_vm_stop(guest_id, dev)
        if dev["type"] == "virtual_nvme" and dev["state"].get("image"):
            await host_ssh.run(f"rm -f {shlex.quote(dev['state']['image'])}")
        prof["devices"] = [x for x in prof["devices"] if x["id"] != device_id]
        _store(guest_type, guest_id, prof)
    # A running container keeps removed device nodes until it restarts; VM hardware outside hot-plug needs a power cycle.
    cold = not CATALOG[dev["type"]]["hotplug"] if kind == "qemu" else bool(dev["state"].get("keys"))
    return {"ok": True, "restart_required": running and cold}


# ---------------------------------------------------------------- Routes: detailed view, identity editor, re-patching


async def _leases() -> dict[str, str]:
    """Guest IPv4 addresses from the host's DHCP leases, by upper-case MAC."""
    txt = await host_ssh.run("cat /var/lib/misc/dnsmasq.vlan-*.leases /var/lib/misc/dnsmasq.leases 2>/dev/null; true",
                             check=False)
    return {x["mac"]: x["ip"] for x in ns.parse_leases(txt, [])}


def _lab_index() -> dict[tuple, dict]:
    return {(m["guest_type"], int(m["guest_id"]), m["net_id"]): lab for lab in _labs() for m in lab["members"]}


async def placement(kind: str, guest_id: int) -> dict:
    """Where the guest runs: the standalone host, or its cluster host with HA roles and floating VIPs."""
    st = cluster.load()
    if not cluster.in_cluster(st):
        return {"mode": "standalone", "host": st["self"], "host_ip": get_provider().host_address()}
    hosts = st["shared"]["hosts"]
    try:
        cur = (await cluster.find_guest(st, kind, guest_id)).get("host")
    except HTTPException:
        cur = None
    pol = st["shared"]["ha_policies"].get(cluster.key_of(kind, guest_id)) or {}
    return {"mode": "cluster", "cluster_name": st["shared"]["name"], "host": cur,
            "host_ip": (hosts.get(cur) or {}).get("address"), "ha_enabled": bool(pol.get("enabled")),
            "preferred_active_host": pol.get("preferred_active_host"),
            "passive_standby_hosts": pol.get("passive_standby_hosts", []),
            "replication_interval_minutes": pol.get("replication_interval_minutes"),
            "floating_vips": st["shared"]["vips"]}


@router.get("/{guest_type}/{guest_id}/detailed")
async def get_detailed(guest_type: GuestTypeT, guest_id: int = GUEST_ID):
    """Everything the Wireframe Node Architect draws: specs, virtual devices with identity, NICs with their endpoint,
    passthrough devices, disks and host / cluster placement."""
    base = await guest_view(guest_type, guest_id)
    kind, p = _kind(guest_type), get_provider()

    async def safe(coro, default):
        try:
            return await coro
        except Exception:  # noqa: BLE001 - one missing source must not blank the whole view
            return default

    cfg, hw, vlan_map, leases, (_links, facts), where = await asyncio.gather(
        safe(p.get_guest_config(kind, guest_id), {}), safe(ns.driver().hardware(kind, guest_id), {}),
        safe(ns.vlans(), {}), safe(_leases(), {}), safe(ns.live(), ({}, {"dhcp": {}})),
        safe(placement(kind, guest_id), {"mode": "standalone"}))
    devs = (hw or {}).get("devices") or {}
    labs, labels = _lab_index(), profile(guest_type, guest_id)["nic_labels"]
    nics = []
    for n in devs.get("net", []):
        ips = [leases[n["macaddr"].upper()]] if n.get("macaddr") and n["macaddr"].upper() in leases else []
        if n.get("ip") and "/" in str(n["ip"]):
            ips.append(n["ip"].split("/")[0])
        nics.append(nic_view(n, labels.get(n["key"], ""), vlan_map, ips,
                             labs.get((guest_type, guest_id, n["key"])), facts.get("dhcp", {})))
    by_id = {d["id"]: d for d in profile(guest_type, guest_id)["devices"]}
    return {**base, "name": cfg.get("name") or str(guest_id), "cores": cfg.get("cores"), "sockets": cfg.get("sockets"),
            "memory_mb": cfg.get("memory"), "os_profile": (hw.get("options") or {}).get("ostype") if hw else None,
            "devices": [{**d, "identity": identity_view(by_id[d["id"]])} for d in base["devices"]],
            "nics": nics, "passthrough": {"pci": devs.get("hostpci", []), "usb": devs.get("usb", [])},
            "disks": cfg.get("disks", []), "placement": where, "driver": settings.hypervisor_driver}


class IdentityBody(BaseModel):
    # Fits a V4L2 card name (32 bytes) and a quoted modprobe argument.
    device_name: str = Field("", pattern=r"^([A-Za-z0-9][A-Za-z0-9 ._()+-]{0,30})?$")
    vendor_id: str = Field("", pattern=r"^((0x)?[0-9a-fA-F]{4})?$")
    device_id: str = Field("", pattern=r"^((0x)?[0-9a-fA-F]{4})?$")
    serial_number: str = Field("", pattern=r"^[A-Za-z0-9-]{0,20}$")
    pci_or_usb_address: str = Field("", pattern=r"^[0-9A-Za-z:./-]{0,24}$")


class DeviceUpdate(BaseModel):
    """PUT body: `options` / `identity` for a virtual device; the NIC fields for net0 … net7. Omitted fields keep
    their value; a NIC's `vlan_tag: null` removes the tag."""
    options: dict | None = None
    identity: IdentityBody | None = None
    interface_name: str | None = Field(None, pattern=r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,30}$")
    mac_address: str | None = Field(None, pattern=MAC_RE)
    model: Literal[QEMU_MODELS] | None = None  # type: ignore[valid-type]
    bridge: str | None = Field(None, pattern=ns.IFACE_RE)
    vlan_tag: int | None = Field(None, ge=1, le=4094)
    trunks: list[int] | None = Field(None, max_length=64)
    link_up: bool | None = None
    rate_mbps: float | None = Field(None, gt=0, le=800_000)

    @model_validator(mode="after")
    def _check(self):
        if self.trunks and not all(1 <= t <= 4094 for t in self.trunks):
            raise ValueError("Trunk VLANs must be 1-4094")
        if self.mac_address and not unicast_mac(self.mac_address):
            raise ValueError("Use a unicast MAC address (the lowest bit of the first byte must be 0)")
        return self


NIC_FIELDS = ("interface_name", "mac_address", "model", "bridge", "vlan_tag", "trunks", "link_up", "rate_mbps")


async def _update_nic(body: DeviceUpdate, guest_type: str, guest_id: int, net_id: str) -> dict:
    kind, f = _kind(guest_type), body.model_fields_set
    if f & {"options", "identity"}:
        raise HTTPException(422, "A network interface has no options or identity block: send its fields directly")
    cur = next((n for n in await ns._nets(kind, guest_id) if n["key"] == net_id), None)
    if cur is None:
        raise HTTPException(404, f"{guest_type} {guest_id} has no {net_id}")
    if kind == "lxc" and body.model:
        raise HTTPException(422, "Containers use a virtual Ethernet pair: the NIC model applies to VMs only")
    name = cur.get("name") or None
    if "interface_name" in f and kind == "lxc":
        if not re.fullmatch(r"eth\d{1,2}", body.interface_name or ""):
            raise HTTPException(422, "A container interface name must be eth0 … eth99")
        name = body.interface_name
    pick = lambda k, old: getattr(body, k) if k in f else old  # noqa: E731
    bridge = pick("bridge", None) or cur.get("bridge") or settings.default_bridge
    tag = pick("vlan_tag", cur.get("tag"))
    trunks = (";".join(map(str, sorted(set(body.trunks or [])))) or None) if "trunks" in f else cur.get("trunks")
    rate = body.rate_mbps / 8 if "rate_mbps" in f and body.rate_mbps else (None if "rate_mbps" in f else cur.get("rate"))
    model = body.model or cur.get("model") or "virtio"
    extra = await ns._ensure_vlan_aware(bridge, bool(tag or trunks))
    await ns.driver().set_net(kind, guest_id, NetBody(
        bridge=bridge, tag=tag, trunks=trunks, model=model if model in QEMU_MODELS else "virtio",
        macaddr=pick("mac_address", cur.get("macaddr")), rate=rate,
        link_down=not body.link_up if "link_up" in f and body.link_up is not None else bool(cur.get("link_down")),
        firewall=bool(cur.get("firewall")), name=name, **ns._keep_ip(cur)), int(net_id[3:]))
    if "interface_name" in f and kind == "qemu":  # a VM NIC's name is a SolarDeck label
        async with _lock:
            prof = profile(guest_type, guest_id)
            prof["nic_labels"] = {**prof["nic_labels"], net_id: body.interface_name or ""}
            _store(guest_type, guest_id, prof)
    return {"ok": True, "net_id": net_id, **extra}


@router.put("/{guest_type}/{guest_id}/devices/{device_id}")
async def update_device(body: DeviceUpdate, guest_type: GuestTypeT, guest_id: int = GUEST_ID,
                        device_id: str = Path(pattern=r"^([0-9a-f]{6}|net[0-7])$")):
    """Edit a device's hardware metadata. Virtual devices: options (the feed of a camera, a modem's dial target, an
    HBA model …) and identity overrides; `guest_visible` in the detailed view says which identity fields the guest
    itself shows. NICs (net0 … net7): name, MAC, model, switch, VLAN tag, trunks, link and rate, applied at once."""
    if device_id.startswith("net"):
        return await _update_nic(body, guest_type, guest_id, device_id)
    if body.model_fields_set & set(NIC_FIELDS):
        raise HTTPException(422, "NIC fields apply to net0 … net7 only")
    g = await _guest(guest_type, guest_id)
    kind = _kind(guest_type)
    notes: list[str] = []
    async with _lock:
        prof = profile(guest_type, guest_id)
        dev = next((x for x in prof["devices"] if x["id"] == device_id), None)
        if dev is None:
            raise HTTPException(404, "This device does not exist")
        t, old = dev["type"], dict(dev["options"])
        opts = clean_options(t, {**old, **(body.options or {})}) if body.options is not None else dict(old)
        ident = {**{k: "" for k in IDENTITY_KEYS}, **(dev.get("identity") or {})}
        if body.identity is not None:
            given = body.identity.model_dump(exclude_unset=True)
            ident.update({k: hex_id(v) if k in ("vendor_id", "device_id") else v.strip() for k, v in given.items()})
            if t == "virtual_nvme" and given.get("serial_number"):
                opts["serial"] = given["serial_number"]
        if t == "virtual_nvme" and opts["size_gb"] != old.get("size_gb"):
            raise HTTPException(422, "The size of an emulated NVMe drive is fixed once it exists")
        if t == "legacy_nic" and opts != old:
            raise HTTPException(422, "Edit this card's model and switch in its network interface")
        changed = opts != old
        if changed and t == "virtual_camera":
            await vcam_start(guest_type, guest_id, {**dev, "options": opts}, set(), nr=dev["state"]["video_nr"])
        elif changed and t == "hayes_modem":
            if kind == "qemu":
                await modem_vm_start(guest_id, {**dev, "options": opts}, dev["state"]["socket"])
            elif g.get("status") == "running":
                await get_provider().container_exec(guest_id, modem_container_script({**dev, "options": opts}), timeout=60)
            else:
                notes.append("modem_applies_at_start")
        elif changed and kind == "qemu":
            d = driver()
            await d.detach(kind, guest_id, dev)
            new = {**dev, "options": opts}
            dev["state"] = {**dev["state"], **(await d.attach(kind, guest_id, new) or {})}
        relabel = t == "virtual_camera" and ident["device_name"] != (dev.get("identity") or {}).get("device_name", "")
        dev["options"], dev["identity"] = opts, ident
        _store(guest_type, guest_id, prof)
    if relabel and not await vcam_relabel():
        notes.append("camera_name_applies_at_reload")
    running = g.get("status") == "running"
    return {"ok": True, "device": {**dev, "identity": identity_view(dev)}, "notes": notes,
            "restart_required": running and kind == "qemu" and changed and not CATALOG[t]["hotplug"]}


class RepatchBody(BaseModel):
    net_id: str = Field("net0", pattern=r"^net[0-7]$")
    bridge: str | None = Field(None, pattern=ns.IFACE_RE)
    vlan_tag: int | None = Field(None, ge=1, le=4094)
    lab_id: str | None = Field(None, pattern=r"^[0-9a-f]{8}$")

    @model_validator(mode="after")
    def _one(self):
        if bool(self.bridge) == bool(self.lab_id):
            raise ValueError("Give either a switch (bridge, optional vlan_tag) or an isolated lab (lab_id)")
        if self.lab_id and self.vlan_tag:
            raise ValueError("A lab sandbox port is untagged")
        return self


@router.post("/{guest_type}/{guest_id}/repatch-endpoint")
async def repatch_endpoint(body: RepatchBody, guest_type: GuestTypeT, guest_id: int = GUEST_ID):
    """Move one guest NIC to another virtual switch / physical bridge / router bridge, VLAN or isolated lab in one
    call. The NIC keeps its MAC, model, rate and link state; trunks are dropped (the port becomes an access port).
    Joining a lab records the NIC's previous endpoint, so deleting the lab puts it back."""
    kind, idx = _kind(guest_type), int(body.net_id[3:])
    async with _lock:
        labs = _labs()
        lab = next((x for x in labs if x["id"] == body.lab_id), None) if body.lab_id else None
        if body.lab_id and lab is None:
            raise HTTPException(404, "This lab does not exist")
        cur = next((n for n in await ns._nets(kind, guest_id) if n["key"] == body.net_id), None)
        if cur is None:
            raise HTTPException(404, f"{guest_type} {guest_id} has no {body.net_id}")
        bridge = lab["bridge"] if lab else body.bridge
        extra = await ns._ensure_vlan_aware(bridge, bool(body.vlan_tag))
        ip = {"ip": "dhcp", "gw": None, "ip6": None} if lab and kind == "lxc" else ns._keep_ip(cur)
        await ns.driver().set_net(kind, guest_id, NetBody(
            bridge=bridge, tag=body.vlan_tag, model=cur.get("model") if cur.get("model") in QEMU_MODELS else "virtio",
            macaddr=cur.get("macaddr"), rate=cur.get("rate"), link_down=bool(cur.get("link_down")),
            firewall=bool(cur.get("firewall")), name=cur.get("name") or None, **ip), idx)
        # Lab membership: leave the old lab (keeping the original endpoint when hopping lab to lab), join the new one.
        me = (guest_type, guest_id, body.net_id)
        old = next((m for x in labs for m in x["members"] if (m["guest_type"], int(m["guest_id"]), m["net_id"]) == me), None)
        for x in labs:
            x["members"] = [m for m in x["members"] if (m["guest_type"], int(m["guest_id"]), m["net_id"]) != me]
        if lab:
            lab["members"].append({"guest_type": guest_type, "guest_id": guest_id, "net_id": body.net_id,
                                   "previous": old["previous"] if old else cur})
        _save(LABS, labs)
    return {"ok": True, "net_id": body.net_id, "bridge": bridge, "vlan_tag": body.vlan_tag,
            "lab_id": lab["id"] if lab else None, **extra}


# ---------------------------------------------------------------- Routes: throttling


class NicShape(BaseModel):
    preset: Literal[tuple(PRESETS) + ("custom",)] = "native"  # type: ignore[valid-type]
    rate_kbps: int | None = Field(None, ge=8, le=10_000_000)
    latency_ms: int = Field(0, ge=0, le=5000)
    jitter_ms: int = Field(0, ge=0, le=1000)
    packet_loss_pct: float = Field(0, ge=0, le=100)


class ThrottleBody(BaseModel):
    cpu_limit_percent: int = Field(100, ge=5, le=100)
    cpu_model: Literal[CPU_MODELS] | None = None  # type: ignore[valid-type]
    nics: dict[str, NicShape] = Field({}, max_length=8)

    @model_validator(mode="after")
    def _check(self):
        if bad := [k for k in self.nics if not re.fullmatch(r"net[0-7]", k)]:
            raise ValueError(f"Unknown NIC {bad[0]}: use net0 … net7")
        return self


async def apply_shaping(guest_type: str, guest_id: int, nics: dict, only_missing: bool = False) -> list[str]:
    """Shape the running guest's interfaces; returns the NIC ids that are not up right now."""
    ifaces = await driver().host_ifaces(_kind(guest_type), guest_id)
    lines, down = [], []
    for net_id, nic in nics.items():
        iface = ifaces.get(net_id)
        if not iface:
            down.append(net_id)
            continue
        cmd = tc_script(iface, shape_of(nic))
        if only_missing and shape_of(nic):
            cmd = f"tc qdisc show dev {shlex.quote(iface)} 2>/dev/null | grep -q netem || {{ {cmd}; }}"
        lines.append(f"[ -e /sys/class/net/{shlex.quote(iface)} ] && {{ {cmd}; }}")
    if lines:
        await host_ssh.run("\n".join(lines) + "\ntrue", timeout=30)
    return down


@router.put("/{guest_type}/{guest_id}/throttling")
async def set_throttling(body: ThrottleBody, guest_type: GuestTypeT, guest_id: int = GUEST_ID):
    g = await _guest(guest_type, guest_id)
    kind = _kind(guest_type)
    if kind == "lxc" and body.cpu_model:
        raise HTTPException(422, "Containers share the host CPU: a CPU model applies to VMs only")
    async with _lock:
        prof = profile(guest_type, guest_id)
        old = prof["throttling"]
        cpu_changed = (body.cpu_limit_percent, body.cpu_model) != (old.get("cpu_limit_percent", 100), old.get("cpu_model"))
        if cpu_changed:
            await driver().set_cpu(kind, guest_id, body.cpu_limit_percent,
                                   body.cpu_model if body.cpu_model != old.get("cpu_model") else None)
        nics = {k: v.model_dump() for k, v in body.nics.items()}
        # NICs that drop out of the request go back to native speed.
        changed = {k: v for k, v in nics.items() if v != old.get("nics", {}).get(k)}
        changed |= {k: {"preset": "native"} for k in old.get("nics", {}) if k not in nics}
        down = await apply_shaping(guest_type, guest_id, changed) if changed and g.get("status") == "running" else []
        prof["throttling"] = {"cpu_limit_percent": body.cpu_limit_percent, "cpu_model": body.cpu_model,
                              "nics": {k: v for k, v in nics.items() if v["preset"] != "native"}}
        _store(guest_type, guest_id, prof)
    return {"ok": True, "throttling": prof["throttling"], "waiting_for_start": down,
            "restart_required": g.get("status") == "running" and body.cpu_model != old.get("cpu_model")}


async def shaping_loop() -> None:
    """A guest's host-side interface is recreated at every start: re-apply missing shaping every 20 s."""
    while True:
        await asyncio.sleep(20)
        try:
            items = [(k, p["throttling"]["nics"]) for k, p in _load(PROFILES, {}).items()
                     if (p.get("throttling") or {}).get("nics")]
            if not items:
                continue
            running = {(("vm" if g["type"] == "qemu" else "lxc"), int(g["vmid"])) for g in await get_provider().guest_rows()
                       if g.get("status") == "running"}
            for key, nics in items:
                gt, gid = key.split("/")
                if (gt, int(gid)) in running:
                    await apply_shaping(gt, int(gid), nics, only_missing=True)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a host hiccup must not end the loop
            continue

