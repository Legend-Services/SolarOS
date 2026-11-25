"""Platform-neutral hypervisor contract. Every driver (providers/<driver id>/) implements HypervisorProvider.

Domain models are permissive (extra fields allowed, every field defaulted) so a driver can pass through its native
fields while the UI relies only on the declared ones. Create/update methods take a plain `spec` dict that the
driver validates against its own request schema, so validation stays in one place per driver.
"""
from abc import ABC, abstractmethod
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

GuestKind = Literal["qemu", "lxc"]
SnapshotScope = Literal["qemu", "lxc", "zfs"]


class Model(BaseModel):
    model_config = ConfigDict(extra="allow")


# ---------------------------------------------------------------- Capabilities & host telemetry
class ProviderCapabilities(Model):
    driver: str
    platform_label: str
    supports_clustering: bool = False
    supports_lxc: bool = True
    supports_qemu: bool = True
    supports_zfs: bool = True
    supports_gpu_passthrough: bool = True
    supports_bios_manager: bool = True
    supports_rbac_realms: bool = False
    supports_apt_repos: bool = True
    supports_host_shell: bool = True
    default_bridge: str = ""  # bridge preselected for new guests and NICs


class NodeMetrics(Model):
    node: str = ""
    cpu: float = 0
    loadavg: list[float] = []
    memory: dict[str, int] = {}
    swap: dict[str, int] = {}
    uptime: int = 0
    kernel: str = ""
    platform_version: str = ""  # e.g. "SolarOS (Ubuntu 24.04.3 LTS)" or the hypervisor manager version
    cpuinfo: dict[str, Any] = {}
    net: dict[str, float] = {}
    vms: dict[str, int] = {}
    containers: dict[str, int] = {}


class HardwareInventory(Model):
    pass


class BiosReadinessStatus(Model):
    pass


# ---------------------------------------------------------------- Compute
class GuestInfo(Model):
    vmid: int
    name: str = ""
    type: GuestKind
    status: str = "unknown"
    cpu: float = 0
    maxcpu: int = 0
    mem: int = 0
    maxmem: int = 0
    disk: int = 0
    maxdisk: int = 0
    uptime: int = 0
    netin: int = 0
    netout: int = 0


class GuestConfigUpdate(Model):
    cores: int | None = None
    memory: int | None = None
    swap: int | None = None
    onboot: bool | None = None
    description: str | None = None
    tags: str | None = None
    resize_disk: str | None = None
    resize_to: str | None = None


class PciDeviceInfo(Model):
    pass


class UsbDeviceInfo(Model):
    pass


class GpuDeviceInfo(Model):
    pass


# ---------------------------------------------------------------- Storage, ZFS, disks
class StoragePoolInfo(Model):
    name: str = ""


class ZfsDatasetInfo(Model):
    name: str = ""


class PhysicalDiskInfo(Model):
    pass


class SmartReport(Model):
    pass


class DiskSettings(Model):
    pass


class BenchmarkResult(Model):
    pass


# ---------------------------------------------------------------- Backups & library
class StorageContentItem(Model):
    pass


class BackupArchiveInfo(Model):
    pass


class BackupScheduleInfo(Model):
    pass


# ---------------------------------------------------------------- Access control
class AccessUserInfo(Model):
    pass


class AccessGroupInfo(Model):
    pass


class AccessRoleInfo(Model):
    pass


class AccessAclInfo(Model):
    pass


class ResourcePoolInfo(Model):
    pass


# ---------------------------------------------------------------- Networking, firewall, tasks, consoles
class NetworkInterfaceInfo(Model):
    iface: str = ""
    type: str = ""


class NetworkTopologyGraph(Model):
    pass


class FirewallRuleInfo(Model):
    pass


class TaskInfo(Model):
    """A started or tracked job. `task` is the driver's job handle."""
    ok: bool = True
    task: str | None = None


class ConsoleTicket(Model):
    """One-time console session; the browser opens `ws_path` with `session` (and `password` for VNC)."""
    session: str = ""
    ws_path: str = ""
    password: str | None = None


class HypervisorProvider(ABC):
    """The single contract every SolarDeck hypervisor driver implements."""

    # Capabilities & host telemetry
    @abstractmethod
    def get_capabilities(self) -> ProviderCapabilities: ...

    async def set_host_admin(self, username: str, password: str) -> None:
        """Make the SolarDeck administrator an administrator of the host too (same name and password); default: no
        host account is touched."""
        return None

    async def host_firewall(self) -> dict | None:
        """Status of a firewall the platform manages itself: {"active": bool, "detail": str}. None (default): the
        host is checked and hardened with ufw / nftables (deploy/host-hardening.sh)."""
        return None

    @abstractmethod
    async def get_node_metrics(self) -> NodeMetrics: ...
    @abstractmethod
    async def get_hardware_inventory(self) -> HardwareInventory: ...
    @abstractmethod
    async def get_bios_status(self) -> BiosReadinessStatus: ...
    @abstractmethod
    async def set_gpu_driver_mode(self, action: str, gpu: str) -> TaskInfo: ...

    # Compute
    @abstractmethod
    async def list_guests(self) -> list[GuestInfo]: ...
    @abstractmethod
    async def get_guest_config(self, kind: GuestKind, vmid: int) -> dict: ...
    @abstractmethod
    async def update_guest_config(self, kind: GuestKind, vmid: int, update: GuestConfigUpdate) -> dict: ...
    @abstractmethod
    async def guest_power_action(self, kind: GuestKind, vmid: int, action: str) -> TaskInfo: ...
    @abstractmethod
    async def create_vm(self, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def create_container(self, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def delete_guest(self, kind: GuestKind, vmid: int, purge: bool = True) -> TaskInfo: ...
    @abstractmethod
    async def list_pci_devices(self) -> list[PciDeviceInfo]: ...
    @abstractmethod
    async def list_usb_devices(self) -> list[UsbDeviceInfo]: ...
    @abstractmethod
    async def list_gpus(self) -> list[GpuDeviceInfo]: ...

    # Local AI GPU provisioning
    @abstractmethod
    async def provision_ai_container(self, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def configure_ai_gpu_passthrough(self, spec: dict) -> dict: ...

    # Storage, ZFS, disks & benchmarks
    @abstractmethod
    async def list_storage_pools(self) -> dict: ...
    @abstractmethod
    async def create_zfs_pool(self, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def destroy_zfs_pool(self, name: str, confirm: str) -> TaskInfo: ...
    @abstractmethod
    async def manage_pool_member(self, pool: str, action: Literal["offline", "online", "detach", "replace"],
                                 spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def list_datasets(self) -> list[ZfsDatasetInfo]: ...
    @abstractmethod
    async def create_dataset(self, spec: dict) -> dict: ...
    @abstractmethod
    async def update_dataset(self, spec: dict) -> dict: ...
    @abstractmethod
    async def delete_dataset(self, name: str, confirm: str, recursive: bool = False) -> dict: ...
    @abstractmethod
    async def list_physical_disks(self) -> list[PhysicalDiskInfo]: ...
    @abstractmethod
    async def get_disk_smart(self, disk: str) -> SmartReport: ...
    @abstractmethod
    async def get_disk_settings(self, disk: str) -> DiskSettings: ...
    @abstractmethod
    async def update_disk_settings(self, disk: str, spec: dict) -> DiskSettings: ...
    @abstractmethod
    async def start_disk_scan(self, disk: str, spec: dict) -> dict: ...
    @abstractmethod
    async def get_disk_scan_status(self, disk: str) -> dict: ...
    @abstractmethod
    async def abort_disk_scan(self, disk: str) -> dict: ...
    @abstractmethod
    async def run_disk_benchmark(self, spec: dict) -> BenchmarkResult: ...
    @abstractmethod
    async def list_snapshots(self, scope: SnapshotScope, target: int | str | None = None) -> list[dict]: ...
    @abstractmethod
    async def create_snapshot(self, scope: SnapshotScope, target: int | str, name: str,
                              description: str = "") -> TaskInfo: ...
    @abstractmethod
    async def rollback_snapshot(self, scope: SnapshotScope, target: int | str, name: str) -> TaskInfo: ...
    @abstractmethod
    async def delete_snapshot(self, scope: SnapshotScope, target: int | str, name: str) -> TaskInfo: ...

    # Backups & ISO/template library
    @abstractmethod
    async def list_storage_content(self, storage: str, content: str | None = None) -> list[StorageContentItem]: ...
    @abstractmethod
    async def download_url_to_storage(self, storage: str, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def delete_storage_content(self, storage: str, volume: str) -> TaskInfo: ...
    @abstractmethod
    async def list_backups(self) -> list[BackupArchiveInfo]: ...
    @abstractmethod
    async def run_backup(self, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def restore_backup(self, spec: dict) -> TaskInfo: ...
    @abstractmethod
    async def list_backup_schedules(self) -> list[BackupScheduleInfo]: ...
    @abstractmethod
    async def create_backup_schedule(self, spec: dict) -> dict: ...
    @abstractmethod
    async def delete_backup_schedule(self, job_id: str) -> dict: ...

    # Access control, firewall, logs & tasks
    @abstractmethod
    async def list_users(self) -> list[AccessUserInfo]: ...
    @abstractmethod
    async def create_user(self, spec: dict) -> dict: ...
    @abstractmethod
    async def update_user(self, userid: str, spec: dict) -> dict: ...
    @abstractmethod
    async def delete_user(self, userid: str) -> dict: ...
    @abstractmethod
    async def list_groups(self) -> list[AccessGroupInfo]: ...
    @abstractmethod
    async def create_group(self, spec: dict) -> dict: ...
    @abstractmethod
    async def delete_group(self, groupid: str) -> dict: ...
    @abstractmethod
    async def list_roles(self) -> list[AccessRoleInfo]: ...
    @abstractmethod
    async def create_role(self, spec: dict) -> dict: ...
    @abstractmethod
    async def update_role(self, roleid: str, spec: dict) -> dict: ...
    @abstractmethod
    async def delete_role(self, roleid: str) -> dict: ...
    @abstractmethod
    async def list_acls(self) -> list[AccessAclInfo]: ...
    @abstractmethod
    async def update_acl(self, spec: dict, delete: bool = False) -> dict: ...
    @abstractmethod
    async def list_pools(self) -> list[ResourcePoolInfo]: ...
    @abstractmethod
    async def create_pool(self, spec: dict) -> dict: ...
    @abstractmethod
    async def delete_pool(self, poolid: str) -> dict: ...
    @abstractmethod
    async def list_firewall_rules(self, scope: str, vmid: int | None = None) -> list[FirewallRuleInfo]: ...
    @abstractmethod
    async def list_tasks(self) -> list[TaskInfo]: ...
    @abstractmethod
    async def get_task_status(self, task: str) -> dict: ...
    @abstractmethod
    async def get_task_log(self, task: str, start: int = 0) -> dict: ...
    @abstractmethod
    async def get_syslog(self, limit: int = 500, start: int = 0, since: str | None = None,
                         until: str | None = None) -> dict: ...

    # Networking & consoles
    @abstractmethod
    async def list_network_interfaces(self) -> list[NetworkInterfaceInfo]: ...
    @abstractmethod
    async def get_network_topology(self) -> NetworkTopologyGraph: ...
    @abstractmethod
    async def open_vnc_console(self, kind: GuestKind, vmid: int) -> ConsoleTicket: ...
    @abstractmethod
    async def open_terminal_console(self, kind: GuestKind, vmid: int) -> ConsoleTicket: ...
    @abstractmethod
    async def open_host_shell(self) -> ConsoleTicket: ...

    # ------------------------------------------------------------ Optional platform hooks
    # Shared modules call these; the defaults mean "this platform has nothing to report / cannot do this", so a
    # driver overrides only what its platform offers.
    def not_available(self) -> HTTPException:
        return HTTPException(501, f"Not available on {self.get_capabilities().platform_label}")

    def scheduler_loops(self) -> list:
        """Coroutines the backend runs for its lifetime (e.g. the driver's own backup scheduler)."""
        return []

    async def close(self) -> None:
        """Release connections on shutdown."""

    def host_address(self) -> str:
        """Address of the hypervisor host as seen from the backend (SSH bridge target, WireGuard endpoint)."""
        return "127.0.0.1"

    async def host_status(self) -> dict:
        """Host status: cpuinfo, memory, swap, rootfs, kversion, current-kernel, boot-info, platform version."""
        return {}

    async def platform_version(self) -> dict:
        """{"version": ...} of the hypervisor management layer, for bug reports."""
        return {}

    async def guest_rows(self) -> list[dict]:
        """Every guest as {vmid, name, type, status, tags}; [] when the hypervisor is unreachable (never raises)."""
        return []

    async def zfs_pool_list(self) -> list[dict]:
        """ZFS pools: name, health, size, alloc, free, frag."""
        return []

    async def zfs_pool_detail(self, name: str) -> dict:
        """One pool with its vdev tree (children)."""
        return {}

    async def storage_list(self) -> list[dict]:
        """Storage targets: storage, type, active, total, used, content."""
        return []

    async def failed_tasks(self, since: int) -> list[dict]:
        """Jobs that failed since the unix time `since`: {upid, type, id, user, status, state, starttime, endtime}."""
        return []

    async def raw_disks(self) -> list[dict]:
        """Whole disks: devpath, model, serial, type, size, rpm, wearout, health, used, by_id_link."""
        return []

    async def disk_smart_raw(self, devpath: str) -> dict:
        """SMART data of one disk: health, type, attributes or text."""
        return {}

    async def pci_devices_raw(self) -> list[dict]:
        """PCI devices from the management API (fallback when lspci over the bridge is unavailable)."""
        return []

    async def guest_rule_power(self, kind: GuestKind, vmid: int, action: str) -> str:
        """Automation rule action start_guest / stop_guest / restart_guest; returns a short result message."""
        raise self.not_available()

    async def container_exec(self, vmid: int, script: str, timeout: float = 120, log=None) -> str:
        """Run a bash script as root inside a running container."""
        raise self.not_available()

    async def container_ip(self, vmid: int) -> str | None:
        return None

    async def container_status(self, vmid: int) -> str | None:
        """"running" / "stopped", or None when the container does not exist."""
        return None

    async def help_diagnostics(self) -> list[dict]:
        """Extra Help Center checks of this platform (update sources, pending updates, backup jobs, ...)."""
        return []

    async def help_fix(self, fix_id: str) -> dict:
        """Apply a platform Help Center fix; returns {message, job?}."""
        raise self.not_available()

    async def relay_console(self, ws, kind: str, guest_type: str, vmid: int, session: dict) -> None:
        """Relay an authenticated browser console WebSocket to the platform's console (not an SSH shell)."""
        await ws.close(code=1011, reason=self.not_available().detail[:120])

    async def set_host_certificate(self, cert: str, key: str) -> None:
        """Install a custom TLS certificate for the platform's own web interface."""
        raise self.not_available()

    async def remove_host_certificate(self) -> None:
        raise self.not_available()

    def switch_driver(self):
        """The driver's network_switch module for the Visual Virtual Switch (app.network_switch documents the
        contract): host network config read/render, reload command and guest NIC handlers. None = not supported."""
        return None
