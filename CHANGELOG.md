# Changelog

## v1.7.2 - Rename and Search Local AI Conversations — 2026-11-24

### Added
- **Rename conversations**: hover a conversation and click the pencil, or double-click its name, then type and press Enter (Escape cancels, clicking away saves). A chosen name is kept: replies saved afterwards no longer reset the title to the first question. Renaming doesn't move the conversation in the list. API: `PATCH /api/ai/chats/{id}` with `{title}`.
- **Search conversations**: a search box at the top of the sidebar finds conversations by name **and by anything said in them** (case-insensitive, on the server). Matches inside the text show a short snippet around the match under the name, with a result count. API: `GET /api/ai/chats?q=…` (adds `snippet`).

## v1.7.1 - Local AI Conversation History — 2026-11-24

### Added
- **Previous conversations** in a sidebar next to the Local AI chat: *New chat* at the top, then your conversations grouped as Today, Yesterday, Previous 7 days and Older. Click one to continue it with the model it used; hover to delete it (with confirmation). The sidebar can be hidden for narrow windows.
- Conversations are saved **on the server** after every reply (stopped and failed ones included), so they follow you to any device: `GET /api/ai/chats`, `GET|PUT|DELETE /api/ai/chats/{id}`, stored in `backend/data/ai_chats.json` (newest 200 kept; Git, `install.sh` and `deploy.sh` leave it alone). The title is your first question.
- Switching conversations while a reply is still streaming stops it, saves it to its own conversation, and never paints it into the one you opened.

## v1.7.0 - Local AI Opens as a Chat — 2026-11-24

### Changed
- **Local AI opens straight into a chat**, laid out like the familiar AI assistants: a centered greeting and message box when empty, then a centered conversation with the message box at the bottom. The box grows with your text (Enter sends, Shift+Enter adds a line). A **model picker** under the box lists your installed models (size, quantization, loaded in VRAM) and links to *Download more models*. Replies render code blocks with a language label and **Copy** button, plus `inline code` and **bold**. Each reply shows tokens/sec and can be copied; reasoning models show a collapsible thought process. **New chat** starts over; the round Stop button stops a reply.
- Model management moved to **Settings** (gear in the top bar): *Download models*, *Installed models*, *Hardware* (GPU/CPU, Flash Attention, KV cache, API endpoints), *Storage* and *Chat* (custom instructions sent as the system prompt, saved in the browser). The conversation stays put while you visit Settings.

### Added
- **Change where models are stored** (Settings → Storage, `POST /api/ai/storage`): pick any folder below `/mnt` or `/srv`, optionally moving the downloaded models along (copied with `cp -a --reflink=auto`, then removed from the old folder). The AI container is stopped, the folder is bind-mounted at Ollama's models folder, and the container is always started again, even if the move fails.

## v1.6.6 - Window Buttons That Match Your Device — 2026-11-24

### Added
- **Window buttons follow the device you sign in from.** On devices whose browser reports a Mac, iPhone or iPad platform, windows get red/yellow/green circles on the left (close, minimize, maximize; the symbols appear on hover) with a centered title. On all other devices they get flat, full-height minimize / maximize / close buttons on the right, with a red close button on hover.
- **Window buttons** setting in Control Panel → Appearance & Layout (and View Options): *Automatic* (default), *Circles left* or *Buttons right*. It is saved with the other layout preferences.

## v1.6.5 - Single-Click Desktop Icons — 2026-11-24

### Changed
- **Desktop icons open with a single click** by default, like links on a website. A new **Open desktop apps with: Single click | Double click** setting in Control Panel → Appearance & Layout (and the desktop's View Options) brings back double-click. It is saved in the browser and on the server with the other layout preferences, and **Reset to Defaults** returns to single click. Keyboard (Enter/Space) and touch taps open apps in both modes; the icon tooltip says which one is active.

## v1.6.4 - Resize Windows From Every Edge and Corner — 2026-11-24

### Fixed
- **Windows could hardly be resized.** The only grip was an invisible 16×16 px square in the bottom-right corner, and the window's 16 px rounded corner clipped almost all of it. Windows now resize from all four edges (6 px) and all four corners, with matching resize cursors. Dragging the top or left edge grows the window in that direction while the opposite edge stays put; windows never go under the top bar and keep the 360×240 px minimum. The top corner grips stay clear of the close button.

## v1.6.3 - Hotfix: Desktop Icons Flickering Through Windows — 2026-11-24

### Fixed
- **Desktop icons sometimes showed sharp through open windows** in Chrome. Each icon had a CSS `drop-shadow` filter (on the icon and on its button), which puts it on its own GPU layer; Chrome's compositor intermittently painted those layers over the windows' `backdrop-filter` glass. The icon shadow is now an SVG filter inside the icon and the labels use `text-shadow`, so no CSS filters sit behind the windows. Same look, also in the Dock and Launchpad.

## v1.6.2 - Playground Stop Button & Per-Window Crash Protection — 2026-11-24

### Added
- **Stop button** in Local AI → Playground Chat: while a reply is generating, Send turns into Stop. Stopping keeps the text received so far (marked *Stopped*) and closes the stream, so Ollama stops generating on the GPU. Leaving the Playground tab stops a running reply too.
- **Per-window crash protection**: every app window has its own error boundary. An app that crashes shows "ran into a problem" with the error and a **Reload window** button inside its own window; the desktop, Dock and other windows keep running.

## v1.6.1 - Hotfix: Local AI Playground Blank Screen, Streaming Chat & Full-GPU 32B Models — 2026-11-24

### Fixed
- **Blank desktop after Send** in Local AI → Playground Chat. The chat's auto-scroll effect returned the Promise that newer Chrome builds return from `scrollIntoView`, and React then called it as a cleanup function (`TypeError: … is not a function`), unmounting the whole desktop. The App Center install log had the same pattern. Both now scroll their own pane with `scrollTop`.
- **32B models running partly on the CPU**: Ollama's default 32K context made `deepseek-r1:32b` need 28 GB (17% CPU / 83% GPU on an RTX 3090). Local AI now sets `OLLAMA_CONTEXT_LENGTH=8192`, the window the VRAM fit ratings assume, so 27B–32B Q4 models run 100% on a 24 GB GPU. Existing installs get it on the next Apply in Hardware & Performance.

### Changed
- **Playground Chat streams replies** word by word. Reasoning models (DeepSeek R1, Qwen 3) show their thinking in a collapsible "Thought process" block. `POST /api/ai/chat` takes `"stream": true` and returns NDJSON (`{delta, thinking}` chunks, then `{done, tokens_per_sec, eval_count, total_duration_ms}`); without it, the JSON response now also includes `thinking`.

## v1.6.0 - Phase 14: Local AI Studio, Online Model Library & Selectable GPU/RTX 3090 Acceleration — 2026-11-24

### Added
- **Local AI Studio (Ollama + Open WebUI)** in App Center → AI & Compute replaces the plain Ollama app. Its installer has a **Compute Hardware Selector**: one card per NVIDIA GPU (VRAM, driver badge), Intel/AMD render node, or the host CPU (threads, RAM), each with a recommended maximum model size (for example *24 GB VRAM → up to ~35B Q4 models at 100% GPU speed*). It also has toggles for ZFS model storage (`/mnt/storage/ai-models`) and Open WebUI (port 3000), and starter model checkboxes.
- **NVIDIA GPU sharing for unprivileged containers**: the backend loads `nvidia` / `nvidia_uvm` on the host (and makes them load at boot), writes the `lxc.cgroup2.devices.allow` and `lxc.mount.entry` lines for `/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-uvm`, `/dev/nvidia-uvm-tools` and `/dev/nvidia-modeset` to `/etc/pve/lxc/<id>.conf`, and installs the host's exact driver version inside the container with `--no-kernel-module`. Ollama's installer is kept from trying to build a kernel driver inside the container.
- **Local AI** desktop app with a bespoke icon and guide, and four tabs:
  - **Online Models**: live search of ollama.com/library with category pills; every size is rated `optimal_gpu`, `tight_gpu`, `cpu_offload` or `cpu_only` for the active GPU's VRAM; one-click downloads with live progress.
  - **Installed Models**: disk sizes, quantization, which models are loaded in VRAM, unload and delete.
  - **Hardware & Performance**: live VRAM, GPU %, temperature and power; switch between GPU and CPU; Flash Attention and KV Cache Quantization switches; copyable OpenAI-compatible endpoint.
  - **Playground Chat**: model picker, system prompt and a tokens/sec badge after each reply.
- API: `GET /api/ai/hardware`, `POST /api/ai/deploy`, `GET /api/ai/status`, `GET /api/ai/models/online?q=&category=&vram_gb=`, `GET /api/ai/models/local`, `POST /api/ai/models/pull` + `GET /api/ai/models/pull/{job_id}`, `POST /api/ai/models/unload`, `DELETE /api/ai/models/{name}`, `POST /api/ai/hardware/switch`, `POST /api/ai/chat`. `POST /api/apps/deploy` accepts `compute_target`, `install_open_webui` and `starter_models` for `local-ai`.
- The active AI container is stored in `backend/data/local_ai.json`. The installer, `deploy.sh` and Git leave it alone.

### Changed
- Earlier Ollama App Center installs (`pos-ollama` tag) are listed under Local AI Studio.

## v1.5.2 - Hotfix: Hardware & System Blank on Boards With Empty DMI Fields — 2026-11-24

### Fixed
- **Hardware & System** showed only Proxmox API data (no motherboard, BIOS, clock, DIMMs, page cache or drives) on boards whose dmidecode output has empty values, such as `Asset Tag:` on HP ProDesk systems. The DMI parser now reads empty values, and this was the cause of the original `Internal Server Error`.
- Each inventory section (DMI, CPU, sensors, memory, DIMMs, GPUs, drives, network, packages) is now parsed on its own: unexpected output empties only that section and is logged, instead of blanking the whole page.
- Network interfaces whose `ip -j addr` entries have no address (VM tap/veth devices) no longer break the network table.

## v1.5.1 - Phase 13: Fault-Tolerant Hardware/BIOS Telemetry & Zero-Touch Fresh Install SSH/API Setup — 2026-11-24

Fresh installations no longer show `Internal Server Error` in **Control Panel → Hardware & System** or when inspecting hosts without ZFS or a discrete GPU, and the installer sets up the host SSH bridge, API token and hardware tools by itself.

### Fixed
- **Hardware inventory** (`GET /api/hardware/inventory`) never returns HTTP 500. Every probe section (`dmidecode`, `lscpu`, `/proc/meminfo`, `lspci`, hwmon sensors, `ip -j addr`, SMART) is parsed independently, so a missing binary or empty output leaves that section empty. Odd `lscpu` values (`-`, comma decimals) no longer crash the parser.
- When the SSH bridge is down or returns partial data, CPU, memory, kernel and virtualization fall back to Proxmox API `/nodes/{node}/status`, and PCI devices/GPUs to `/nodes/{node}/hardware/pci`.
- **ZFS on LVM / LVM-Thin / Directory hosts**: `GET /api/pve/zfs/snapshots` returns empty lists with `zfs_available: false`, `GET /api/pve/zfs/datasets` returns `[]`, and `GET /api/pve/storage` includes `zfs_available`, instead of an error. A real helper failure on a host that has ZFS pools is still reported.
- **BIOS facts** read `/sys/devices/virtual/dmi/id/*` when `dmidecode` is missing or empty, and ignore placeholders such as `To Be Filled By O.E.M.` and `Default string`.
- **Host SSH bridge**: an unreadable key file is reported as "bridge unavailable" (HTTP 503) instead of a 500; `GET /api/host/bridge` never fails.

### Added
- `GET /api/pve/bios/status`: board, BIOS, CPU vendor, VT-x/AMD-V and Secure Boot facts with dmidecode → sysfs → Proxmox API fallbacks; always HTTP 200.
- Inventory fields `ssh_bridge_connected`, `ssh_bridge_message` and `ssh_setup_command`. Hardware & System shows a bridge status badge and, when the key is not authorized yet, a **Copy SSH Setup Command** button (also in Control Panel → User & Security → SSH key bridge).
- `host_ssh.run_host_cmd(cmd, timeout=10) -> (ok, stdout, stderr)`: never raises on connection, SSH or timeout errors.
- The backend creates `backend/.ssh/id_ed25519` (mode 600) at startup when it is missing.
- **Installer**:
  - installs `dmidecode`, `pciutils`, `lm-sensors` and `smartmontools` on the host;
  - takes the host IP from `vmbr0` and the node name from `hostname -s`, and writes `PVE_PORT=8006` to `backend/.env`;
  - creates the `solardeck@pve!solardeck` API token (`Administrator` on `/`, `--privsep 0`) on fresh installs;
  - sets `chmod 600` on the bridge key and `/root/.ssh/authorized_keys`;
  - runs a post-install self-test of `/api/pve/bios/status` and `/api/hardware/inventory` and shows the result in the final box.

### Changed
- The SSH bridge no longer verifies the host key (`known_hosts=None`), so a reinstalled or re-provisioned Proxmox host keeps working without re-running the installer. The installer stops writing `backend/.ssh/known_hosts`, and Control Panel no longer shows a "Host key" row.
- Upgrades keep their existing API token (`pve-desktop@pve!webui` on installs from before v1.5.1).

## v1.5.0 - Phase 12: Rebranded to SolarDeck for Proxmox VE with Trademark Attribution & Seamless Upgrade Compatibility — 2026-11-24

ProxmoxOS is now **SolarDeck** (*SolarDeck for Proxmox VE*), so the project name no longer suggests a connection to Proxmox Server Solutions GmbH. Existing installations upgrade in place with no manual steps.

### Changed
- **Brand**: all UI labels, the browser title (`SolarDeck — Web Desktop for Proxmox VE`), top bar, sign-in screen, Control Panel, Help Center, wizards, BIOS guides, bug reports, notifications, 2FA issuer and managed-file headers now say SolarDeck.
- **Backend**: FastAPI title `SolarDeck API`; `GET /api/health` returns `{"status": "ok", "app": "SolarDeck", "node": ...}`.
- **Automatic ZFS snapshots** are named `solardeck-auto-<interval>-<timestamp>`. Existing `proxmoxos-auto-*` snapshots still count toward retention and are pruned as new ones arrive.
- **Disk tuning rules** are written with a `# solardeck` marker; rules files with the old `# proxmoxos` marker are still read.
- **Installer**: new containers get the hostname `solardeck`. `install.sh`, `deploy.sh` and the host helper find a `solardeck`, `proxmox-os` or `proxmos-os` container, so re-running the installer always upgrades in place and keeps `.env`, `data/`, `.ssh/` and shares. The completion banner reads **SolarDeck for Proxmox VE**.

### Added
- **Trademark notice** on the sign-in screen, in Control Panel → System & Updates, in `README.md` and in the new `COMMERCIAL_LICENSE.md`.
- **localStorage migration** (`frontend/src/lib/migrateStorage.ts`): `proxmoxos-prefs`, `proxmoxos-dock`, `proxmoxos-layout`, `proxmoxos-wizard` and `proxmoxos.seenAlerts` are copied once to their `solardeck-*` keys before the stores load, so view mode, icon size, alignment and Dock settings carry over.
- **`/opt/solardeck`** symlink to `/opt/proxmox-os`, created by the installer and the self-updater.

### Compatibility
- Kept on purpose so in-place Git updates never break running containers: the install directory `/opt/proxmox-os`, systemd units (`proxmox-os-backend`, `proxmox-os-router`, `proxmox-os-job-*`), the host helper `/usr/local/sbin/proxmox-os-helper` and its SSH keys, guest/app tags (`proxmox-os-guest`, `proxmox-os-app`), managed config file paths on the host, and the `pve-desktop@pve` service account.

## v1.4.0 - Phase 11: Centered Desktop Icon Alignment, Vertical Placement & Safe-Zone Grid Layout — 2026-11-24

### Added
- **Desktop icon alignment**: `Left` (column-first, as before) or `Center` (row-first grid, centered in the free desktop area). In Center mode, **Vertical placement** (`Top` | `Middle`) and **Icons per row** (`Auto` | `4` | `5` | `6` | `8`) appear. List mode in Center stacks one centered column unless a column count is chosen.
- The controls live in **View Options** and **Control Panel → Appearance & Layout**, below the Grid | List switch, and the desktop right-click menu has **Align Icons: Left** and **Align Icons: Center**.
- **Preferences** (`GET|PUT /api/system/preferences`): the `layout` block gains `desktopAlignment` (`left` | `center`, default `left`), `desktopVerticalAlign` (`top` | `middle`, default `top`) and `desktopMaxColumns` (`"auto"` or 3–8, default `"auto"`). PUT rejects invalid values with 422; older saved layouts get the defaults filled in. The values are also kept in localStorage and restored by **Reset to Defaults**.

### Changed
- **Safe-zone layout**: desktop shortcuts sit in their own box between the top bar, the Dock and the widget column. At large icon sizes and spacing, extra columns scroll inside that box instead of sliding under the widgets. Switching alignment or moving a slider animates over 200 ms.

## v1.3.0 - Phase 7: Clean Brand Identity, Safe Installer Upgrades, Git Updater/Rollback & Bug Reporter — 2026-11-24

### Added
- **Git updater** (`backend/app/updater.py`, replaces `/api/system/update/*`): `GET /api/system/updates/status[?check=true]` (current version, tag, commit, branch, latest remote commit/tag, incoming commits, settings, live job log), `PUT /api/system/updates/settings`, `GET /api/system/updates/versions` (all tags + last 25 commits), `POST /api/system/updates/apply` (optional `target_ref`, defaults to `origin/main`) and `POST /api/system/updates/rollback` (`target_ref` required). A deployment without `.git` is converted into a full checkout with tags on first use, so version history is always populated.
- **Update preferences** in `backend/data/update_settings.json`: `mode` `manual` | `notify` (default) | `auto`, `schedule_frequency` `6h` | `daily` | `weekly`, `schedule_time` (`HH:MM`), `schedule_day` (0 = Sunday). A lifespan scheduler checks on that schedule; `notify` adds a top bar notification, `auto` installs the update. A rollback switches `auto` to `notify` so the next run does not undo it.
- **State preservation** in `deploy/self-update.sh`: `.env`, `data/`, `.ssh/` and the Samba share config are snapshotted to `/tmp/proxmox-os-state-backup` before `git reset --hard <target>` and restored afterwards. New optional `.env` keys come from `deploy/env-defaults` via `deploy/merge-env.sh`; existing values are never changed.
- **Control Panel → System & Updates**: version card with Check for Updates / Install Update Now and a what's-new preview, Automatic Update Preferences, and Version History with "Downgrade to This Version".
- **Bug reporter** (`backend/app/bug_report.py`, `components/BugReportModal.tsx`): `GET /api/system/bug-report/diagnostics` (version, Proxmox VE, kernel, CPU/RAM, last 30 backend log lines) with IPs, MAC addresses, e-mails, passwords, tokens, JWTs and SSH keys redacted; `POST /api/system/bug-report` returns a pre-filled GitHub issue link and the Markdown body, and creates the issue directly when `GITHUB_TOKEN` is set or a token is entered. Open it from the top bar Help menu, the user menu, Control Panel or the desktop right-click menu.
- `docs/screenshots/` and a rewritten, beginner-friendly README.

### Changed
- **install.sh Upgrade Mode**: an existing `proxmox-os` (or `proxmos-os`) container with a configured `.env` keeps its `.env`, `data/`, `.ssh/` and shares. The API token is no longer rotated and `JWT_SECRET` no longer regenerated (no forced logouts). `.env` and `data/` are backed up to `/var/backups/proxmox-os-preupgrade-<timestamp>/` inside the container first. Running install.sh inside the ProxmoxOS container upgrades it in place.
- **install.sh** fresh installs print a framed summary with Web UI URL, username, generated password, container ID, Proxmox host and storage mount. Installs from GitHub now fetch full history and tags.
- Brand cleanup: third-party product names removed from UI, help content and docs. The SMB "Time Machine backup target" switch is now **Network Backup Target**.

### Fixed
- install.sh no longer deletes `/opt/proxmox-os` (including `.env` and `data/`) when re-run from GitHub on a container that was deployed without `.git`.
- Updater git commands work on trees owned by another uid (`safe.directory`), which broke the first in-app update after a `deploy.sh` deployment.

## v1.2.0 - Phase 9: Storage Asset List/Grid Modes, Disk Tuning, ZFS Member Offline/Replace, SMART Scans & Storage Benchmark — 2026-11-24

### Added
- **Disk metadata** (`GET /api/pve/disks`): `rotational`, `rpm` (a known spindle speed, otherwise `null`), `rpm_label` (`7200 RPM`, `HDD`, `SSD / NVMe`, `Flash (USB)`) and `wearout_pct` (`null` for hard disks). Each disk also carries its ZFS membership from `zpool status -P`: `pool_name`, `vdev_name`, `member_device`, `member_state`, `read_errors`, `write_errors`, `cksum_errors`. If the SSH bridge is down, the list still loads without them.
- **Disk tuning** (`GET|PUT /api/pve/disks/{disk}/settings`): APM (`hdparm -B`, 1–254 or `disabled`), spindown (`hdparm -S`, 0/5/10/20/30/60/120 min), write cache (`hdparm -W`), NVMe power state (`nvme set-feature -f 2`; `nvme-cli` is installed on first use; power states come from `smartctl -j`), and SMART on/off (`smartctl -s`). Each control reports `supported` and a `reason` per bus. Tuning is persisted in `/etc/udev/rules.d/69-proxmoxos-disk-tuning.rules`, matched on the exact `/dev/disk/by-id` link.
- **ZFS member control** (`POST /api/pve/zfs/pools/{pool}/members/offline|online|replace|detach`): devices are checked against `zpool status -P` (full path, short name or kernel device). Offline refuses when the vdev would lose its last redundancy (mirror: all but one; RAIDZ1/2/3: parity). Replace requires `confirm_device`, refuses disks that belong to a pool, and with `partition_match` copies the old disk's GPT (`sgdisk -R`, `-G`) and replaces partition-for-partition. Detach is limited to mirror, replacing and spare members.
- **Disk scans** (`POST|GET|DELETE /api/pve/disks/{disk}/scan`): SMART short/long self-tests (`smartctl -t`) and a read-only `badblocks -sv -b 4096` surface scan as a detached host job. Status returns progress, ETA, read errors, the bad-block count and the self-test history parsed from `smartctl -j` (ATA and NVMe). DELETE stops the scan and runs `smartctl -X`.
- **Storage benchmark** (`backend/app/disk_benchmark.py`): `POST /api/pve/disks/benchmark`, `GET /api/pve/disks/benchmark/{id}` (live step progress), `DELETE /api/pve/disks/benchmark/{id}` (stop), `GET /api/pve/disks/benchmark/history`. fio with libaio and `direct=1`, 5 s per pass, best of N passes. Raw disks open with `--readonly` unless unused and confirmed; mountpoints use a temporary `.proxmoxos-bench.tmp` that is always removed. Only one run at a time. Finished runs are stored in `backend/data/benchmarks.json` (last 200).
- **Storage Manager UI**: Grid | List toggle for disks and datasets (Phase 8 `useAppView`, new `datasets` view), Tune and Scan Drive dialogs, member actions with offline and replace dialogs and a resilver progress bar in ZFS Pools, a new **Benchmark** tab. `GlassSlider` gains optional `display` and `disabled` props. Storage deep links (`pools`, `disks`, `benchmark`) for Help Center "Show me" buttons.
- **Guided wizards** (`data/wizardGuides.ts`: `storage-replace-disk`, `storage-disk-tests`, `storage-benchmark`, opened from the matching screens) and **Help Center** tutorials: replacing a failing RAID disk, SMART short vs. extended test vs. surface scan, and reading SEQ1M vs. RND4K benchmark results.

### Changed
- `GET /api/pve/disks`: `wearout` is renamed to `wearout_pct`. Hard disks that Proxmox reports with `rpm: -1` no longer show "-1 rpm".
## v1.1.0 - Phase 8: Desktop Grid/List Layout Controls, Icon Size/Spacing Sliders & Interactive Feature Wizards — 2026-11-24

### Added
- **Layout store** (`frontend/src/store/layoutStore.ts`): desktop view mode, icon size (36–96 px, default 56), horizontal app distance (8–64 px, default 20), vertical app distance (8–56 px, default 16), Dock icon spacing (4–20 px) and per-app Grid/List choices. Values are clamped on load, kept in `localStorage`, and synced to the server.
- **Preferences API**: `GET|PUT /api/system/preferences` stores the UI preferences (layout, Dock size, Welcome Tour setting) in `backend/data/user_preferences.json` with an atomic write and a 64 KB limit. The server copy wins on login; changes are uploaded with a short debounce. `deploy.sh` and `install.sh` never overwrite the file. Self-check: `python -m tests.test_preferences`.
- **Desktop Grid View** fills columns from top to bottom and wraps into a new column based on the space between the 36 px top bar and the Dock, so no icon is clipped at the bottom edge. **List View** shows frosted rows with icon, title, a plain-English description (new `desc` field in `apps/registry.ts`) and a launch arrow; Launchpad follows the same mode.
- **View Options** popover (top-bar layout button, desktop right-click **View Options…**, and Control Panel → **Appearance & Layout**) with the new `GlassSlider` primitive, live numeric readouts, Dock icon size and spacing sliders, and **Reset to Defaults**.
- **Grid | List switches** (persisted per app) in Compute Manager, Storage → Disks & SMART, App Center and Network Shares.
- **Guided wizard system**: `components/wizards/GuidedWizardModal.tsx`, `data/wizardGuides.ts`, `store/wizardStore.ts`. A **? Guide** pill in every window title bar opens that app's guide (step pills, Back / Next / Finish, What It Does, When To Use It, How To Use It, **Show Me** deep link). Ten sub-guides cover VMs vs. containers, creating a VM or container, GPU/USB/audio passthrough, ZFS RAID levels, pools and datasets, SMART and snapshot schedules, DNS ad blocking, DHCP and port forwarding, WireGuard with a phone QR code, and Let's Encrypt or custom certificates.
- **Welcome Tour**: five steps shown on first login, with a "Don't show automatically again" switch; replay it from the new **?** Help menu in the top bar, which also opens the guide for the active app.
- **"Need help? Launch Step-by-Step Guide" banners** in empty states and in the Create ZFS Pool, device passthrough (VM wizard and guest Hardware tab), WireGuard Server, DNS AdBlocker and Restore Backup screens.
- **Deep links** (`openLink`, `useIntentFor` in `lib/stores.ts`): Storage tabs and Create Dataset, Network & Services tabs, Backup Center tabs and Back Up Now, Network Shares Create share and Users. Help Center uses the shared helper.

### Changed
- Control Panel's "Appearance & Dock" section is now **Appearance & Layout**; the Dock size slider moved into the layout controls.
- The Dock's strongest-but-one magnification preset is renamed **Strong** (same strength). Saved settings with the old name fall back to it.
- Neutral wording in the README, Network Shares labels and code comments.

## v0.6.1 — 2026-11-24

### Fixed
- **Help Center IOMMU fix** chose the GRUB path on systemd-boot hosts (ZFS on UEFI), so `/etc/kernel/cmdline` was left unchanged while the job still reported success. Host jobs run with `pipefail`, and `proxmox-boot-tool status | grep -q uefi` failed on SIGPIPE even when it matched. The check no longer uses a pipe. The NVIDIA install job had the same pattern (`lsmod | grep -q`) and now reads `/proc/modules`. A self-check now rejects `| grep -q` in host job scripts.

## v0.6.0 - Phase 6 — 2026-11-24

### Added
- **Root SSH bridge** (`backend/app/host_ssh.py`, `asyncssh`): one persistent root connection to the PVE host with the backend's own key `backend/.ssh/id_ed25519` (generated if missing). `install.sh` authorizes it in `/root/.ssh/authorized_keys` and pins the host key in `backend/.ssh/known_hosts`; `deploy.sh` verifies the bridge after installing. Long operations run as detached host jobs (`systemd-run`), followed with `GET /api/host/jobs/{name}`. `GET /api/host/bridge` shows key and connectivity status.
- **Passwordless shells**: `WS /api/pve/ws/host-shell` opens a root PTY on the host (Host Shell app, TopBar button, Control Panel). LXC terminals use `pct enter <vmid>` over the bridge, so containers don't ask for a login. QEMU still uses the termproxy serial console.
- **Dock & Launchpad**: cosine-curve magnification that resizes icon layout boxes (neighbours move aside, no overlap), pin/unpin from the right-click menu, drag to reorder, auto-hide, base size 36–64 px, and magnification Off/Subtle/Strong/Large. Settings are stored per browser (`useDock`) and editable in Control Panel → Appearance & Dock. The Launchpad button opens a full-screen grid of all apps with search.
- **Datacenter app** (`pve_access.py`, `pve_datacenter.py`): users (passwords set through `pvesh` over the bridge), groups, roles with a privilege grid, ACLs, resource pools with members, API tokens, realms; cluster/host/guest firewall rules, options, aliases and IP sets; syslog, journal and cluster log viewers. The ProxmoxOS service user and token are protected. Storage Manager gets a **Storage backends** tab: Directory, LVM, LVM-Thin, ZFS, NFS and CIFS/SMB, with scan-backed selects.
- **Guest hardware** (`guest_hardware.py`, `provisioning.py`): `GET /api/pve/hardware/gpus|usb|pci` with driver, IOMMU group, paired HDMI audio and isolation warnings (`app/pci.py`). Per-guest PCI/GPU passthrough (`pcie`, `rombar`, `x-vga`, whole slot with audio), USB passthrough, NICs `net0..7`, cloud-init, snapshots and options, all applied with `qm set` over the bridge. The Create VM wizard has a passthrough picker; Compute Manager has a tabbed guest drawer.
- **Network & Services app** (`net_services.py`): dnsmasq DNS server with local records and upstream presets, plus a DNS AdBlocker (StevenBlack, OISD, Hagezi, whitelist/blacklist, query metrics); DHCP server with reservations and live leases; WireGuard server (peers, `.conf` download, QR code) and client (`wg-quick`, imported profiles without script hooks); router/NAT (IP forwarding, masquerade, port forwards and static routes in an nftables table `ip proxmox_os`, persisted by `proxmox-os-router.service`); certificate manager (ACME accounts, DNS plugins, domains and ordering; custom certificates for the Proxmox node and ProxmoxOS nginx on port 443).
- **Help & Support app** (`help_center.py`, `bios_guides.py`, lifebuoy icon in the Dock and a `?` button in the top bar):
  - **Ask & search**: type a question in plain words ("my updates fail with 401", "use my graphics card in a Windows VM"). An offline matcher shows one-click fixes, step-by-step guides and FAQ answers.
  - **Fix problems**: `GET /api/help/diagnostics` checks the SSH bridge, 2FA, update sources (Enterprise without a subscription), pending updates, automatic backups, time sync, VT-x, IOMMU, NVIDIA cards on `nouveau`, and the existing ZFS/capacity/SMART alerts. The **Fix it for me** wizard (`POST /api/help/fix/{repos|iommu|time|updates|backups}`) walks through four steps (the problem → what will change → live progress → done) and ends with "Next time, do it yourself" instructions.
  - **BIOS & firmware**: `GET /api/help/bios` detects the motherboard and BIOS vendor (ASUS, MSI, Gigabyte, ASRock, Dell, HP, Lenovo, Supermicro, AMI Aptio) and gives exact menu paths for VT-x, VT-d/AMD-Vi, Above 4G Decoding, primary display and Secure Boot. It marks which ones this server needs. Each guide has **QR codes that contain the instructions themselves**, so a phone can show them while the server is in the BIOS and offline; guides can also be printed or copied.
  - **Tutorials** (24, with "Show me" deep links into the right app or settings section) and an **FAQ** (16 questions).
- **Hardware & System** in Control Panel (`hardware_admin.py`): board/BIOS, VT-x/IOMMU, CPU with per-core temperatures, memory with DIMM slots and ZFS ARC, every GPU from the PCI bus (shown even with no driver loaded), storage controllers and drives, and NICs. **GPU & Drivers**: install NVIDIA (driver + CUDA tools + container toolkit), Intel (VA-API/QuickSync + GuC/HuC) or AMD (firmware, radeontop, ROCm) packages, and switch a GPU between host-driver and `vfio-pci` passthrough mode. Logs stream while it runs.

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
