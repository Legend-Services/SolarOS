"""Hardware inventory / GPU manager self-check on real host output. Run: python -m tests.test_hardware_admin (from backend/)."""
import os
import tempfile
from pathlib import Path

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import hardware_admin as h, pci  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
s = h.split_sections((FIX / "hw_probe.txt").read_text())
assert {"dmi", "dimm", "lscpu", "hwmon", "meminfo", "netsys", "smart", "pkgs", "kernel"} <= s.keys(), s.keys()
probe = pci.parse((FIX / "hw_pci.txt").read_text())
disks = [{"devpath": "/dev/nvme0n1", "model": "Samsung SSD", "serial": "S1", "size": 10, "type": "nvme", "wearout": 99,
          "health": "PASSED"}, {"devpath": "/dev/sdb", "model": "HDD"}]
inv = h.build_inventory(s, probe, disks)

assert inv["system"]["manufacturer"] == "TOPC" and inv["system"]["bios_version"] == "E1.5D", inv["system"]
assert inv["system"]["bios_date"] == "01/14/2026" and inv["system"]["kernel"] == "7.0.14-30-generic"
assert inv["virtualization"]["cpu"] == "VT-x"
c = inv["cpu"]
assert c["model"] == "Intel(R) Core(TM) i9-14900HX" and (c["sockets"], c["cores"], c["threads"]) == (1, 24, 32), c
assert c["package_c"] == 42.0 and c["cores_c"][0]["label"] == "Core 0" and len(c["cores_c"]) == 24, c["cores_c"][:3]
assert c["mhz"]["min"] >= 400 and c["max_mhz"] == 5800.0
m = inv["memory"]
assert m["total"] == 65145908 * 1024 and 0 < m["used"] < m["total"] and m["arc"] > 0, m
assert [d["type"] for d in m["dimms"] if d["size"]] == ["DDR4", "DDR4"], m["dimms"]
assert m["dimms"][0]["speed"] == "3200 MT/s" and m["dimms"][0]["manufacturer"] == "Kingston"
g = {x["id"]: x for x in inv["gpus"]}
assert set(g) == {"00:02.0", "01:00.0"}, g.keys()
assert g["01:00.0"]["driver"] == "nouveau" and g["01:00.0"]["mode"] == "host" and not g["01:00.0"]["reboot_required"]
assert g["01:00.0"]["audio_function"] == "01:00.1" and g["01:00.0"]["metrics"] is None
assert g["00:02.0"]["firmware"] == {"enable_guc": "-1", "guc": "RUNNING", "huc": "RUNNING"}, g["00:02.0"]["firmware"]
drives = {d["devpath"]: d for d in inv["storage"]["drives"]}
assert drives["/dev/nvme0n1"]["temp_c"] == 34 and drives["/dev/sdb"]["temp_c"] is None
nics = {n["name"]: n for n in inv["network"]}
assert nics["nic0"]["physical"] and nics["nic0"]["driver"] == "r8169" and nics["nic0"]["speed_mbps"] == 1000
assert "lo" not in nics and nics["br0"]["addresses"], nics["br0"]
assert all(inv["packages"][p] is None for p in ("lm-sensors", *h.PLATFORM.HOST_PACKAGES)), inv["packages"]

# Parsers with outputs not present on this host.
nv = h.parse_nvidia("00000000:01:00.0, NVIDIA GeForce RTX 3090, 570.153.02, 24576, 512, 7, 41, 23.45\nbad")
assert nv == {"01:00.0": {"name": "NVIDIA GeForce RTX 3090", "driver_version": "570.153.02", "vram_total_mib": 24576.0,
                          "vram_used_mib": 512.0, "util_pct": 7.0, "temp_c": 41.0, "power_w": 23.45}}, nv
assert h.parse_nvidia("00000000:01:00.0, X, 1, [N/A], 1, 0, 30, [N/A]")["01:00.0"]["power_w"] is None
assert h.parse_amd_vram("/sys/bus/pci/devices/0000:03:00.0/mem_info_vram_total 17163091968") == {"03:00.0": 17163091968}
assert h.parse_meminfo("MemTotal:  10 kB\nHugePages_Total:  2") == {"MemTotal": 10240, "HugePages_Total": 2}
assert h.parse_dimms("Handle 0x1, DMI type 17\nMemory Device\n\tSize: No Module Installed\n\tLocator: B1\n")[0] == {
    "locator": "B1", "bank": "", "size": None, "type": None, "speed": None, "configured_speed": None,
    "manufacturer": None, "part_number": None}

# vfio-pci mode files.
conf = h.vfio_files(["10de:1aef", "10de:2204"], {"nvidia"})
assert h.parse_vfio_ids(conf[h.VFIO_CONF]) == ["10de:1aef", "10de:2204"]
assert "blacklist nouveau" in conf[h.BLACKLIST_CONF]
assert all(v is None for v in h.vfio_files([], set()).values())
gpu = {**g["01:00.0"], "driver": "nouveau"}
assert h.gpu_mode(gpu, ["10de:2204"], False) == {"mode": "passthrough", "reboot_required": True}
assert h.gpu_mode({**gpu, "driver": "vfio-pci"}, ["10de:2204"], False) == {"mode": "passthrough", "reboot_required": False}
assert h.gpu_mode(gpu, [], True)["reboot_required"]  # NVIDIA module built but nouveau still bound
script = h.mode_script(conf)
assert "options vfio-pci ids=10de:1aef,10de:2204" in script and "update-initramfs -u -k all" in script
assert all(a.split("-")[0] in ("nvidia", "intel", "amd") for a in h.SCRIPTS)
assert "__PROBE_PKG__" not in h.SCRIPTS["intel-install"]
# `apt-cache show` exits 0 for a package with no candidate, which skipped enabling non-free (trixie hosts).
assert "apt-cache show" not in h.NONFREE and "apt-cache madison" in h.NONFREE
# Debian firmware-* packages can conflict with the host's own firmware package.
installs = [ln for s in h.SCRIPTS.values() for ln in s.splitlines() if "apt-get install" in ln]
assert installs and not any("firmware-" in ln for ln in installs), "a GPU script installs a Debian firmware-* package"
print("hardware_admin self-check OK")

# Live thermals (GET /api/hardware/thermals): hwmon rows "chip|device|block|attr|label|value", per-core clock and load.
probe_out = """@@hwmon@@
coretemp|coretemp.0||temp1_input|Package id 0|61000
coretemp|coretemp.0||temp2_input|Core 0|55000
coretemp|coretemp.0||temp3_input|Core 1|58000
amdgpu|0000:03:00.0||temp1_input|edge|47000
amdgpu|0000:03:00.0||temp2_input|junction|52000
amdgpu|0000:03:00.0||fan1_input||1200
amdgpu|0000:03:00.0||power1_average||35000000
nvme|nvme0||temp1_input|Composite|39850
nvme|nvme0||temp2_input|Sensor 1|44850
drivetemp|0:0:0:0|sdb|temp1_input||33000
nct6798|nct6775.656||fan1_input|CPU Fan|900
nct6798|nct6775.656||fan2_input||0
@@freq@@
0|0|4800000
1|1|4200000
2|0|5000000
3|1|4000000
@@mhz@@
@@stat@@
cpu0 200 0 100 600 100 0 0 0 0 0
cpu1 100 0 0 900 0 0 0 0 0 0
cpu2 0 0 0 1000 0 0 0 0 0 0
cpu3 500 0 0 500 0 0 0 0 0 0
@@nvidia@@
00000000:01:00.0, RTX Test, 64, 30, 120.5, 2048, 8192, 45
"""
ts = h.split_sections(probe_out)
prev = {"0": (0, 0), "1": (0, 0), "2": (0, 0), "3": (0, 0)}
t = h.parse_thermals(ts, prev, [{"devpath": "/dev/nvme0n1", "model": "Fast NVMe", "life_left_pct": 97, "temp_c": 50}])
assert t["cpu"]["package_temp_c"] == 61.0, t["cpu"]
assert [(c["core_id"], c["temp_c"], c["freq_mhz"]) for c in t["cpu"]["cores"]] == [(0, 55.0, 5000), (1, 58.0, 4200)], t["cpu"]["cores"]
assert t["cpu"]["cores"][0]["load_pct"] == 15.0 and t["cpu"]["cores"][1]["load_pct"] == 30.0, t["cpu"]["cores"]
assert (t["cpu"]["min_freq_mhz"], t["cpu"]["avg_freq_mhz"], t["cpu"]["max_freq_mhz"]) == (4000, 4500, 5000)
gp = {x["slot"]: x for x in t["gpus"]}
assert gp["01:00.0"]["temp_c"] == 64 and gp["01:00.0"]["fan_rpm_or_pct"] == 30 and gp["01:00.0"]["vram_total_mb"] == 8192, gp
assert (gp["03:00.0"]["temp_c"], gp["03:00.0"]["hotspot_temp_c"], gp["03:00.0"]["power_w"]) == (47.0, 52.0, 35.0), gp
dr = {x["device"]: x for x in t["drives"]}
assert dr["/dev/nvme0n1"] == {"device": "/dev/nvme0n1", "model": "Fast NVMe", "temp_c": 39.9, "wear_pct": 97}, dr
assert dr["/dev/sdb"]["temp_c"] == 33.0, dr
assert t["chassis_fans"] == [{"label": "CPU Fan", "rpm": 900}], t["chassis_fans"]
assert h.parse_thermals({}, {}, [])["cpu"]["cores"] == []  # no bridge, no sysfs: empty but well-formed
print("thermals self-check OK")
