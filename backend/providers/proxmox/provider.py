"""Proxmox VE driver: REST API (/api2/json) plus host CLI (pct, qm, zpool, zfs, smartctl, hdparm, fio) via the helper.

The low-level Proxmox plumbing (API client, request validation, host helper calls) stays in the app.* modules, which
are this driver's internals; the provider binds every contract method to them. Calling a route handler directly
skips FastAPI parameter parsing, so every Query/Path argument is passed explicitly and bodies are built from `spec`
with the handler's own request model (same validation as the HTTP route).
"""
import asyncio

from app import (automation, backups, console, disk_benchmark, guest_hardware, hardware_admin, local_ai, provisioning,
                 pve_access, pve_datacenter, storage_admin, tasks)
from app import pve as api
from app.config import settings
from providers.base import (AccessAclInfo, AccessGroupInfo, AccessRoleInfo, AccessUserInfo, BackupArchiveInfo,
                            BackupScheduleInfo, BenchmarkResult, BiosReadinessStatus, ConsoleTicket, DiskSettings,
                            FirewallRuleInfo, GpuDeviceInfo, GuestConfigUpdate, GuestInfo, GuestKind,
                            HardwareInventory, HypervisorProvider, NetworkInterfaceInfo, NetworkTopologyGraph,
                            NodeMetrics, PciDeviceInfo, PhysicalDiskInfo, ProviderCapabilities, ResourcePoolInfo,
                            SmartReport, SnapshotScope, StorageContentItem, TaskInfo, UsbDeviceInfo, ZfsDatasetInfo)

GUEST_FIELDS = ("cpu", "maxcpu", "mem", "maxmem", "disk", "maxdisk", "uptime", "netin", "netout")


def _many(model, items) -> list:
    return [model.model_validate(i) for i in items or []]


def _task(res) -> TaskInfo:
    """Handlers return a UPID string, {"ok", "task"} or another dict; normalize to TaskInfo."""
    if isinstance(res, str):
        return TaskInfo(task=res)
    return TaskInfo.model_validate(res if isinstance(res, dict) else {"result": res})


def normalize_guest(g: dict, kind: str) -> dict:
    out = {"vmid": int(g["vmid"]), "name": g.get("name", f"{kind}-{g['vmid']}"), "type": kind,
           "status": g.get("status", "unknown"), **{f: g.get(f, 0) for f in GUEST_FIELDS}}
    # /nodes/{node}/qemu|lxc report the core count as "cpus"; only /cluster/resources uses "maxcpu".
    out["maxcpu"] = g.get("maxcpu") or g.get("cpus") or 0
    return out


class ProxmoxProvider(HypervisorProvider):
    # ------------------------------------------------------------ Capabilities & host telemetry
    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            driver="proxmox", platform_label="Proxmox VE", supports_clustering=True, supports_lxc=True,
            supports_qemu=True, supports_zfs=True, supports_gpu_passthrough=True, supports_bios_manager=True,
            supports_rbac_realms=True, supports_apt_repos=True, supports_host_shell=True)

    async def get_node_metrics(self) -> NodeMetrics:
        pve, safe, node = api.pve, api._safe, api._node
        status, qemu, lxc, rrd = await asyncio.gather(
            pve("GET", node("/status")), safe(node("/qemu"), []), safe(node("/lxc"), []),
            # shortcut: network rate + ZFS ARC come from the 1-minute RRD average; upgrade to a host agent for per-second data.
            safe(node("/rrddata?timeframe=hour&cf=AVERAGE"), []),
        )
        last = next((p for p in reversed(rrd or []) if p.get("netin") is not None), {})
        count = lambda items, state: sum(1 for g in items if g.get("status") == state)  # noqa: E731
        mem, swap, cpuinfo = status.get("memory", {}), status.get("swap", {}), status.get("cpuinfo", {})
        return NodeMetrics(
            node=settings.pve_node,
            cpu=round(status.get("cpu", 0) * 100, 2),
            loadavg=[float(x) for x in status.get("loadavg", [])],
            memory={"used": mem.get("used", 0), "total": mem.get("total", 0), "free": mem.get("free", 0),
                    "arc": int(last.get("arcsize") or 0)},
            swap={"used": swap.get("used", 0), "total": swap.get("total", 0)},
            uptime=status.get("uptime", 0),
            kernel=status.get("kversion", ""),
            pveversion=status.get("pveversion", ""),
            cpuinfo={"model": cpuinfo.get("model", ""), "cpus": cpuinfo.get("cpus", 0),
                     "sockets": cpuinfo.get("sockets", 0), "cores": cpuinfo.get("cores", 0)},
            net={"in": float(last.get("netin") or 0), "out": float(last.get("netout") or 0)},
            vms={"running": count(qemu, "running"), "stopped": count(qemu, "stopped"), "total": len(qemu)},
            containers={"running": count(lxc, "running"), "stopped": count(lxc, "stopped"), "total": len(lxc)},
        )

    async def get_hardware_inventory(self) -> HardwareInventory:
        return HardwareInventory.model_validate(await hardware_admin.inventory())

    async def get_bios_status(self) -> BiosReadinessStatus:
        return BiosReadinessStatus.model_validate(await hardware_admin.bios_status())

    async def set_gpu_driver_mode(self, action: str, gpu: str) -> TaskInfo:
        return _task(await hardware_admin.gpu_driver_action(action, hardware_admin.GpuBody(gpu=gpu)))

    # ------------------------------------------------------------ Compute
    async def list_guests(self) -> list[GuestInfo]:
        qemu, lxc = await asyncio.gather(api.pve("GET", api._node("/qemu")), api.pve("GET", api._node("/lxc")))
        items = [normalize_guest(g, "qemu") for g in qemu or []] + [normalize_guest(g, "lxc") for g in lxc or []]
        return [GuestInfo.model_validate(g) for g in sorted(items, key=lambda g: g["vmid"])]

    async def get_guest_config(self, kind: GuestKind, vmid: int) -> dict:
        return await api.guest_config(kind, vmid)

    async def update_guest_config(self, kind: GuestKind, vmid: int, update: GuestConfigUpdate) -> dict:
        body = api.GuestConfigBody(**update.model_dump(include=set(api.GuestConfigBody.model_fields)))
        return await api.guest_config_update(kind, vmid, body)

    async def guest_power_action(self, kind: GuestKind, vmid: int, action: str) -> TaskInfo:
        api.ActionBody(action=action)  # validates start/shutdown/stop/reboot
        return TaskInfo(task=await api.pve("POST", api._node(f"/{kind}/{vmid}/status/{action}")))

    async def create_vm(self, spec: dict) -> TaskInfo:
        return _task(await provisioning.create_qemu(provisioning.QemuBody(**spec)))

    async def create_container(self, spec: dict) -> TaskInfo:
        return _task(await provisioning.create_lxc(provisioning.LxcBody(**spec)))

    async def delete_guest(self, kind: GuestKind, vmid: int, purge: bool = True) -> TaskInfo:
        params = {"purge": 1, "destroy-unreferenced-disks": 1} if purge else None
        return TaskInfo(task=await api.pve("DELETE", api._node(f"/{kind}/{int(vmid)}"), params=params))

    async def list_pci_devices(self) -> list[PciDeviceInfo]:
        return _many(PciDeviceInfo, await provisioning.pci_devices())

    async def list_usb_devices(self) -> list[UsbDeviceInfo]:
        return _many(UsbDeviceInfo, (await provisioning.usb_devices())["devices"])

    async def list_gpus(self) -> list[GpuDeviceInfo]:
        return _many(GpuDeviceInfo, await provisioning.gpus())

    # ------------------------------------------------------------ Local AI GPU provisioning
    async def provision_ai_container(self, spec: dict) -> TaskInfo:
        return _task(await local_ai.deploy_ai(local_ai.LocalAiDeployBody(**spec)))

    async def configure_ai_gpu_passthrough(self, spec: dict) -> dict:
        return await local_ai.switch(local_ai.SwitchBody(**spec))

    # ------------------------------------------------------------ Storage, ZFS, disks & benchmarks
    async def list_storage_pools(self) -> dict:
        return await api.storage()

    async def create_zfs_pool(self, spec: dict) -> TaskInfo:
        return _task(await storage_admin.pool_create(storage_admin.PoolBody(**spec)))

    async def destroy_zfs_pool(self, name: str, confirm: str) -> TaskInfo:
        return _task(await storage_admin.pool_destroy(name, confirm))

    async def manage_pool_member(self, pool, action, spec: dict) -> TaskInfo:
        if action == "replace":
            return _task(await storage_admin.member_replace(pool, storage_admin.ReplaceBody(**spec)))
        fn = {"offline": storage_admin.member_offline, "online": storage_admin.member_online,
              "detach": storage_admin.member_detach}[action]
        return _task(await fn(pool, storage_admin.MemberBody(**spec)))

    async def list_datasets(self) -> list[ZfsDatasetInfo]:
        res = await storage_admin.datasets()
        return _many(ZfsDatasetInfo, res.get("datasets") if isinstance(res, dict) else res)

    async def create_dataset(self, spec: dict) -> dict:
        return await storage_admin.dataset_create(storage_admin.DatasetCreate(**spec))

    async def update_dataset(self, spec: dict) -> dict:
        return await storage_admin.dataset_update(storage_admin.DatasetPatch(**spec))

    async def delete_dataset(self, name: str, confirm: str, recursive: bool = False) -> dict:
        return await storage_admin.dataset_destroy(name, confirm, recursive)

    async def list_physical_disks(self) -> list[PhysicalDiskInfo]:
        res = await storage_admin.disks()
        return _many(PhysicalDiskInfo, res.get("disks") if isinstance(res, dict) else res)

    async def get_disk_smart(self, disk: str) -> SmartReport:
        return SmartReport.model_validate(await storage_admin.disk_smart(disk))

    async def get_disk_settings(self, disk: str) -> DiskSettings:
        return DiskSettings.model_validate(await storage_admin.disk_settings(disk))

    async def update_disk_settings(self, disk: str, spec: dict) -> DiskSettings:
        return DiskSettings.model_validate(
            await storage_admin.disk_settings_update(disk, storage_admin.DiskSettings(**spec)))

    async def start_disk_scan(self, disk: str, spec: dict) -> dict:
        return await storage_admin.disk_scan_start(disk, storage_admin.ScanBody(**spec))

    async def get_disk_scan_status(self, disk: str) -> dict:
        return await storage_admin.disk_scan_status(disk)

    async def abort_disk_scan(self, disk: str) -> dict:
        return await storage_admin.disk_scan_abort(disk)

    async def run_disk_benchmark(self, spec: dict) -> BenchmarkResult:
        return BenchmarkResult.model_validate(await disk_benchmark.start(disk_benchmark.BenchBody(**spec)))

    async def list_snapshots(self, scope: SnapshotScope, target=None) -> list[dict]:
        if scope == "zfs":
            snaps = (await api.zfs_snapshots())["snapshots"]
            return [s for s in snaps if target is None or s["dataset"] == target]
        return await guest_hardware.snapshots(scope, int(target))

    async def create_snapshot(self, scope: SnapshotScope, target, name: str, description: str = "") -> TaskInfo:
        if scope == "zfs":
            return _task(await api.zfs_snapshot_create(api.SnapshotBody(dataset=str(target), name=name)))
        body = guest_hardware.SnapshotBody(name=name, description=description)
        return _task(await guest_hardware.create_snapshot(scope, int(target), body))

    async def rollback_snapshot(self, scope: SnapshotScope, target, name: str) -> TaskInfo:
        if scope == "zfs":
            return _task(await api.zfs_snapshot_rollback(api.RollbackBody(snapshot=f"{target}@{name}")))
        return _task(await guest_hardware.rollback_snapshot(scope, int(target), name))

    async def delete_snapshot(self, scope: SnapshotScope, target, name: str) -> TaskInfo:
        if scope == "zfs":
            return _task(await api.zfs_snapshot_delete(f"{target}@{name}"))
        return _task(await guest_hardware.delete_snapshot(scope, int(target), name))

    # ------------------------------------------------------------ Backups & ISO/template library
    async def list_storage_content(self, storage: str, content: str | None = None) -> list[StorageContentItem]:
        return _many(StorageContentItem, await provisioning.storage_content(storage, content))

    async def download_url_to_storage(self, storage: str, spec: dict) -> TaskInfo:
        return _task(await provisioning.download_url(provisioning.DownloadBody(**spec), storage))

    async def delete_storage_content(self, storage: str, volume: str) -> TaskInfo:
        return _task(await provisioning.delete_content(storage, volume))

    async def list_backups(self) -> list[BackupArchiveInfo]:
        return _many(BackupArchiveInfo, (await backups.backups())["archives"])

    async def run_backup(self, spec: dict) -> TaskInfo:
        return _task(await backups.run_backup(backups.RunBody(**spec)))

    async def restore_backup(self, spec: dict) -> TaskInfo:
        return _task(await backups.restore(backups.RestoreBody(**spec)))

    async def list_backup_schedules(self) -> list[BackupScheduleInfo]:
        return _many(BackupScheduleInfo, (await backups.backups())["schedules"])

    async def create_backup_schedule(self, spec: dict) -> dict:
        return await backups.create_schedule(backups.ScheduleBody(**spec))

    async def delete_backup_schedule(self, job_id: str) -> dict:
        return await backups.delete_schedule(job_id)

    # ------------------------------------------------------------ Access control, firewall, logs & tasks
    async def list_users(self) -> list[AccessUserInfo]:
        return _many(AccessUserInfo, await pve_access.users())

    async def create_user(self, spec: dict) -> dict:
        return await pve_access.create_user(pve_access.UserCreate(**spec))

    async def update_user(self, userid: str, spec: dict) -> dict:
        return await pve_access.update_user(pve_access.UserFields(**spec), userid)

    async def delete_user(self, userid: str) -> dict:
        return await pve_access.delete_user(userid)

    async def list_groups(self) -> list[AccessGroupInfo]:
        return _many(AccessGroupInfo, await pve_access.groups())

    async def create_group(self, spec: dict) -> dict:
        return await pve_access.create_group(pve_access.GroupBody(**spec))

    async def delete_group(self, groupid: str) -> dict:
        return await pve_access.delete_group(groupid)

    async def list_roles(self) -> list[AccessRoleInfo]:
        return _many(AccessRoleInfo, await pve_access.roles())

    async def create_role(self, spec: dict) -> dict:
        return await pve_access.create_role(pve_access.RoleCreate(**spec))

    async def update_role(self, roleid: str, spec: dict) -> dict:
        return await pve_access.update_role(pve_access.RoleBody(**spec), roleid)

    async def delete_role(self, roleid: str) -> dict:
        return await pve_access.delete_role(roleid)

    async def list_acls(self) -> list[AccessAclInfo]:
        return _many(AccessAclInfo, await pve_access.acl())

    async def update_acl(self, spec: dict, delete: bool = False) -> dict:
        body = pve_access.AclBody(**spec)
        if delete:
            return await pve_access.delete_acl(body.path, body.roleid, body.type, body.ugid)
        return await pve_access.add_acl(body)

    async def list_pools(self) -> list[ResourcePoolInfo]:
        return _many(ResourcePoolInfo, await pve_access.pools())

    async def create_pool(self, spec: dict) -> dict:
        return await pve_access.create_pool(pve_access.PoolBody(**spec))

    async def delete_pool(self, poolid: str) -> dict:
        return await pve_access.delete_pool(poolid)

    async def list_firewall_rules(self, scope: str, vmid: int | None = None) -> list[FirewallRuleInfo]:
        return _many(FirewallRuleInfo, await pve_datacenter.fw_rules(scope, vmid))

    async def list_tasks(self) -> list[TaskInfo]:
        return _many(TaskInfo, await tasks.tasks())

    async def get_task_status(self, task: str) -> dict:
        return await tasks.task_status(task)

    async def get_task_log(self, task: str, start: int = 0) -> dict:
        return await tasks.task_log(task, start)

    async def get_syslog(self, limit: int = 500, start: int = 0, since: str | None = None,
                         until: str | None = None) -> dict:
        return await pve_datacenter.syslog(limit, start, since, until)

    # ------------------------------------------------------------ Networking & consoles
    async def list_network_interfaces(self) -> list[NetworkInterfaceInfo]:
        return _many(NetworkInterfaceInfo, await api.pve("GET", api._node("/network")))

    async def get_network_topology(self) -> NetworkTopologyGraph:
        return NetworkTopologyGraph.model_validate(await automation.topology())

    async def open_vnc_console(self, kind: GuestKind, vmid: int) -> ConsoleTicket:
        t = await console.vnc_ticket(kind, vmid)
        return ConsoleTicket(session=t["session"], password=t["password"], ws_path=f"/api/v1/ws/vnc/{kind}/{vmid}")

    async def open_terminal_console(self, kind: GuestKind, vmid: int) -> ConsoleTicket:
        t = await console.terminal_ticket(kind, vmid)
        return ConsoleTicket(session=t["session"], ws_path=f"/api/v1/ws/terminal/{kind}/{vmid}")

    async def open_host_shell(self) -> ConsoleTicket:
        # The host shell socket authenticates with the login cookie itself; no one-time session is needed.
        return ConsoleTicket(ws_path="/api/v1/ws/host-shell")
