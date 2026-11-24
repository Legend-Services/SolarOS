"""SolarOS guest editing self-check (libvirt XML, cloud-init, Incus mapping, route shadowing).
Run: python -m tests.test_solaros_guest_edit"""
import json
import os

os.environ["HYPERVISOR_DRIVER"] = "native_ubuntu"
os.environ["DEFAULT_BRIDGE"] = "br0"  # as written by install-hypervisor.sh
os.environ.setdefault("ADMIN_PASSWORD", "ci")
os.environ.setdefault("JWT_SECRET", "ci-secret-ci-secret-ci-secret-ci-secret")

from fastapi import HTTPException  # noqa: E402
from fastapi.routing import APIRoute  # noqa: E402

from app.guest_hardware import CloudInitBody, NetBody  # noqa: E402
from providers.native_ubuntu import guest_edit as ge, host  # noqa: E402

XML = host.domain_xml(name="win", vmid=100, cores=2, sockets=1, memory_mb=2048, uefi=True, secure_boot=False,
                      disks=[{"path": "/x/vm-100-disk-0.qcow2", "type": "file", "format": "qcow2"}], cdroms=[],
                      bridge="br0", ostype="l26", hostpci=["01:00.0"], usb=["046d:c52b"], tpm=False)

# ---- devices read back in the Proxmox shapes
dv = ge.vm_devices(XML)
assert [(n["key"], n["bridge"], n["model"]) for n in dv["net"]] == [("net0", "br0", "virtio")], dv
assert dv["hostpci"][0]["id"] == "01:00.0" and dv["usb"][0]["host"] == "046d:c52b", dv

# ---- NIC edit keeps the MAC, adds VLAN + rate; append; delete; missing index
with_mac = ge.set_interface(XML.replace("<model type=\"virtio\" />", "<mac address=\"52:54:00:aa:bb:cc\" /><model type=\"virtio\" />"),
                            0, NetBody(bridge="br0", rate=12.5, model="e1000"))
n0 = ge.vm_devices(with_mac)["net"][0]
assert (n0["bridge"], n0["macaddr"], n0["tag"], n0["rate"], n0["model"]) == ("br0", "52:54:00:AA:BB:CC", None, 12.5, "e1000"), n0
two = ge.set_interface(with_mac, 1, NetBody(bridge="br1"))
assert [n["bridge"] for n in ge.vm_devices(two)["net"]] == ["br0", "br1"]
assert [n["bridge"] for n in ge.vm_devices(ge.set_interface(two, 0, None))["net"]] == ["br1"]
try:
    ge.set_interface(XML, 5, None)
    raise AssertionError("expected 404")
except HTTPException as e:
    assert e.status_code == 404

# ---- passthrough and flag devices
x = ge.set_hostdev(XML, "pci", 1, host.hostdev_pci("02:00.0"))
assert [p["id"] for p in ge.vm_devices(x)["hostpci"]] == ["01:00.0", "02:00.0"]
assert ge.vm_devices(ge.set_hostdev(x, "usb", 0, None))["usb"] == []
assert ge.vm_options(ge.set_flag_device(XML, "agent", False), False, {})["agent"] == 0
assert ge.vm_options(ge.set_flag_device(XML, "tablet", False), True, {})["tablet"] == 0
o = ge.vm_options(XML, True, {"ostype": "win11"})
assert (o["onboot"], o["bios"], o["agent"], o["tablet"], o["cpu"], o["ostype"]) == (1, "ovmf", 1, 1, "host", "win11"), o

# ---- cloud-init drive and documents
seed = "/var/lib/libvirt/images/vm-100-cloudinit.iso"
c = ge.attach_cdrom(XML, seed)
assert ge.has_file(c, seed) and ge.attach_cdrom(c, seed) == c and not ge.has_file(XML, seed)
net = json.loads(ge.ci_network_config({"ipconfig0": "ip=10.0.0.5/24,gw=10.0.0.1", "ipconfig3": "ip=dhcp"},
                                      ["52:54:00:AA:BB:CC"], "1.1.1.1 9.9.9.9", "lan"))
e0 = net["ethernets"]["eth0"]
assert e0["addresses"] == ["10.0.0.5/24"] and e0["routes"][0]["via"] == "10.0.0.1" and e0["match"]["macaddress"] == "52:54:00:aa:bb:cc"
assert e0["nameservers"] == {"addresses": ["1.1.1.1", "9.9.9.9"], "search": ["lan"]} and "eth3" not in net["ethernets"]
ud = json.loads(ge.ci_user_data("web", {"ciuser": "ops", "password_hash": "$6$x", "sshkeys": "ssh-ed25519 AAA k\n"}).split("\n", 1)[1])
assert ud["users"][0]["passwd"] == "$6$x" and ud["users"][0]["ssh_authorized_keys"] == ["ssh-ed25519 AAA k"] and ud["ssh_pwauth"]
ci = ge.merge_cloudinit({"ciuser": "a", "ipconfig": {"ipconfig0": "ip=dhcp"}},
                        CloudInitBody(ciuser="", nameserver="1.1.1.1", ipconfig={"ipconfig0": "", "ipconfig1": "ip=dhcp"}))
assert ci["ciuser"] is None and ci["nameserver"] == "1.1.1.1" and ci["ipconfig"] == {"ipconfig1": "ip=dhcp"}, ci
assert ge.ci_view({}, None)["password_set"] is False

# ---- Incus NICs
inst = {"config": {"volatile.eth0.hwaddr": "00:16:3e:01:02:03"},
        "expanded_devices": {"eth0": {"type": "nic", "nictype": "bridged", "parent": "br0", "vlan": "5", "limits.max": "80Mbit"},
                             "root": {"type": "disk"}, "eth1": {"type": "none"}}}
assert ge.lxc_nets(inst) == [{"key": "net0", "index": 0, "raw": "", "name": "eth0", "macaddr": "00:16:3E:01:02:03", "ip": "dhcp",
                              "gw": None, "ip6": None, "gw6": None, "bridge": "br0", "tag": 5, "firewall": False, "rate": 10.0}]
assert ge.lxc_nic_args(1, NetBody(bridge="br0", tag=7, rate=2)) == [
    "eth1", "nic", "nictype=bridged", "parent=br0", "name=eth1", "vlan=7", "limits.max=16Mbit"]

# ---- install CD-ROM: load, swap, eject; seed drive is never the install drive; Windows gets SATA + e1000e
iso = "/mnt/storage/isos/win11.iso"
assert ge.install_cdrom(XML) == (None, None)
x = ge.set_cdrom(ge.attach_cdrom(XML, seed), iso)
assert ge.install_cdrom(x)[1] == iso and ge.has_file(x, seed)
x2 = ge.set_cdrom(x, "/mnt/storage/isos/other.iso")
assert ge.install_cdrom(x2)[1] == "/mnt/storage/isos/other.iso" and ge.install_cdrom(ge.set_cdrom(x2, None))[1] is None
assert ge.set_cdrom(XML, None) == XML
import xml.etree.ElementTree as ET  # noqa: E402
boots = lambda x: [(dk.get("device"), (dk.find("source").get("file") if dk.find("source") is not None else None))  # noqa: E731
                   for dk in sorted((dk for dk in ET.fromstring(x).findall("devices/disk") if dk.find("boot") is not None),
                                    key=lambda dk: int(dk.find("boot").get("order")))]
assert boots(x2) == [("disk", "/x/vm-100-disk-0.qcow2"), ("cdrom", "/mnt/storage/isos/other.iso")], boots(x2)
assert ET.fromstring(x2).find("os/boot") is None  # libvirt rejects os/boot mixed with per-device order
assert boots(ge.set_cdrom(XML, iso))[1] == ("cdrom", iso)
win = host.domain_xml(name="w", vmid=101, cores=2, sockets=1, memory_mb=4096, uefi=True, secure_boot=True,
                      disks=[{"path": "/x/d.qcow2", "type": "file", "format": "qcow2"}], cdroms=[iso], bridge="br0",
                      ostype="win11", hostpci=[], usb=[], tpm=True)
assert 'bus="sata"' in win and 'bus="scsi"' not in win.split("<controller")[0] and 'type="e1000e"' in win
assert 'bus="scsi"' in XML and 'type="virtio"' in XML  # Linux guests keep virtio
from app.guest_hardware import cdrom_iso  # noqa: E402
assert cdrom_iso({"ide2": "local:iso/win11.iso,media=cdrom,size=5G"}) == "local:iso/win11.iso"
assert cdrom_iso({"ide2": "none,media=cdrom"}) is None and cdrom_iso({"ide2": "local:cloudinit,media=cdrom"}) is None
assert cdrom_iso({}) is None

# ---- ISO upload streams into /mnt/storage/isos, refuses duplicates and leaves no partial file on errors
import asyncio, tempfile  # noqa: E401,E402
from pathlib import Path  # noqa: E402
from app.config import settings  # noqa: E402
from providers.native_ubuntu.provider import NativeUbuntuProvider  # noqa: E402
async def chunks(*parts, fail=False):
    for c in parts:
        yield c
    if fail:
        raise RuntimeError("client went away")
with tempfile.TemporaryDirectory() as d:
    settings.storage_root = Path(d)
    prov = NativeUbuntuProvider()
    r = asyncio.run(prov.upload_to_storage("local", "iso", "win11.iso", chunks(b"ab", b"cd"), 4))
    assert r["volid"] == "local:iso/win11.iso" and (Path(d) / "isos" / "win11.iso").read_bytes() == b"abcd"
    for name, kw, code in (("win11.iso", {}, 409), ("x.iso", {"storage": "zfs"}, 400), ("x.tar.gz", {}, 400)):
        try:
            asyncio.run(prov.upload_to_storage(kw.get("storage", "local"), "iso", name, chunks(b"x"), 1))
            raise AssertionError(name)
        except HTTPException as e:
            assert e.status_code == code, (name, e.status_code)
    try:
        asyncio.run(prov.upload_to_storage("local", "iso", "broken.iso", chunks(b"x", fail=True), 2))
    except RuntimeError:
        pass
    assert sorted(p.name for p in (Path(d) / "isos").iterdir()) == ["win11.iso"], "partial upload left behind"

# ---- the SolarOS routes come before the Proxmox-only ones
from app.main import app  # noqa: E402
order = [(r.path, r.endpoint.__module__) for r in app.routes if isinstance(r, APIRoute)]
first = {}
for path, mod in order:
    first.setdefault(path, mod)
for p in ("/api/v1/guests/{guest_type}/{vmid}/hardware", "/api/v1/guests/{guest_type}/{vmid}/net/{idx}",
          "/api/v1/guests/qemu/{vmid}/cloudinit", "/api/v1/guests/{guest_type}/{vmid}/options",
          "/api/v1/guests/qemu/{vmid}/hostpci/{idx}", "/api/v1/guests/qemu/{vmid}/cdrom"):
    assert first[p] == "providers.native_ubuntu.guest_edit", (p, first[p])
print("SolarOS guest editing self-check OK")
