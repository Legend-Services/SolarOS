"""Visual Virtual Switch on Proxmox VE: /etc/network/interfaces round trip. Run: python -m tests.test_proxmox_network_switch"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import network_switch as ns  # noqa: E402
from providers.proxmox import network_switch as px  # noqa: E402

LIVE = """auto lo
iface lo inet loopback

iface nic0 inet manual

auto vmbr0
iface vmbr0 inet static
	address 192.168.68.220/24
	gateway 192.168.68.1
	bridge-ports nic0
	bridge-stp off
	bridge-fd 0


source /etc/network/interfaces.d/*
"""
RESOLV = "search lan\nnameserver 192.168.68.1\n"

m = px.parse(LIVE, RESOLV)
assert m["vmbr0"]["kind"] == "bridge" and m["vmbr0"]["ports"] == ["nic0"] and m["vmbr0"]["address"] == "192.168.68.220/24"
assert m["vmbr0"]["gateway"] == "192.168.68.1" and m["vmbr0"]["dns"] == ["192.168.68.1"] and m["vmbr0"]["auto"]
assert m["nic0"]["kind"] == "eth" and not m["nic0"]["auto"] and m["lo"]["kind"] == "loopback"

# Unchanged model -> same file (modulo blank lines).
out = px.render_interfaces(m)
assert [x for x in out.splitlines() if x] == [x for x in LIVE.splitlines() if x], out
assert px.render_resolv(m) == RESOLV

# VLAN-aware switch, access + trunk ports, a host VLAN NIC, a dummy NIC and a new isolated switch.
m["nic1"] = ns.blank("nic1", "eth")
m["nic1"]["auto"] = False
ns.assign(m, "nic1", "vmbr0", "trunk", 1, [10, 20])
ns.add_host_vnic(m, ns.HostVnicBody(type="vlan", parent="vmbr0", vlan_id=20, ipv4_cidr="10.10.20.1/24"))
ns.add_host_vnic(m, ns.HostVnicBody(type="dummy", name="dummy0", ipv4_cidr="10.99.0.1/24"))
m["vmbr1"] = {**ns.blank("vmbr1", "bridge"), "mode": "isolated", "mtu": 9000}
ns.assign(m, "dummy0", "vmbr1", "access", 30, [])
out = px.render_interfaces(m)
for line in ("\tbridge-vlan-aware yes", "\tbridge-vids 2-4094", "\tbridge-vids 10 20", "iface vmbr0.20 inet static",
             "\taddress 10.10.20.1/24", "iface dummy0 inet manual", "\tlink-type dummy", "\tbridge-access 30",
             "\tbridge-ports dummy0", "\tmtu 9000", "\tbridge-stp off", "source /etc/network/interfaces.d/*"):
    assert line in out.splitlines(), line
assert "address 10.99.0.1/24" not in out  # a bridge port carries no address of its own

back = px.parse(out, RESOLV)
assert back["vmbr0"]["vlan_aware"] and back["vmbr0"]["ports"] == ["nic0", "nic1"]
assert ns.port_mode(back["vmbr0"], back["nic1"]) == ("trunk", 1, [10, 20])
assert back["vmbr0.20"]["kind"] == "vlan" and back["vmbr0.20"]["raw"] == "vmbr0" and back["vmbr0.20"]["vid"] == 20
assert back["dummy0"]["kind"] == "dummy" and back["dummy0"]["pvid"] == 30 and back["vmbr1"]["ports"] == ["dummy0"]
assert back["vmbr0"]["extra"]["inet"].count("bridge-vids 2-4094") == 1
assert px.render_interfaces(back) == out  # stable

# Native VLAN on a trunk + legacy netmask + inet6 + unknown options survive.
legacy = """auto eno1
iface eno1 inet manual
	bridge-vids 10 20 30
	bridge-pvid 10
	post-up ethtool -K eno1 tso off

auto vmbr2
iface vmbr2 inet static
	address 10.0.0.2
	netmask 255.255.255.0
	bridge-ports eno1
	bridge-vlan-aware yes
	bridge-vids 2-100

iface vmbr2 inet6 static
	address fd00::2/64
	gateway fd00::1
"""
lm = px.parse(legacy)
assert lm["vmbr2"]["address"] == "10.0.0.2/24" and lm["vmbr2"]["address6"] == "fd00::2/64" and lm["vmbr2"]["gateway6"] == "fd00::1"
assert ns.port_mode(lm["vmbr2"], lm["eno1"]) == ("trunk", 10, [20, 30])
lo = px.render_interfaces(lm)
assert "\tpost-up ethtool -K eno1 tso off" in lo and "\tbridge-vids 2-100" in lo and "\tbridge-pvid 10" in lo
assert "\tbridge-vids 10 20 30" in lo and "iface vmbr2 inet6 static" in lo and "bridge-vids 2-4094" not in lo
assert px.render_resolv(lm) is None
assert px.vlan_script(lm) == ""

print("proxmox network switch self-check OK")
