"""SolarDeck for Proxmox VE keeps its host-side names: with SYSTEM_PREFIX=proxmox-os (deploy/env-defaults-proxmox)
every derived name equals the name earlier releases used, so existing containers, hosts and guests keep working.
Run: python -m tests.test_proxmox_edition_names"""
import os
import subprocess
import tempfile
from pathlib import Path

os.environ.update(SYSTEM_PREFIX="proxmox-os", NODE_NAME="pve", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32,
                  STORAGE_ROOT=tempfile.mkdtemp())

from app import apps, hardware_admin, net_services as ns, provisioning, updater  # noqa: E402
from app.config import settings  # noqa: E402

assert settings.name("helper") == "proxmox-os-helper"
assert settings.host_ssh_key == "/root/.ssh/proxmox-os-helper" and str(settings.samba_conf) == "/etc/samba/proxmox-os-shares.conf"
assert apps.TAG == "proxmox-os-app" and provisioning.GUEST_TAG == "proxmox-os-guest"
assert ns.STATE_DIR == "/etc/proxmox-os/net" and ns.NFT_TABLE == "proxmox_os" and ns.ROUTER == "proxmox-os-router"
assert ns.DNS_CONF == "/etc/dnsmasq.d/proxmox-os-dns.conf" and str(ns.NGINX_SNIPPET) == "/etc/nginx/proxmox-os-ssl.conf"
assert hardware_admin.VFIO_CONF == "/etc/modprobe.d/proxmox-os-vfio.conf"
assert "/var/lib/proxmox-os/NVIDIA" in hardware_admin.SCRIPTS["nvidia-install"]
assert updater.UNIT == "proxmox-os-self-update" and str(updater.LOG) == "/var/log/proxmox-os-self-update.log"
assert updater.edition()["service"] == "proxmox-os-backend"

# merge-env.sh adds the edition's SYSTEM_PREFIX for the Proxmox driver only, and renames old keys.
repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory() as d:
    for driver, prefix in (("proxmox", "proxmox-os"), ("native_ubuntu", None)):
        env = Path(d) / f"{driver}.env"
        env.write_text(f"HYPERVISOR_DRIVER={driver}\nPVE_NODE=pve\n")
        subprocess.run(["bash", str(repo / "deploy/merge-env.sh"), str(env), str(repo / "deploy/env-defaults")],
                       check=True, capture_output=True)
        text = env.read_text()
        assert ("SYSTEM_PREFIX=proxmox-os" in text) == bool(prefix), (driver, text)
        assert "NODE_NAME=pve" in text and "PVE_NODE=pve" in text, text  # old key kept for rollbacks
print("proxmox edition names OK")
