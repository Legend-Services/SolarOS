"""Settings > System Services: systemctl parsing. Run: python -m tests.test_host_services (from backend/)."""
import os
import re

os.environ.update(ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import host_services as s  # noqa: E402

out = """ssh.service loaded active running Secure Shell server
pve-guests.service loaded inactive dead PVE guests
getty@tty1.service loaded active running Getty on tty1
bogus line
"""
rows = s.parse_units(out)
assert [r["unit"] for r in rows] == ["ssh.service", "pve-guests.service", "getty@tty1.service"]
assert rows[0] == {"unit": "ssh.service", "load": "loaded", "active": "active", "sub": "running", "description": "Secure Shell server"}
assert not re.match(s.UNIT_RE, "ssh.service; reboot") and not re.match(s.UNIT_RE, "a/x.service")
print("ok")
