"""Updater schedule + bug report self-check. Run: python -m tests.test_phase7_updater"""
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app import bug_report, updater
from app.config import settings

# ---- update settings persistence
with tempfile.TemporaryDirectory() as d:
    settings.update_settings_file = Path(d) / "data" / "update_settings.json"
    assert updater.load_settings() == updater.DEFAULTS
    updater.put_settings(updater.UpdateSettings(mode="auto", schedule_frequency="weekly", schedule_time="04:30", schedule_day=3))
    s = updater.load_settings()
    assert s["mode"] == "auto" and s["schedule_day"] == 3 and s["update_available"] is False, s
    settings.update_settings_file.write_text("[]")
    assert updater.load_settings() == updater.DEFAULTS

# ---- due(): Wednesday 2026-11-25 10:00
now = datetime(2026, 11, 25, 10, 0)
base = {**updater.DEFAULTS, "schedule_time": "03:00"}
iso = lambda dt: dt.isoformat()  # noqa: E731
assert updater.due({**base, "mode": "manual"}, now) is False
assert updater.due(base, now) is True  # never checked
assert updater.due({**base, "last_checked_at": iso(now.replace(hour=3, minute=1))}, now) is False  # today's slot done
assert updater.due({**base, "last_checked_at": iso(now - timedelta(days=1))}, now) is True  # missed today's 03:00
assert updater.due({**base, "schedule_time": "11:00", "last_checked_at": iso(now - timedelta(hours=20))}, now) is False
h6 = {**base, "schedule_frequency": "6h"}
assert updater.due({**h6, "last_checked_at": iso(now - timedelta(hours=5))}, now) is False
assert updater.due({**h6, "last_checked_at": iso(now - timedelta(hours=6))}, now) is True
wk = {**base, "schedule_frequency": "weekly", "schedule_day": 1}  # Monday 03:00 -> slot 2026-11-23 03:00
assert updater.due({**wk, "last_checked_at": iso(datetime(2026, 11, 23, 4))}, now) is False
assert updater.due({**wk, "last_checked_at": iso(datetime(2026, 11, 22, 4))}, now) is True
wk3 = {**wk, "schedule_day": 3, "schedule_time": "11:00"}  # today, later -> last week's slot counts
assert updater.due({**wk3, "last_checked_at": iso(datetime(2026, 11, 19))}, now) is False
assert updater.due({**wk3, "last_checked_at": iso(datetime(2026, 11, 18, 10))}, now) is True

# ---- git log parsing
row = updater._parse_log(f"abc123{updater.SEP}abc{updater.SEP}2026-11-24T10:00:00+00:00{updater.SEP}Fix x{updater.SEP}HEAD -> main, tag: v1.3.0", "abc123")
assert row == [{"hash": "abc123", "short_hash": "abc", "tag": "v1.3.0", "date": "2026-11-24T10:00:00+00:00", "subject": "Fix x", "is_current": True}], row

# ---- redaction
raw = """login from 192.168.68.230 user=admin password=hunter2 ADMIN_PASSWORD=Abc123
Authorization: Bearer abc.def JWT_SECRET: "deadbeef" token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig-_x
PVEAPIToken=pve-desktop@pve!webui=4f9e2c1a-1111-2222-3333-444455556666 ghp_abcdefghijklmnopqrstuvwx1234
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample proxmox-os-root fe80::1ff:fe23:4567:890a at 12:30:45 aa:bb:cc:dd:ee:ff
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
print("phase 7 updater + bug report OK")
