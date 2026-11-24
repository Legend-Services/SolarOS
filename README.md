# ProxmoxOS

A web desktop for Proxmox VE, in the style of Synology DSM, QNAP QTS and ZimaOS. It runs in its own unprivileged LXC container and talks to the host through the Proxmox API.

**Phase 1 (MVP):** lock screen, multi-window desktop, live widgets, Resource Monitor, Compute Manager (VMs + LXC), Storage & ZFS Manager, File Station.

**Phase 2 (v0.2.0):**

- **Integrated consoles.** Every guest row in Compute Manager has **Console** (noVNC) and **Shell** (xterm.js) buttons. Each opens its own floating window with a status badge, Ctrl+Alt+Del, Reconnect, Fullscreen and auto-fit. The backend relays the WebSocket to Proxmox's `vncwebsocket` with the API token, so you never log in to the Proxmox UI. For a VM, Shell uses the serial terminal, so the VM needs `serial0`.
- **App Center.** A one-click storefront for Jellyfin (with optional Intel Quick Sync `/dev/dri`), Docker & Portainer CE, Samba, AdGuard Home, Nginx Proxy Manager, Immich and Ollama. Each app is installed in its own unprivileged Debian 12 LXC with `nesting=1`, tagged `proxmox-os-app`. You can optionally bind-mount `/mnt/storage` into it. Progress is shown live from the Proxmox task (UPID) and the installer output.
- **Network Shares.** Create SMB shares on folders inside `/mnt/storage`, with read-only and guest options and a list of allowed users. You can manage Samba users and copy `smb://` and `\\host\share` paths with one click.
- **ZFS Snapshots.** A new tab in Storage & ZFS. Filter by pool or dataset, take snapshots, and roll back or delete them after a confirmation prompt.
- **Task Center.** A top-bar indicator that spins while Proxmox tasks run. It opens a list of recent tasks with status badges and an expandable live log.

## Install

Run this on the Proxmox VE host as `root`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/main/install.sh)"
```

You don't need to configure anything. The installer:

1. Finds the node name, host IP, next free CT ID, rootfs storage (ZFS > `local-lvm` > `local`), the latest `debian-12-standard` template, the bridge and gateway, and a free static IP in `.230`–`.249`. If no address there is free, the container uses DHCP.
2. Creates the `pve-desktop@pve` user with the `PVEAdmin` role, plus a fresh `webui` API token.
3. Creates the unprivileged container `proxmox-os` (2 cores, 2 GB RAM, 16 GB disk, `nesting=1`, `onboot=1`). Every mounted ZFS dataset outside `rpool` is bind-mounted at `/mnt/storage/<dataset>`. If there are no data pools, the host's `/mnt/storage` is mounted instead.
4. Installs Python, Node 22, nginx and Samba in the container, and deploys the app to `/opt/proxmox-os`.
5. Installs the host helper (see below), adds `include = /etc/samba/proxmox-os-shares.conf` to the container's `smb.conf`, writes `backend/.env`, starts the services and runs a health check.
6. Prints the URL, the username (`admin`) and a generated password.

You can re-run it safely. It reuses the existing `proxmox-os` container, redeploys the app, and rotates the password and API token. If you run `./install.sh` from a local checkout, it copies that checkout instead of cloning. To install from a fork, set `REPO_URL` and `REPO_BRANCH`.

### Storage permissions

Container root in an unprivileged container is uid/gid `100000` on the host. The installer grants that uid access with **additive POSIX ACLs**: it sets `acltype=posixacl` on each dataset and runs `setfacl -R`. It never uses `chown`, so existing ownership on the host stays as it was. On datasets with millions of files the first run can take a while.

### Host helper

Some operations are restricted to root on the host, so the Proxmox API token can't do them:

- ZFS dataset snapshots (Proxmox has no API for them)
- bind mounts and `/dev/dri` passthrough for App Center containers
- running the app installer inside a new container (`pct exec`)

For these, the installer puts `deploy/proxmox-os-helper.sh` on the host at `/usr/local/sbin/proxmox-os-helper`. It gives the ProxmoxOS container an SSH key whose `authorized_keys` entry is locked to that script (`command="…",restrict`). The helper accepts only a fixed list of commands (`zfs-list|snapshot|rollback|destroy`, `app-configure`, `app-provision`) and validates every argument again. The `app-*` commands refuse any container that isn't tagged `proxmox-os-app`. The host's sshd must allow root key logins, which is the Proxmox default.

## Layout

```
install.sh                 zero-touch installer (runs on the PVE host)
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
  data/                    app_catalog.json + per-app install scripts
  tests/test_selfcheck.py  auth, sandbox, mocked-PVE, shares, ZFS, App Center and console auth checks
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
- App Center deployment logs are kept in memory. If the backend restarts, the container and its Proxmox tasks remain, but the installer output is lost.
- Shares run file I/O as container root (`force user = root`), because that is the uid granted on `/mnt/storage`. Users and `valid users` control who can connect.
- The VNC password, which is the short-lived ticket, is passed to the browser for the RFB handshake. The terminal ticket never leaves the backend.
