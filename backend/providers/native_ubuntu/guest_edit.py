"""Guest editing on SolarOS: NICs, PCI/USB passthrough, cloud-init and options for libvirt VMs and Incus containers.

Shadows the Proxmox-only app.guest_hardware routes with the same paths, request models and response shapes, so the
VM / container drawer works unchanged. VM changes are written to the persistent libvirt definition and apply at the
next start of a running VM; container changes go through `incus config`.
"""
import asyncio
import json
import re
import shutil
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path as FsPath

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from app.auth import require_user
from app.guest_hardware import VMID, CloudInitBody, GuestType, NetBody, OptionsBody
from app.provisioning import PciPassthrough, UsbPassthrough

from . import host
from .host import run, run_json
from .provider import LOCAL, _bridge, _store_dir, _volume_file

router = APIRouter(prefix="/api/v1/guests", dependencies=[Depends(require_user)], tags=["native_ubuntu"])
AGENT = "org.qemu.guest_agent.0"
USB_ID_RE = re.compile(r"^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$")


# ---------------------------------------------------------------- Pure helpers: libvirt domain XML (unit tested)


def _int(v: str | None) -> int:
    return int(v, 16) if v and v.lower().startswith("0x") else int(v or 0)


def vm_devices(xml: str) -> dict:
    """Domain XML -> {"hostpci", "usb", "net"} in the shapes of app.guest_hardware.list_devices."""
    d = ET.fromstring(xml)
    nets = []
    for i, el in enumerate(d.findall("devices/interface")):
        src, mac, model, tag = el.find("source"), el.find("mac"), el.find("model"), el.find("vlan/tag")
        out_bw, link = el.find("bandwidth/outbound"), el.find("link")
        nets.append({"key": f"net{i}", "index": i, "raw": "",
                     "model": model.get("type", "virtio") if model is not None else "virtio",
                     "macaddr": (mac.get("address") or "").upper() or None if mac is not None else None,
                     "link_down": link is not None and link.get("state") == "down",
                     "bridge": (src.get("bridge") or src.get("network") or "") if src is not None else "",
                     "tag": int(tag.get("id")) if tag is not None else None, "firewall": False,
                     "rate": round(int(out_bw.get("average")) / 1024, 2) if out_bw is not None else None})
    pci, usb = [], []
    for el in d.findall("devices/hostdev"):
        if el.get("type") == "pci" and el.find("source/address") is not None:
            a = el.find("source/address")
            dev = f"{_int(a.get('bus')):02x}:{_int(a.get('slot')):02x}.{_int(a.get('function'))}"
            if _int(a.get("domain")):
                dev = f"{_int(a.get('domain')):04x}:{dev}"
            pci.append({"key": f"hostpci{len(pci)}", "index": len(pci), "raw": "", "id": dev, "mapping": None,
                        "pcie": True, "rombar": True, "x_vga": False, "all_functions": False})
        elif el.get("type") == "usb" and el.find("source/vendor") is not None and el.find("source/product") is not None:
            vid, pid = _int(el.find("source/vendor").get("id")), _int(el.find("source/product").get("id"))
            usb.append({"key": f"usb{len(usb)}", "index": len(usb), "raw": "", "host": f"{vid:04x}:{pid:04x}",
                        "usb3": False})
    return {"hostpci": pci, "usb": usb, "net": nets}


def _replace(devs: ET.Element, items: list[ET.Element], idx: int, new: ET.Element | None, what: str) -> None:
    """Replace items[idx] with `new`, remove it (new=None) or append `new` (idx past the end)."""
    if idx < len(items):
        pos = list(devs).index(items[idx])
        devs.remove(items[idx])
        if new is not None:
            devs.insert(pos, new)
    elif new is None:
        raise HTTPException(404, f"{what}{idx} does not exist")
    else:
        devs.append(new)


def nic_element(b: NetBody, old_mac: str | None = None) -> ET.Element:
    el = ET.Element("interface", type="bridge")
    ET.SubElement(el, "source", bridge=_bridge(b.bridge))
    mac = b.macaddr or old_mac
    if mac:
        ET.SubElement(el, "mac", address=mac.lower())
    ET.SubElement(el, "model", type=b.model)
    if b.rate:
        kib = str(int(b.rate * 1024))  # MB/s -> KiB/s
        bw = ET.SubElement(el, "bandwidth")
        ET.SubElement(bw, "inbound", average=kib)
        ET.SubElement(bw, "outbound", average=kib)
    return el


def set_interface(xml: str, idx: int, b: NetBody | None) -> str:
    """Domain XML with NIC `idx` replaced (its MAC kept unless given), added (idx past the end) or removed (b=None)."""
    d = ET.fromstring(xml)
    devs = d.find("devices")
    nics = devs.findall("interface")
    old = nics[idx] if idx < len(nics) else None
    old_mac = old.find("mac").get("address") if old is not None and old.find("mac") is not None else None
    _replace(devs, nics, idx, nic_element(b, old_mac) if b else None, "net")
    return ET.tostring(d, encoding="unicode")


def set_hostdev(xml: str, kind: str, idx: int, el: ET.Element | None) -> str:
    """Domain XML with the idx-th <hostdev type=kind> replaced, added or removed."""
    d = ET.fromstring(xml)
    devs = d.find("devices")
    _replace(devs, [h for h in devs.findall("hostdev") if h.get("type") == kind], idx, el,
             "hostpci" if kind == "pci" else "usb")
    return ET.tostring(d, encoding="unicode")


def set_flag_device(xml: str, which: str, on: bool) -> str:
    """Add or remove the guest-agent channel (which="agent") or the USB tablet (which="tablet")."""
    d = ET.fromstring(xml)
    devs = d.find("devices")
    if which == "agent":
        found = [c for c in devs.findall("channel") if c.find("target") is not None and c.find("target").get("name") == AGENT]
    else:
        found = [i for i in devs.findall("input") if i.get("type") == "tablet"]
    if on and not found:
        if which == "agent":
            ch = ET.SubElement(devs, "channel", type="unix")
            ET.SubElement(ch, "target", type="virtio", name=AGENT)
        else:
            ET.SubElement(devs, "input", type="tablet", bus="usb")
    for el in found if not on else []:
        devs.remove(el)
    return ET.tostring(d, encoding="unicode")


def attach_cdrom(xml: str, path: str) -> str:
    """Domain XML with a read-only SATA CD-ROM for `path` (unchanged if one already points there)."""
    d = ET.fromstring(xml)
    devs = d.find("devices")
    used = set()
    for disk in devs.findall("disk"):
        src, tgt = disk.find("source"), disk.find("target")
        if src is not None and src.get("file") == path:
            return xml
        if tgt is not None:
            used.add(tgt.get("dev"))
    dev = next(f"sd{c}" for c in "abcdefghijklmnopqrstuvwxyz" if f"sd{c}" not in used)
    el = ET.SubElement(devs, "disk", type="file", device="cdrom")
    ET.SubElement(el, "driver", name="qemu", type="raw")
    ET.SubElement(el, "source", file=path)
    ET.SubElement(el, "target", dev=dev, bus="sata")
    ET.SubElement(el, "readonly")
    return ET.tostring(d, encoding="unicode")


def install_cdrom(xml: str, seed_suffix: str = "-cloudinit.iso") -> tuple[str | None, str | None]:
    """(target dev, ISO path or None) of the first CD-ROM that is not the cloud-init seed; (None, None) if none."""
    for disk in ET.fromstring(xml).findall("devices/disk"):
        src, tgt = disk.find("source"), disk.find("target")
        path = src.get("file") if src is not None else None
        if disk.get("device") == "cdrom" and tgt is not None and not (path or "").endswith(seed_suffix):
            return tgt.get("dev"), path
    return None, None


def set_cdrom(xml: str, path: str | None) -> str:
    """Domain XML with the install CD-ROM loaded with `path` (added if missing) or ejected (path=None)."""
    dev, _ = install_cdrom(xml)
    if dev is None:
        if not path:
            return xml
        d = ET.fromstring(attach_cdrom(xml, path))
        host.set_boot_order(d)
        return ET.tostring(d, encoding="unicode")
    d = ET.fromstring(xml)
    disk = next(x for x in d.findall("devices/disk") if x.find("target") is not None and x.find("target").get("dev") == dev)
    src = disk.find("source")
    if path is None:
        if src is not None:
            disk.remove(src)
    elif src is None:
        disk.insert(1, ET.Element("source", file=path))
    else:
        src.set("file", path)
    host.set_boot_order(d)
    return ET.tostring(d, encoding="unicode")


def iso_volid(path: str | None) -> str | None:
    p = FsPath(path) if path else None
    return f"{LOCAL}:iso/{p.name}" if p and p.parent == _store_dir("iso") else path


def has_file(xml: str, path: str) -> bool:
    return any(s.get("file") == path for s in ET.fromstring(xml).findall("devices/disk/source"))


def vm_options(xml: str, autostart: bool, meta: dict) -> dict:
    d = ET.fromstring(xml)
    cpu = d.find("cpu")
    return {"name": d.findtext("name"), "onboot": int(autostart), "startup": None, "protection": None, "boot": None,
            "agent": int(any(t.get("name") == AGENT for t in d.findall("devices/channel/target"))),
            "ostype": meta.get("ostype"), "machine": (d.find("os/type").get("machine") if d.find("os/type") is not None else None),
            "bios": "ovmf" if d.find("os/loader") is not None else "seabios",
            "cpu": "host" if cpu is not None and cpu.get("mode") == "host-passthrough" else (cpu.findtext("model") if cpu is not None else None),
            "numa": None, "hotplug": None, "tablet": int(any(i.get("type") == "tablet" for i in d.findall("devices/input")))}


# ---------------------------------------------------------------- Pure helpers: cloud-init and Incus (unit tested)


def parse_ipconfig(v: str) -> dict:
    """Proxmox-style "ip=dhcp" / "ip=10.0.0.5/24,gw=10.0.0.1" -> {"ip": ..., "gw": ...}."""
    return dict(p.split("=", 1) for p in v.split(",") if "=" in p)


def ci_network_config(ipconfig: dict[str, str], macs: list[str], nameserver: str = "", searchdomain: str = "") -> str:
    """Netplan v2 network-config for cloud-init: ipconfigN applies to the N-th NIC (matched by MAC)."""
    eth = {}
    for key in sorted(ipconfig):
        i = int(key.removeprefix("ipconfig"))
        if i >= len(macs) or not macs[i]:
            continue
        p = parse_ipconfig(ipconfig[key])
        cfg: dict = {"match": {"macaddress": macs[i].lower()}, "set-name": f"eth{i}"}
        if p.get("ip", "dhcp") == "dhcp":
            cfg["dhcp4"] = True
        elif p.get("ip"):
            cfg["addresses"] = [p["ip"]]
            if p.get("gw"):
                cfg["routes"] = [{"to": "default", "via": p["gw"]}]
        if nameserver or searchdomain:
            cfg["nameservers"] = {k: v.split() for k, v in (("addresses", nameserver), ("search", searchdomain)) if v}
        eth[f"eth{i}"] = cfg
    return json.dumps({"version": 2, "ethernets": eth}, indent=2) + "\n"  # JSON is valid YAML


def ci_user_data(hostname: str, ci: dict) -> str:
    user = {"name": ci.get("ciuser") or "solaros", "sudo": "ALL=(ALL) NOPASSWD:ALL", "shell": "/bin/bash",
            "lock_passwd": not ci.get("password_hash")}
    if ci.get("password_hash"):
        user["passwd"] = ci["password_hash"]
    keys = [k.strip() for k in (ci.get("sshkeys") or "").splitlines() if k.strip()]
    if keys:
        user["ssh_authorized_keys"] = keys
    doc = {"hostname": hostname, "users": [user], "ssh_pwauth": bool(ci.get("password_hash")),
           "package_upgrade": bool(ci.get("ciupgrade"))}
    return "#cloud-config\n" + json.dumps(doc, indent=2) + "\n"


def ci_view(ci: dict, drive: str | None) -> dict:
    return {"ciuser": ci.get("ciuser"), "nameserver": ci.get("nameserver"), "searchdomain": ci.get("searchdomain"),
            "citype": "nocloud", "ciupgrade": int(bool(ci.get("ciupgrade"))), "sshkeys": ci.get("sshkeys") or "",
            "password_set": bool(ci.get("password_hash")), "ipconfig": ci.get("ipconfig") or {}, "drive": drive}


def merge_cloudinit(ci: dict, b: CloudInitBody) -> dict:
    """Apply a CloudInitBody: None = untouched, "" = clear, an empty password keeps the current one."""
    out = dict(ci)
    for k in ("ciuser", "nameserver", "searchdomain", "sshkeys"):
        v = getattr(b, k)
        if v is not None:
            out[k] = v.strip() or None
    if b.ciupgrade is not None:
        out["ciupgrade"] = b.ciupgrade
    ipc = dict(out.get("ipconfig") or {})
    for k, v in b.ipconfig.items():
        if v:
            ipc[k] = v
        else:
            ipc.pop(k, None)
    out["ipconfig"] = ipc
    return out


def lxc_nets(inst: dict) -> list[dict]:
    """Incus instance (recursion=1) -> NIC list in the shapes of app.guest_hardware.parse_net (lxc)."""
    out = []
    for name, dev in sorted((inst.get("expanded_devices") or {}).items()):
        m = re.fullmatch(r"eth(\d+)", name)
        if dev.get("type") != "nic" or not m:
            continue
        rate = re.fullmatch(r"(\d+(?:\.\d+)?)Mbit", dev.get("limits.max", ""))
        out.append({"key": f"net{m.group(1)}", "index": int(m.group(1)), "raw": "", "name": dev.get("name", name),
                    "macaddr": (dev.get("hwaddr") or (inst.get("config") or {}).get(f"volatile.{name}.hwaddr") or "").upper() or None,
                    "ip": dev.get("ipv4.address") or "dhcp", "gw": None, "ip6": None, "gw6": None,
                    "bridge": dev.get("parent") or dev.get("network") or "",
                    "tag": int(dev["vlan"]) if str(dev.get("vlan", "")).isdigit() else None, "firewall": False,
                    "rate": round(float(rate.group(1)) / 8, 2) if rate else None})
    return sorted(out, key=lambda n: n["index"])


def vlan_filtering(bridge: str) -> bool:
    try:
        return FsPath(f"/sys/class/net/{bridge}/bridge/vlan_filtering").read_text().strip() == "1"
    except OSError:
        return False


def lxc_nic_args(idx: int, b: NetBody) -> list[str]:
    return [f"eth{idx}", "nic", "nictype=bridged", f"parent={_bridge(b.bridge)}", f"name={b.name or f'eth{idx}'}",
            *([f"hwaddr={b.macaddr.lower()}"] if b.macaddr else []), *([f"vlan={b.tag}"] if b.tag else []),
            *([f"limits.max={b.rate * 8:g}Mbit"] if b.rate else [])]


# ---------------------------------------------------------------- Registry metadata (ostype, cloud-init)


def _meta(vmid: int) -> dict:
    return host.guest(vmid).get("meta") or {}


def _save_meta(vmid: int, **changes) -> None:
    reg = host.load_guests()
    reg[vmid]["meta"] = {**(reg[vmid].get("meta") or {}), **changes}
    host.save_guests(reg)


async def _xml(name: str) -> str:
    return await run("virsh", "dumpxml", "--inactive", name)


async def _inst(name: str) -> dict:
    return await run_json("incus", "query", f"/1.0/instances/{name}?recursion=1") or {}


# ---------------------------------------------------------------- Routes


@router.get("/{guest_type}/{vmid}/hardware")
async def hardware(guest_type: GuestType, vmid: VMID):
    name = host.name_of(vmid, guest_type)
    if guest_type == "lxc":
        inst = await _inst(name)
        cfg = inst.get("config") or {}
        nesting = cfg.get("security.nesting") == "true"
        return {"devices": {"hostpci": [], "usb": [], "net": lxc_nets(inst)}, "cloudinit": None, "pending": [],
                "options": {"hostname": name, "onboot": int(cfg.get("boot.autostart") == "true"), "startup": None,
                            "protection": int(cfg.get("security.protection.delete") == "true"),
                            "unprivileged": int(cfg.get("security.privileged") != "true"),
                            "features": "nesting=1" if nesting else None}}
    xml = await _xml(name)
    autostart = bool(re.search(r"^Autostart:\s+enable", await run("virsh", "dominfo", name), re.M))
    meta = _meta(vmid)
    seed = str(host.IMAGES / f"vm-{vmid}-cloudinit.iso")
    return {"devices": vm_devices(xml), "options": vm_options(xml, autostart, meta), "pending": [],
            "cloudinit": ci_view(meta.get("cloudinit") or {}, "sata" if has_file(xml, seed) else None),
            "cdrom": {"iso": iso_volid(install_cdrom(xml)[1])}}


class CdromBody(BaseModel):
    iso_volume: str | None = Field(None, max_length=500)  # None ejects


@router.put("/qemu/{vmid}/cdrom")
async def set_cdrom_route(vmid: VMID, body: CdromBody):
    name = host.name_of(vmid, "qemu")
    path = str(_volume_file(body.iso_volume)) if body.iso_volume else None
    if path and not FsPath(path).is_file():
        raise HTTPException(404, f"{body.iso_volume} not found")
    xml = await _xml(name)
    dev, _ = install_cdrom(xml)
    await host.define(set_cdrom(xml, path))
    running = "running" in await run("virsh", "domstate", name)
    if dev and running:
        # Swap the disc in the running VM too; the persistent definition above already has it for the next start.
        await run("virsh", "change-media", name, dev, *(["--update", path] if path else ["--eject"]), "--live",
                  check=False)
    # A new SATA drive cannot be hot-plugged: it appears at the next start.
    return {"ok": True, "restart_required": bool(running and not dev and path)}


@router.put("/qemu/{vmid}/hostpci/{idx}")
async def set_hostpci(vmid: VMID, body: PciPassthrough, idx: int = Path(ge=0, le=15)):
    name = host.name_of(vmid, "qemu")
    fn = body.id if "." in body.id else f"{body.id}.0"
    xml = set_hostdev(await _xml(name), "pci", idx, host.hostdev_pci(fn))
    if body.include_audio and fn.endswith(".0"):  # GPU + its HDMI audio function, like the Proxmox driver's slot pass
        audio = fn[:-1] + "1"
        if FsPath(f"/sys/bus/pci/devices/{audio if audio.count(':') == 2 else '0000:' + audio}").exists() \
                and audio not in [p["id"] for p in vm_devices(xml)["hostpci"]]:
            xml = set_hostdev(xml, "pci", 99, host.hostdev_pci(audio))
    await host.define(xml)
    return {"ok": True, "value": fn, "warnings": []}


@router.delete("/qemu/{vmid}/hostpci/{idx}")
async def delete_hostpci(vmid: VMID, idx: int = Path(ge=0, le=15)):
    name = host.name_of(vmid, "qemu")
    await host.define(set_hostdev(await _xml(name), "pci", idx, None))
    return {"ok": True}


@router.put("/qemu/{vmid}/usb/{idx}")
async def set_usb(vmid: VMID, body: UsbPassthrough, idx: int = Path(ge=0, le=4)):
    if not USB_ID_RE.fullmatch(body.host):
        raise HTTPException(400, "On SolarOS, pass a USB device by vendor:product ID (e.g. 046d:c52b)")
    name = host.name_of(vmid, "qemu")
    await host.define(set_hostdev(await _xml(name), "usb", idx, host.hostdev_usb(body.host)))
    return {"ok": True}


@router.delete("/qemu/{vmid}/usb/{idx}")
async def delete_usb(vmid: VMID, idx: int = Path(ge=0, le=4)):
    name = host.name_of(vmid, "qemu")
    await host.define(set_hostdev(await _xml(name), "usb", idx, None))
    return {"ok": True}


@router.put("/{guest_type}/{vmid}/net/{idx}")
async def set_net(guest_type: GuestType, vmid: VMID, body: NetBody, idx: int = Path(ge=0, le=7)):
    name = host.name_of(vmid, guest_type)
    if guest_type == "qemu":
        if body.tag:
            # libvirt only tags VLANs on Open vSwitch; on a Linux bridge the VM would refuse to start.
            raise HTTPException(400, "VLAN tags on VMs need a VLAN bridge on SolarOS: create one (e.g. br0.10) and pick it as the bridge")
        await host.define(set_interface(await _xml(name), idx, body))
        return {"ok": True}
    if body.ip not in (None, "dhcp"):
        raise HTTPException(400, "On SolarOS a container's static address is set inside the container (or at creation)")
    if body.tag and not vlan_filtering(_bridge(body.bridge)):
        raise HTTPException(400, f"Bridge {_bridge(body.bridge)} has no VLAN filtering: pick a VLAN bridge (e.g. br0.10) instead of a tag")
    inst = await _inst(name)
    old = (inst.get("devices") or {}).get(f"eth{idx}")
    if old:
        await run("incus", "config", "device", "remove", name, f"eth{idx}")
    try:
        await run("incus", "config", "device", "add", name, *lxc_nic_args(idx, body))
    except HTTPException:
        if old:  # put the previous NIC back so a rejected change never leaves the container offline
            await run("incus", "config", "device", "add", name, f"eth{idx}", old.get("type", "nic"),
                      *[f"{k}={v}" for k, v in old.items() if k != "type"], check=False)
        raise
    return {"ok": True}


@router.delete("/{guest_type}/{vmid}/net/{idx}")
async def delete_net(guest_type: GuestType, vmid: VMID, idx: int = Path(ge=0, le=7)):
    name = host.name_of(vmid, guest_type)
    if guest_type == "qemu":
        await host.define(set_interface(await _xml(name), idx, None))
        return {"ok": True}
    inst = await _inst(name)
    dev = f"eth{idx}"
    if dev in (inst.get("devices") or {}):
        await run("incus", "config", "device", "remove", name, dev)
    elif dev in (inst.get("expanded_devices") or {}):
        await run("incus", "config", "device", "add", name, dev, "none")  # masks the profile's NIC
    else:
        raise HTTPException(404, f"net{idx} does not exist")
    return {"ok": True}


async def _write_seed(vmid: int, name: str, xml: str, ci: dict) -> str:
    seed = host.IMAGES / f"vm-{vmid}-cloudinit.iso"
    macs = [n["macaddr"] for n in vm_devices(xml)["net"]]
    d = FsPath(tempfile.mkdtemp(prefix="sd-ci-"))
    try:
        (d / "user-data").write_text(ci_user_data(name, ci))
        (d / "meta-data").write_text(f"instance-id: sd-{vmid}-{ci.get('generation', 0)}\nlocal-hostname: {name}\n")
        (d / "network-config").write_text(ci_network_config(ci.get("ipconfig") or {}, macs, ci.get("nameserver") or "",
                                                            ci.get("searchdomain") or ""))
        host.IMAGES.mkdir(parents=True, exist_ok=True)
        await run("cloud-localds", "--network-config", str(d / "network-config"), str(seed), str(d / "user-data"),
                  str(d / "meta-data"))
    finally:
        shutil.rmtree(d, ignore_errors=True)
    return str(seed)


@router.post("/qemu/{vmid}/boot-iso")
async def boot_iso(vmid: VMID):
    """Restart (or start) the VM and press Enter every 0.5 s for 12 s, so a Windows installer boots from its ISO."""
    name = host.name_of(vmid, "qemu")
    running = "running" in await run("virsh", "domstate", name)
    await run("virsh", "reset" if running else "start", name)
    for _ in range(24):
        await asyncio.sleep(0.5)
        await run("virsh", "send-key", name, "KEY_ENTER", check=False)
    return {"ok": True}


@router.get("/qemu/{vmid}/cloudinit")
async def get_cloudinit(vmid: VMID):
    xml = await _xml(host.name_of(vmid, "qemu"))
    return ci_view(_meta(vmid).get("cloudinit") or {},
                   "sata" if has_file(xml, str(host.IMAGES / f"vm-{vmid}-cloudinit.iso")) else None)


@router.put("/qemu/{vmid}/cloudinit")
async def set_cloudinit(vmid: VMID, body: CloudInitBody):
    name = host.name_of(vmid, "qemu")
    ci = merge_cloudinit(_meta(vmid).get("cloudinit") or {}, body)
    if body.cipassword:
        ci["password_hash"] = (await run("openssl", "passwd", "-6", "-stdin", input=body.cipassword + "\n")).strip()
    xml = await _xml(name)
    seed = str(host.IMAGES / f"vm-{vmid}-cloudinit.iso")
    attached = has_file(xml, seed)
    if attached or body.add_drive_storage:
        await _write_seed(vmid, name, xml, ci)
        if not attached:
            await host.define(attach_cdrom(xml, seed))
    _save_meta(vmid, cloudinit=ci)
    return {"ok": True}


@router.post("/qemu/{vmid}/cloudinit/regenerate")
async def regenerate_cloudinit(vmid: VMID):
    name = host.name_of(vmid, "qemu")
    ci = {**(_meta(vmid).get("cloudinit") or {})}
    ci["generation"] = int(ci.get("generation", 0)) + 1  # a new instance-id makes cloud-init apply it again
    xml = await _xml(name)
    seed = await _write_seed(vmid, name, xml, ci)
    if not has_file(xml, seed):
        await host.define(attach_cdrom(xml, seed))
    _save_meta(vmid, cloudinit=ci)
    return {"ok": True}


@router.patch("/{guest_type}/{vmid}/options")
async def set_options(guest_type: GuestType, vmid: VMID, body: OptionsBody):
    given = body.model_dump(exclude_none=True)
    name = host.name_of(vmid, guest_type)
    supported = {"name", "onboot", "agent", "tablet", "ostype"} if guest_type == "qemu" else \
        {"hostname", "onboot", "protection", "features"}
    bad = sorted(set(given) - supported)
    if bad:
        raise HTTPException(400, f"Not adjustable on SolarOS: {', '.join(bad)} (set at creation or fixed by the host)")
    if guest_type == "qemu":
        if "onboot" in given:
            await run("virsh", "autostart", name, *([] if given["onboot"] else ["--disable"]))
        xml = await _xml(name)
        new = xml
        for which in ("agent", "tablet"):
            if which in given:
                new = set_flag_device(new, which, given[which])
        if new != xml:
            await host.define(new)
        if "ostype" in given:
            _save_meta(vmid, ostype=given["ostype"])
        if given.get("name") and given["name"] != name:
            await run("virsh", "domrename", name, given["name"])  # libvirt requires the VM to be shut off
            reg = host.load_guests()
            reg[vmid]["name"] = given["name"]
            host.save_guests(reg)
        return {"ok": True}
    sets = {}
    if "onboot" in given:
        sets["boot.autostart"] = str(given["onboot"]).lower()
    if "protection" in given:
        sets["security.protection.delete"] = str(given["protection"]).lower()
    if "features" in given:
        sets["security.nesting"] = "true" if "nesting=1" in given["features"] else "false"
    if sets:
        await run("incus", "config", "set", name, *[f"{k}={v}" for k, v in sets.items()])
    if given.get("hostname") and given["hostname"] != name:
        await run("incus", "rename", name, given["hostname"])  # Incus requires the container to be stopped
        reg = host.load_guests()
        reg[vmid]["name"] = given["hostname"]
        host.save_guests(reg)
    return {"ok": True}
