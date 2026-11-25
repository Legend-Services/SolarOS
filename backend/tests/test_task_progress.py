"""Unified job progress self-check. Run: python -m tests.test_task_progress (from backend/)."""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import hardware_admin as h, task_progress as tp  # noqa: E402

# GPU host job: stage markers move the bar and are hidden from the log.
st = {"running": True, "exit_code": None, "log": ["@@stage gpu 0@@", "lspci…", "@@stage gpu 2@@", "Installing"]}
v = tp.from_host_job("gpu-nvidia-install", "gpu", st, "RTX")
assert v["status"] == "running" and v["progress_percent"] == 60 and v["stage_index"] == 2, v
assert v["logs"] == ["lspci…", "Installing"] and v["subject"] == "RTX" and v["stage_key"] == "gpu.install"
assert len(v["stages"]) == 6 and v["stages"][-1]["percent"] == 100
done = tp.from_host_job("gpu-mode", "gpu", {**st, "running": False, "exit_code": 0}, "")
assert done["status"] == "completed" and done["progress_percent"] == 100 and done["stage_index"] == 5
fail = tp.from_host_job("gpu-mode", "gpu", {"running": False, "exit_code": 3, "log": ["@@stage gpu 1@@", "!! nouveau is still loaded", "solardeck: exit 3"]})
assert fail["status"] == "failed" and fail["progress_percent"] == 30 and fail["error_message"] == "nouveau is still loaded", fail
assert tp.from_host_job("gpu-amd-install", "gpu", {"running": False, "exit_code": None, "log": []}) is None
# Running jobs never show the final "completed" stage, even when the last marker points at it.
assert tp.from_host_job("x", "gpu", {"running": True, "exit_code": None, "log": ["@@stage gpu 5@@"]})["progress_percent"] == 95

# Every GPU script walks the stages in order and verifies after the initramfs step; driver installs keep going
# when update-initramfs / lsinitramfs complain, a mode switch does not.
for name, script in [*h.SCRIPTS.items(), ("mode", h.mode_script(h.vfio_files(["10de:2204"], {"nvidia"})))]:
    marks = [int(x.split()[3].rstrip("@'")) for x in script.splitlines() if x.startswith("echo '@@stage gpu")]
    assert marks == sorted(marks) and marks[0] == 0 and marks[-1] == 4, (name, marks)
    assert 'lsinitramfs "/boot/initrd.img-$K"' in script and "uname -r" in script, name
for name, script in h.SCRIPTS.items():
    assert "update-initramfs -u -k \"$K\" || echo" in script and "\nupdate-initramfs -u\n" not in script, name
assert "\nupdate-initramfs -u -k all\n" in h.mode_script(h.vfio_files([], set()))

# apt: lists → download → unpack/configure → triggers; failures surface the apt error line.
apt = ["Hit:1 http://deb.debian.org/debian trixie InRelease", "Reading package lists..."]
assert tp.apt_stage(apt) == 0
apt += ["3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.", "Get:1 http://x curl 8.0 [300 kB]"]
assert tp.apt_stage(apt) == 1
apt += ["Preparing to unpack .../curl.deb ...", "Unpacking curl (8.0) over (7.9) ...", "Setting up curl (8.0) ..."]
assert tp.apt_stage(apt) == 2
apt += ["Processing triggers for man-db (2.12) ..."]
assert tp.apt_stage(apt) == 3
assert tp.apt_stage(["0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded."]) == 3
os_ok = tp.from_apt("os-upgrade", {"running": False, "exit_code": 0, "log": apt + ["solardeck: exit 0"]})
assert os_ok["status"] == "completed" and os_ok["progress_percent"] == 100
os_bad = tp.from_apt("os-upgrade", {"running": False, "exit_code": 100, "log": ["E: Could not get lock /var/lib/dpkg/lock-frontend", "solardeck: exit 100"]})
assert os_bad["status"] == "failed" and os_bad["error_message"].startswith("E: Could not get lock"), os_bad
assert tp.from_apt("os-upgrade", {"running": False, "exit_code": None, "log": []}) is None
assert tp.from_apt("os-upgrade", {"running": True, "exit_code": None, "log": apt[:2]})["progress_percent"] == 15

# App Center phases (both drivers) → weighted stages.
job = {"vmid": 105, "app_id": "jellyfin", "phase": "creating", "log": [], "error": None}
assert tp.from_app(job)["progress_percent"] == 10
pct = {p: tp.from_app({**job, "phase": p, "log": ["x"]})["progress_percent"] for p in ("creating", "configuring", "installing", "registering", "done")}
assert pct == {"creating": 30, "configuring": 55, "installing": 80, "registering": 95, "done": 100}, pct
err = tp.from_app({**job, "phase": "error", "failed_phase": "installing", "log": ["x"], "error": "apt failed"})
assert err["status"] == "failed" and err["progress_percent"] == 80 and err["error_message"] == "apt failed"
assert err["job_id"] == "app-105" and err["subject"] != ""

# Local AI pulls carry their own percentage (never 100 until done).
pull = {"id": "a" * 12, "model": "llama3.1:8b", "state": "running", "status": "downloading", "percent": 42.4, "error": None}
assert tp.from_pull(pull)["progress_percent"] == 42 and tp.from_pull({**pull, "percent": 100.0})["progress_percent"] == 99
assert tp.from_pull({**pull, "state": "done"})["progress_percent"] == 100

# Task Center feed: finished jobs stay listed for KEEP_FINISHED seconds after they are first seen finished.
w: dict = {}
assert tp._recent({"status": "running"}, w) and "ended" not in w
assert tp._recent({"status": "completed"}, w) and w["ended"]
w["ended"] -= tp.KEEP_FINISHED + 1
assert not tp._recent({"status": "completed"}, w)

print("task progress self-check passed")
