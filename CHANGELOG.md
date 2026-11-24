# Changelog

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
