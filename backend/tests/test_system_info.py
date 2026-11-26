"""System › Info summary helpers self-check. Run: python -m tests.test_system_info"""
from app import system_info as si


def test_gpu_type_and_row():
    igpu = {"id": "00:02.0", "vendor": "intel", "name": "UHD Graphics 770", "driver": "i915"}
    arc = {"id": "03:00.0", "vendor": "intel", "name": "Arc A380", "driver": "vfio-pci", "vram_bytes": 6 * 1024 ** 3}
    nv = {"id": "01:00.0", "vendor": "nvidia", "name": "GA102", "driver": "nvidia",
          "metrics": {"name": "RTX 3090", "vram_total_mib": 24576.0, "vram_used_mib": 512.0, "temp_c": 41.0}}
    assert si.gpu_type(igpu) == "integrated" and si.gpu_type(arc) == "discrete" and si.gpu_type(nv) == "discrete"
    row = si.gpu_row(nv)
    assert row["name"] == "RTX 3090" and row["vram_total_mb"] == 24576.0 and row["temperature_c"] == 41.0
    assert not row["passthrough_bound"]
    assert si.gpu_row(arc)["vram_total_mb"] == 6144 and si.gpu_row(arc)["passthrough_bound"]


def test_storage_and_memory_summary():
    drives = [{"size": 1000, "health": "PASSED"}, {"size": 2000, "health": "FAILED"}, {"size": None, "health": None}]
    pools = [{"name": "tank", "health": "ONLINE", "alloc": 10, "size": 100}]
    s = si.storage_summary(drives, pools)
    assert (s["physical_disk_count"], s["total_raw_bytes"], s["healthy_disks"], s["degraded_disks"]) == (3, 3000, 1, 1)
    assert s["pools_summary"] == [{"name": "tank", "health": "ONLINE", "used_bytes": 10, "total_bytes": 100}]
    dimms = [{"size": None}, {"size": "32 GB", "type": "DDR5", "speed": "4800 MT/s", "configured_speed": "4400 MT/s"}]
    assert si.memory_type_speed(dimms) == "DDR5 4400 MT/s"
    assert si.memory_type_speed([]) is None


def test_updates_block():
    u = si.updates({"current_version": "1.0.0", "latest_version": "1.1.0", "update_available": True, "branch": "main",
                    "incoming": [{"subject": "a"}, {"subject": "b"}]})
    assert u["update_available"] and u["channel"] == "main" and u["release_notes_summary"] == "a; b"
    assert si.updates({})["update_available"] is False


for f in (test_gpu_type_and_row, test_storage_and_memory_summary, test_updates_block):
    f()
print("system info: ok")
