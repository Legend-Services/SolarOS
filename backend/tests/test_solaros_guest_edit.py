"""SolarOS guest editing self-check (libvirt XML, cloud-init, Incus mapping, route shadowing).
Run: python -m tests.test_solaros_guest_edit"""
import json
import os

os.environ["HYPERVISOR_DRIVER"] = "native_ubuntu"
os.environ["PVE_BRIDGE"] = "br0"  # as written by install-hypervisor.sh
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
                            0, NetBody(bridge="vmbr0", rate=12.5, model="e1000"))
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
assert ge.lxc_nic_args(1, NetBody(bridge="vmbr0", tag=7, rate=2)) == [
    "eth1", "nic", "nictype=bridged", "parent=br0", "name=eth1", "vlan=7", "limits.max=16Mbit"]

# ---- the SolarOS routes come before the Proxmox-only ones
from app.main import app  # noqa: E402
order = [(r.path, r.endpoint.__module__) for r in app.routes if isinstance(r, APIRoute)]
first = {}
for path, mod in order:
    first.setdefault(path, mod)
for p in ("/api/pve/guests/{guest_type}/{vmid}/hardware", "/api/pve/guests/{guest_type}/{vmid}/net/{idx}",
          "/api/pve/guests/qemu/{vmid}/cloudinit", "/api/pve/guests/{guest_type}/{vmid}/options",
          "/api/pve/guests/qemu/{vmid}/hostpci/{idx}"):
    assert first[p] == "providers.native_ubuntu.guest_edit", (p, first[p])
print("SolarOS guest editing self-check OK")
