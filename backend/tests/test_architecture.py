"""Wireframe Node Architect & Network Architect self-check (identity helpers, NIC view, scanner parsers and classifier,
network list, request validation). Run: python -m tests.test_architecture"""
import json
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from pydantic import ValidationError  # noqa: E402

from app import architecture as arch  # noqa: E402
from app import network_scanner as sc  # noqa: E402
from app import virtual_hardware as vh  # noqa: E402


def raises(fn):
    try:
        fn()
    except (ValidationError, ValueError):
        return True
    raise AssertionError("expected an error")


# MACs and ids.
assert vh.unicast_mac("52:54:00:12:34:56") and vh.unicast_mac("BC:24:11:AA:BB:CC")
assert not vh.unicast_mac("01:00:5E:00:00:01") and not vh.unicast_mac("00:00:00:00:00:00") and not vh.unicast_mac("zz")
assert vh.hex_id("8086") == "0x8086" and vh.hex_id("0X1AF4") == "0x1af4" and vh.hex_id("") == ""

# Identity view: native ids, NVMe serial, camera node, which fields reach the guest.
nvme = {"id": "a1b2c3", "type": "virtual_nvme", "options": {"size_gb": 32, "serial": "SDNVME1"}, "state": {}}
iv = vh.identity_view(nvme)
assert iv["serial_number"] == "SDNVME1" and iv["native_vendor_id"] == "0x1b36" and iv["guest_visible"] == ["serial_number"]
cam = {"id": "c0ffee", "type": "virtual_camera", "options": {}, "state": {"video_nr": 42},
       "identity": {"device_name": "Studio HDMI Capture Pro"}}
iv = vh.identity_view(cam)
assert iv["device_name"] == "Studio HDMI Capture Pro" and iv["pci_or_usb_address"] == "/dev/video42"
assert iv["bus_type"] == "USB" and iv["guest_visible"] == ["device_name"]
assert vh.identity_view({"id": "1", "type": "sas_hba", "options": {"model": "megasas"}, "state": {}})["native_device_id"] == "0x0060"

# Camera card names per slot.
labels = vh.vcam_labels({"lxc/101": {"devices": [cam]}})
assert labels[2] == "Studio HDMI Capture Pro" and labels[0] == vh.VCAM_LABEL and len(labels) == vh.VCAM_SLOTS
assert 'card_label="SolarDeck-Camera","SolarDeck-Camera","Studio HDMI Capture Pro"' in vh.vcam_opts(labels)

# NIC view: endpoint VLAN with DHCP, lab badge, rate in Mbit/s, PCI ids by model.
vlans = {"20": {"name": "IoT", "color": "#22c55e", "bridge": "br0", "host_ipv4_cidr": "10.20.0.1/24",
                "dhcp_config": {"gateway_ip": "10.20.0.1", "dns_servers": ["1.1.1.1"]}}}
n = vh.nic_view({"key": "net0", "model": "e1000", "macaddr": "52:54:00:00:00:01", "bridge": "br0", "tag": 20, "rate": 12.5,
                 "link_down": False}, "Uplink", vlans, ["10.20.0.50"], None, {"20": True})
assert n["vendor_id"] == "0x8086" and n["device_id"] == "0x100e" and n["rate_mbps"] == 100.0
assert n["vlan"]["subnet_cidr"] == "10.20.0.0/24" and n["vlan"]["dhcp_active"] and n["interface_name"] == "Uplink"
lab = {"id": "deadbeef", "name": "Malware Lab", "gateway_cidr": "10.66.0.1/24"}
n = vh.nic_view({"key": "net1", "name": "eth1", "bridge": "br50", "tag": None}, "", {}, [], lab, {})
assert n["lab"]["subnet_cidr"] == "10.66.0.0/24" and n["model"] == "veth" and n["vendor_id"] is None and n["link_up"]

# Request validation.
assert vh.DeviceUpdate(mac_address="52:54:00:AA:BB:CC").mac_address
raises(lambda: vh.DeviceUpdate(mac_address="01:54:00:AA:BB:CC"))  # multicast
raises(lambda: vh.DeviceUpdate(trunks=[10, 5000]))
raises(lambda: vh.DeviceUpdate(bridge="br0; reboot"))
assert vh.IdentityBody(device_name="Studio HDMI Capture Pro", vendor_id="1b36", device_id="0x0010")
raises(lambda: vh.IdentityBody(device_name='Cam" options x'))
raises(lambda: vh.IdentityBody(vendor_id="12345"))
assert "vlan_tag" in vh.DeviceUpdate(vlan_tag=None).model_fields_set  # explicit null clears the tag
raises(lambda: vh.RepatchBody(net_id="net0"))  # neither switch nor lab
raises(lambda: vh.RepatchBody(bridge="br0", lab_id="deadbeef"))
raises(lambda: vh.RepatchBody(lab_id="deadbeef", vlan_tag=5))
assert vh.RepatchBody(bridge="br1", vlan_tag=30).vlan_tag == 30

# Scanner parsers.
neigh = json.dumps([{"dst": "192.168.1.1", "lladdr": "aa:bb:cc:00:00:01", "state": ["REACHABLE"]},
                    {"dst": "192.168.1.9", "lladdr": "aa:bb:cc:00:00:09", "state": ["FAILED"]},
                    {"dst": "10.0.0.5", "lladdr": "aa:bb:cc:00:00:05", "state": ["STALE"]},
                    {"dst": "192.168.1.7", "state": ["INCOMPLETE"]}])
assert sc.parse_neigh(neigh, "192.168.1.0/24") == {"192.168.1.1": "AA:BB:CC:00:00:01"}
assert sc.parse_mdns("=;eth0;IPv4;Office Printer;_ipp._tcp;local;printer.local;192.168.1.40;631;\n+;eth0;IPv4;x\n") == \
    {"192.168.1.40": "printer"}
assert sc.parse_oui("001B21|00-1B-21   (hex)\t\tExample Networks Inc\n525400|525400\tQEMU virtual NIC\nABCDEF|\n") == \
    {"001B21": "Example Networks Inc", "525400": "QEMU virtual NIC"}
assert sc.parse_open("open 192.168.1.1 53\nopen 192.168.1.1 80\nnoise\n") == {"192.168.1.1": {53, 80}}
assert len(sc.sweep_targets("10.0.0.0/16")) == sc.MAX_SWEEP and sc.sweep_targets("10.0.0.0/30") == ["10.0.0.1", "10.0.0.2"]
assert sc.locally_administered("DA:A1:19:00:00:01") and not sc.locally_administered("BC:24:11:00:00:01")
assert not sc.locally_administered("52:54:00:00:00:01")  # the emulator prefix is a VM, not a phone
s = sc.sections("open 1.2.3.4 22\n@@rdns\n1.2.3.4 nas\n@@oui\nX|y\n")
assert s["_"].strip() == "open 1.2.3.4 22" and s["rdns"].strip() == "1.2.3.4 nas" and s["oui"].strip() == "X|y"
assert "/dev/tcp/$h/$p" in sc.probe_script(["10.0.0.2"], ["52:54:00:00:00:01"]) and "525400" in sc.probe_script([], ["52:54:00:00:00:01"])
assert "-I br0" in sc.discovery_script("br0", ["10.0.0.2"])

# Classifier and summaries.
cat, roles = sc.classify({53, 80, 443}, "router", gateway=True, dhcp=True)
assert cat == "router_gateway" and sc.summary(roles, cat) == "Gateway, DHCP & DNS Resolver, Web & Reverse Proxy Host"
assert sc.classify({9100, 631, 80})[0] == "printer_scanner" and sc.summary(*reversed(sc.classify({9100}))) == "Network Printer"
assert sc.classify({554, 80})[0] == "camera_nvr"
assert sc.classify({32400})[0] == "media_tv"
assert sc.classify({445, 5000, 443})[0] == "nas_storage" and sc.classify({2049})[0] == "nas_storage"
assert sc.classify({3389, 445})[0] == "workstation_pc"
assert sc.classify({1883})[0] == "iot_device" and sc.classify({80})[0] == "iot_device"
assert sc.classify(set(), "", "DA:A1:19:00:00:01")[0] == "mobile_tablet"
assert sc.classify({22, 8006}, is_host=True)[0] == "server_hypervisor" and sc.classify({22})[0] == "server_hypervisor"
assert sc.classify(set(), managed=True)[0] == "server_hypervisor"
assert sc.classify(set(), "core-switch")[0] == "switch_ap" and sc.classify(set())[0] == "unknown"
assert sc.summary([], "unknown") == "No open services found"
assert sc.summary(["ssh", "web", "database", "dashboard"], "server_hypervisor").endswith("…")
rows = sc.port_rows({443, 22, 9999})
assert [r["port"] for r in rows] == [22, 443] and rows[0]["service_name"] == "SSH" and rows[0]["purpose_description"]
assert set(sc.CATEGORIES) >= {sc.classify(p)[0] for p in ({53}, {554}, {9100}, set())}

# Network list: switches, VLANs (not the lab's), labs.
state = {"bridges": [{"name": "br0", "ipv4_cidr": "192.168.1.10/24", "ipv4_gateway": "192.168.1.1", "dns_servers": [],
                      "vlan_aware": True, "clustered": True, "live_addrs": []},
                     {"name": "br9", "ipv4_cidr": None, "live_addrs": ["172.16.0.1/24"]}],
         "vlans": [{"vlan_id": 20, "name": "IoT", "bridge": "br0", "host_ipv4_cidr": "10.20.0.1/24", "dhcp_active": True,
                    "color": "#22c55e", "dhcp_config": {"gateway_ip": "10.20.0.1", "subnet_mask": "255.255.255.0",
                                                        "range_start": "10.20.0.100", "range_end": "10.20.0.200"}},
                   {"vlan_id": 30, "name": "Guests", "bridge": "br0", "host_ipv4_cidr": None, "dhcp_config": None},
                   {"vlan_id": 900, "name": "Lab", "bridge": "br50", "lab": "deadbeef", "dhcp_active": True}]}
labs = [{"id": "deadbeef", "name": "Lab", "bridge": "br50", "vlan_id": 900, "gateway_cidr": "10.66.0.1/24",
         "range_start": "10.66.0.100", "range_end": "10.66.0.200", "members": []}]
nets = {n["network_id"]: n for n in arch.networks(state, labs)}
assert set(nets) == {"br0", "br9", "vlan-20", "vlan-30", "lab-deadbeef"}
assert nets["br0"]["subnet_cidr"] == "192.168.1.0/24" and nets["br9"]["subnet_cidr"] == "172.16.0.0/24"
assert nets["vlan-20"]["iface"] == "br0.20" and nets["vlan-20"]["dhcp_active"] and "10.20.0.100" in nets["vlan-20"]["dhcp_range"]
assert nets["vlan-30"]["host_cidr"] is None and nets["vlan-30"]["subnet_cidr"] is None
assert nets["lab-deadbeef"]["dhcp_active"] and nets["lab-deadbeef"]["gateway_ip"] == "10.66.0.1"

# Host facts: default gateway with MAC, LLDP neighbor, DNS without the local stub.
host = arch.parse_host(json.dumps([{"dst": "default", "gateway": "192.168.1.1", "dev": "br0"}]) + "\n@@\n"
                       + json.dumps([{"dst": "192.168.1.1", "lladdr": "aa:bb:cc:dd:ee:ff"}]) + "\n@@\n"
                       + json.dumps({"lldp": {"interface": [{"eno1": {"via": "LLDP", "chassis": {"core-sw": {}},
                                                                       "port": {"descr": "port 7"}}}]}}) + "\n@@\n"
                       + "127.0.0.53\n1.1.1.1\n1.1.1.1\n")
assert host["gateways"] == [{"ip": "192.168.1.1", "dev": "br0", "mac": "AA:BB:CC:DD:EE:FF"}]
assert host["lldp"] == [{"local_port": "eno1", "neighbor": "core-sw", "protocol": "LLDP", "neighbor_port": "port 7"}]
assert host["dns"] == ["1.1.1.1"] and arch.parse_host("") == {"gateways": [], "lldp": [], "dns": []}
assert arch.pct(1, 4) == 25.0 and arch.pct(1, 0) is None

# Routes are registered.
from app.main import app  # noqa: E402

paths = {r.path for r in app.routes}
for p in ("/api/architecture/overview", "/api/architecture/networks/{network_id}/scan",
          "/api/architecture/networks/{network_id}/devices", "/api/virtual-hardware/{guest_type}/{guest_id}/detailed",
          "/api/virtual-hardware/{guest_type}/{guest_id}/devices/{device_id}",
          "/api/virtual-hardware/{guest_type}/{guest_id}/repatch-endpoint"):
    assert p in paths, p
print("architecture self-check OK")
