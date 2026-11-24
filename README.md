# ProxmoxOS

A web desktop for Proxmox VE, in the style of Synology DSM, QNAP QTS and ZimaOS. It runs in its own unprivileged LXC container and talks to the host through the Proxmox API.

**Phase 1 (MVP):** lock screen, multi-window desktop, live widgets, Resource Monitor, Compute Manager (VMs + LXC), Storage & ZFS Manager, File Station.

**Phase 2 (v0.2.0):**

- **Integrated consoles.** Every guest row in Compute Manager has **Console** (noVNC) and **Shell** (xterm.js) buttons. Each opens its own floating window with a status badge, Ctrl+Alt+Del, Reconnect, Fullscreen and auto-fit. The backend relays the WebSocket to Proxmox's `vncwebsocket` with the API token, so you never log in to the Proxmox UI. For a VM, Shell uses the serial terminal, so the VM needs `serial0`.
- **App Center.** A one-click storefront for Jellyfin (with optional Intel Quick Sync `/dev/dri`), Docker & Portainer CE, Samba, AdGuard Home, Nginx Proxy Manager, Immich and Ollama. Each app is installed in its own unprivileged Debian 12 LXC with `nesting=1`, tagged `proxmox-os-app`. You can optionally bind-mount `/mnt/storage` into it. Progress is shown live from the Proxmox task (UPID) and the installer output.
- **Network Shares.** Create SMB shares on folders inside `/mnt/storage`, with read-only and guest options and a list of allowed users. You can manage Samba users and copy `smb://` and `\\host\share` paths with one click.
- **ZFS Snapshots.** A new tab in Storage & ZFS. Filter by pool or dataset, take snapshots, and roll back or delete them after a confirmation prompt.
- **Task Center.** A top-bar indicator that spins while Proxmox tasks run. It opens a list of recent tasks with status badges and an expandable live log.

**Phase 3 (v0.3.0):**

- **Hardware & GPU telemetry.** Resource Monitor has a **Hardware & GPU** tab. It shows NVIDIA GPU utilization, temperature, power and VRAM, Intel Quick Sync availability, and a temperature, SMART and remaining-life card for every NVMe, SATA SSD and HDD. When an NVIDIA GPU is present, a compact GPU widget appears on the desktop. Hosts without one show "not detected" and no errors.
- **Notification Center.** A bell in the top bar has an unread counter. It lists live health alerts: ZFS pools that aren't `ONLINE`, resilvering or fragmented, disks above 55°C or failing SMART, storage above 85%, and Proxmox tasks that failed in the last 24 hours.
- **ZFS schedules.** Storage & ZFS has a **Schedules** tab. You can create hourly, daily or weekly automatic snapshots with a retention limit, and monthly pool scrubs. You can pause or delete each schedule. The backend runs them itself, so you don't need cron.
- **`deploy.sh`.** Deploys your local checkout to any Proxmox VE host over SSH, without pushing to GitHub first.

**System app (v0.3.1):** host administration without the Proxmox UI. You can switch APT repositories (for example from Enterprise to No-Subscription), check for and install host updates, open a root shell on the host (it asks for the host's login), and reboot or shut down the server. The API token therefore has the `Administrator` role.

**Phase 4 (v0.4.0): full control and the Liquid Glass UI**

- **Storage & ZFS.** The app is rebuilt around six workflows. **Create ZFS Pool** is a wizard: choose the RAID topology (Single, Mirror, RAID10, RAIDZ1–3), pick unused disks, set compression and ashift, and optionally register the pool as Proxmox storage. You can also scrub or destroy a pool. **Volumes & Datasets** creates datasets and ZVOLs, edits compression and quota inline, has switches for `atime` and auto-share (SMB), and deletes datasets. **Disks & SMART** shows a card per drive with its temperature and remaining life. From there you can open a full SMART attribute drawer, initialize GPT, wipe a disk (you must type the device path), or format it as Directory/LVM/LVM-Thin storage.
- **Network Shares.** One click creates a share together with its own ZFS dataset. Switches cover read-only, guest access, recycle bin, macOS Time Machine and visibility.
- **Compute Manager.** An **Edit** dialog changes CPU cores, memory, swap, start at boot, tags and notes, and grows disks.
- **Control Panel.** A new app with four sections: change the admin password (saved to `.env`, and kept by later `install.sh`/`deploy.sh` runs), view API token status, view host network interfaces and DNS, pick a wallpaper and toggle widgets, see Proxmox VE/kernel info, and reboot or shut down the host.
- **Liquid Glass UI.** Translucent buttons, switches, inputs and modals; new multi-layer icons for every app; windows animate when they open and close, minimize into their Dock icon, and snap to the left, right or top edge.

## Deploy from a checkout (`deploy.sh`)

```bash
./deploy.sh                                  # root@192.168.68.220
./deploy.sh --host 10.0.0.5 --user admin     # non-root users need passwordless sudo
```

It packages the repository without `.git`, `node_modules`, `.venv`, `.env` and build output, and streams it over SSH to `/tmp/proxmox-os-deploy` on the host. It then runs `install.sh` from there. The installer finds the local source and copies it into the `proxmox-os` container instead of cloning from GitHub. If the container doesn't exist yet it is created; otherwise it is updated in place. You need key-based SSH access to the host.

## Install

Run this on the Proxmox VE host as `root`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/main/install.sh)"
```

You don't need to configure anything. The installer:

1. Finds the node name, host IP, next free CT ID, rootfs storage (ZFS > `local-lvm` > `local`), the latest `debian-12-standard` template, the bridge and gateway, and a free static IP in `.230`–`.249`. If no address there is free, the container uses DHCP.
2. Creates the `pve-desktop@pve` user with the `Administrator` role, plus a fresh `webui` API token.
3. Creates the unprivileged container `proxmox-os` (2 cores, 2 GB RAM, 16 GB disk, `nesting=1`, `onboot=1`). Every mounted ZFS dataset outside `rpool` is bind-mounted at `/mnt/storage/<dataset>`. If there are no data pools, the host's `/mnt/storage` is mounted instead.
4. Installs Python, Node 22, nginx and Samba in the container, and deploys the app to `/opt/proxmox-os`.
5. Installs the host helper (see below), adds `include = /etc/samba/proxmox-os-shares.conf` to the container's `smb.conf`, writes `backend/.env`, starts the services and runs a health check.
6. Prints the URL, the username (`admin`) and a generated password.

You can re-run it safely. It reuses the existing `proxmox-os` container, redeploys the app, and rotates the password and API token. It never prompts. If it finds a local source tree, it copies that instead of cloning. It looks for `$SRC_DIR`, then the script's own directory (a checkout, an extracted tarball or a `deploy.sh` upload), then `/opt/proxmox-os`. To install from a fork, set `REPO_URL` and `REPO_BRANCH`.

### Storage permissions

Container root in an unprivileged container is uid/gid `100000` on the host. The installer grants that uid access with **additive POSIX ACLs**: it sets `acltype=posixacl` on each dataset and runs `setfacl -R`. It never uses `chown`, so existing ownership on the host stays as it was. On datasets with millions of files the first run can take a while.

### Host helper

Some operations are restricted to root on the host, so the Proxmox API token can't do them:

- ZFS dataset snapshots (Proxmox has no API for them)
- bind mounts and `/dev/dri` passthrough for App Center containers
- running the app installer inside a new container (`pct exec`)

For these, the installer puts `deploy/proxmox-os-helper.sh` on the host at `/usr/local/sbin/proxmox-os-helper`. It gives the ProxmoxOS container an SSH key whose `authorized_keys` entry is locked to that script (`command="…",restrict`). The helper accepts only a fixed list of commands (`zfs-list|snapshot|rollback|destroy`, `zpool-scrub`, `hw-info`, `apt-upgrade`, `apt-upgrade-status`, `app-configure`, `app-provision`) and validates every argument again. The `app-*` commands refuse any container that isn't tagged `proxmox-os-app`. The host's sshd must allow root key logins, which is the Proxmox default.

## Layout

```
install.sh                 zero-touch installer (runs on the PVE host)
deploy.sh                  push this checkout to a PVE host over SSH and run install.sh there
deploy/                    systemd unit + nginx site (inside the CT), proxmox-os-helper.sh (on the host)
backend/                   FastAPI + httpx + PyJWT
  app/auth.py              /api/auth/login|me|logout (HTTP-only cookie or Bearer JWT)
  app/pve.py               /api/pve/overview|guests|guests/{type}/{id}/action|storage
  app/files.py             /api/files/list|mkdir|upload|download|rename|delete (sandboxed to STORAGE_ROOT)
  app/console.py           /api/pve/guests/{type}/{id}/vnc|terminal + WS /api/pve/ws/vnc|terminal/{type}/{id}
  app/tasks.py             /api/pve/tasks, /api/pve/tasks/{upid}/status|log
  app/apps.py              /api/apps/catalog|deploy|deployments/{vmid}
  app/shares.py            /api/shares, /api/shares/users (Samba)
  app/host.py              client for the host helper (ZFS snapshots live in app/pve.py)
  app/telemetry.py         /api/pve/telemetry/hardware (disk SMART/temps, Intel iGPU, NVIDIA GPU)
  app/notifications.py     /api/notifications (health alerts)
  app/schedules.py         /api/schedules + the background snapshot/scrub scheduler
  app/system.py            /api/system/repositories|updates|upgrade|power (host administration)
  data/                    app_catalog.json + per-app install scripts
  tests/test_selfcheck.py  auth, sandbox, mocked-PVE, shares, ZFS, App Center, console auth, telemetry,
                           alert and scheduler checks
frontend/                  React 19 + TypeScript + Vite + Tailwind 4 + Zustand + lucide-react
  src/lib/stores.ts        auth, window manager, telemetry (60-sample rolling history)
  src/components/          lock screen, top bar, desktop + widgets, dock, window frame, charts
  src/apps/                Resource Monitor, Compute Manager, Storage & ZFS, File Station,
                           App Center, Network Shares, Console (noVNC / xterm.js, lazy-loaded)
```

## Development

```bash
# backend
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # point PVE_* at a real host/token
.venv/bin/python -m tests.test_selfcheck
.venv/bin/uvicorn app.main:app --reload --port 8000

# frontend (proxies /api to :8000)
cd frontend && npm ci && npm run dev
```

## Known limits

- Network throughput and ZFS ARC come from Proxmox's 1-minute RRD averages, so those charts update in steps.
- The installer doesn't add bind mounts for pools created after the container. Delete the container and re-run the installer to pick them up.
- Folder downloads (zip) and multi-select in File Station are not implemented.
- There is a single admin account from `.env` and no login rate limiting. Keep the UI on a trusted network.
- GPU telemetry reads `nvidia-smi` and `/dev/dri` on the host through the helper, or inside the container as a fallback. Only the first NVIDIA GPU is shown. After upgrading from v0.2, re-run the installer (or `deploy.sh`) so the host helper gains `hw-info` and `zpool-scrub`.
- Schedules run inside the backend. If it is down when a run is due, that run is skipped, not replayed later. "Monthly" means every 30 days, counted from when the schedule was created.
- Alerts are recomputed from live state on every request and aren't stored. Read/unread state is kept per browser.
- App Center deployment logs are kept in memory. If the backend restarts, the container and its Proxmox tasks remain, but the installer output is lost.
- Shares run file I/O as container root (`force user = root`), because that is the uid granted on `/mnt/storage`. Users and `valid users` control who can connect.
- The VNC password, which is the short-lived ticket, is passed to the browser for the RFB handshake. The terminal ticket never leaves the backend.
