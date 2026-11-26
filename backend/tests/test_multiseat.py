"""Multi-seat self-check (topology parsing, core balancing, seat conflicts, Plug to Assign, SolarOS domain XML).
Run: python -m tests.test_multiseat"""
import os
import tempfile
from pathlib import Path

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from pydantic import ValidationError  # noqa: E402

from app import multiseat as ms  # noqa: E402
from providers.native_ubuntu import multiseat as nm  # noqa: E402

LSPCI = """0000:00:02.0 VGA compatible controller [0300]: Intel Corporation UHD Graphics 770 [8086:4680] (rev 0c)
\tKernel driver in use: i915
0000:00:14.0 USB controller [0c03]: Intel Corporation Alder Lake USB 3.2 xHCI [8086:7ae0] (rev 11)
\tKernel driver in use: xhci_hcd
0000:01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA102 [GeForce RTX 3090] [10de:2204] (rev a1)
\tKernel driver in use: nvidia
0000:01:00.1 Audio device [0403]: NVIDIA Corporation GA102 High Definition Audio Controller [10de:1aef] (rev a1)
\tKernel driver in use: snd_hda_intel
---IOMMU---
/sys/kernel/iommu_groups/0/devices/0000:00:02.0
/sys/kernel/iommu_groups/5/devices/0000:00:14.0
/sys/kernel/iommu_groups/12/devices/0000:01:00.0
/sys/kernel/iommu_groups/12/devices/0000:01:00.1
---CMDLINE---
BOOT_IMAGE=/vmlinuz intel_iommu=on
"""
T = "\t"
SYS = "\n".join([
    "@@PCI@@", f"0000:00:02.0{T}1{T}fixed", f"0000:00:14.0{T}{T}fixed", f"0000:01:00.0{T}0{T}removable",
    "@@DRM@@", f"card0-HDMI-A-1{T}/sys/devices/pci0000:00/0000:00:02.0{T}connected",
    f"card1-DP-1{T}/sys/devices/pci0000:00/0000:00:01.0/0000:01:00.0{T}disconnected",
    f"card1-HDMI-A-2{T}/sys/devices/pci0000:00/0000:00:01.0/0000:01:00.0{T}connected",
    "@@TB@@", f"0-1{T}0{T}Razer{T}Core X{T}abc-123", "@@USB@@",
    T.join(["usb1", "1", "1d6b", "0002", "09", "480", "xHCI Host Controller", "Linux", "/sys/devices/pci0000:00/0000:00:14.0/usb1"]),
    T.join(["1-4", "1", "046d", "c08b", "00", "12", "G502 Mouse", "Logitech", "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-4"]),
    T.join(["1-5", "1", "046d", "c08b", "00", "12", "G502 Mouse", "Logitech", "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-5"]),
    T.join(["1-4:1.0", "1", "", "", "", "", "", "", "/x"]),
    T.join(["1-10", "1", "05e3", "0610", "09", "480", "USB2.1 Hub", "GenesysLogic", "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-10"]),
    T.join(["1-10.2", "1", "1532", "0084", "00", "12", "", "", "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-10/1-10.2"]),
    "@@CPU@@", "# The following is the parsable format", *[f"{c},{c % 4},0" for c in range(8)],
    "@@BOLT@@", "yes",
])

topo = ms.parse_topology(LSPCI + SYS)
gpus = {g["id"]: g for g in topo["gpus"]}
igpu, rtx = gpus["00:02.0"], gpus["01:00.0"]
assert igpu["boot_vga"] and not igpu["external"] and igpu["connectors"] == [{"name": "HDMI-A-1", "status": "connected"}]
assert rtx["external"] and not rtx["boot_vga"] and rtx["audio_function"] == "0000:01:00.1"
assert rtx["functions"] == ["0000:01:00.0", "0000:01:00.1"] and [c["name"] for c in rtx["connectors"]] == ["DP-1", "HDMI-A-2"]
assert rtx["passthrough_ready"] and rtx["iommu_group"] == 12
assert topo["usb_controllers"][0]["slot"] == "0000:00:14.0" and topo["usb_controllers"][0]["buses"] == [1]
ports = [u["port"] for u in topo["usb_devices"]]
assert ports == ["1-4", "1-5", "1-10", "1-10.2"], ports  # numeric order; root hubs and interfaces are left out
same = [u for u in topo["usb_devices"] if u["product"] == "G502 Mouse"]
assert len(same) == 2 and same[0]["port"] != same[1]["port"]  # identical mice stay apart by port
assert next(u for u in topo["usb_devices"] if u["port"] == "1-10")["hub"]
assert next(u for u in topo["usb_devices"] if u["port"] == "1-10.2")["name"] == "1532:0084"
assert topo["thunderbolt"] == [{"id": "0-1", "authorized": False, "vendor": "Razer", "name": "Core X", "uuid": "abc-123"}]
assert topo["boltctl"] and topo["iommu_enabled"]
# 8 threads on 4 cores (SMT pairs 0+4, 1+5, ...): the host keeps core 0.
assert topo["cpu"]["cores"][0] == {"socket": 0, "core": 0, "threads": [0, 4]} and topo["cpu"]["reserved"] == [0, 4]
assert topo["cpu"]["threads"] == 8

# Balancing: whole cores, no overlap, the reserved core(s) never handed out.
cores = ms.parse_cpus([f"{c},{c % 8},0" for c in range(16)])  # 8 cores, 16 threads -> 2 reserved
assert ms.reserved_cores(cores) == cores[:2]
groups = ms.balance(cores, 2)
assert groups == [[2, 3, 4, 10, 11, 12], [5, 6, 7, 13, 14, 15]]
assert not set(groups[0]) & set(groups[1]) and not {0, 1, 8, 9} & set(groups[0] + groups[1])
assert ms.balance(cores, 7)[-1] == [] and ms.balance(cores, 0) == []

# Conflicts between seats.
a = {"seat_id": "a", "name": "Seat 1", "vm_id": 101, "gpu_pci_slot": "0000:01:00.0", "usb_ports": ["1-4"], "cpu_cores": [2, 10]}
b = {"seat_id": "b", "name": "Seat 2", "vm_id": 102, "gpu_pci_slot": "0000:02:00.0", "usb_ports": ["1-5"], "cpu_cores": [3, 11]}
assert ms.conflicts(b, [a]) == []
bad = ms.conflicts({**b, "vm_id": 101, "usb_ports": ["1-4"], "cpu_cores": [10], "extra_pci_slots": ["0000:01:00.0"]}, [a])
assert len(bad) == 4 and "Seat 1" in bad[0]

# Request model: normalization and refusals.
s = ms.SeatBody(name="Seat 1 · Primary Desk", gpu_pci_slot="01:00.0", usb_ports=["1-4", "1-4", "3-2.1"],
                usb_names={"1-4": "Mouse", "9-9": "gone"}, usb_controller_pci_slots=["00:14.0"], cpu_cores=[5, 4, 4]).record()
assert s["gpu_pci_slot"] == "0000:01:00.0" and s["usb_ports"] == ["1-4", "3-2.1"] and s["cpu_cores"] == [4, 5]
assert s["usb_controller_pci_slots"] == ["0000:00:14.0"] and s["usb_names"] == {"1-4": "Mouse"}
for kw in ({"usb_ports": ["1-4; reboot"]}, {"gpu_pci_slot": "01:00"}, {"name": "<b>"}, {"cpu_cores": [-1]},
           {"extra_pci_slots": ["x"]}):
    try:
        ms.SeatBody(**{"name": "S", **kw})
        raise AssertionError(kw)
    except ValidationError:
        pass

# Plug to Assign: listener output.
new = ms.parse_new_usb(f"1-6{T}00{T}Gaming Mouse{T}Acme\n3-2{T}09{T}Hub{T}\n3-2.1{T}00{T}{T}Maker\nbogus;rm{T}00{T}x{T}y\n")
assert new == [{"port": "1-6", "hub": False, "name": "Gaming Mouse"}, {"port": "3-2", "hub": True, "name": "Hub"},
               {"port": "3-2.1", "hub": False, "name": "Maker"}]
assert "0.25" in ms.listen_script() and "120" in ms.listen_script()

# Boot-GPU release script: quoted functions, consoles and framebuffers first.
rs = ms.release_script(["01:00.0", "0000:01:00.1"])
assert "for f in 0000:01:00.0 0000:01:00.1;" in rs and rs.index("vtconsole") < rs.index("efi-framebuffer") < rs.index("vfio-pci")

# SolarOS: seat hostdevs replace earlier ones (by alias), the user's own hostdevs and CPU topology stay.
XML = """<domain type="kvm"><name>seat1</name><vcpu placement="static">4</vcpu><devices>
<hostdev mode="subsystem" type="usb" managed="yes"><source><vendor id="0x1111"/><product id="0x2222"/></source></hostdev>
<hostdev mode="subsystem" type="pci" managed="yes"><source><address domain="0x0000" bus="0x05" slot="0x00" function="0x0"/></source><alias name="ua-seat-0"/></hostdev>
</devices></domain>"""
out = nm.seat_xml(XML, {**a, "gpu_audio_pci_slot": "0000:01:00.1", "usb_ports": ["1-4", "1-9"]}, {"1-4": (1, 7)})
assert 'bus="0x05"' not in out and out.count("ua-seat-") == 3 and 'vendor id="0x1111"' in out
assert 'bus="1" device="7"' in out and 'startupPolicy="optional"' in out and 'cpuset="2,10"' in out
cleared = nm.seat_xml(out, {"usb_ports": []}, {})
assert "ua-seat-" not in cleared and "cpuset" not in cleared and 'vendor id="0x1111"' in cleared
root = Path(tempfile.mkdtemp())
(root / "1-4").mkdir()
(root / "1-4" / "busnum").write_text("1\n")
(root / "1-4" / "devnum").write_text("12\n")
assert nm.usb_address("1-4", root) == (1, 12) and nm.usb_address("1-5", root) is None

print("multiseat: all checks passed")
