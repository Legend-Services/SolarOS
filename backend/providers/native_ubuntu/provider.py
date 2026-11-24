"""Standalone hypervisor driver (HYPERVISOR_DRIVER=native_ubuntu): contract scaffold for Phase 19.

Only get_capabilities() is live. Every other contract method raises NotImplementedError, which the API turns into
HTTP 501. Phase 19 replaces the stubs one by one with libvirt (QEMU/KVM), Incus (LXC), zfsutils-linux, Netplan and
websockify calls; see providers/PHASE19_DRIVER_SPEC.md for the method-to-command mapping.
"""
from providers.base import HypervisorProvider, ProviderCapabilities

PLANNED = "Planned for Phase 19: Native Ubuntu LTS driver"


class NativeUbuntuProvider(HypervisorProvider):
    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            driver="native_ubuntu", platform_label="SolarDeck Hypervisor", supports_clustering=False,
            supports_lxc=True, supports_qemu=True, supports_zfs=True, supports_gpu_passthrough=True,
            supports_bios_manager=True, supports_rbac_realms=False, supports_apt_repos=True, supports_host_shell=True)


def _stub(name: str):
    async def method(self, *args, **kwargs):
        raise NotImplementedError(PLANNED)
    method.__name__ = method.__qualname__ = name
    return method


# One stub per remaining contract method, so the class is concrete and stays in lockstep with base.py.
for _name in sorted(HypervisorProvider.__abstractmethods__ - {"get_capabilities"}):
    setattr(NativeUbuntuProvider, _name, _stub(_name))
NativeUbuntuProvider.__abstractmethods__ = frozenset()
