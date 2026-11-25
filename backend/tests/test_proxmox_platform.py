"""Proxmox driver platform constants as the shared modules see them. Run: python -m tests.test_proxmox_platform"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import bug_report, hardware_admin as h, schedules, storage_admin as s  # noqa: E402

assert "pve-firmware" in h.PKGS and "lm-sensors" in h.PKGS
assert 'apt-get install -y "proxmox-headers-$K" || apt-get install -y "pve-headers-$K"' in h.SCRIPTS["nvidia-install"]
assert s.RULES_FILE == "/etc/udev/rules.d/69-proxmoxos-disk-tuning.rules" and schedules.LEGACY_AUTO_PREFIX == "proxmoxos-auto-"
bid = "/dev/disk/by-id/ata-X"
rules = s.render_rules({bid: {"by_id": bid, "apm_level": 127}})
assert s.parse_rules(rules.replace("# solardeck ", "# proxmoxos "))[bid]["apm_level"] == 127  # pre-rename rules files still load
out = bug_report.redact("PVEAPIToken=pve-desktop@pve!webui=4f9e2c1a-1111-2222-3333-444455556666 rest")
assert "4f9e2c1a" not in out and "pve-desktop" not in out and out.endswith(" rest"), out
print("proxmox platform constants OK")
