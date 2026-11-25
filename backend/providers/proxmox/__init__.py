"""SolarDeck for Proxmox VE driver (HYPERVISOR_DRIVER=proxmox): Proxmox REST API plus pct/qm/pvesh over the bridge.

Imported by name through providers.registry only when this driver is active. Keep this module free of app.* imports:
shared modules read the platform constants below while they are being imported.
"""

# Host packages Hardware & System reports besides the GPU tools (GPU firmware ships in pve-firmware).
HOST_PACKAGES = ("pve-firmware",)
# Shell line that installs the headers of the running kernel $K (NVIDIA DKMS build).
KERNEL_HEADERS = 'apt-get install -y "proxmox-headers-$K" || apt-get install -y "pve-headers-$K"'
# Tool that manages systemd-boot entries from /etc/kernel/cmdline on UEFI installs ("" = GRUB only).
BOOT_TOOL = "proxmox-boot-tool"
# Bug report redactions of this platform's credentials, applied before the generic ones.
REDACTIONS = [(r"PVEAPIToken=\S+", "PVEAPIToken=[TOKEN]")]

# Name of host-side files before the SolarDeck rename (udev rules, snapshot prefix); still read and cleaned up.
LEGACY_NAME = "proxmoxos"

# Product name shown by the updater, and whether "Install Update Now" may also upgrade the host's APT packages.
EDITION = "SolarDeck for Proxmox VE"
SYSTEM_PACKAGES = False


def create_provider():
    from .provider import ProxmoxProvider
    return ProxmoxProvider()


def routers() -> list:
    """Proxmox routes, mounted ahead of the shared routers."""
    from .routes import ROUTERS
    return ROUTERS
