"""Smart Compute Groups self-check: network / VLAN / lab groups, custom groups, multi-homed guests, ungrouped guests,
resource totals, name suggestions and request validation. Run: python -m tests.test_compute_groups"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import architecture as arch  # noqa: E402
from app import compute_groups as cg  # noqa: E402

state = {
    "bridges": [{"name": "br0", "ipv4_cidr": "192.168.1.10/24", "vlan_aware": True},
                {"name": "br50", "ipv4_cidr": "10.66.0.1/24"}],
    "vlans": [{"vlan_id": 20, "name": "Production", "color": "#22c55e", "bridge": "br0", "dhcp_active": True,
               "host_ipv4_cidr": "10.10.20.1/24", "dhcp_config": {"gateway_ip": "10.10.20.1", "range_start": "10.10.20.100",
                                                                   "range_end": "10.10.20.199", "dns_servers": ["10.10.20.1"]}},
              {"vlan_id": 30, "name": "", "bridge": "br0"}],
}
labs = [{"id": "deadbeef", "name": "Malware Lab", "bridge": "br50", "vlan_id": None, "gateway_cidr": "10.66.0.1/24",
         "range_start": "10.66.0.100", "range_end": "10.66.0.200", "members": []}]
nets = arch.networks(state, labs)
rows = [{"type": "qemu", "vmid": 101, "name": "web", "status": "running", "cpu": 0.25, "maxcpu": 4, "mem": 2 * 2**30,
         "maxmem": 4 * 2**30, "host": "h1"},
        {"type": "lxc", "vmid": 200, "name": "db", "status": "stopped", "cpu": 0, "maxcpu": 2, "mem": 0, "maxmem": 2**30, "host": "h1"},
        {"type": "qemu", "vmid": 300, "name": "nonic", "status": "running", "cpu": 0.5, "maxcpu": 1, "mem": 2**29,
         "maxmem": 2**30, "host": "h1"}]
vnics = [{"guest_type": "vm", "guest_id": 101, "net_id": "net0", "bridge": "br0", "vlan_tag": 20, "ip_address": "10.10.20.45", "mac": "52:54:00:00:00:01"},
         {"guest_type": "vm", "guest_id": 101, "net_id": "net1", "bridge": "br50", "vlan_tag": None, "ip_address": "10.66.0.12", "mac": "52:54:00:00:00:02"},
         {"guest_type": "lxc", "guest_id": 200, "net_id": "net0", "bridge": "br0", "vlan_tag": None, "ip_address": None, "mac": "BC:24:11:00:00:01"},
         {"guest_type": "lxc", "guest_id": 200, "net_id": "net1", "bridge": "br0", "vlan_tag": 99, "ip_address": None, "mac": "BC:24:11:00:00:02"}]
custom = [{"group_id": "grp-1", "name": "Web stack", "color": "#ff0000", "members": [
    {"guest_type": "vm", "guest_id": 101}, {"guest_type": "lxc", "guest_id": 200}, {"guest_type": "vm", "guest_id": 999}]}]

groups = cg.synthesize(nets, vnics, rows, custom, {"vlan-20": 18})
by = {g["group_id"]: g for g in groups}
ids = lambda g: [(m["guest_type"], m["guest_id"]) for m in by[g]["members"]]  # noqa: E731

# One group per switch / VLAN / lab; the lab's bridge does not also show up as a plain switch.
assert set(by) == {"net-br0", "net-vlan-20", "net-vlan-30", "net-lab-deadbeef", "grp-1", "ungrouped"}, set(by)
assert by["net-vlan-20"]["name"] == "VLAN 20 · Production" and by["net-vlan-20"]["color"] == "#22c55e"
assert by["net-vlan-30"]["name"] == "VLAN 30" and by["net-vlan-30"]["color"] == cg.KIND_COLOR["vlan"]
assert by["net-vlan-20"]["subnet_cidr"] == "10.10.20.0/24" and by["net-vlan-20"]["dhcp_active"] and by["net-vlan-20"]["device_count"] == 18

# Multi-homed: the VM is in its VLAN, the lab and the custom group, with the NIC used in each.
assert ids("net-vlan-20") == [("vm", 101)] and ids("net-lab-deadbeef") == [("vm", 101)]
vm = by["net-vlan-20"]["members"][0]
assert [i["iface"] for i in vm["matched_interfaces"]] == ["net0"] and vm["matched_interfaces"][0]["vlan_name"] == "Production"
assert by["net-lab-deadbeef"]["members"][0]["matched_interfaces"][0]["ip"] == "10.66.0.12"
assert sorted(vm["all_group_ids"]) == ["grp-1", "net-lab-deadbeef", "net-vlan-20"]

# Untagged and undefined-VLAN NICs belong to the switch; deleted guests in a custom group are hidden.
sw = by["net-br0"]["members"]
assert ids("net-br0") == [("lxc", 200)] and [i["iface"] for i in sw[0]["matched_interfaces"]] == ["net0", "net1"]
assert ids("grp-1") == [("vm", 101), ("lxc", 200)]
assert len(by["grp-1"]["members"][0]["matched_interfaces"]) == 2  # unlinked custom group: every NIC
assert by["grp-1"]["members"][0]["matched_interfaces"][1]["network_id"] == "lab-deadbeef"

# A guest with no NIC on any network is never hidden.
assert ids("ungrouped") == [("vm", 300)] and by["ungrouped"]["members"][0]["all_group_ids"] == ["ungrouped"]

# Totals: running count, vCPU, RAM (allocated over all members, used over running ones), average CPU of running.
g = by["grp-1"]
assert (g["total_guests"], g["running_guests"], g["total_vcpu"]) == (2, 1, 6)
assert g["allocated_ram_mb"] == 5 * 1024 and g["used_ram_mb"] == 2048 and g["avg_cpu_pct"] == 25.0
assert by["net-vlan-30"]["total_guests"] == 0 and by["net-vlan-30"]["avg_cpu_pct"] == 0.0

# Linked custom group: only the NICs on its network.
linked = cg.synthesize(nets, vnics, rows, [{**custom[0], "linked_network_id": "vlan-20"}])
lg = next(x for x in linked if x["group_id"] == "grp-1")
assert lg["vlan_id"] == 20 and [len(m["matched_interfaces"]) for m in lg["members"]] == [1, 0]

# Suggestions: the VLAN beats the lab and the plain switch; a network id is looked up directly.
s = cg.suggest(groups, {("vm", 101)})
assert s["suggested_name"] == "VLAN 20 · Production" and s["suggested_color"] == "#22c55e" and s["linked_network_id"] == "vlan-20"
assert cg.suggest(groups, {("lxc", 200)})["linked_network_id"] == "br0"
assert cg.suggest(groups, network_id="lab-deadbeef")["suggested_name"] == "Malware Lab"
assert cg.suggest(groups, {("vm", 300)})["suggested_name"] is None
assert cg.parse_keys("vm:101, 200") == {("vm", 101), ("vm", 200), ("lxc", 200)}
for bad in ("vm:x", "qemu:1", "1;2"):
    try:
        cg.parse_keys(bad)
        raise AssertionError(bad)
    except HTTPException:
        pass

# Request validation.
assert cg.GroupBody(name="Lab", members=[{"guest_type": "vm", "guest_id": "101"}]).members[0].guest_id == 101
for bad in ({"name": ""}, {"name": "x", "color": "red"}, {"name": "x", "linked_network_id": "a b"},
            {"name": "x", "members": [{"guest_type": "qemu", "guest_id": 1}]}):
    try:
        cg.GroupBody(**bad)
        raise AssertionError(bad)
    except ValidationError:
        pass

# Store round trip.
cg.STORE = cg.FsPath(tempfile.mkdtemp()) / "g.json"
assert cg._custom() == []
cg._save(custom)
assert cg._custom()[0]["name"] == "Web stack"

print("compute groups: ok")
