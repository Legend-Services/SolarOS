# ProxmoxOS

A friendly web desktop for Proxmox VE: windows, a Dock, live widgets and point-and-click apps for every part of your server. It runs in its own unprivileged LXC container and talks to the host through the Proxmox API.

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
- **Network Shares.** One click creates a share together with its own ZFS dataset. Switches cover read-only, guest access, recycle bin, Time Machine backup target and visibility.
- **Compute Manager.** An **Edit** dialog changes CPU cores, memory, swap, start at boot, tags and notes, and grows disks.
- **Control Panel.** A new app with four sections: change the admin password (saved to `.env`, and kept by later `install.sh`/`deploy.sh` runs), view API token status, view host network interfaces and DNS, pick a wallpaper and toggle widgets, see Proxmox VE/kernel info, and reboot or shut down the host.
- **Liquid Glass UI.** Translucent buttons, switches, inputs and modals; new multi-layer icons for every app; windows animate when they open and close, minimize into their Dock icon, and snap to the left, right or top edge.

**Phase 5 (v0.5.0): wizards, backups, Spotlight and self-update**

- **Create VM / Create Container wizards** in Compute Manager: General → OS/ISO (or template) → Disk & Storage → CPU & Memory → Network & PCIe passthrough (or ZFS bind mount) → Review & Deploy, with the live Proxmox task log. UEFI VMs get an EFI vars disk; Windows 11 gets a TPM 2.0 state disk. Guests created here are tagged `proxmox-os-guest`.
- **ISO & Templates** tab: browse ISO images and container templates on every storage, download new ones straight onto Proxmox storage by pasting a URL, and delete them.
- **Backup Center** app: list vzdump archives with guest name, size and date, **Backup Now** (one guest or all, snapshot/suspend/stop, zstd), a restore dialog (new VMID, or overwrite after an explicit confirmation), and Proxmox cluster backup jobs with on/off switches and "keep last N" retention.
- **Spotlight** (`⌘K` / `Ctrl+K`, or the search icon in the top bar): one palette for apps, VMs, containers (opens the console when running), ZFS pools, datasets and SMB shares (jumps to the File Station path), App Center apps and Control Panel sections, with full keyboard navigation.
- **Desktop context menu** on right-click: New Virtual Machine, New Container, Create ZFS Pool, Open Terminal, Change Wallpaper, Refresh Telemetry.
- **Two-factor authentication** (TOTP) in Control Panel → User & Security, with a QR code for any authenticator app. When it is on, the lock screen asks for the 6-digit code.
- **System Update** in Control Panel → System & Power: shows the version and commit, compares it with GitHub, and installs updates (git pull, `pip install`, frontend rebuild, service restart) in a detached systemd unit inside the container.

**Phase 6 (v0.6.0): root shell, Dock, Datacenter, network services and GPUs**

- **Host Shell** (Dock, TopBar, Control Panel) drops you into `root@pve:~#` with no second login, and container shells go straight into `pct enter`. Both run over a root SSH key bridge that `install.sh` sets up. Anyone signed in to ProxmoxOS is root on the host, so keep 2FA on.
- **Dock** with smooth parabolic magnification, pin/unpin, drag to reorder, auto-hide, size and magnification settings, plus **Launchpad**.
- **Datacenter** app: users, groups, roles, ACLs, pools, API tokens, realms, firewall and logs. Storage Manager adds Directory/LVM/LVM-Thin/ZFS/NFS/CIFS storages.
- **Compute Manager**: GPU/PCI/USB passthrough in the VM wizard and in a new guest drawer (hardware, network, cloud-init, snapshots, options).
- **Network & Services** app: DNS server + AdBlocker, DHCP, WireGuard server/client with QR codes, router/NAT with port forwarding, Let's Encrypt and custom certificates.
- **Help & Support** app: ask questions in plain words, run a health check with one-click **Fix it for me** wizards (each ends with do-it-yourself steps), 24 tutorials that link straight to the right settings, an FAQ, and BIOS instructions for your exact motherboard. The BIOS instructions come with QR codes that carry the text itself, so you can read them on your phone while the server is offline.
- **Control Panel → Hardware & System**: full hardware inventory and one-click NVIDIA/Intel/AMD driver installs or VFIO passthrough mode. GPU passthrough needs IOMMU (VT-d) enabled in the BIOS and kernel.

**Phase 8 (v1.1.0): layout controls and guided wizards**

- **Grid or List desktop.** In Grid View, desktop icons fill columns from top to bottom and start a new column before they would reach the Dock, so every app stays visible. List View shows each app as a frosted row with its icon, name, a one-line description and a launch arrow. Launchpad follows the same setting.
- **View Options** (the layout icon in the top bar, **View Options…** in the desktop right-click menu, or Control Panel → **Appearance & Layout**): sliders for desktop icon size (36–96 px), horizontal and vertical app spacing, and Dock icon size and spacing, all updating live, plus **Reset to Defaults**. Settings are kept in the browser and on the server (`GET|PUT /api/system/preferences`, stored in `backend/data/user_preferences.json`), so they survive a browser reset or an update.
- **Grid | List switches** in Compute Manager (cards or detailed table), Storage → Disks & SMART (drive cards or a compact table), App Center (storefront or compact list) and Network Shares (cards or table). Each app remembers its choice.
- **Guided wizards.** Every app window has a **? Guide** button in its title bar. It opens a plain-English walkthrough: What It Does → When To Use It → How To Use It → Try It Now, with a **Show Me** button that opens the right tab or creation dialog. Ten step-by-step sub-guides cover VMs vs. containers, creating a VM, GPU/USB passthrough, ZFS RAID levels, pools and datasets, disk health and snapshots, DNS ad blocking, DHCP and port forwarding, WireGuard and certificates.
- **Welcome Tour** on first login (five steps, with a "Don't show automatically again" switch). Replay it from the **?** Help menu in the top bar.
- **"Need help?" banners** in empty lists and in the Create ZFS Pool, device passthrough, WireGuard, DNS AdBlocker and backup restore screens launch the matching guide.

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

- PCIe passthrough of raw host devices and ZFS bind mounts for wizard-created guests

For these, the installer puts `deploy/proxmox-os-helper.sh` on the host at `/usr/local/sbin/proxmox-os-helper`. It gives the ProxmoxOS container an SSH key whose `authorized_keys` entry is locked to that script (`command="…",restrict`). The helper accepts only a fixed list of commands (`zfs-list|snapshot|rollback|destroy`, `zpool-scrub`, `hw-info`, `apt-upgrade`, `apt-upgrade-status`, `app-configure`, `app-provision`, `guest-hostpci`, `guest-bindmount`, …) and validates every argument again. The `app-*` commands refuse any container that isn't tagged `proxmox-os-app`, and the `guest-*` commands any guest that isn't tagged `proxmox-os-guest`. The host's sshd must allow root key logins, which is the Proxmox default.

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
  app/system.py            /api/system/repositories|updates|upgrade|power|preferences (host administration, UI preferences)
  app/provisioning.py      /api/pve/storage/{s}/content|download-url, hardware/pci, nextid, guests/qemu|lxc
  app/backups.py           /api/pve/backups, backups/run|restore|schedules
  app/system_extra.py      /api/search, /api/system/update/status|apply (runs deploy/self-update.sh)
  data/                    app_catalog.json + per-app install scripts
  tests/test_selfcheck.py  auth, sandbox, mocked-PVE, shares, ZFS, App Center, console auth, telemetry,
                           alert and scheduler checks
frontend/                  React 19 + TypeScript + Vite + Tailwind 4 + Zustand + lucide-react
  src/lib/stores.ts        auth, window manager, telemetry (60-sample rolling history), deep-link intents
  src/store/               layoutStore (Grid/List, icon size, spacing, server sync), wizardStore
  src/data/wizardGuides.ts plain-English guides for every app plus the Welcome Tour
  src/components/wizards/  GuidedWizardModal and the "Need help?" GuideBanner
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
- 2FA protects the single admin account only; there are no recovery codes. If you lose the authenticator, delete `backend/data/security.json` in the container.
- The self-updater updates the code inside the container. Changes to `deploy/proxmox-os-helper.sh` still need `install.sh` or `deploy.sh` on the host. A deployment made by `deploy.sh` has no `.git`; the first update turns it into a checkout of `REPO_URL`/`REPO_BRANCH` (default: GitHub `main`).
- PCIe passthrough needs IOMMU enabled on the host (`intel_iommu=on` / `amd_iommu=on`); the wizard does not check it.
- App Center deployment logs are kept in memory. If the backend restarts, the container and its Proxmox tasks remain, but the installer output is lost.
- Shares run file I/O as container root (`force user = root`), because that is the uid granted on `/mnt/storage`. Users and `valid users` control who can connect.
- The VNC password, which is the short-lived ticket, is passed to the browser for the RFB handshake. The terminal ticket never leaves the backend.
