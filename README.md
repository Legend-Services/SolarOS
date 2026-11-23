# ProxmoxOS

A web desktop for Proxmox VE, in the style of Synology DSM, QNAP QTS and ZimaOS. It runs in its own unprivileged LXC container and talks to the host through the Proxmox API.

**Phase 1 (MVP):** lock screen, multi-window desktop, live widgets, Resource Monitor, Compute Manager (VMs + LXC), Storage & ZFS Manager, File Station.

## Install

Run this on the Proxmox VE host as `root`:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/main/install.sh)"
```

You don't need to configure anything. The installer:

1. Finds the node name, host IP, next free CT ID, rootfs storage (ZFS > `local-lvm` > `local`), the latest `debian-12-standard` template, the bridge and gateway, and a free static IP in `.230`–`.249`. If no address there is free, the container uses DHCP.
2. Creates the `pve-desktop@pve` user with the `PVEAdmin` role, plus a fresh `webui` API token.
3. Creates the unprivileged container `proxmox-os` (2 cores, 2 GB RAM, 16 GB disk, `nesting=1`, `onboot=1`). Every mounted ZFS dataset outside `rpool` is bind-mounted at `/mnt/storage/<dataset>`. If there are no data pools, the host's `/mnt/storage` is mounted instead.
4. Installs Python, Node 22 and nginx in the container, deploys the app to `/opt/proxmox-os`, writes `backend/.env`, starts the services and runs a health check.
5. Prints the URL, the username (`admin`) and a generated password.

You can re-run it safely. It reuses the existing `proxmox-os` container, redeploys the app, and rotates the password and API token. If you run `./install.sh` from a local checkout, it copies that checkout instead of cloning. To install from a fork, set `REPO_URL` and `REPO_BRANCH`.

### Storage permissions

Container root in an unprivileged container is uid/gid `100000` on the host. The installer grants that uid access with **additive POSIX ACLs**: it sets `acltype=posixacl` on each dataset and runs `setfacl -R`. It never uses `chown`, so existing ownership on the host stays as it was. On datasets with millions of files the first run can take a while.

## Layout

```
install.sh                 zero-touch installer (runs on the PVE host)
deploy/                    systemd unit + nginx site (installed inside the CT)
backend/                   FastAPI + httpx + PyJWT
  app/auth.py              /api/auth/login|me|logout (HTTP-only cookie or Bearer JWT)
  app/pve.py               /api/pve/overview|guests|guests/{type}/{id}/action|storage
  app/files.py             /api/files/list|mkdir|upload|download|rename|delete (sandboxed to STORAGE_ROOT)
  tests/test_selfcheck.py  auth + sandbox + mocked-PVE aggregation checks
frontend/                  React 19 + TypeScript + Vite + Tailwind 4 + Zustand + lucide-react
  src/lib/stores.ts        auth, window manager, telemetry (60-sample rolling history)
  src/components/          lock screen, top bar, desktop + widgets, dock, window frame, charts
  src/apps/                Resource Monitor, Compute Manager, Storage & ZFS, File Station
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

## Known limits (Phase 1)

- Network throughput and ZFS ARC come from Proxmox's 1-minute RRD averages, so those charts update in steps.
- The installer doesn't add bind mounts for pools created after the container. Delete the container and re-run the installer to pick them up.
- Folder downloads (zip) and multi-select in File Station are not implemented.
- There is a single admin account from `.env` and no login rate limiting. Keep the UI on a trusted network.
