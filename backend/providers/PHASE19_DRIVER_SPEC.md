# `native_ubuntu` driver (SolarOS)

Phase 18 split SolarDeck into a platform-neutral contract (`providers/base.py`) and drivers. `HYPERVISOR_DRIVER`
in `backend/.env` picks the driver package under `providers/` (`providers/registry.py`). **Status (Phase 19, v1.14.0): implemented.**
`NativeUbuntuProvider` (`providers/native_ubuntu/provider.py`) implements every contract method; `routes.py` mounts
the standalone routes ahead of the shared ones at the same paths (`fallback.py` answers 501 for
the other edition's routes); `host.py` holds the command runner, the job
registry (Task Center), the vmid registry (`data/native_guests.json`) and the libvirt XML; `rbac.py` the local users.
The table below is the original design map; where the implementation differs, the code is authoritative
(Incus image templates instead of tarballs, backups under `STORAGE_ROOT/backups`, schedules run by the backend,
local RBAC in `data/local_rbac.json`, the VNC bridge in-process instead of a separate websockify).

## Ground rules

- **The contract is frozen.** Add a method to `base.py` only together with an implementation in *both* drivers.
- **Return the domain models.** The `base.py` models and the shapes the shared `app/*` modules read are the reference.
  The UI reads those field names.
- **Stubs raise `NotImplementedError`.** The API turns that into HTTP 501 (`app/main.py`), so the desktop shows a clear
  "planned" error instead of a crash. Replace stubs one at a time; each new method overrides the generated stub.
- **Host access.** The backend runs on the host itself. Root-only commands go through an allowlisted helper, the same
  pattern as `deploy/solardeck-helper.sh`. Never use a shell string built from user input. Validate with the request
  models in the shared `app/*` modules (`*Body` classes).
- **Job handles.** Long operations return `TaskInfo(task=<job id>)`. Phase 19 adds a small job registry (systemd
  transient units or asyncio tasks with a log file) behind `list_tasks` / `get_task_status` / `get_task_log`.

## Capabilities

| Flag | Value | UI effect |
|---|---|---|
| `driver` / `platform_label` | `native_ubuntu` / `SolarOS` | Driver badge "SolarOS", labels |
| `supports_clustering` | `false` | Hides the cluster task/access log |
| `supports_rbac_realms` | `false` | Hides Datacenter → Realms |
| `supports_lxc` / `supports_qemu` / `supports_zfs` | `true` | Create buttons, filters, ZFS tabs |
| `supports_gpu_passthrough` / `supports_bios_manager` | `true` | Solar AI Studio GPU targets, BIOS guide |
| `supports_apt_repos` / `supports_host_shell` | `true` | System → Repositories, Host Shell button |

## Method mapping

| Contract method(s) | Phase 19 implementation |
|---|---|
| `get_node_metrics` | `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/sys/class/net/*/statistics`, ARC from `/proc/spl/kstat/zfs/arcstats`; guest counts from libvirt + Incus |
| `get_hardware_inventory`, `get_bios_status` | Reuse `app/hardware_admin.py` parsers (`dmidecode`, `lspci -nnk`, `/sys/devices/virtual/dmi/id`) run locally |
| `set_gpu_driver_mode` | Same `app/hardware_admin.py` actions; module blacklist / `vfio-pci` binding via `/etc/modprobe.d` + `update-initramfs -u` |
| `list_guests`, `guest_power_action` | libvirt: `virsh list --all`, `virsh domstats`, `virsh start/shutdown/destroy/reboot`. Incus: `incus list --format json`, `incus start/stop [--force]/restart` |
| `get_guest_config`, `update_guest_config` | libvirt: `virsh dumpxml` / `virsh setvcpus`, `setmaxmem`, `setmem`, `blockresize`. Incus: `incus config show` / `incus config set limits.cpu`, `limits.memory`, `incus config device set root size=` |
| `create_vm`, `create_container`, `delete_guest` | `virt-install --import/--cdrom` with a ZFS zvol disk; `incus launch <image>`; `virsh undefine --remove-all-storage` / `incus delete --force` |
| `list_pci_devices`, `list_usb_devices`, `list_gpus` | `lspci -nnk` + `/sys/kernel/iommu_groups`, `lsusb`. Reuse `app/pci.py` parsing |
| `provision_ai_container`, `configure_ai_gpu_passthrough` | Incus container + `incus config device add gpu` (NVIDIA: `nvidia.runtime=true`); reuse `backend/data/apps/local-ai.sh` |
| `list_storage_pools`, `create_zfs_pool`, `destroy_zfs_pool`, `manage_pool_member` | `zpool list -Hp`, `zpool status -P`, `zpool create/destroy`, `zpool offline/online/detach/replace` (zfsutils-linux) |
| `list_datasets`, `create_dataset`, `update_dataset`, `delete_dataset` | `zfs list -Hp -o ...`, `zfs create -o`, `zfs set`, `zfs destroy [-r]` |
| `list_snapshots`, `create_snapshot`, `rollback_snapshot`, `delete_snapshot` | scope `zfs`: `zfs snapshot/rollback/destroy`. `qemu`: `virsh snapshot-create-as/-revert/-delete`. `lxc`: `incus snapshot create/restore/delete` |
| `list_physical_disks`, `get_disk_smart`, `get/update_disk_settings`, `start/get/abort_disk_scan` | `lsblk -J -O`, `smartctl -a -j`, `hdparm -B/-S`, `smartctl -t long / -X` (same as the shared helper) |
| `run_disk_benchmark` | Reuse `app/disk_benchmark.py` (`fio --output-format=json`) run locally |
| `list_storage_content`, `download_url_to_storage`, `delete_storage_content` | Files under `/var/lib/solardeck/{iso,templates,backups}`; downloads with `curl --fail` + checksum verification |
| `list_backups`, `run_backup`, `restore_backup` | VMs: `zfs send` of the zvol + `virsh dumpxml`. Containers: `incus export` / `incus import`. Archives stored as `.zst` |
| `list/create/delete_backup_schedule` | systemd timers (`solardeck-backup@<id>.timer`) generated from the schedule spec |
| `list/create/update/delete_user`, `*_group`, `*_role`, `list_acls`, `update_acl`, `*_pool` | SolarDeck-native RBAC stored in `backend/data/access.json` (no realms). Linux PAM users only for Host Shell |
| `list_firewall_rules` | nftables table `inet solardeck` (`nft -j list table`) |
| `list_tasks`, `get_task_status`, `get_task_log` | Phase 19 job registry (see ground rules) |
| `get_syslog` | `journalctl -o short-iso --since/--until -n` |
| `list_network_interfaces` | `ip -j addr`, `ip -j link`, `networkctl status --json=short`; config written through Netplan (`netplan apply` with `netplan try` rollback) |
| `get_network_topology` | Reuse `app/automation.py` `build_topology()` with the interfaces above plus guest NICs from libvirt/Incus |
| `open_vnc_console` | libvirt VNC on `127.0.0.1` + `websockify` bridge to `/api/v1/ws/vnc/{kind}/{vmid}` |
| `open_terminal_console`, `open_host_shell` | `incus exec <ct> -- login -f root` / a local PTY. Reuse `app/console.py` PTY relay |

## Done criteria for Phase 19

1. No method in `NativeUbuntuProvider` falls back to the generated stub. Then delete the stub loop.
2. The provider self-check passes with the native driver exercised against recorded command fixtures.
3. Every `/api/v1/*` route that the desktop calls goes through `get_provider()`. Today that is overview, guests and
   power actions; driver-specific handlers live in the driver package, shared ones in `app/*`.
