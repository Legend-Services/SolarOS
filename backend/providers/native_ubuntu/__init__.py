"""SolarOS standalone hypervisor driver (HYPERVISOR_DRIVER=native_ubuntu): libvirt, Incus and ZFS on Ubuntu.

Imported by name through providers.registry only when this driver is active. Keep this module free of app.* imports:
shared modules read the platform constants below while they are being imported.
"""

HOST_PACKAGES = ()
KERNEL_HEADERS = 'apt-get install -y "linux-headers-$K"'
BOOT_TOOL = ""  # GRUB
REDACTIONS = []

# No pre-rename host files on this platform.
LEGACY_NAME = ""

# Product name shown by the updater, and whether "Install Update Now" may also upgrade the host's APT packages.
EDITION = "SolarOS"
SYSTEM_PACKAGES = True


def create_provider():
    from .provider import NativeUbuntuProvider
    return NativeUbuntuProvider()


def routers() -> list:
    """SolarOS routes, mounted ahead of the shared routers so they shadow the shared handlers of the same paths."""
    from . import fallback, guest_edit, routes
    return [routes.router, guest_edit.router, routes.ws_router, fallback.router]
