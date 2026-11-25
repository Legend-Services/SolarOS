"""Visual Virtual Switch self-check (shared model, DHCP rendering, Netplan driver). Run: python -m tests.test_network_switch"""
import json
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import network_switch as ns  # noqa: E402
from providers.native_ubuntu import network_switch as nn  # noqa: E402


def raises(fn, exc=(HTTPException, ValidationError)):
    try:
        fn()
    except exc:
        return True
    raise AssertionError("expected an error")


# Port assignment: access, trunk, unassigned; VLAN use turns the switch VLAN-aware.
m = {"br0": {**ns.blank("br0", "bridge"), "ports": ["eno1"], "address": "192.168.1.5/24", "gateway": "192.168.1.1"},
     "br1": ns.blank("br1", "bridge"), "eno1": ns.blank("eno1", "eth"), "eno2": ns.blank("eno2", "eth")}
ns.assign(m, "eno2", "br1", "access", 20, [])
assert m["br1"]["ports"] == ["eno2"] and m["eno2"]["pvid"] == 20 and m["br1"]["vlan_aware"]
assert ns.port_mode(m["br1"], m["eno2"]) == ("access", 20, [])
ns.assign(m, "eno2", "br0", "trunk", 1, [10, 20, 1])
assert m["br1"]["ports"] == [] and m["br0"]["ports"] == ["eno1", "eno2"] and m["eno2"]["vids"] == [10, 20]
assert ns.port_mode(m["br0"], m["eno2"]) == ("trunk", 1, [10, 20])
ns.assign(m, "eno2", None, "unassigned", None, [])
assert ns.bridge_of(m, "eno2") is None and ns.port_mode(None, m["eno2"])[0] == "unassigned"
raises(lambda: ns.assign(m, "eno2", "br9", "access", 5, []))
assert ns.guest_tag("access", 1, []) == (None, None) and ns.guest_tag("access", 30, []) == (30, None)
assert ns.guest_tag("trunk", None, [20, 10]) == (None, "10;20") and ns.guest_tag("unassigned", 5, [1]) == (None, None)

# The default switch and the one carrying the gateway are protected.
assert {"br0"} <= ns.protected_bridges(m) and "br1" not in ns.protected_bridges(m)

# Model checks: missing port, port in two switches, VLAN without parent.
raises(lambda: ns.check_model({"br5": {**ns.blank("br5", "bridge"), "ports": ["nope"]}}))
raises(lambda: ns.check_model({**m, "br1": {**m["br1"], "ports": ["eno1"]}}))
raises(lambda: ns.check_model({"br7.5": {**ns.blank("br7.5", "vlan"), "raw": "br7"}}))
ns.check_model(m)

# Host VLAN NIC + per-VLAN host IP.
assert ns.set_vlan_host_ip(m, "br0", 20, "10.10.20.1/24") and m["br0.20"]["vid"] == 20 and m["br0"]["vlan_aware"]
assert not ns.set_vlan_host_ip(m, "br0", 20, "10.10.20.1/24")
assert ns.set_vlan_host_ip(m, "br0", 20, None) and "br0.20" not in m
raises(lambda: ns.add_host_vnic(m, ns.HostVnicBody(type="vlan", parent="averyverylongbr", vlan_id=100)))

# Metadata round trip (what a platform config cannot hold).
m2 = {"br1": ns.blank("br1", "bridge")}
ns.with_meta(m2, {"br1": {"mode": "nat", "vlan_aware": True, "pvid": None}, "gone": {"mode": "nat"}})
assert m2["br1"]["mode"] == "nat" and m2["br1"]["vlan_aware"] and "gone" not in m2
assert ns.meta_of(m2)["br1"]["mode"] == "nat"

# Live link parsing.
ipj = json.dumps([{"ifname": "eno1", "address": "aa:bb:cc:00:00:01", "operstate": "UP", "mtu": 1500, "master": "br0",
                   "addr_info": []},
                  {"ifname": "br0", "address": "aa:bb:cc:00:00:01", "operstate": "UP", "mtu": 1500,
                   "linkinfo": {"info_kind": "bridge"},
                   "addr_info": [{"local": "192.168.1.5", "prefixlen": 24, "scope": "global"},
                                 {"local": "fe80::1", "prefixlen": 64, "scope": "link"}]}])
links = ns.parse_links(ipj, "eno1|1|up|2500|igc|0000:03:00.0\nghost|1|up|1|x|y\n")
assert links["eno1"]["physical"] and links["eno1"]["speed_mbps"] == 2500 and links["eno1"]["driver"] == "igc"
assert links["br0"]["addrs"] == ["192.168.1.5/24"] and "physical" not in links["br0"]
assert ns.parse_links(ipj, "eno1|0|down|-1||0000:03:00.0")["eno1"]["speed_mbps"] is None

# State view.
v = ns.view(m, links, {"20": {"name": "IoT", "color": "#22c55e", "bridge": "br0", "dhcp_config": None}},
            [{"bridge": "br0", "trunks": [], "mac": None}])
assert v["physical"][0]["assigned_bridge"] == "br0" and v["physical"][0]["vlan_mode"] == "access"
assert v["bridges"][0]["protected"] and v["vlans"][0]["vlan_id"] == 20 and v["guest_vnics"][0]["vlan_mode"] == "access"

# DHCP validation + rendering: strictly bound to the VLAN interface, DHCP only.
d = ns.DhcpBody(enabled=True, gateway_ip="10.10.20.1", range_start="10.10.20.100", range_end="10.10.20.200",
                dns_servers=["1.1.1.1", "9.9.9.9"],
                static_leases=[{"mac": "AA:BB:CC:DD:EE:FF", "ip": "10.10.20.50", "hostname": "printer"}])
assert d.cidr == "10.10.20.1/24"
conf = ns.render_dhcp(20, "br0.20", d.model_dump())
for line in ("interface=br0.20", "bind-interfaces", "port=0", "dhcp-range=10.10.20.100,10.10.20.200,255.255.255.0,24h",
             "dhcp-option=option:router,10.10.20.1", "dhcp-option=option:dns-server,1.1.1.1,9.9.9.9",
             "dhcp-host=aa:bb:cc:dd:ee:ff,10.10.20.50,printer", "dhcp-leasefile=/var/lib/misc/dnsmasq.vlan-20.leases"):
    assert line + "\n" in conf, line
raises(lambda: ns.DhcpBody(enabled=True, gateway_ip="10.10.20.1", range_start="10.10.21.1", range_end="10.10.20.9"))
raises(lambda: ns.DhcpBody(enabled=True, gateway_ip="10.10.20.150", range_start="10.10.20.100", range_end="10.10.20.200"))
raises(lambda: ns.DhcpBody(enabled=True, gateway_ip="10.10.20.1", range_start="10.10.20.200", range_end="10.10.20.100"))
raises(lambda: ns.DhcpBody(enabled=True, gateway_ip="10.10.20.1", range_start="10.10.20.100", range_end="10.10.20.200",
                           lease_time="1 week"))
ls = ns.parse_leases("1767225600 aa:bb:cc:dd:ee:ff 10.10.20.50 printer 01:aa\n1767225601 11:22:33:44:55:66 10.10.20.101 * *\n",
                     [{"mac": "AA:BB:CC:DD:EE:FF"}])
assert ls[0]["is_static"] and ls[0]["mac"] == "AA:BB:CC:DD:EE:FF" and ls[1]["hostname"] == "" and not ls[1]["is_static"]

# Request validation.
raises(lambda: ns.BridgeBody(name="br3", mode="nat"))
raises(lambda: ns.BridgeBody(name="br3", mode="isolated", member_ports=["eno2"]))
raises(lambda: ns.InterfaceBody(method="static"))
raises(lambda: ns.InterfaceBody(method="static", ipv4_cidr="10.0.0.2/24", ipv4_gateway="10.0.1.1"))
raises(lambda: ns.InterfaceBody(method="static", ipv4_cidr="10.0.0.2"))
raises(lambda: ns.AssignBody(port_kind="physical", port="eno2", mode="trunk", target_bridge="br0"))
raises(lambda: ns.VlanBody(vlan_id=4095, name="x", bridge="br0"))
raises(lambda: ns.VlanBody(vlan_id=10, name="x\nrm", bridge="br0"))

# NAT switches get a masquerade rule; the switch script always ends cleanly.
nat = {"br2": {**ns.blank("br2", "bridge"), "mode": "nat", "address": "10.10.10.1/24"}}
sh = ns.render_switch_script(nat, "")
assert "ip saddr 10.10.10.0/24 oifname != \"br2\" masquerade" in sh and sh.endswith("exit 0\n")
assert "masquerade" not in ns.render_switch_script(m, "")

# Apply script: snapshot, restore script and a 60-second rollback timer.
a = ns.apply_script(["/etc/netplan"], "netplan apply")
assert "--on-active=60" in a and "cp -a --parents" in a and "netplan apply" in a and "exit 3" in a

# ---------------------------------------------------------------- Netplan driver
docs = [{"network": {"version": 2, "renderer": "networkd", "ethernets": {"eno1": {"dhcp4": True}}}},
        {"network": {"version": 2, "ethernets": {"eno1": {"dhcp4": False}, "eno2": {"dhcp4": False, "wakeonlan": True}},
                     "bridges": {"br0": {"interfaces": ["eno1"], "addresses": ["192.168.1.5/24", "fd00::5/64"],
                                         "routes": [{"to": "default", "via": "192.168.1.1"}, {"to": "10.9.0.0/16", "via": "192.168.1.2"}],
                                         "nameservers": {"addresses": ["192.168.1.1"], "search": ["lan"]},
                                         "parameters": {"stp": False, "forward-delay": 0}}}}}]
pm = nn.parse(docs)
assert pm["eno1"]["method"] == "manual" and pm["br0"]["address"] == "192.168.1.5/24" and pm["br0"]["gateway"] == "192.168.1.1"
assert pm["br0"]["address6"] == "fd00::5/64" and pm["br0"]["dns"] == ["192.168.1.1"] and pm["br0"]["ports"] == ["eno1"]
ns.assign(pm, "eno2", "br0", "trunk", None, [10, 20])
assert ns.add_host_vnic(pm, ns.HostVnicBody(type="vlan", parent="br0", vlan_id=10, ipv4_cidr="10.10.10.1/24")) == "br0.10"
out = nn.render_netplan(pm)
back = nn.parse([__import__("yaml").safe_load(out)])
assert back["br0"]["ports"] == ["eno1", "eno2"] and back["br0.10"]["raw"] == "br0" and back["br0.10"]["vid"] == 10
assert back["br0"]["gateway"] == "192.168.1.1" and back["eno2"]["extra"]["cfg"].get("wakeonlan") is True
cfg = back["br0"]["extra"]["cfg"]
assert {"to": "10.9.0.0/16", "via": "192.168.1.2"} in cfg["routes"] and cfg["nameservers"]["search"] == ["lan"]
assert "renderer: networkd" in out
vs = nn.vlan_script(pm)
assert "ip link set dev br0 type bridge vlan_filtering 1 || true" in vs
assert "bridge vlan add dev br0 vid 10 self || true" in vs and "bridge vlan add dev eno2 vid 20 || true" in vs
pm["br0"]["vlan_aware"] = False
assert "vlan_filtering 0" in nn.vlan_script(pm)

print("network switch self-check OK")
