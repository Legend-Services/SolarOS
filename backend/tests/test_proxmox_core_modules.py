"""Proxmox VE side of the core modules (providers/proxmox/modules.py). Run: python -m tests.test_proxmox_core_modules"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from app import image_hub as ih  # noqa: E402
from providers.proxmox import modules as m  # noqa: E402
from providers.proxmox.provider import ProxmoxProvider  # noqa: E402

assert ProxmoxProvider().module_driver() is m and m.CLONE_TEMPLATES and m.BACKUP_DIR == "/var/lib/vz/dump"
assert m.serial_command("qemu", 105) == "qm terminal 105" and m.serial_command("lxc", 106) == "pct console 106"
assert m.heartbeat_command("qemu", 105) == "qm agent 105 ping" and m.heartbeat_command("lxc", 106) == "pct exec 106 -- true"

zt = ih.ZeroTouchBody(image_volume="local:iso/noble-server-cloudimg-amd64.img", vmid=150, name="web01", storage="local-zfs",
                      bridge="br0", vlan_tag=40, password="correct-horse", ssh_keys=["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc"],
                      network={"cidr": "192.168.40.10/24", "gateway": "192.168.40.1"})
pve = m.zero_touch_script(zt)
assert "import-from=$IMG" in pve and "bridge=br0,tag=40" in pve and "--ipconfig0 ip=192.168.40.10/24,gw=192.168.40.1" in pve
assert "qm resize 150 scsi0 20G" in pve and "--cicustom vendor=local:snippets/" in pve and "--cipassword correct-horse" in pve
assert "--nameserver '1.1.1.1'" in pve and "@@stage zerotouch 2@@" in pve
dhcp = m.zero_touch_script(zt.model_copy(update={"network": "dhcp", "guest_agent": False, "vlan_tag": None, "password": None}))
assert "ip=dhcp" in dhcp and "cicustom" not in dhcp and "tag=" not in dhcp and "cipassword" not in dhcp

print("proxmox core modules: all checks passed")
