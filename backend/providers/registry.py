"""Active hypervisor driver, chosen by HYPERVISOR_DRIVER in backend/.env (default: proxmox)."""
from functools import cache

from app.config import settings
from providers.base import HypervisorProvider

DRIVERS = ("proxmox", "native_ubuntu")


@cache
def get_provider() -> HypervisorProvider:
    driver = (settings.hypervisor_driver or "proxmox").strip().lower()
    if driver == "native_ubuntu":
        from providers.native_ubuntu.provider import NativeUbuntuProvider
        return NativeUbuntuProvider()
    if driver != "proxmox":
        raise RuntimeError(f"Unknown HYPERVISOR_DRIVER {driver!r}; expected one of {', '.join(DRIVERS)}")
    from providers.proxmox.provider import ProxmoxProvider
    return ProxmoxProvider()
