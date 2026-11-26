"""Multi-seat workstations on SolarOS (contract: app.multiseat).

Seat devices are libvirt <hostdev> elements tagged with the user alias "ua-seat-<n>": the GPU, its audio function,
extra PCIe devices and USB controllers (managed: libvirt binds them to vfio-pci at start), and one USB hostdev per
bound physical port. libvirt addresses a host USB device by bus + device number, which changes on every replug, so
each apply (every seat save and every seat start) resolves the port path to the device plugged in right now; a port
with nothing plugged in is skipped, and startupPolicy="optional" lets the VM start when a device was unplugged since.
CPU threads become the <vcpu cpuset> of the domain.
"""
import xml.etree.ElementTree as ET
from pathlib import Path

from . import host
from .guest_edit import _xml

ALIAS = "ua-seat-"
USB_SYSFS = Path("/sys/bus/usb/devices")


def usb_address(port: str, root: Path = USB_SYSFS) -> tuple[int, int] | None:
    """(bus, device number) of what is plugged into `port` now, None when the port is empty."""
    try:
        return int((root / port / "busnum").read_text()), int((root / port / "devnum").read_text())
    except (OSError, ValueError):
        return None


def seat_xml(xml: str, seat: dict, usb: dict[str, tuple[int, int]]) -> str:
    """Domain XML with its seat hostdevs and CPU set replaced by `seat`'s; `usb` maps port -> (bus, device)."""
    d = ET.fromstring(xml)
    devs = d.find("devices")
    for h in devs.findall("hostdev"):
        a = h.find("alias")
        if a is not None and (a.get("name") or "").startswith(ALIAS):
            devs.remove(h)
    pci = [x for x in [seat.get("gpu_pci_slot"), seat.get("gpu_audio_pci_slot"), *seat.get("extra_pci_slots", []),
                       *seat.get("usb_controller_pci_slots", [])] if x]
    n = 0
    for addr in dict.fromkeys(pci):
        h = host.hostdev_pci(addr)
        ET.SubElement(h, "alias", name=f"{ALIAS}{n}")
        devs.append(h)
        n += 1
    for port in seat.get("usb_ports", []):
        if port not in usb:
            continue
        bus, dev = usb[port]
        h = ET.Element("hostdev", mode="subsystem", type="usb", managed="yes")
        ET.SubElement(ET.SubElement(h, "source", startupPolicy="optional"), "address", bus=str(bus), device=str(dev))
        ET.SubElement(h, "alias", name=f"{ALIAS}{n}")
        devs.append(h)
        n += 1
    vcpu = d.find("vcpu")
    if vcpu is not None:
        if seat.get("cpu_cores"):
            vcpu.set("cpuset", ",".join(map(str, seat["cpu_cores"])))
        else:
            vcpu.attrib.pop("cpuset", None)
    return ET.tostring(d, encoding="unicode")


async def apply(vmid: int, seat: dict, state: dict) -> dict:
    name = host.name_of(vmid, "qemu")
    usb = {p: a for p in seat.get("usb_ports", []) if (a := usb_address(p))}
    await host.define(seat_xml(await _xml(name), seat, usb))
    return {"usb_present": sorted(usb)}
