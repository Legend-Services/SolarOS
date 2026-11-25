"""Phase 6 core self-check: terminal framing, PCI/IOMMU parsing, host job status. Run: python -m tests.test_phase6_core"""
from app import console, host_ssh, pci

assert console.parse_term_frame("0:5:a:b:c") == ("data", "a:b:c")
assert console.parse_term_frame("1:120:40:") == ("resize", (120, 40))
assert console.parse_term_frame("1:99999:0:") == ("resize", (1000, 1))
assert console.parse_term_frame("2") == ("ping", None)
assert console.parse_term_frame("1:abc") == ("ping", None)

LSPCI = """0000:00:02.0 VGA compatible controller [0300]: Intel Corporation Raptor Lake-S UHD Graphics [8086:a788] (rev 04)
\tDeviceName: Onboard - Video
\tSubsystem: Intel Corporation Device [8086:0760]
\tKernel driver in use: i915
\tKernel modules: i915, xe
0000:00:1f.3 Audio device [0403]: Intel Corporation Raptor Lake High Definition Audio Controller [8086:7a50] (rev 11)
\tKernel driver in use: snd_hda_intel
0000:01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA102 [GeForce RTX 3090] [10de:2204] (rev a1)
\tSubsystem: ASUSTeK Computer Inc. Device [1043:87b3]
\tKernel driver in use: nouveau
\tKernel modules: nvidiafb, nouveau
0000:01:00.1 Audio device [0403]: NVIDIA Corporation GA102 High Definition Audio Controller [10de:1aef] (rev a1)
\tKernel driver in use: snd_hda_intel
0000:02:00.0 Non-Volatile memory controller [0108]: Samsung Electronics Co Ltd NVMe SSD Controller [144d:a80a] (prog-if 02 [NVM Express])
\tKernel driver in use: nvme
---IOMMU---
/sys/kernel/iommu_groups/0/devices/0000:00:02.0
/sys/kernel/iommu_groups/14/devices/0000:01:00.0
/sys/kernel/iommu_groups/14/devices/0000:01:00.1
/sys/kernel/iommu_groups/15/devices/0000:00:1f.3
/sys/kernel/iommu_groups/15/devices/0000:02:00.0
---CMDLINE---
BOOT_IMAGE=/vmlinuz intel_iommu=on
"""
r = pci.parse(LSPCI)
d = {x["id"]: x for x in r["devices"]}
assert r["iommu_enabled"] and r["cmdline"].endswith("intel_iommu=on")
assert len(d) == 5 and d["02:00.0"]["class"] == "0108", d.keys()
nv = d["01:00.0"]
assert nv["gpu"] and nv["vendor"] == "nvidia" and nv["driver"] == "nouveau" and nv["iommu_group"] == 14
assert nv["audio_function"] == "01:00.1" and nv["functions"] == ["01:00.0", "01:00.1"] and not nv["iommu_shared_with"]
assert any("vfio-pci" in w for w in nv["warnings"]) and not pci.gpu_view(nv)["passthrough_ready"]
assert d["00:02.0"]["vendor"] == "intel" and d["00:02.0"]["modules"] == ["i915", "xe"]
assert d["00:1f.3"]["iommu_shared_with"] == ["02:00.0"]
assert not pci.parse(LSPCI.split("---IOMMU---")[0])["iommu_enabled"]

assert host_ssh.parse_job_status("state:active\nGet:1 x") == {"running": True, "exit_code": None, "log": ["Get:1 x"]}
assert host_ssh.parse_job_status("state:inactive\nok\nold-helper: exit 3")["exit_code"] == 3  # any "<name>: exit N" marker
assert host_ssh.target() == ("root", "127.0.0.1")
print("phase6 core self-check OK")
