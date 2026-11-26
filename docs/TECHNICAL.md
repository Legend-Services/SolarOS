# SolarDeck & SolarOS: technical details

The [README](../README.md) covers installing and using SolarDeck. This page has everything under the hood.

## What the Proxmox VE installer does

It finds everything by itself: the node name, the next free container ID, the best storage (ZFS > `local-lvm` > `local`), the latest Debian 12 template, and a free static IP in `.230`–`.249` (DHCP if none is free). Then it:

- installs `dmidecode`, `pciutils`, `lm-sensors` and `smartmontools` on the host (hardware inventory, BIOS facts, SMART),
- creates the `solardeck@pve` API user with the token `solardeck@pve!solardeck` (`Administrator` role on `/`, no privilege separation, needed for host updates and power control); installs from before v1.5.1 keep their `pve-desktop@pve!webui` token,
- creates the unprivileged container `proxmox-os` (2 cores, 2 GB RAM, 16 GB disk) and bind-mounts every ZFS dataset outside `rpool` at `/mnt/storage/<dataset>`,
- generates a random 14-character admin password and JWT secret,
- sets up passwordless SSH from the container to the host (for the Host Shell, ZFS snapshots, drivers and network services),
- installs Python, Node 22, nginx and Samba, builds the app and runs a health check,
- enables HTTPS on port 443 with a self-signed certificate for the container's IP and hostname (`deploy/selfsigned-cert.sh`, renewed automatically). Your browser warns about it once; get a Let's Encrypt certificate for your own domain in Settings → Network Topology → Domains (DNS-01, renewed automatically) or upload one in Certificates, and updates will keep that one. Plain http keeps working,
- runs a self-test that signs in and calls `/api/v1/bios/status` and `/api/hardware/inventory`, and prints the result in the final box.

## SolarOS on an existing Ubuntu Server

On a clean **Ubuntu Server 24.04 / 26.04 LTS** machine, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/main/hypervisor/install-hypervisor.sh)" -- --with-console-tui
```

It installs KVM/libvirt, Incus, OpenZFS and the disk/sensor tools, creates the `br0` bridge, deploys SolarDeck to
`/opt/solardeck` with `HYPERVISOR_DRIVER=native_ubuntu`, and (with `--with-console-tui`) shows a console dashboard on
the server's monitor. Or build a bootable installer ISO with `hypervisor/build-iso.sh`. Details: [hypervisor/README.md](../hypervisor/README.md).


## Testing the SolarOS ISO inside a Proxmox VE VM

You can test the whole standalone edition (installer, first-boot setup, tty1 console, VMs, containers and ZFS) in a
nested VM on any Proxmox VE host. Run as root on the Proxmox host:

```bash
# 1. Build the ISO with an extra unattended entry for the test VM's first disk and copy it to local:iso
git clone https://github.com/Legend-Services/SolarOS.git && cd SolarOS
apt install -y xorriso                  # + Node.js 22 and python3-pip to bundle the desktop and Python wheels
bash hypervisor/build-iso.sh --auto-disk /dev/sda --copy-to /var/lib/vz/template/iso

# 2. Create and start the test VM (q35, OVMF, host CPU, 4 cores, 8 GiB, 32 GB OS disk + two 32 GB data disks)
bash hypervisor/test-in-proxmox-vm.sh   # --vmid 950 --storage local-zfs --bridge vmbr0 --enable-nested --dry-run
```

`test-in-proxmox-vm.sh` checks nested virtualization (`/sys/module/kvm_intel/parameters/nested` or `kvm_amd`) and
prints the `modprobe` command to turn it on (or does it with `--enable-nested` when no VM is running). It picks the
next free VMID from 900, `local-zfs` or `local-lvm` and `vmbr0` unless you pass them, and never touches an existing VM.

Then open **Datacenter → your node → the VM → Console** (noVNC):

1. Choose **SolarOS - Automated VM Test Install** in the boot menu. The default entry,
   **Install SolarOS (Interactive Disk Selection)**, asks for the disk and is the one to use on real servers.
2. After the reboot, the first-boot setup bridges the NIC into `br0`, installs KVM/libvirt, Incus, OpenZFS and
   SolarDeck, and starts the tty1 console. It shows the web URL and the setup code for the administrator.
3. Sign in at `http://<VM IP>`, then build a ZFS mirror or RAIDZ1 from the two blank data disks in Storage & ZFS and
   check SMART health and disk benchmarks. Option **[6]** on the console checks `/dev/kvm`, nested virtualization,
   libvirtd, Incus, ZFS and `br0`.

Eject the ISO afterwards with `qm set <vmid> --ide2 none,media=cdrom`; remove the VM with `qm destroy <vmid> --purge`.


Both editions update from the same `main` branch in Settings → System Services & Repositories.

## Updating & Downgrading Without Losing Settings

**From the desktop (recommended):** open **Settings → System → Info** (quick check) or **Settings → System → System Services & Repositories** (schedule, history, rollback).

- **Check for Updates** compares your version with GitHub and lists what's new. **Install Update Now** updates in about a minute.
- **Update Progress**: while an update runs, a progress bar shows the step (backup 5%, fetch 20%, checkout 40%, backend dependencies 60%, frontend 80%, service restart 92%, done 100%), the elapsed time and the live log. The runner is a detached systemd unit that writes its stage to `/run/<prefix>-update-progress.json`, so the progress survives the backend restart; the page reloads itself 2 seconds after 100%. A failed step keeps its percentage and shows the error and the full log.
- **Automatic Updates & Schedule**: background checks every 1, 6, 12 or 24 hours (on by default) show an **Update Ready** badge in the top bar, or in the taskbar tray in the taskbar layout. Choose **Manual Updates** (default) or **Automatic Scheduled Updates**: daily, weekly or monthly at a set time, at most once per day. On a standalone SolarOS host the scheduled run can also upgrade the OS packages. Settings are stored in `backend/data/update_settings.json`; older *Manual / Notify / Automatic* choices carry over.
- **Version History & Downgrade** lists every release and recent change. **Downgrade to This Version** switches back if a new version gives you trouble. You can move forward again from the same list.

Updates and downgrades only replace program files. **Your settings, users, passwords, 2FA, schedules, ZFS pools and datasets, and network shares are never touched.** Before each switch, `backend/.env`, `backend/data/`, `backend/.ssh/` and the Samba share config are copied to `/tmp/proxmox-os-state-backup` and restored afterwards. New settings that a release introduces are added with safe defaults, and existing values are never changed.

**From the Proxmox Shell:** run the same install command again. The installer detects the existing container and switches to **Upgrade Mode**. It backs up `.env` and `data/` to `/var/backups/proxmox-os-preupgrade-<timestamp>/` inside the container, keeps every setting and your password, refreshes the code and dependencies, and restarts the services. Running `install.sh` inside the SolarDeck container also upgrades it in place. Re-run it on the host after updates that change the host helper (`deploy/proxmox-os-helper.sh`).

> **Private fork?** Add `GITHUB_TOKEN=<token with read access>` to `/opt/proxmox-os/backend/.env` and restart the backend (`systemctl restart proxmox-os-backend`) so the updater can reach GitHub.

## Reporting Bugs

Found a problem? Click **Report a Bug**. It's in the **?** Help menu and the user menu in the top bar, in Settings → System Services & Repositories, and in the desktop right-click menu.

1. Pick a category, give it a short title, and describe what happened and how to reproduce it.
2. Leave **Attach anonymized system diagnostics** on. It adds the SolarDeck and Proxmox VE versions, kernel, CPU/RAM and the last 30 backend log lines. IP and MAC addresses, e-mail addresses, passwords, tokens, JWTs and SSH keys are removed first. Click **Preview** to see exactly what is sent.
3. Click **Submit to GitHub**. A pre-filled GitHub issue opens in a new tab; review it and click *Submit new issue*. With a GitHub token (entered in the dialog, or `GITHUB_TOKEN` in `.env`) the issue is created directly. **Copy Report Markdown** copies the report so you can paste it anywhere.

## Architecture

```
 Browser ──HTTP──▶ nginx ──▶ FastAPI backend ──Proxmox API (token)──▶ Proxmox VE host
 (React SPA)        │          │                                    ▲
                    │          ├──SSH (restricted helper key)───────┤  ZFS snapshots, bind mounts, pct exec
                    │          └──SSH (root bridge key)─────────────┘  Host Shell, drivers, network services
                    └── frontend/dist        all inside the unprivileged "proxmox-os" LXC container
```

- **Frontend**: React 19, TypeScript, Vite, Tailwind 4, Zustand, lucide-react, noVNC and xterm.js.
- **Backend**: FastAPI, httpx, asyncssh and PyJWT, running as `proxmox-os-backend` (systemd) behind nginx in `/opt/proxmox-os`.
- **State**: `backend/.env` (credentials, generated by the installer), `backend/data/*.json` (2FA, schedules, preferences, benchmarks, update settings) and `backend/data/themes/` (custom themes and uploaded wallpapers). Both are outside Git's tracked files, so updates never overwrite them.
- **Updater**: `backend/app/updater.py` + `deploy/self-update.sh`, run as a detached systemd unit so it can restart the backend safely.

```
install.sh                 zero-touch installer and upgrader (runs on the PVE host)
deploy.sh                  push a local checkout to a PVE host over SSH and run install.sh there
deploy/                    systemd unit, nginx site, self-update.sh, merge-env.sh + env-defaults, solardeck-helper.sh (+ -proxmox edition part),
                           make-edition-tree.sh + editions/ (per-edition source trees)
backend/providers/         hypervisor driver layer: base.py (contract + domain models), registry.py, proxmox/, native_ubuntu/
backend/app/               shared, driver-neutral routers: hypervisor, files, console, apps, shares, storage_admin,
                           provisioning, backups, net_services, hardware_admin, guest_hardware, access, updater, ...
backend/providers/proxmox/ Proxmox VE driver: REST client, routes/, help checks (not shipped with SolarOS)
backend/tests/             self-check scripts (python -m tests.<name>)
frontend/src/apps/         one component per desktop app
frontend/src/theme/        theme engine: built-in themes, procedural wallpaper art, palette variables (palette.css)
frontend/src/components/   desktop, top bar, dock, windows, wizards, BugReportModal, Liquid Glass UI kit
docs/screenshots/          README screenshots
```

### Hypervisor drivers

The backend talks to the hypervisor through one contract, `HypervisorProvider` in `backend/providers/base.py`, so the
same repository and desktop can manage different platforms. `HYPERVISOR_DRIVER` in `backend/.env` picks the driver:

- `proxmox` (default, also when the key is missing): the Proxmox VE REST API plus host tools over the helper/bridge.
- `native_ubuntu`: **SolarOS**, the standalone edition on Ubuntu Server LTS, where SolarDeck itself is the
  management layer: QEMU/KVM guests through libvirt, containers through Incus, OpenZFS, smartctl/hdparm/nvme-cli/fio,
  Netplan and a local root helper. Its routes (`backend/providers/native_ubuntu/routes.py`) shadow the Proxmox ones
  at the same paths, so the desktop is identical. VM and container editing (network, PCI/USB passthrough, cloud-init,
  options) lives in `backend/providers/native_ubuntu/guest_edit.py`. Proxmox-only extras (cluster log, PVE storage
  backends, API tokens, ACME certificates) answer HTTP 501 there. See `hypervisor/README.md`.

`GET /api/system/capabilities` (also `/api/v1/system/capabilities`) returns the active driver, its platform label and
feature flags. The desktop uses them for labels and to show only supported features. Every route lives under
`/api/v1/...` (the `/api/pve/...` paths were removed in v2.3.0). Updates,
downgrades and re-installs keep `HYPERVISOR_DRIVER` like every other `.env` value.

### Themes and Light / Dark Mode

Every surface reads CSS variables (`--sd-bg-base`, `--sd-surface-glass`, the semantic tiers `--sd-surface-window|panel|card|input|canvas`, `--sd-border-hairline`, `--sd-text-primary|secondary|muted`, `--sd-accent|-soft|-border`, `--sd-text-primary`, `--sd-accent-primary`, `--sd-radius-window`, …) that `frontend/src/store/themeStore.ts` sets on `<html>` with `data-color-mode="dark|light"` and `data-window-chrome="standard|traffic-dots|angular-hud"`. `frontend/src/theme/palette.css` maps Tailwind's palette onto those variables, so every app follows the theme without per-app styles: neutrals are derived from the theme's text and background colors, sky/blue follow the primary accent and violet/indigo the secondary one, and the other color scales are mirrored in Light Mode.

In Light Mode every structural zone (window bars, breadcrumbs, tab bars, sidebars, canvases, cards, drawers, dialogs) uses the same bright surface and is set apart by 1px hairlines (`--sd-hairline`) instead of gray fills: `index.css` repaints the `bg-white/N` tints (white is the text color here) and `bg-black/N` wells as white, with active tabs and selected items as a crisp white pill. `node scripts/audit-scaling-and-themes.mjs` opens every app, Settings sub-module, inner tab, drawer, dialog, nested popover and schematic canvas in headless Chromium at 1440×900 and 1024×768, each in Light Mode and Dark Mode. It fails on a dark bar or gray block in Light Mode, a bright block in Dark Mode, text below WCAG AA contrast (4.5:1, 3:1 for large text), a window, dialog or scroll body that overflows sideways, a footer or primary action button that is cut off or pushed out of view, or a drawer that covers a blueprint canvas; `--mode light|dark` and `--viewport 1440x900` run one pass.

The schematic canvases (Network Architect, Wireframe Architecture, Network Topology) draw with SVG, which cannot use the mirrored Tailwind scales, so they read `--bp-*` variables from `palette.css`: a navy blueprint with luminous text in Dark Mode, a bright `slate-50` blueprint with white node cards and dark text in Light Mode. Accent strokes and icons, including user-picked VLAN colors, pass through `ink()` in `lib/format.ts`, which darkens them by `--bp-ink` (0% dark, 38% light) so they stay vivid on white. Muted text (`slate-400`/`slate-500`) and the `-300`/`-400` shades of the low-luminance hues are tuned to stay at AA contrast on both modes.

| Theme | Character |
|---|---|
| SolarDeck Liquid Glass (default) | cosmic indigo glass / alabaster glass, electric blue and violet |
| Cupertino Frost | frosted acrylic, traffic-dot window controls |
| Redmond Mica | mica-tinted layers, crisp 1px borders, azure accents |
| Aubergine Yaru | aubergine and volcanic slate / warm stone, coral-orange |
| Nordic Slate | polar night / snow drift, glacier cyan |
| Vice Horizon | tropical neon sunset, palms and ocean |
| Nightcity 2099 | megacity steel, acid yellow and neon cyan, chamfered HUD windows, scanlines |
| Synthwave '84 | ultraviolet laser grids and striped suns |
| Phosphor Terminal | phosphor green on obsidian / forest ink on e-ink paper, monospace UI |
| Solarized Amber | ocean teal / parchment, amber-gold |
| Obsidian Gold | carbon glass with champagne gold / ivory silk with bronze |

App launches are counted for the App Gallery's *Most Used* and *Recently Used* sorting (`GET /api/system/app-usage`, `POST /api/system/app-usage/record`, `DELETE /api/system/app-usage` to reset; stored in `backend/data/app_usage.json`). The gallery order, sort mode, bottom bar order and the *Show Desktop Shortcuts* switch are saved with the other preferences.

The active theme, color mode, wallpaper choice per theme, blur and dimming are saved with the other preferences (`theme` in `GET|PUT /api/system/preferences`). Custom themes and uploaded wallpapers live in `backend/data/themes/`:

- `GET /api/system/themes` lists custom themes and the active theme preferences; `POST` adds one, `PUT|DELETE /api/system/themes/{id}` changes or removes it. Theme files are validated (colors, ranges, exactly 4 wallpapers; wallpaper images may only come from `data:image/` URIs, uploads or https).
- `POST /api/system/themes/wallpapers/upload` accepts `.png`, `.jpg`, `.jpeg`, `.webp` or `.svg` up to 15 MB (the content is checked, not only the extension) and returns its URL; `GET /api/system/themes/wallpapers/{file}` serves it with long-lived caching. File names are random 128-bit tokens, so the lock screen can show the wallpaper before sign-in; SVGs are served with a sandboxing Content-Security-Policy.

### Automation & Alerts

Settings → **Automation & Alerts** has two tabs:

- **Alert Channels**: Telegram Bot (`bot_token`, `chat_id`), Discord Webhook (rich embeds), Custom Webhook (`POST` or `PUT` JSON, optional bearer token) and SMTP Email (STARTTLS, or implicit TLS on port 465). **Send Test** delivers a test alert and shows the exact result. Secrets are stored in `backend/data/alert_channels.json` (mode 600) and never sent back to the browser.
- **Automation Rules**: *When* a trigger holds, *then* run an action. Triggers: `gpu_temp_above`, `disk_temp_above`, `zfs_pool_degraded`, `storage_usage_above`, `guest_stopped_unexpectedly`, `scheduled_time`. Actions: `send_external_alert` (all or chosen channels, plus the top bar Notification Center), `restart_guest`, `start_guest`, `stop_guest`, `prune_old_snapshots` (removes `solardeck-auto-*` snapshots older than N days, on the pools over the threshold when the trigger is storage usage). A rule fires at most once per cooldown (default 15 minutes); a scheduled rule once per scheduled slot.

The backend checks the rules every minute. API: `GET|PUT /api/automation/channels`, `POST /api/automation/channels/test` (`{"channel": "telegram"}`), `GET|POST /api/automation/rules`, `PUT|DELETE /api/automation/rules/{id}`, `GET /api/automation/logs` (newest first, up to 300 entries). Rules and the log are stored in `backend/data/automation_rules.json` and `backend/data/automation_logs.json`.

### Network Topology

Settings → Network Topology → **Topology** draws `GET /api/v1/network/topology`, a `nodes[]` / `edges[]` graph built from the host's interfaces (`/nodes/{node}/network` plus `ip -j link` for MACs and link state), every VM and container's `net0..netN` bridge bindings and IPs (container interfaces, or the QEMU guest agent), the WireGuard server and its peers, and the router's port forwards. Click a node to highlight its connections and see its IP, MAC and link status, with **Open Console**, **Configure Bridge**, **Edit Port Forward** or **Configure VPN**.

### Widgets and languages

Widgets, their order, slot (left, right, grid) and size, and the Scratchpad notes are saved in the browser and under `widgets` in `/api/system/preferences`; the language is saved under `i18n.language`. Translations live in `frontend/src/i18n/` (`en.ts` is the source; TypeScript rejects a language file with a missing or extra key). They cover the login screen, top bar, Dock, taskbar, App Gallery, View Options, Settings, app names, widgets, Automation & Alerts and the Network & Services tabs; deeper app screens are still in English.

### Local AI Studio

App Center → AI & Compute → **Local AI Studio** creates an unprivileged Debian 12 container with Ollama (and optionally Open WebUI on port 3000). The installer's **Compute Hardware Selector** lists every GPU from `GET /api/ai/hardware`:

- **NVIDIA** (`nvidia:<PCI address>`): the backend loads `nvidia`/`nvidia_uvm` on the host (and makes them load at boot), adds `lxc.cgroup2.devices.allow` rules for the NVIDIA device majors and `lxc.mount.entry` binds for `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools` and `/dev/nvidia-modeset`, then installs the matching user-space driver inside the container with `--no-kernel-module`, so `nvidia-smi` and CUDA work immediately. A card without a host driver, or bound to `vfio-pci`, gets a one-click **Prepare** button.
- **Intel / AMD** (`intel:/dev/dri/renderD128`): the render node is passed through and Ollama uses Vulkan (AMD also gets ROCm).
- **CPU**: no devices are mapped.

Models are stored on `/mnt/storage/ai-models` (bind-mounted at `/usr/share/ollama/.ollama/models`) when that option is on. The **Local AI** desktop app browses the ollama.com library (cached for 15 minutes, with a built-in catalog as a fallback), rates every size for your GPU's VRAM, downloads models with live progress, shows which models are loaded in VRAM, switches between GPU and CPU, toggles Flash Attention and KV cache quantization, and has a test chat. Other tools can use the OpenAI-compatible endpoint `http://<container IP>:11434/v1`.

### Security-by-Design modules

Eight optional modules are governed by `backend/app/platform_modules.py` (`GET /api/platform/modules`,
`PUT /api/platform/modules/{module_id}`). Each has a profile in `backend/data/platform_modules.json`: `enabled`,
`runtime_mode` (`container` or `host_native`, only where the module supports it), `network_isolation_mode`
(`management`, `vlan`, `dmz`, `isolated_lab`), `bound_bridge`, `bound_vlan_id`, `service_ip` and `security_hardening`.
A switched-off module answers `409` on its write routes.

| Module | Runtime | What runs where |
|---|---|---|
| `reverse_proxy` | container (recommended) / host | nginx in the `edge-proxy` worker container, or `/etc/nginx/<prefix>-proxy.d/` on the host |
| `offsite_backup` | container (recommended) / host | rclone in the `backup-worker` container (sees `/mnt/storage`) or on the host |
| `image_hub` | host | downloads into the hypervisor's ISO storage; zero-touch VMs via the driver |
| `ups_power` | host | Network UPS Tools (`upsd`, `upsmon`) and the backend's 10 s watchdog |
| `oob_bmc` | host | `ipmitool -I lanplus` on the host, Redfish over HTTPS, Wake-on-LAN broadcast from the host |
| `vlan_firewall` | host | nftables table `inet <prefix>_zones`, fail2ban jails in `/etc/fail2ban/jail.d/<prefix>.local` |
| `storage_protocols` | host | `/etc/exports.d/<prefix>.exports`, an nginx WebDAV server on its own HTTPS port |
| `rbac_users` | host | accounts in `backend/data/rbac_users.json`, enforced by the `role_check` middleware in `main.py` |

Worker containers are App Center system apps (`"system": true` in `app_catalog.json`, hidden from the gallery) with a
hardened service (read-only system paths, no new privileges, minimal capabilities). A module pinned to a VLAN or DMZ
gets least-privilege rules in the nftables table `inet <prefix>_modules`: its service ports are dropped on every other
interface, and a container module's address may not open new connections into the management subnet.

The reverse proxy renders one bundle (server blocks, stream servers, certificates, htpasswd files), ships it as a
tarball, swaps it in atomically, checks it with `nginx -t` and reloads; a rejected bundle restores the previous one.
Host-name upstreams resolve per request (an unresolvable name fails only its own requests). Private keys and ACME
credentials are encrypted with the secrets vault. The SolarDeck 2FA gate uses `auth_request` against
`GET /api/proxy/auth/verify`; visitors without a gate cookie go through `/api/proxy/auth/start` (needs a SolarDeck
session) and `/__solardeck_gate` on the proxied host, which trades a one-time 60-second ticket for an HttpOnly cookie
bound to that host and session.

Host snapshots (`POST /api/dr/host-snapshot`) are `SDDR1 | salt | nonce | AES-256-GCM(tar)` with a scrypt-derived
key; they hold `backend/data` (including the vault key) and `.env`, plus `/etc/<prefix>/net`, the interfaces file and
DHCP leases. A restore writes the data back, restores the network state JSON (the interfaces file is staged as
`restored-interfaces` for a manual check) and restarts the backend.

Module jobs (zero-touch VMs, sandbox restore checks, offsite copies) report through `GET /api/tasks/mod-<id>` like
every other long-running job. The full endpoint list is in [api/README.md](api/README.md).

### Host helper and permissions

Some operations are limited to root on the host and can't be done with the API token: ZFS dataset snapshots, bind mounts and `/dev/dri` passthrough for App Center containers, and running installers inside new containers. The installer puts `deploy/proxmox-os-helper.sh` on the host at `/usr/local/sbin/proxmox-os-helper`. The container's SSH key for it is locked to that script (`command="…",restrict`). The helper accepts only a fixed list of commands, validates every argument, and refuses guests that SolarDeck didn't tag.

The Host Shell, container shells, GPU drivers and network services use a second, unrestricted root key. **Anyone signed in to SolarDeck is root on the host, so turn on 2FA** (Settings → Security & 2FA).

Container root in an unprivileged container is uid `100000` on the host. The installer grants it access to your datasets with additive POSIX ACLs (`setfacl -R`), never `chown`, so existing ownership on the host is unchanged.

## Development

```bash
# Deploy your working copy to a Proxmox host over SSH (no GitHub push needed)
./deploy.sh                                  # root@192.168.68.220
./deploy.sh --host 10.0.0.5 --user admin     # non-root users need passwordless sudo

# Backend
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                         # point PVE_* at a real host and token
for t in tests/test_*.py; do .venv/bin/python -m tests.$(basename $t .py); done
.venv/bin/uvicorn app.main:app --reload --port 8000

# Frontend (proxies /api to :8000)
cd frontend && npm ci && npm run dev
node scripts/audit-scaling-and-themes.mjs   # layout + Light/Dark surface and contrast audit of every window, 2 viewports
```

## Known limits

- Extra accounts (Users & Roles) sign in with a password only; two-factor sign-in belongs to the administrator.
  Seat users only control their own VMs and seats, but lists such as the guest list still show every guest.
- The installer doesn't add bind mounts for pools created after the container. Delete the container and re-run the installer to pick them up.
- Network throughput and ZFS ARC come from Proxmox's 1-minute averages, so those charts update in steps.
- SolarOS: task logs live in memory and are lost when the backend restarts; VM snapshots
  need QCOW2 disks (VMs on ZFS volumes are protected with dataset snapshots and backups instead); static container
  addresses use the cloud-init image variants.
- Schedules, automation rules and update checks run inside the backend. A run that is due while it is down is skipped, not replayed.
- 2FA has no recovery codes. If you lose your authenticator, delete `backend/data/security.json` in the container.
- PCIe passthrough needs IOMMU enabled on the host; Help & Support can check it and walk you through the BIOS.
- App Center installer logs are kept in memory and are lost when the backend restarts (the containers remain).
- Local AI model download progress is also kept in memory; after a backend restart, start the download again and Ollama resumes from the partial files.
- Local AI Studio manages one AI container (`backend/data/local_ai.json`). An Ollama container from before v1.6.0 shows as installed in App Center but is not managed by the Local AI app; install Local AI Studio to use the new features.
- NVIDIA GPU sharing binds the host's device nodes into the container, so the host driver must stay installed (not in VM passthrough mode). After a host driver upgrade, switch Local AI to CPU and back to the GPU in Hardware & Performance to reinstall matching user-space libraries.

See [CHANGELOG.md](../CHANGELOG.md) for the full feature history.

## Editions

One repository builds two products. `HYPERVISOR_DRIVER` picks the backend driver package under
`backend/providers/`, `VITE_EDITION` picks `frontend/src/editions/<edition>/`, and `SYSTEM_PREFIX` names everything
created on a host (`proxmox-os` for SolarDeck for Proxmox VE, `solardeck` for SolarOS).
`deploy/make-edition-tree.sh solaros . <out>` builds the SolarOS source tree: CI checks it on every push, the ISO is
built from it, and each release publishes it to the `solaros` branch, which SolarOS installs update from.
