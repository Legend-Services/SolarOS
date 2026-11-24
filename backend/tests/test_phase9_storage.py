"""Phase 9 self-check: disk normalization, ZFS members, tuning rules, self-test/surface parsing, fio parsing.
Run: python -m tests.test_phase9_storage (from backend/)."""
import json
import os
import tempfile
from pathlib import Path

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import disk_benchmark as b, storage_admin as s  # noqa: E402

FIX = Path(__file__).parent / "fixtures"

# ---- Disk list normalization on real PVE /disks/list rows (HDD reports rpm -1 and wearout "N/A").
hdd = s.normalize_disk({"devpath": "/dev/sda", "rpm": -1, "wearout": "N/A", "type": "unknown", "vendor": "ATA",
                        "by_id_link": "/dev/disk/by-id/ata-WDC_WD20EFRX-68AX9N0_WD-WMC300635480"}, None, None)
assert hdd["rotational"] and hdd["rpm"] is None and hdd["rpm_label"] == "HDD" and hdd["wearout_pct"] is None, hdd
assert s.normalize_disk({"devpath": "/dev/sda", "rpm": -1, "wearout": -1}, None, 7200)["rpm_label"] == "7200 RPM"
assert s.normalize_disk({"devpath": "/dev/sdc", "rpm": 5400, "type": "hdd"}, None, None)["rpm"] == 5400
nvme = s.normalize_disk({"devpath": "/dev/nvme0n1", "rpm": 0, "wearout": 95, "type": "nvme"}, None, None)
assert not nvme["rotational"] and nvme["rpm"] is None and nvme["rpm_label"] == "SSD / NVMe" and nvme["wearout_pct"] == 95
usb = s.normalize_disk({"devpath": "/dev/sdb", "rpm": 0, "wearout": "N/A", "type": "usb"}, None, None)
assert usb["bus"] == "USB" and usb["rpm_label"] == "Flash (USB)" and not usb["rotational"] and usb["pool_name"] is None
assert s.parse_rpm("5400 rpm") == 5400 and s.parse_rpm("Solid State Device") is None

# ---- zpool status -P from the real host (rpool mirror of two NVMe partitions).
pools = s.parse_zpool_status((FIX / "zpool_status.txt").read_text())
rows = pools["rpool"]
assert [r["depth"] for r in rows] == [0, 1, 2, 2] and rows[1]["name"] == "mirror-0", rows
leaf = rows[2]
assert leaf["parent"] == "mirror-0" and leaf["state"] == "ONLINE" and leaf["name"].endswith("-part3")
links = {rows[2]["name"]: "/dev/nvme0n1p3", rows[3]["name"]: "/dev/nvme1n1p3"}
members = s.zfs_members(pools, links)
assert members["/dev/nvme0n1"]["pool_name"] == "rpool" and members["/dev/nvme0n1"]["vdev_name"] == "mirror-0"
assert members["/dev/nvme1n1"]["member_device"] == rows[3]["name"] and members["/dev/nvme1n1"]["cksum_errors"] == 0
assert s.find_member(rows, rows[2]["name"].rsplit("/", 1)[-1], links) is leaf  # short name as zpool status prints it
assert s.find_member(rows, "nvme0n1p3", links) is leaf and s.find_member(rows, "sdz", links) is None
assert s.offline_problem(rows, "rpool", leaf) is None
degraded = [dict(r) for r in rows]
degraded[3]["state"] = "OFFLINE"
assert "fault" in s.offline_problem(degraded, "rpool", degraded[2])
assert s.base_disk("/dev/nvme0n1p3") == "/dev/nvme0n1" and s.base_disk("/dev/sda1") == "/dev/sda"
assert s.base_disk("/dev/sda") == "/dev/sda" and s.base_disk("/dev/nvme0n1") == "/dev/nvme0n1"
assert s.partition_number("/dev/nvme0n1p3") == "3" and s.partition_number("/dev/sdb2") == "2"
assert s.partition_number("/dev/sdb") is None and s.partition_number("/dev/disk/by-id/nvme-eui.x-part3") == "3"
assert s.partition_number("/dev/disk/by-id/ata-X") is None
assert s.partition_path("/dev/disk/by-id/ata-X", "3") == "/dev/disk/by-id/ata-X-part3"
assert s.partition_path("/dev/nvme1n1", "3") == "/dev/nvme1n1p3" and s.partition_path("/dev/sdc", "1") == "/dev/sdc1"

RAIDZ2 = """  pool: tank
 state: DEGRADED
config:

\tNAME          STATE     READ WRITE CKSUM
\ttank          DEGRADED     0     0     0
\t  raidz2-0    DEGRADED     0     0     0
\t    /dev/sda  ONLINE       0     0     0
\t    /dev/sdb  FAULTED     12  1.2K     3  too many errors
\t    /dev/sdc  ONLINE       0     0     0
\t    /dev/sdd  ONLINE       0     0     0
\t/dev/sde      ONLINE       0     0     0
\tcache
\t  /dev/nvme2n1  ONLINE   0     0     0

errors: No known data errors
"""
t = s.parse_zpool_status(RAIDZ2)["tank"]
by = {r["name"]: r for r in t}
assert by["/dev/sdb"]["write"] == 1200 and by["/dev/sdb"]["msg"] == "too many errors" and by["/dev/sdb"]["read"] == 12
assert by["/dev/nvme2n1"]["group"] == "cache" and by["/dev/sda"]["group"] == "data"
assert s.offline_problem(t, "tank", by["/dev/sda"]) is None  # raidz2 with one failure survives one more
two_down = [dict(r, state="OFFLINE") if r["name"] == "/dev/sdc" else r for r in t]
assert "fault" in s.offline_problem(two_down, "tank", next(r for r in two_down if r["name"] == "/dev/sda"))
assert s.offline_problem(t, "tank", by["/dev/nvme2n1"]) is None
assert s.vdev_kind("raidz2-0") == "raidz2" and s.vdev_kind("mirror-12") == "mirror"
assert s.zfs_members({"tank": t}, {})["/dev/sdb"]["write_errors"] == 1200

# ---- Tuning: hdparm encodings, udev rules round trip, capability detection.
assert [s.spindown_value(m) for m in (0, 5, 10, 20, 30, 60, 120)] == [0, 60, 120, 240, 241, 242, 244]
bid = "/dev/disk/by-id/ata-WDC_WD20EFRX-68AX9N0_WD-WMC300635480"
PULLED = RAIDZ2.replace("\t    /dev/sdb  FAULTED     12  1.2K     3  too many errors",
                        "\t    9876543210123  UNAVAIL  0  0  0  was /dev/sdb1")
p = s.parse_zpool_status(PULLED)["tank"]
gone = s.find_member(p, "9876543210123", {})
assert gone and gone["state"] == "UNAVAIL" and s.find_member(p, "/dev/sdb1", {}) is gone
assert s.find_member(p, "raidz2-0", {}) is None and s.find_member(p, "tank", {}) is None  # not leaves
assert s.offline_problem(p, "tank", s.find_member(p, "/dev/sda", {})) is None

rules = s.render_rules({bid: {"by_id": bid, "apm_level": 127, "spindown_minutes": 20, "write_cache": True},
                        "/dev/disk/by-id/nvme-X": {"by_id": "/dev/disk/by-id/nvme-X", "power_state": 2}})
assert 'RUN+="/usr/sbin/hdparm -B 127 -S 240 -W 1 /dev/%k"' in rules and "-f 2 -v 2" in rules, rules
assert f'ENV{{DEVLINKS}}=="{bid}|{bid} *|* {bid}|* {bid} *"' in rules
assert s.parse_rules(rules)[bid]["spindown_minutes"] == 20 and len(s.parse_rules(rules + "\n# proxmoxos {bad")) == 2
assert "hdparm" not in s.render_rules({bid: {"by_id": bid}})

smart_i = json.dumps({"smart_support": {"available": True, "enabled": True}})
sata = s.parse_settings("SATA", True, {"smart": smart_i, "apm": " APM_level\t= not supported",
                                       "wcache": " write-caching =  1 (on)"}, {"spindown_minutes": 10}, bid)
assert sata["values"] == {"apm_level": None, "spindown_minutes": 10, "write_cache": True, "power_state": None,
                          "smart_enabled": True}, sata["values"]
c = sata["capabilities"]
assert not c["apm_level"]["supported"] and c["apm_level"]["reason"] and c["spindown_minutes"]["supported"]
assert c["write_cache"]["supported"] and c["smart_enabled"]["supported"] and not c["power_state"]["supported"]
assert s.parse_settings("SATA", True, {"apm": "APM_level\t= 254"}, None, "")["values"]["apm_level"] == 254
assert s.parse_settings("SATA", True, {"apm": "APM_level\t= off"}, None, "")["values"]["apm_level"] == "disabled"
assert not s.parse_settings("USB", True, {}, None, "")["capabilities"]["spindown_minutes"]["supported"]
nv_json = (FIX / "smart_selftest_nvme.json").read_text()
nv = s.parse_settings("NVMe", False, {"smart": nv_json, "ps": "get-feature:0x02 (Power Management), Current value:0x00000002"}, None, "x")
assert [p["operational"] for p in nv["power_states"]] == [True, True, True, False, False], nv["power_states"]
assert nv["power_states"][0]["max_power_w"] == 3.5 and nv["power_states"][4]["max_power_w"] == 0.004
assert nv["values"]["power_state"] == 2 and nv["capabilities"]["power_state"]["supported"] and nv["nvme_cli_installed"]
assert not nv["capabilities"]["smart_enabled"]["supported"] and not nv["capabilities"]["apm_level"]["supported"]
assert not s.parse_settings("NVMe", False, {"missing": "nvme"}, None, "")["nvme_cli_installed"]

# ---- SMART self-test log (real smartctl 7.5 JSON) and badblocks progress.
ata = s.parse_selftest(json.loads((FIX / "smart_selftest_ata.json").read_text()))
assert not ata["running"] and len(ata["history"]) == 21 and ata["history"][0]["type"] == "Short offline", ata["history"][:1]
assert ata["history"][0]["passed"] and ata["history"][0]["lifetime_hours"] == 26990
run = s.parse_selftest({"ata_smart_data": {"self_test": {"status": {"value": 249, "remaining_percent": 90},
                                                          "polling_minutes": {"short": 2, "extended": 281}}}}, "long")
assert run["running"] and run["progress_pct"] == 10 and run["eta_seconds"] == int(281 * 60 * 0.9) and run["test"] == "Extended self-test"
assert not s.parse_selftest(json.loads(nv_json))["running"]
nrun = s.parse_selftest({"nvme_self_test_log": {"current_self_test_operation": {"value": 1, "string": "Short self-test in progress"},
                                                "current_self_test_completion_percent": 50,
                                                "table": [{"self_test_code": {"string": "Short"}, "self_test_result": {"value": 0, "string": "Completed without error"}, "power_on_hours": 5}]}})
assert nrun["running"] and nrun["progress_pct"] == 50 and nrun["eta_seconds"] == 60 and nrun["history"][0]["passed"]
bb = s.parse_badblocks("active", "Checking for bad blocks (read-only test): \n  1.00% done, 0:10 elapsed. (0/0/0 errors)\n 25.00% done, 1:00 elapsed. (1/0/0 errors)\n", "1\n")
assert bb["running"] and bb["progress_pct"] == 25.0 and bb["eta_seconds"] == 180 and bb["errors"] == 1 and bb["bad_blocks"] == 1, bb
done = s.parse_badblocks("inactive", "Pass completed, 0 bad blocks found. (0/0/0 errors)\nproxmox-os: exit 0\n", "")
assert not done["running"] and done["exit_code"] == 0 and done["bad_blocks"] == 0
assert s._scan_job("/dev/nvme0n1") == "scan-nvme0n1" and s._scan_job("/dev/disk/by-id/ata-X_Y.1")[:5] == "scan-"

# ---- fio command + JSON parsing.
cmd = b.fio_command("/dev/sda", "RND4K_Q32T1", "read", 1024, True)
assert "--rw=randread" in cmd and "--bs=4k" in cmd and "--iodepth=32" in cmd and cmd.endswith("--readonly"), cmd
assert "--rw=write" in b.fio_command("/tank/.proxmoxos-bench.tmp", "SEQ1M_Q8T1", "write", 256, False)
fio_out = "fio: warning\n" + json.dumps({"jobs": [{"read": {"bw_bytes": 3_500_000_000, "bw": 3417968, "iops": 3337.9,
                                                            "lat_ns": {"mean": 2_396_000}}, "write": {}}]})
assert b.parse_fio(fio_out, "read") == {"mbps": 3500.0, "iops": 3337.9, "lat_us": 2396.0}
assert b.best([{"mbps": 1}, {"mbps": 3}, {"mbps": 2}]) == {"mbps": 3}
try:
    b.parse_fio("fio: failed to open /dev/x", "read")
    raise AssertionError("parse_fio accepted garbage")
except ValueError as e:
    assert "failed to open" in str(e)

# ---- Routes are registered and protected.
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

paths = {r.path for r in app.routes}
for p in ("/api/pve/disks/{disk:path}/settings", "/api/pve/disks/{disk:path}/scan", "/api/pve/disks/benchmark",
          "/api/pve/disks/benchmark/history", "/api/pve/disks/benchmark/{job_id}",
          "/api/pve/zfs/pools/{pool}/members/offline", "/api/pve/zfs/pools/{pool}/members/replace"):
    assert p in paths, p
cl = TestClient(app)
assert cl.get("/api/pve/disks/benchmark/history").status_code == 401
cl.post("/api/auth/login", json={"username": "admin", "password": "pw"})
b.history_file = Path(tempfile.mkdtemp()) / "benchmarks.json"
assert cl.get("/api/pve/disks/benchmark/history").json() == []
b.save_result({"id": "a"})
assert cl.get("/api/pve/disks/benchmark/history").json() == [{"id": "a"}]
assert cl.post("/api/pve/disks/benchmark", json={"target_type": "mountpoint", "target": "/../etc"}).status_code == 422
assert cl.post("/api/pve/disks/benchmark", json={"target_type": "disk", "target": "/dev/sda", "test_size_mb": 7}).status_code == 422
assert cl.post("/api/pve/zfs/pools/bad name/members/offline", json={"device": "sda"}).status_code == 422
assert cl.put("/api/pve/disks/sda/settings", json={"spindown_minutes": 7}).status_code == 422
print("phase 9 storage self-check OK")
