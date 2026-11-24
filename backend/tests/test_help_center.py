"""Help Center self-check: diagnostic evaluators. Run: python -m tests.test_help_center (from backend/)."""
import os

os.environ.update(ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import help_center as h  # noqa: E402

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

i = h.check_iommu(False, True, "intel")
assert i["status"] == "warning" and i["fix"]["reboot"] and "intel_iommu=on" in i["fix"]["changes"][0]
assert "amd_iommu=on" in h.check_iommu(False, False, "amd")["fix"]["changes"][0]
assert h.check_iommu(False, False, "intel")["status"] == "info" and h.check_iommu(True, True, "intel")["fix"] is None

assert h.check_time(False)["fix"] and h.check_time(True)["status"] == "ok"
assert h.check_twofa(False)["fix"] is None and h.check_twofa(False)["link"]["intent"] == "security"
assert h.check_updates([])["status"] == "ok"
assert h.check_updates([{"Origin": "Debian-Security"}])["status"] == "warning"
assert h.check_updates([{"Origin": "Proxmox"}])["status"] == "info"

stores = [{"storage": "local", "content": "iso,backup,vztmpl", "enabled": 1, "active": 1}]
b = h.check_backups([], stores)
assert b["status"] == "warning" and "'local'" in b["fix"]["label"]
assert h.check_backups([], [{"storage": "x", "content": "images"}])["fix"] is None
assert h.check_backups([{"id": "j", "enabled": 1}], stores)["status"] == "ok"

gpu = {"id": "01:00.0", "gpu": True, "vendor": "nvidia", "driver": "nouveau", "name": "RTX 3090"}
assert [g["id"] for g in h.check_gpu_drivers([gpu, {**gpu, "driver": "vfio-pci"}])] == ["gpu:01:00.0"]
assert h.check_bridge("refused")["status"] == "error" and h.check_bridge(None)["status"] == "ok"
a = h.from_alerts([{"id": "zfs-health:tank", "severity": "critical", "category": "zfs", "title": "t", "message": "m"}])
assert a[0]["status"] == "error" and a[0]["link"] == {"app": "storage"}
assert "__FLAG__" in h.IOMMU_SCRIPT
assert h.check_iommu(False, True, "intel")["bios"] == "vt-d" and h.check_vtx(False)["bios"] == "vt-x"
assert h.check_vtx(True)["status"] == "ok"

# BIOS facts as printed by BIOS_PROBE on the real host (TOPC board, AMI BIOS, i9-14900HX).
f = h.parse_bios_facts("system-manufacturer=TOPC\nbaseboard-manufacturer=TOPC\nbaseboard-product-name=TOPC RPL-HX MATX 2.5G\n"
                       "bios-vendor=American Megatrends International, LLC.\nbios-version=E1.5D\nvirt=32\n"
                       "cpu=vendor_id\t: GenuineIntel\nsb=SecureBoot disabled")
assert f["virtualization"] and f["cpu"] == "intel" and not f["secure_boot"] and f["board"].startswith("TOPC"), f
assert h.parse_bios_facts("virt=0\nsb=1\ncpu=AuthenticAMD")["secure_boot"] and not h.parse_bios_facts("virt=0")["virtualization"]

from app import bios_guides as bg  # noqa: E402

assert bg.detect_vendor("TOPC", "TOPC", "American Megatrends International, LLC.") == "ami"
assert bg.detect_vendor("ASUSTeK COMPUTER INC.", "", "") == "asus" and bg.detect_vendor("Micro-Star International Co., Ltd.") == "msi"
assert bg.detect_vendor("Hewlett-Packard") == "hp" and bg.detect_vendor("Unknown") == "ami"
s = bg.guide_steps("vt-d", "ami", "intel")
assert any("System Agent (SA) Configuration → VT-d" in x for x in s) and "Del, F2 or F7" in s[2] and "start-up logo" in s[2] and s[-2].startswith("Press F10")
assert any("IOMMU" in x for x in bg.guide_steps("vt-d", "asus", "amd"))
assert bg.guide_steps("secure-boot", "supermicro", "intel")[3].startswith("(Exact menu names vary on Supermicro")
for t in bg.TOPICS:  # every topic resolves for every vendor and CPU
    for v in bg.VENDORS:
        for cpu in ("intel", "amd"):
            assert len(bg.guide_steps(t, v, cpu)) > 5, (t, v, cpu)
parts = bg.split_text("\n".join(f"line {i} " + "x" * 50 for i in range(40)), 600)
assert len(bg.split_text(g0 := bg.guide_text("t", "ami", bg.guide_steps("vt-d", "ami", "intel"), "v", "TOPC X"))) == 1, g0
assert "Board: TOPC X (AMI" in g0
assert len(parts) > 1 and all(len(p) <= 620 for p in parts) and parts[0].startswith("(Part 1/")
assert bg.split_text("short") == ["short"] and all(len(p) <= 920 for p in bg.split_text("y" * 2500))
g = bg.build_guide("vt-d", "ami", "intel", True)
assert g["needed"] and g["qr"] and g["qr"][0].startswith("<") and "Board: AMI" in g["text"]
print("help center self-check OK")
