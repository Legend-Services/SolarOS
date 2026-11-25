"""Updater schedule + bug report self-check. Run: python -m tests.test_phase7_updater"""
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app import bug_report, updater
from app.config import settings

# ---- update schedule persistence + migration from the old manual / notify / auto modes
with tempfile.TemporaryDirectory() as d:
    settings.update_settings_file = Path(d) / "data" / "update_settings.json"
    assert updater.load_settings() == updater.DEFAULTS
    body = updater.UpdateSchedule(auto_check_enabled=True, check_interval_hours=12, auto_install_enabled=True,
                                  schedule_frequency="monthly", schedule_day_of_month=15, schedule_time="04:30")
    r = updater.put_schedule(body)
    assert r["schedule_day_of_month"] == 15 and r["next_install_at"] and "last_checked_at" not in r, r
    s = updater.load_settings()
    assert s["auto_install_enabled"] and s["check_interval_hours"] == 12 and s["update_available"] is False, s
    settings.update_settings_file.write_text("[]")
    assert updater.load_settings() == updater.DEFAULTS
    settings.update_settings_file.write_text('{"mode": "auto", "schedule_frequency": "6h", "schedule_day": 3}')
    s = updater.load_settings()
    assert s["auto_check_enabled"] and s["auto_install_enabled"] and s["schedule_frequency"] == "daily", s
    assert s["check_interval_hours"] == 6 and s["schedule_day_of_week"] == 3 and "mode" not in s, s
    settings.update_settings_file.write_text('{"mode": "manual", "schedule_frequency": "weekly"}')
    s = updater.load_settings()
    assert not s["auto_check_enabled"] and not s["auto_install_enabled"] and s["schedule_frequency"] == "weekly", s

# ---- check_due / install_due / next_runs: Wednesday 2026-11-25 10:00
now = datetime(2026, 11, 25, 10, 0)
base = {**updater.DEFAULTS, "schedule_time": "10:00"}
iso = lambda dt: dt.isoformat()  # noqa: E731
assert updater.check_due(base, now) is True  # never checked
assert updater.check_due({**base, "auto_check_enabled": False}, now) is False
assert updater.check_due({**base, "last_checked_at": iso(now - timedelta(hours=5))}, now) is False
assert updater.check_due({**base, "last_checked_at": iso(now - timedelta(hours=6))}, now) is True
assert updater.check_due({**base, "check_interval_hours": 24, "last_checked_at": iso(now - timedelta(hours=6))}, now) is False
auto = {**base, "auto_install_enabled": True, "schedule_frequency": "daily"}
assert updater.install_due({**auto, "auto_install_enabled": False}, now) is False
assert updater.install_due(auto, now) is True
assert updater.install_due(auto, now + timedelta(minutes=59)) is True
assert updater.install_due(auto, now + timedelta(hours=1)) is False  # missed slots are skipped, not caught up
assert updater.install_due(auto, now - timedelta(minutes=1)) is False
assert updater.install_due({**auto, "last_auto_install_at": iso(now.replace(hour=10, minute=0))}, now + timedelta(minutes=5)) is False
assert updater.install_due({**auto, "last_auto_install_at": iso(now - timedelta(days=1))}, now) is True
wk = {**auto, "schedule_frequency": "weekly"}
assert updater.install_due({**wk, "schedule_day_of_week": 3}, now) is True  # Wednesday = 3
assert updater.install_due({**wk, "schedule_day_of_week": 0}, now) is False
mo = {**auto, "schedule_frequency": "monthly"}
assert updater.install_due({**mo, "schedule_day_of_month": 25}, now) is True
assert updater.install_due({**mo, "schedule_day_of_month": 1}, now) is False
n = updater.next_runs({**mo, "schedule_day_of_month": 1, "last_checked_at": iso(now - timedelta(hours=1))}, now)
assert n == {"next_check_at": "2026-11-25T15:00:00", "next_install_at": "2026-12-01T10:00:00"}, n
n = updater.next_runs({**wk, "schedule_day_of_week": 3}, now)  # the slot is now, so the next one is in a week
assert n["next_install_at"] == "2026-12-02T10:00:00" and n["next_check_at"] == "2026-11-25T10:00:00", n
assert updater.next_runs({**base, "auto_check_enabled": False}, now) == {"next_check_at": None, "next_install_at": None}

# ---- update progress: the file survives backend restarts; a dead unit without a final stage is resolved from its log
with tempfile.TemporaryDirectory() as d:
    updater.PROGRESS = Path(d) / "progress.json"
    idle = {"running": False, "exit_code": None, "log": []}
    assert updater.progress(idle, now)["update_status"] == "idle"
    updater.write_progress(status="running", percent=60, stage="backend", stage_label="Installing", started_at=iso(now))
    r = updater.progress({**idle, "running": True}, now)
    assert (r["update_status"], r["progress_percent"], r["stage"]) == ("running", 60, "backend"), r
    r = updater.progress({**idle, "exit_code": 1}, now)
    assert (r["update_status"], r["progress_percent"]) == ("failed", 60) and r["error_message"], r
    r = updater.progress({**idle, "exit_code": 0}, now)
    assert (r["update_status"], r["progress_percent"]) == ("completed", 100), r
    updater.write_progress(status="completed", percent=100, stage="done", finished_at=iso(now), completed_version="x")
    assert updater.progress(idle, now + timedelta(minutes=1))["completed_version"] == "x"
    assert updater.progress(idle, now + timedelta(minutes=3))["update_status"] == "idle"  # auto-cleared
    updater.write_progress(status="failed", percent=40, finished_at=iso(now), error_message="boom")
    assert updater.progress(idle, now + timedelta(days=1))["update_status"] == "failed"  # stays until acknowledged
    updater.PROGRESS.write_text("{broken")
    assert updater.progress(idle, now)["update_status"] == "idle"

# ---- git log parsing
row = updater._parse_log(f"abc123{updater.SEP}abc{updater.SEP}2026-11-24T10:00:00+00:00{updater.SEP}Fix x{updater.SEP}HEAD -> main, tag: v1.3.0", "abc123")
assert row == [{"hash": "abc123", "short_hash": "abc", "tag": "v1.3.0", "date": "2026-11-24T10:00:00+00:00", "subject": "Fix x", "is_current": True}], row

# ---- redaction
raw = """login from 192.168.68.230 user=admin password=hunter2 ADMIN_PASSWORD=Abc123
Authorization: Bearer abc.def JWT_SECRET: "deadbeef" token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_x
api_token=desktop@node!webui=4f9e2c1a-1111-2222-3333-444455556666 ghp_abcdefghijklmnopqrstuvwx1234
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample solardeck-root fe80::1ff:fe23:4567:890a at 12:30:45 aa:bb:cc:dd:ee:ff
mail me@example.com
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA
-----END OPENSSH PRIVATE KEY-----"""
out = bug_report.redact(raw)
for secret in ("192.168", "hunter2", "Abc123", "abc.def", "deadbeef", "eyJhbGci", "4f9e2c1a", "ghp_", "AAAAC3Nza", "fe80", "aa:bb",
               "me@example", "b3BlbnNz"):
    assert secret not in out, (secret, out)
assert "12:30:45" in out and "ssh-ed25519 [SSH KEY]" in out and "[PRIVATE KEY]" in out, out

# ---- GitHub URLs
assert bug_report.repo_slug("https://github.com/Legend-Services/SolarOS.git") == "Legend-Services/SolarOS"
assert bug_report.repo_slug("git@github.com:a-b/c.d.git") == "a-b/c.d"
assert bug_report.repo_slug("https://gitlab.com/a/b") is None
url = bug_report.prefilled_url("o/r", "[UI & Desktop] Broken", "x" * 20000)
assert len(url) <= bug_report.URL_MAX, len(url)
q = parse_qs(urlparse(url).query)
assert q["title"] == ["[UI & Desktop] Broken"] and q["labels"] == ["bug,user-reported"] and "shortened" in q["body"][0]
report = bug_report.BugReport(title="Dock jumps", category="UI & Desktop", description="It jumps", steps_to_reproduce="1. Hover")
body = bug_report.format_body(report, None)
assert "### Steps to reproduce" in body and "System diagnostics" not in body
# ---- SolarOS installer ISO card
import asyncio, hashlib  # noqa: E401,E402
with tempfile.TemporaryDirectory() as d:
    settings.storage_root = Path(d)
    (Path(d) / "isos").mkdir()
    (Path(d) / "isos" / "SolarOS-v2.2.1-amd64.iso").write_bytes(b"iso")
    (Path(d) / "isos" / "windows.iso").write_bytes(b"x")
    r = asyncio.run(updater.hypervisor_iso())
    assert [i["name"] for i in r["isos"]] == ["SolarOS-v2.2.1-amd64.iso"], r
    assert r["isos"][0]["sha256"] == hashlib.sha256(b"iso").hexdigest() and r["isos"][0]["size"] == 3
    assert updater.find_isos([Path(d) / "missing"]) == [] and "build-iso.sh" in r["build_command"]
# ---- fresh ISO install: .build-commit is a main-branch commit the edition branch lacks -> its same-version tag
import asyncio as _aio  # noqa: E402
import subprocess as _sp  # noqa: E402

with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    sh = lambda *a, cwd=d: _sp.run(a, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()  # noqa: E731
    origin, app = d / "origin", d / "app"
    origin.mkdir()
    sh("git", "init", "-q", "-b", "solaros", cwd=origin)
    (origin / "frontend").mkdir()
    (origin / "frontend/package.json").write_text('{"version": "9.9.9"}')
    sh("git", "add", "-A", cwd=origin)
    sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "SolarOS v9.9.9", cwd=origin)
    sh("git", "tag", "solaros-v9.9.9", cwd=origin)
    released = sh("git", "rev-parse", "HEAD", cwd=origin)
    (origin / "later.txt").write_text("next")
    sh("git", "add", "-A", cwd=origin)
    sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "SolarOS v10", cwd=origin)
    (app / "frontend").mkdir(parents=True)  # installed copy of v9.9.9 without .git, as the ISO leaves it
    (app / "frontend/package.json").write_text('{"version": "9.9.9"}')
    (app / ".build-commit").write_text("dc84881b319f97c308c3ab29497888938131b26e\n")
    old_dir, old_url = updater.APP_DIR, settings.repo_url
    updater.APP_DIR, settings.repo_url = app, str(origin)
    try:
        _aio.run(updater.ensure_repo("solaros"))
        assert (app / ".build-commit").read_text().strip() == released
        assert sh("git", "rev-parse", "HEAD", cwd=app) == released
        assert _aio.run(updater.source())["commit"] == released
        # A test deploy left the checkout on a feature branch: updates still follow the configured REPO_BRANCH.
        sh("git", "checkout", "-q", "-b", "feat/old-test", cwd=app)
        old_branch, settings.repo_branch = settings.repo_branch, "solaros"
        assert _aio.run(updater.source())["branch"] == "solaros"
        settings.repo_branch = old_branch
    finally:
        updater.APP_DIR, settings.repo_url = old_dir, old_url
print("phase 7 updater + bug report OK")
