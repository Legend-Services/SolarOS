"""Proxmox Help Center checks: update sources and backup jobs. Run: python -m tests.test_proxmox_help_center (from backend/)."""
import os

os.environ.update(ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import help_center  # noqa: E402
from providers.proxmox import help as h  # noqa: E402

REPOS = {"files": [
    {"path": "/etc/apt/sources.list.d/pve-enterprise.sources", "repositories": [
        {"Enabled": 1, "Types": ["deb"], "URIs": ["https://enterprise.proxmox.com/debian/pve"], "Suites": ["trixie"],
         "Components": ["pve-enterprise"]}]},
    {"path": "/etc/apt/sources.list.d/ceph.sources", "repositories": [
        {"Enabled": 1, "Types": ["deb"], "URIs": ["https://enterprise.proxmox.com/debian/ceph-squid"], "Suites": ["trixie"],
         "Components": ["enterprise"]}]}]}
r = h.check_repos(REPOS, {"status": "notfound"})
assert r["status"] == "warning" and r["fix"] and len(r["fix"]["changes"]) == 2, r
assert "2 enterprise" in r["fix"]["changes"][0] and r["manual"] and r["link"] == {"app": "system"}
assert h.check_repos(REPOS, {"status": "active"})["status"] == "ok"  # paid subscription: enterprise is right

stores = [{"storage": "local", "content": "iso,backup,vztmpl", "enabled": 1, "active": 1}]
b = h.check_backups([], stores)
assert b["status"] == "warning" and "'local'" in b["fix"]["label"]
assert h.check_backups([], [{"storage": "x", "content": "images"}])["fix"] is None
assert h.check_backups([{"id": "j", "enabled": 1}], stores)["status"] == "ok"

assert h.check_updates([{"Origin": "Proxmox"}])["status"] == "info"
# The systemd-boot branch of the IOMMU fix uses the Proxmox boot tool.
assert 'BT="proxmox-boot-tool"' in help_center.IOMMU_SCRIPT and "proxmox-boot-tool refresh" in " ".join(
    help_center.check_iommu(False, True, "intel")["manual"])
print("proxmox help center self-check OK")
