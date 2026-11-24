# Changelog

## v0.5.0 - Phase 5 — 2026-11-24

### Added
- **Provisioning API** (`backend/app/provisioning.py`): `GET|DELETE /api/pve/storage/{storage}/content` (ISO, template and backup volumes), `POST /api/pve/storage/{storage}/download-url` (download onto Proxmox storage, returns the UPID), `GET /api/pve/hardware/pci` (IOMMU group, vendor/device, GPU flag), `GET /api/pve/nextid`, `POST /api/pve/guests/qemu` (OVMF + EFI disk, TPM for Windows 11, q35, optional PCIe passthrough) and `POST /api/pve/guests/lxc` (unprivileged, DHCP or static IP, nesting, optional ZFS bind mount). New helper commands `guest-hostpci` and `guest-bindmount`, restricted to guests tagged `proxmox-os-guest`.
- **Backups API** (`backend/app/backups.py`): `GET /api/pve/backups` (archives on every backup storage plus cluster backup jobs), `POST /api/pve/backups/run` (vzdump), `POST /api/pve/backups/restore` (with `force` overwrite), `POST|PUT|DELETE /api/pve/backups/schedules`.
- **Search and self-update** (`backend/app/system_extra.py`): `GET /api/search?q=` and `GET /api/system/update/status`, `POST /api/system/update/apply`, which runs `deploy/self-update.sh` in a transient systemd unit. `deploy.sh` records the deployed commit in `.build-commit`.
- **TOTP 2FA**: `/api/auth/2fa/status|setup|enable|disable` (pyotp, QR code as SVG). Secrets are stored in `backend/data/security.json` (mode 600); `/api/auth/login` takes an `otp` field once 2FA is on.
- **Frontend**: Create VM / Create Container wizards and an ISO & Templates tab in Compute Manager, the Backup Center app (new icon, Desktop and Dock), Spotlight search (`⌘K` / `Ctrl+K`), a desktop right-click menu, 2FA and System Update cards in Control Panel, and a 2FA code prompt on the lock screen.

## v0.4.0 - Phase 4 — 2026-11-24

### Added
- **Disk administration** (`backend/app/storage_admin.py`): `GET /api/pve/disks` returns each disk's by-id path, vendor, bus (NVMe/SATA/SAS/USB), usage and wearout. `GET /api/pve/disks/{disk}/smart` returns a normalized SMART report: temperature, power-on hours, life used, unsafe shutdowns, media errors, and the full attribute table. `POST /api/pve/disks/wipe` requires `confirm_device` to match the device path. Also added: `POST /api/pve/disks/initgpt`, `POST /api/pve/disks/directory` (ext4/xfs), and `POST /api/pve/disks/lvm` (`thin: true` creates LVM-Thin).
- **ZFS pools:** `POST /api/pve/zfs/pools` creates a pool through `/nodes/{node}/disks/zfs` and checks the device count for each RAID level. `DELETE /api/pve/zfs/pools/{name}?confirm=<name>` destroys a pool and removes its storage entry. `POST /api/pve/zfs/pools/{name}/scrub` starts a scrub.
- **ZFS datasets & ZVOLs:** `GET|POST|PATCH|DELETE /api/pve/zfs/datasets` and `POST /api/pve/zfs/datasets/map`. New datasets can be bind-mounted into the ProxmoxOS container at `/mnt/storage/<dataset>` right away, which makes them visible to File Station and SMB shares. New helper commands: `zfs-datasets`, `zfs-create`, `zfs-set` (allowlisted properties only), `zfs-destroy-dataset` (refuses pool roots and Proxmox guest disks), and `storage-map`.
- **Shares:** a share can create and map its own ZFS dataset (`dataset`, `create_dataset`). New Samba options: `browseable`, `recycle_bin` (vfs recycle), and `timemachine` (vfs fruit).
- **Guest resource editor:** `GET|PATCH /api/pve/guests/{type}/{vmid}/config` covers cores, memory, swap (LXC), onboot, description, tags, and growing a disk through `/resize`.
- **Control Panel API:** `GET /api/system/info` returns PVE version, kernel, network interfaces, DNS and API token status. `POST /api/system/password` changes the admin password and writes it to `backend/.env`.
- **Frontend:** the Liquid Glass design system (`components/ui/GlassKit.tsx`), bespoke app icons (`components/icons/AppIcons.tsx`), the Control Panel app, a redesigned Storage & ZFS app, Network Shares with dataset-backed shares, and a Compute Manager hardware editor. Windows have open, close and maximize animations, minimize into their Dock icon (`dockIconRects` in the window store), and snap to screen edges. Five wallpapers.

### Changed
- `install.sh` keeps an existing `ADMIN_PASSWORD` when it updates an installation. Only fresh installs generate a password.

## v0.3.1 — 2026-11-24

### Added
- **System app** for full host administration from ProxmoxOS:
  - **Repositories:** enable or disable any APT repository and add Proxmox standard repositories such as No-Subscription (`/api/system/repositories`, `/repositories/toggle`, `/repositories/add`). A warning appears when Enterprise is enabled but No-Subscription isn't.
  - **Updates:** list upgradable packages, check for updates (live task log), and run a full `apt dist-upgrade` on the host (`/api/system/updates`, `/updates/refresh`, `/api/system/upgrade`). The upgrade runs in a transient systemd unit on the host (helper commands `apt-upgrade` and `apt-upgrade-status`), so a dropped connection or backend restart can't interrupt dpkg.
  - **Host & Power:** a host shell (node `termproxy`, which asks for a host login) and reboot or shutdown (`/api/system/power`).

### Changed
- The installer grants the API token the `Administrator` role instead of `PVEAdmin`. `PVEAdmin` has neither `Sys.Modify` nor `Sys.PowerMgmt`.

## v0.3.0 - Phase 3 — 2026-11-24

### Added
- **Hardware & GPU telemetry:** `GET /api/pve/telemetry/hardware` combines SMART health, temperature and remaining life for every physical disk (`/nodes/{node}/disks/list` + `/disks/smart`), Intel iGPU render nodes with Quick Sync detection, and NVIDIA metrics from `nvidia-smi` (name, temperature, utilization, VRAM, power). Without an NVIDIA GPU it returns `gpu.available: false` and no error. Results are cached for 30 seconds.
- **Notification Center:** `GET /api/notifications` returns prioritized `critical` / `warning` / `info` alerts for ZFS pools that aren't `ONLINE`, resilvering, scrubbing or more than 80% fragmented; disks above 55°C or failing SMART; storage, ZFS pools or the host rootfs above 85% (critical at 95%); and Proxmox tasks that failed in the last 24 hours. A bell in the top bar shows an unread counter colored by the worst unread severity, and opens a popover listing the alerts.
- **ZFS schedules:** `GET|POST /api/schedules`, `PATCH|DELETE /api/schedules/{id}`. Supports hourly, daily or weekly snapshots of a dataset with a retention count, and monthly pool scrubs. Snapshots are named `proxmoxos-auto-<interval>-<timestamp>`, and older ones beyond the retention count are pruned (per dataset and interval; manual snapshots are never touched). Definitions live in `backend/data/schedules.json` and run from an asyncio loop in the FastAPI lifespan, which checks every 60 seconds. You manage them in the new **Schedules** tab in Storage & ZFS.
- **Resource Monitor → Hardware & GPU tab:** NVIDIA utilization gauge, temperature, power draw, VRAM bar, Intel Quick Sync status, and one temperature card per drive.
- **Desktop GPU widget:** shown only when an NVIDIA GPU is detected.
- **`deploy.sh`:** `./deploy.sh [--host <IP>] [--user <USER>]` streams the checkout over SSH to `/tmp/proxmox-os-deploy` on a Proxmox VE host and runs `install.sh` there. The defaults are `192.168.68.220` and `root`.
- Host helper commands `hw-info` (GPU probe) and `zpool-scrub <pool>`.

### Changed
- `install.sh` uses a local source tree when it finds one, in this order: `$SRC_DIR`, the script's own directory, then `/opt/proxmox-os`. Otherwise it clones `REPO_URL`. It runs fully non-interactively and never copies `.claude/` or `backend/data/schedules.json` into the container.
- Storage & ZFS → Disks: wearout is now labelled as remaining life (`% left`). That is what Proxmox reports; the old label said "used", which was wrong.

## v0.2.0 (Phase 2) — 2026-11-24

### Added
- **Integrated consoles:** noVNC graphical console and xterm.js shell in multi-instance windows, launched from Compute Manager. Backend endpoints `POST /api/pve/guests/{type}/{vmid}/vnc|terminal` and authenticated WebSocket relays `WS /api/pve/ws/vnc|terminal/{type}/{vmid}`. Tickets are single-use and valid for 60 seconds.
- **Task Center:** top-bar indicator and popover backed by `GET /api/pve/tasks` and `GET /api/pve/tasks/{upid}/status|log`.
- **App Center:** curated catalog (`backend/data/app_catalog.json`) of Jellyfin, Docker & Portainer CE, Samba, AdGuard Home, Nginx Proxy Manager, Immich and Ollama. `POST /api/apps/deploy` creates an unprivileged Debian 12 LXC (`nesting=1`, tag `proxmox-os-app`) and optionally adds `/mnt/storage` bind mounts and `/dev/dri` passthrough, then runs the app installer.
- **Network Shares:** Samba share and user management (`/api/shares`, `/api/shares/users`) on folders in `/mnt/storage`, with copyable `smb://` and `\\host\share` paths.
- **ZFS Snapshots:** Snapshots tab in Storage & ZFS. `GET|POST|DELETE /api/pve/zfs/snapshots` and `POST /api/pve/zfs/snapshots/rollback`.
- **Host helper:** `deploy/proxmox-os-helper.sh`, a forced-command SSH helper on the PVE host for root-only operations.

### Changed
- nginx: dedicated `/api/pve/ws/` location with WebSocket upgrade headers and a 1-hour read timeout.
- `install.sh`: installs `samba`, `samba-common-bin` and `openssh-client`, includes `/etc/samba/proxmox-os-shares.conf` in `smb.conf`, installs the host helper and its SSH key, and writes `PVE_BRIDGE` and `HOST_SSH` to `.env`.
- The window manager supports several windows of the same app, keyed per console target.

## v0.1.0 (Phase 1)

- Lock screen, multi-window desktop, widgets, Resource Monitor, Compute Manager, Storage & ZFS Manager, File Station, zero-touch installer.
