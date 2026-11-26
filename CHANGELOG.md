# Changelog

## v2.20.2 - Features & Services grid alignment — 2026-11-26

### Fixed
- **Settings → System → Features & Services**: every feature card now sits on one two-column grid with shared left edges, centre gutter and right edges. Sub-features (WireGuard VPN Server and Client, Per-VLAN DHCP Servers) are no longer indented; a small pill next to the title names their parent. Cards have one height, icon box and padding, and the switch stays vertically centred whether the description takes one line or two.
- The last card of a Settings page is no longer clipped at the bottom of the scroll area.
- The Settings sidebar is wider and shows a compact `n/total` badge, so **Features & Services** (and other long names) no longer truncate.

## v2.20.1 - Module worker network fix — 2026-11-26

### Fixed
- Isolated module workers (Docker Engine runtime, edge proxy, backup worker) lost their IPv4 address when they were placed on their network: changing the NIC recreates the container's interface and nothing renewed the DHCP lease, so the worker could not reach the internet or its clients. Placement now renews the lease inside the container. Workers already affected get their address back when the container restarts or when their module's network is changed.

## v2.20.0 - Native Docker Engine & App Center Catalog Consolidation — 2026-11-26

### Added
- **Docker Engine & Compose as a built-in platform feature**: a new `docker_engine` switch in **Settings → Features & Services** (its Security-by-Design options appear right under the card) and a **Docker** tab in **Compute**. The engine runs as an **Isolated Container (Recommended)** in its own runtime container or **Host Native**, and can be pinned to the management network, a VLAN, the DMZ or an isolated lab with the least-privilege rules of the other modules. The tab installs Docker Engine & Compose with a progress card, lists every container (image, state, ports, Compose stack) with start, stop, restart and remove, and lists Compose stacks. It works on both drivers through the same module runtime. Host-native installs keep the host's FORWARD policy (`ip-forward-no-drop`), so guests on the bridges keep their network.
  - `GET /api/docker/status`, `POST /api/docker/enable`, `GET /api/docker/containers`, `POST /api/docker/containers/{id}/{start|stop|restart|pause|unpause|remove}`, `GET /api/docker/stacks`.
- **SMB quick presets** in Shared Folders & SMB: **Public guest share** (`public` in `/public`, read-only, no password) and **Storage share** (`storage` over the whole storage root, read/write for SMB users, recycle bin). `POST /api/shares/presets/{public|storage}`.
- **App Center shortcuts**: searching for Samba, SMB, Nginx, reverse proxy or Docker shows a banner that opens the built-in feature.

### Changed
- App Center catalog: **Samba File Server** and **Nginx Proxy Manager** are removed (Shared Folders & SMB and Reverse Proxy & SSL do the same job built in), and **Docker & Portainer CE** is replaced by standalone **Portainer CE** (multi-instance), an optional web UI for containers. The Server Setup Wizard offers Local AI Studio, Jellyfin, Immich, AdGuard Home and Portainer CE.
- The Virtualization Host role and the Home & Media Server preset include Docker Engine & Compose. Features & Services now counts 29 features.

### Notes
- Instances of the removed apps installed on an older version stay listed in Settings → Installed Apps & Instances with a **Built-In Native Feature Available** badge and an *Open built-in feature* link; they keep working and can be opened or uninstalled as before. They can no longer be installed (`DeployBody` refuses legacy app ids).

## v2.19.0 - Features & Services Toggle Hub, Server Setup Wizard & Interactive Desktop Tour — 2026-11-26

### Added
- **Settings → System → Features & Services** with a live `n / 28 Active` badge in the sidebar and on its tile: one switch per optional feature, grouped into Networking & Edge, Compute & Virtualization, Storage & Data Protection, System, Hardware & Security and Applications & AI, with search, plain-English descriptions and quick presets (**Minimal Core**, **Home & Media Server**, **Full Hypervisor Lab**, **Enable All**). Sub-features sit indented under their parent: **WireGuard VPN Server** and **WireGuard VPN Client** switch independently, **Per-VLAN DHCP Servers** live under Virtual Switch.
  - A switched-off feature disappears from the Settings sidebar and tiles, from the inner tabs of its module (for example the WireGuard server tab while the client tab stays), from TopBar Global Search (apps, sub-modules, controls and manual articles), and its app from the desktop, App Gallery, launcher, Dock and taskbar. Pinned and ordered apps keep their place and come back when the feature is switched on again.
  - Background services pause with their feature: running WireGuard server / client tunnels, per-VLAN DHCP servers and UPS monitoring units are recorded, disabled and stopped, and exactly those units start again when the feature is switched back on. Configuration files are never touched.
  - General & Appearance, Users & Roles, Software & Repositories and Features & Services itself have no switch, so nobody can hide their way out of administration.
  - Flags live in `backend/data/enabled_features.json` and default to on, so upgraded installations look exactly as before. `GET /api/system/features`, `PUT /api/system/features` (administrator only; seat users and viewers can read them so their desktop is filtered too).
- **Server Setup Wizard**: opens full-screen on the first sign-in of a new installation and any time from **Re-run Setup Wizard** (Features & Services, Help & Support). Pick one or more server roles on cards with glowing schematic wireframes and checkmarks (Storage & Media, Virtualization Host, Multi-Seat Gaming, High-Availability Cluster, Network Gateway & VPN, AI Compute, Other Services), choose **Standalone Server** or **Cluster Host** (create or join), fine-tune single services, tick App Center apps with their vCPU / RAM / disk footprint, review the summary and press **Setup My Server**. A progress card runs from 0 to 100 % while features are applied, cluster readiness is checked and the apps install one after another; the finish screen shows the server address, roles and apps, and **Enter Desktop** opens cluster setup next for a cluster host. **Skip Setup & Use Defaults** keeps everything on. `GET /api/onboarding/state`, `POST /api/onboarding/apply` (a Task Center job), `POST /api/onboarding/skip`; state in `backend/data/onboarding_state.json`.
- **Interactive Desktop Tour**: five Liquid Glass speech balloons with a pointer arrow and highlight ring on the real desktop (search bar, system tray and Task Center, widgets, Dock or taskbar, Settings → Features & Services), each with Step X of 5, Back, Next / Finish Tour and **Skip Guide**. It follows the wizard unless *Skip interactive get-started guide after setup* stays ticked, and starts any time from Help & Support or the top bar's help menu. `POST /api/onboarding/tour-complete`.
- Manual, Global Search, guides, screenshots, `docs/` and the API reference cover the new screens. All new texts in English, Nederlands, Deutsch, Español and Français.

### Notes
- An installation that was already set up never sees the wizard automatically; the first-run state is written when the first administrator is created.
- The reverse proxy's web server is not stopped when Reverse Proxy & SSL is hidden: on a single-host installation it may also serve this interface.

## v2.18.0 - Built-In Reverse Proxy & SSL, Security-by-Design Isolation & Core OS Modules — 2026-11-26

### Added
- **Security-by-Design modules** (Settings → Privilege & Security → Security-by-Design Modules, and a header on top of every module): eight optional modules can each be switched on or off, run as an **Isolated Container (Recommended)** or **Host Native** where both are supported, and be pinned to the **Management Network**, a **VLAN**, the **DMZ Isolated Network** or an **Isolated Lab**. Pinned modules get least-privilege nftables rules (their service ports answer only on their own network; a container module may not open connections into the management subnet). Profiles live in `backend/data/platform_modules.json`; `GET /api/platform/modules`, `PUT /api/platform/modules/{module_id}`.
- **Reverse Proxy & SSL** (Settings → Network & Services → Reverse Proxy & SSL):
  - **Proxy Hosts** with several domains each, a quick pick of VMs, containers and App Center instances, WebSocket, HTTP/2, Force HTTPS, HSTS, upload size, per-host rate limiting, IP access lists with optional passwords, advanced directives (validated) and the **SolarDeck 2FA gate**: visitors who are not signed in to SolarDeck (password + two-factor code) are sent to its sign-in first, and signing out or revoking the session ends access to every protected app.
  - **SSL Certificates & Private Root CA**: one-click ECDSA P-384 / RSA-4096 root CA with `solardeck-root-ca.crt` download, one-click self-signed and wildcard certificates (domains and IP addresses), Let's Encrypt with HTTP-01 or DNS-01 and automatic renewal 30 days before expiry, and certificate upload. Private keys are stored encrypted.
  - **TCP/UDP Streams** for game servers, SSH, MQTT or databases.
  - Runs in the hardened `solardeck-edge-proxy` container (read-only system paths, no new privileges, minimal capabilities), which can be moved onto a DMZ VLAN, or in dedicated files under `/etc/nginx/<prefix>-proxy.d/` on the host next to any existing server. Switching mode moves the configuration. Every change is checked with `nginx -t` and reloaded without dropping connections; a rejected configuration keeps the previous one running.
- **Backups & Disaster Recovery → Disaster Recovery & 3-2-1**: AES-256-GCM encrypted **host snapshots** of SolarDeck's configuration (network, switches and VLANs, DHCP, reverse proxy rules and certificates, multi-seat, cluster, accounts, settings) with download, upload and restore; **offsite targets** (S3-compatible, SFTP, WebDAV) copied with rclone in an isolated backup-worker container or on the host, with retention; **Sandbox Restore Verification** restores a backup into an air-gapped isolated lab, boots it, waits for the guest agent heartbeat and removes everything again.
- **Image & Template Hub** (Settings → Storage → ISO & Templates, and a **Templates & Images** tab in Compute): curated server, desktop, driver and cloud images resolved from their checksum lists and downloaded with checksum verification; **Zero-Touch Create** builds a VM from a cloud image with cloud-init (host name, admin user, password and/or SSH keys, DHCP or static address, guest agent, VLAN); **golden templates** with clone.
- **Power & UPS** (Settings → System): Network UPS Tools for a USB UPS or one another machine serves, live charge / load / input voltage / runtime with a **battery pill in the top bar**, an ordered guest shutdown plus ZFS sync and power-off at a battery or runtime threshold, and **power profiles** (performance, balanced, eco — eco can stop chosen lab guests) on a weekly schedule.
- **Out-of-band control** (Settings → Hypervisor & Runtime → Cluster & HA → Out-of-Band & Wake-on-LAN): IPMI and Redfish power on / off / cycle / soft reset and hardware sensors, and Wake-on-LAN for standby hosts; credentials are stored encrypted. A **Serial Console** tab in the guest drawer keeps a VM reachable when its display goes to a passed-through GPU (`WS /api/compute/{guest_type}/{guest_id}/serial`).
- **Firewall & IDS** (Settings → Network & Services): visual inter-VLAN / DMZ **zones** and ordered **rules** (accept, drop, reject, logging) with a zone matrix, applied as their own nftables table; **intrusion prevention** with fail2ban jails, ban settings, banned addresses and manual ban / unban.
- **Shared Folders**: **NFS & WebDAV** shares, a **Snapshot Files** browser that restores single files or folders from ZFS snapshots, and **USB Drives** with mount, unmount and attach-to-VM.
- **Users & Roles → SolarDeck Accounts**: accounts besides the administrator with the roles admin, operator, seat user and viewer and per-account VMs, seats and shares. One request check covers every API route; seat users only control their own Seat VMs, consoles and USB ports, operators cannot change users, security, updates or clustering, and only the administrator gets the host shell.
- Help & Support, Global Search, the guides and `docs/` cover every new module with new screenshots; `node scripts/generate-api-docs.mjs` writes the REST API reference to `docs/api/`. All new texts in English, Nederlands, Deutsch, Español and Français.

### Changed
- Validation errors now show their reasons instead of "Unprocessable Entity".

### Notes
- Extra accounts sign in with a password; two-factor sign-in belongs to the administrator. Seat users see the full guest list but can only act on their own guests.
- Template cloning and NFS / WebDAV / UPS / firewall services run on the host; the first save installs the needed packages, which can take a minute.

## v2.17.0 - Wireframe Node Architect, Hardware Identity Editor & Network Architecture Explorer — 2026-11-26

### Added
- **Wireframe Architecture view** for every VM and container: a **Form View | Wireframe Architecture** switch at the top of the guest drawer.
  - A blueprint computer case with live specs (vCPU, RAM, OS profile, status LED) and sectioned slots: *Network adapters*, *Motherboard PCIe cards* (GPU / PCI passthrough, HD audio, watchdog …), *Capture, audio & USB peripherals* (virtual webcam, smartcard reader, modem, USB passthrough …) and *Storage controllers & drives* (disks, NVMe, SAS/RAID HBA).
  - **Hardware Device Inspector & Editor** (slide-over, **Save & Apply**): network cards get interface name (containers) or label (VMs), MAC address with a valid random-MAC generator, driver model, switch, VLAN tag, trunk VLANs, link state and rate limit, plus their PCI vendor:device ID and IPv4 addresses; virtual devices get a **Guest Device Manager display name**, vendor ID (VID), device ID (PID), serial number and PCI/USB address next to their own settings (a camera's stream source, a modem's dial target …). Fields marked *Visible in guest* reach the guest — the virtual camera's card name (per-slot v4l2loopback `card_label`) and the NVMe serial; the others are SolarDeck labels, and the native IDs of the emulated chip are shown.
  - Animated schematic lines from every network card to its **switch / VLAN node** (VLAN pill, DHCP and DNS indicators, guest IP) or **isolated lab node**; clicking a line or node opens **Change Network Endpoint** (virtual switch, physical bridge, router / NAT bridge, VLAN or lab; *Switch Lab* for lab ports). A **host placement node** shows *Standalone Mode* (host + IP) or *Cluster Mode* (preferred active host, standby hosts, ZFS sync interval, floating VIPs).
- **Network Architect** app (App Gallery, and **Open Network Architect** in Settings → Network & Services → Network Topology):
  - **Infrastructure Blueprint:** a pan / zoom canvas with the standalone host or cluster band (quorum, host cards with CPU / RAM, floating VIPs), gateways with MAC vendor and LLDP / CDP neighbors, physical uplinks, virtual switches, VLANs and labs with live **DHCP** / **DNS** badges, and every VM and container with its IP addresses and host.
  - **Network drill-down:** the router / gateway, DHCP server, DNS server, SolarDeck host and the network's guests around the network hub; more than six unmanaged devices collapse into one **Other Devices (+N)** hub. **Scan Network Now** shows live progress.
  - **Discovered Devices Explorer:** searchable and filterable by type, with a device-type icon (router, switch / AP, server, PC, phone / tablet, printer, camera, TV / media, NAS, IoT), name, IP, MAC + hardware vendor, a functionality badge (e.g. *Gateway, DHCP & DNS Resolver*, *Network Printer*, *RTSP IP Camera*) and open-port pills that expand into a plain-English purpose per port.
- New endpoints: `GET /api/virtual-hardware/{guest_type}/{guest_id}/detailed`, `PUT /api/virtual-hardware/{guest_type}/{guest_id}/devices/{device_id}` (a virtual device id or `net0` … `net7`), `POST /api/virtual-hardware/{guest_type}/{guest_id}/repatch-endpoint` (switch + VLAN or lab in one call; joining a lab records the previous endpoint so deleting the lab restores it), `GET /api/architecture/overview`, `POST /api/architecture/networks/{network_id}/scan` and `GET /api/architecture/networks/{network_id}/devices` (`network_id`: a switch name, `vlan-<id>` or `lab-<id>`).
- Scans run on the host over the SSH bridge: a ping sweep bound to the network's host interface (up to 1024 addresses), the ARP table, DHCP lease files and the host's own DHCP server, reverse DNS, an mDNS browse (`avahi-browse` when installed), MAC vendors from the host's IEEE OUI tables (`ieee-data`, `arp-scan` or `nmap`) and TCP connect probes (1 s, no data sent) on 37 common service ports. The last result per network persists in `backend/data/network_scans.json`.
- Guides, Global Search, the Help manual and `docs/` cover *Wireframe Node Architecture & Hardware ID Overrides* and *Network & Infrastructure Architect*, with new screenshots. All new texts in English, Nederlands, Deutsch, Español and Français.

### Notes
- An emulated network card's vendor and device ID follow its driver model; pick another model to change them. Overrides of other virtual devices' VID / PID are SolarDeck labels: the emulated chip keeps its native IDs.
- A new camera name applies once no program in the guest holds a camera open (the module reloads then); otherwise at the next module load.
- UDP services are not probed: mDNS is reported from the browse answers and DNS from its TCP listener. A network can only be scanned when the host has an address on it.

## v2.16.0 - Multi-Host Clustering, Live Migration & Active/Passive High Availability — 2026-11-26

### Added
- **Settings → Hypervisor & Runtime → Cluster & High Availability.**
  - **Standalone Host Mode** card (the default on every install) with a readiness list — network address (DHCP flagged), clock synchronization, healthy ZFS pool, SSH keys & certificates — and **Create New Cluster** / **Join Existing Cluster**.
  - **Create** asks for a cluster name and the primary cluster network interface and shows a single-use, one-hour **join token** with **Copy** and a QR code, the cluster address and the certificate fingerprint. Running guests, pools and settings stay as they are. **+ Add Host (Show Join Token)** issues a new one.
  - **Join** pastes the token; the joining host's guests and storage come into the cluster inventory (guest-ID clashes are refused up front) and progress is shown in an *OperationProgressCard*.
  - **Cluster view:** name, coordinator and fingerprint, a quorum badge (*Quorum Healthy · 3/3 Votes*, *2-Node + Witness Active* or *No Quorum*), active hosts and synced HA workloads; a **host grid** (role, CPU / RAM bars, ZFS health, running workloads, clock skew) with **Enter Maintenance (Drain)** / **Exit Maintenance**; an **HA & Active/Passive Workloads** matrix (active host, preferred host, standbys, *Synced 42s ago*, *Auto-Failback*, **Configure HA**, **Switchover Now**); and a **Floating VIPs** card. **Add Quorum Witness** and **Leave Cluster** (typed confirmation) sit in the banner.
- **Live migration:** `POST /api/cluster/workloads/{guest_type}/{guest_id}/migrate` (`target_host`, `online`, `with_local_disks`) with 0–100 % stage progress (precheck, pre-sync, transfer, switchover). Proxmox VE: the migrate API with `online` + `with-local-disks` for VMs and `restart` for containers (`ha-manager migrate` for HA resources), progress parsed from the task log. SolarOS: disks are pre-created on the target (zvols with the same `volsize`, qcow2 with the same virtual size), then `virsh migrate --live --persistent --undefinesource --copy-storage-all`; stopped VMs are copied with ZFS send / rsync; containers move with `incus export` → `incus import`.
- **Compute in cluster mode:** a **host filter pill bar** (*All Hosts* | each host), a host badge (and *HA* badge) on every VM / container, the other hosts' workloads in the same list, **Migrate to Host…** (target picker, *Live Migration (Zero Downtime)* switch, live progress) and an **HA & Failover** tab in the guest drawer.
- **Active/passive high availability** per workload (`GET` / `PUT` / `DELETE /api/cluster/ha/{guest_type}/{guest_id}`, `POST …/switchover`): `preferred_active_host`, `passive_standby_hosts`, `replication_interval_minutes` (1 / 5 / 15 / 60), `failover_timeout_seconds` (10–120, default 15) and `auto_failback`.
  - Proxmox VE: an HA resource, a node-affinity rule (preferred node priority 2, standbys 1, `failback` from the policy) and storage replication jobs (`pvesr`) per standby; failover and fencing are the cluster's own, SolarDeck follows and reports every move.
  - SolarOS: a 3-second heartbeat watchdog. The active host replicates incrementally (`zfs send -i | ssh <standby> zfs receive -F` for zvols, `rsync --inplace` for qcow2 files, domain XML and NVRAM; uncompressed `incus export` for containers). When the active host is gone longer than the timeout and the cluster has quorum, one host promotes the first healthy standby from its latest replica; a host that loses quorum stops its HA workloads itself (no split-brain). Auto-failback live-migrates back after the preferred host has been healthy for 60 s. **Switchover Now** live-migrates and swaps the roles.
  - Failovers, fencing and hosts going offline / online are written to the tamper-evident audit log and sent to the Telegram / Discord / webhook / email alert channels.
- **Quorum witness** for 2-host clusters (`POST` / `DELETE /api/cluster/witness`): `pvecm qdevice setup` (corosync-qdevice installed on every node) with Proxmox VE; with SolarOS any other SolarOS host acts as a lease-based witness that grants its vote to one partition at a time.
- **Host maintenance / drain** (`POST /api/cluster/hosts/{host_id}/maintenance`): marks the host, puts it in HA node maintenance on Proxmox VE and live-migrates every running workload to its HA standby or the host with the most free memory.
- **Clustered virtual switches:** a **Clustered Switch (Sync Across All Hosts)** switch on every switch in the Visual Switch (cluster mode) with a *Synced across N hosts* badge; `PUT /api/network/switch/bridges/{name}/clustered` and `POST /api/network/switch/sync-cluster` create the switch (VLAN-aware, MTU, mode; a NAT switch's gateway address) and its VLANs on every host, then apply and confirm there. Physical ports and host addresses stay per host.
- **Floating cluster VIPs** (`GET` / `POST` / `DELETE /api/cluster/vips`): IPv4 / IPv6 addresses on a clustered switch or VLAN, one keepalived VRRP instance each with the highest priority on the preferred host; keepalived is installed where missing and an existing hand-written `keepalived.conf` is never overwritten. A **Floating VIPs** button in the Visual Switch opens the same card.
- Cluster state lives in `backend/data/cluster_state.json` (`0600`); deploys and updates keep it. Peers authenticate with an HMAC of the cluster secret (30-second window); every member's root SSH key is authorized on every host so any host can run migrations and replication. Migrations, drains, failovers and joins appear in the Task Center.
- Drivers implement the new `cluster_driver()` contract. Global Search and the Help manual find *Cluster & High Availability*, *Live Migration*, *Active/Passive Failover*, *Clustered Virtual Switches* and *Floating Cluster VIPs*. All new texts in English, Nederlands, Deutsch, Español and Français.

### Notes
- Joining a Proxmox VE node that already has guests uses `pvecm add --force`; SolarDeck backs up the node's guest configs, `storage.cfg`, its API user and token and the root `authorized_keys` first and merges them back once the node is quorate (storages only that node had are kept, restricted to it).
- Replication-based failover needs ZFS; without it live migration still works. Containers always move with a restart. On Proxmox VE the cluster's own fencing timing decides the failover moment.
- Peer traffic is authenticated with the cluster secret; the cluster CA and host certificates are issued now (the fingerprint pins the cluster in the join token) for a later mTLS transport.

## v2.15.0 - Multi-Seat Workstations, Physical Port Passthrough & Offline ISO — 2026-11-26

### Added
- **Multi-Seat & Ports studio** in **Compute** (a tab next to *VMs* and *Containers*) and in **Settings → System → Hardware & GPU → Multi-Seat & Ports**: turn one machine into several workstations, one Liquid Glass card per seat plus **+ Create Seat**.
  - Each seat has a name, a target VM (or **Create New Seat VM**, which opens the VM wizard), a *Running* / *Stopped* badge with **Start Seat** / **Stop Seat**, and an *Include in Start All* switch. **Start All Seats** starts every enabled seat one after the other, 3 seconds apart.
  - **Display & GPU Output:** every GPU with its model and PCIe slot, a *Boot GPU* badge for the card the server starts on, *External GPU* for Thunderbolt / USB4 enclosures, its HDMI / DisplayPort connectors (*HDMI-A-1: Connected*, *DP-1: Ready*) and *GPU Audio Included* when the card's HDMI/DP audio function comes along.
  - **Physical USB Ports & Hubs:** ports are bound by physical bus-port path (`1-4`, `3-2.1`), so identical mice or keyboards on different ports go to different seats. **Plug to Assign** starts a 30-second listener (sysfs polled every 250 ms): plug a mouse, keyboard, game controller, audio DAC or USB hub into any port of the server and it is bound to the seat (devices behind a newly plugged hub included). Connected devices can also be picked from a list, and whole USB host controllers can be passed through for hot-plug and full bandwidth.
  - **CPU Core Pinning:** a core-pair map (a physical core with its SMT / Hyper-Threading sibling); cores of other seats are greyed out and the server's own first core(s) are locked. **Auto-Balance Cores Across Seats** hands every enabled seat an equal, non-overlapping share of whole cores.
- **Automatic boot-GPU release:** before a seat whose GPU is the boot GPU starts, SolarDeck unbinds the virtual consoles and the firmware framebuffer (`efi-framebuffer` / `simple-framebuffer`) and binds the GPU and its audio function to `vfio-pci`, so every GPU in the machine can drive a desk. The server's console screen switches off while that seat runs.
- **External GPUs:** new Thunderbolt / USB4 devices are listed with an **Authorize** button (`boltctl enroll` when installed, otherwise the kernel's authorization switch, then a PCI rescan). Authorizing asks to confirm your identity and is recorded in the audit log.
- New endpoints: `GET /api/multiseat/topology`, `GET` / `POST /api/multiseat/seats`, `PUT` / `DELETE /api/multiseat/seats/{seat_id}`, `POST /api/multiseat/seats/{seat_id}/start`, `POST …/stop`, `POST /api/multiseat/seats/start-all`, `POST /api/multiseat/seats/auto-balance`, `POST /api/multiseat/usb/listen`, `GET /api/multiseat/usb/listen/{session_id}` and `POST /api/multiseat/egpu/authorize`. Seats persist in `backend/data/multiseat.json`; deploys and updates keep it.
- Both drivers implement the new `seat_driver()` contract: `hostpciN` (GPU with `x-vga`), `usbN host=<bus-port>` and CPU `affinity` with Proxmox VE; aliased libvirt `<hostdev>` elements (USB ports resolved to the plugged-in device at every save and start, `startupPolicy="optional"`) and `<vcpu cpuset>` with SolarOS. Your own passthrough devices on the VM are left alone.
- **100% offline SolarOS ISO:** `build-iso.sh` resolves the complete `.deb` closure of the kernel, both boot loaders (UEFI and BIOS) and every package SolarOS uses inside the ISO's own minimal root file system (any Linux build host, no container runtime needed) and ships it as a signed APT repository in place of the ISO's own package archive (`dists/` + `pool/`, the archive the installer always uses), with a one-time signing key per build that is also baked into the installed image. The SolarDeck bundle (source, prebuilt desktop, Python wheels) becomes `solardeck-bundle.tar.gz`. `--no-offline-repo` builds the smaller online ISO.
  - The autoinstall uses that archive as its only mirror (updates / backports / security suites, geoip, drivers, codecs, OEM and installer refresh off) and treats Ethernet as optional, so it installs on air-gapped machines without a cable or DHCP server. `late-commands` copy the repository and the bundle to `/opt/solardeck-offline`.
  - First boot points APT at `/opt/solardeck-offline/repo` (`solardeck-offline.list`) and enables the Ubuntu mirrors in `ubuntu.sources` only when they can be reached (`Enabled: no` otherwise; flip it once the server is online).
  - `test-in-proxmox-vm.sh --offline` creates the test VM with its network link down, to prove an install needs no internet.
- `bolt` is installed on SolarOS hosts (Thunderbolt / USB4 enrollment). Global Search and the Help manual find the studio. All new texts in English, Nederlands, Deutsch, Español and Français.

### Notes
- Seats need IOMMU (VT-d / AMD-Vi) switched on in the BIOS; the studio says so when it is off. A seat's GPU should sit in its own IOMMU group (the GPU list warns otherwise).
- On SolarOS a USB device that is replugged while its seat runs comes back at the next seat start (libvirt addresses USB devices by bus and device number); Proxmox VE follows the port live.
- The offline ISO is larger (about 2.8 GB) because it carries the kernel, firmware and every package.

## v2.14.0 - Virtual Hardware, Retro Throttling & Isolated Lab Forge — 2026-11-26

### Added
- **Virtual Hardware & Lab tab** in every VM and container drawer in **Compute**: attached virtual devices with icon, bus (*PCIe*, *USB*, *Serial*, *ISA*, *Virtual*), a *Universal Inbox Driver* badge, a status dot, **Configure** and **Remove**, and a *Power cycle to change* badge on VM devices that cannot be hot-plugged.
- **+ Add Virtual Device** with categorized device cards and plain-English descriptions:
  - *Audio & Voice:* **HD Audio Card + Microphone** (VMs: `ich9-intel-hda` with a duplex codec; containers: a virtual ALSA loopback card, never the host's own sound card) and **Retro Sound Card** (AC97 or ISA SB16, VMs; SB16 needs the i440fx machine type).
  - *Video & Capture:* **Virtual Webcam / Capture Feed** for containers: a `v4l2loopback` device (`/dev/video40`–`47`) fed by a managed `ffmpeg` service from a test pattern, an RTSP camera, a looping video file or another VM's screen.
  - *Storage Controllers:* **SAS / RAID HBA** (`megasas`, `mptsas1068`, `lsi53c895a`) and a **Virtual NVMe Drive** with its own sparse disk image and serial number (removing it deletes the image).
  - *Communication & Legacy:* **Virtual 56k Modem**: a COM port with a built-in Hayes AT-command emulator (`ATZ`, `ATI`, `ATDT host:port`, `CONNECT 56000`, `+++`, `ATH`) that dials over TCP/IP; VMs get a serial socket served by a host service, containers get `/dev/ttyS0` from a service inside the container (needs `python3` there). **Retro 10/100 Mbps Ethernet** adds an NE2000 (`ne2k_pci`), PCnet, RTL8139 or E1000 network card on a chosen switch.
  - *Security & Reliability:* **Virtual TPM 2.0**, **USB SmartCard Reader** (USB CCID), **Hardware Watchdog** (`i6300esb`: reset, shut down, power off or pause) and **Hardware Entropy** (`virtio-rng` from `/dev/urandom`).
- **Retro & WAN Throttling** card: a **CPU Speed Limiter** (5–100 % of the guest's vCPUs) with CPU architecture presets (*Modern Host*, *Standard 64-bit*, *Retro Pentium*, *Retro 486*, VMs), and a per-NIC **Network Link Speed & Latency Simulator**: *Native*, *100 Mbps*, *10 Mbps*, *56k Modem* (120 ms), *4G Mobile* (25 Mbps, 45 ms, 10 ms jitter) or *Custom* bandwidth, latency, jitter and packet loss. Shaping uses `tc` + `netem` on the guest's host-side interface (download shaped, upload policed), applies to a running guest at once and is re-applied within ~20 s after every guest start.
- **Isolated Lab Sandbox** in **Compute** and **Settings → Network & Virtual Switch → Isolated Labs**: name a lab (*Retro Gaming LAN*, *Firewall & Router Test Lab*, …), pick a private subnet, DHCP range and optional VLAN ID, tick the VMs and containers to isolate and press **Launch lab**. SolarDeck adds a virtual switch without physical ports, a lab VLAN record with its own DHCP server, moves each guest's first network card onto it (containers switch to DHCP) and loads an *Air-Gapped · Zero LAN Leak* firewall: nothing is routed in or out, and lab guests reach only each other and the lab's DHCP server. **Tear down** puts every guest back on its previous network and removes the switch, VLAN and DHCP server.
- New endpoints: `GET /api/virtual-hardware/catalog` (public, static), `GET /api/virtual-hardware/{vm|lxc}/{id}`, `POST …/devices`, `DELETE …/devices/{device_id}`, `PUT …/throttling`, and `GET` / `POST /api/virtual-hardware/labs/sandbox`, `DELETE /api/virtual-hardware/labs/sandbox/{lab_id}`. Profiles persist in `backend/data/virtual_hardware.json`, labs in `backend/data/isolated_labs.json`; deploys and updates keep both.
- Both drivers implement the new `vhw_driver()` contract: VM options and tagged emulator arguments with Proxmox VE, libvirt domain devices (user aliases) and Incus devices with SolarOS.
- Global Search and the Help manual find the tab and the lab sandbox. All new texts in English, Nederlands, Deutsch, Español and Français.

### Notes
- The virtual webcam needs `ffmpeg` and the `v4l2loopback` kernel module on the host, the SolarOS TPM needs `swtpm`, and labs need `dnsmasq`; SolarDeck says so with the install command when one is missing. VMs get the webcam feed only through USB passthrough of a real capture device.
- Removing a virtual TPM keeps its state volume as an unused disk of the VM, so encryption keys are never destroyed by accident.

## v2.13.0 - Multi-Instance Naming & App Uninstaller — 2026-11-26

### Added
- **Configure Instance dialog (App Center):** *Install another* (or *Custom name* on a first install) asks for an instance label first. It is pre-filled with the next free *Instance N*, so **Install** works straight away. Preset chips (*Production*, *Dev*, *Staging*, *Testing*, *Lab*, *Backup*) fill it in one click, and a live preview shows the display name (*Docker & Portainer CE — Dev*) and the container hostname (`docker-portainer-dev`). *Advanced options…* opens the full install drawer with the label kept.
- **Uninstall from App Center:** installed cards show *Installed* or *N Instances* plus **Install another** and **Uninstall** (one instance) or **Manage** (two or more). **Manage** lists every instance with its label, container ID, IP address, status dot, **Open** and its own **Uninstall**.
- **Uninstall confirmation:** shows the instance name, container ID and IP address, with an *Also delete persistent app data & volumes* switch (off by default; data in `/mnt/storage/apps/<instance_id>` is kept). Removal runs as a tracked job with a live progress card and shows up in **Notifications → Task Center**: stop container 15%, remove container + virtual NICs 45%, clean up routes + metadata 75%, storage retention 90%, removed 100%.
- **Settings → Hypervisor & Runtime → Installed Apps & Instances:** every instance grouped by app, with label, container ID, IP address, status, **Open App** and **Uninstall**. Global Search and the Help manual find it. An uninstall from Settings refreshes App Center straight away.
- **Instance registry** `backend/data/installed_apps.json` (`instance_id`, `app_id`, `app_name`, `instance_label`, `display_name`, `guest_id`, `ip_address`, `web_url`, `created_at`). It is reconciled against the live containers of the active driver: earlier installs are adopted automatically, and guests deleted elsewhere drop out. Nothing is pruned while the hypervisor is unreachable. Deploys and updates preserve the file.
- New endpoints: `GET /api/apps/instances`, `DELETE /api/apps/instances/{instance_id}?delete_data=false` and `POST /api/apps/{app_id}/install`. Install requests accept `instance_label`; the hostname is derived from it when left empty. Install responses add `instance_id`, `display_name` and `job_id`. `GET /api/system/tasks?kind=uninstall` and `GET /api/tasks/uninstall-<id>` report removal progress.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Fixed
- App Center card titles (such as *Local AI Studio*) are no longer truncated next to the *Featured* / *Installed* pills: the title has its own line, and the pills wrap below it.
- SolarOS: the host-wide guest list used by automation rules, the network switch and global search now includes containers and VMs (it was empty).
- Uninstalling Local AI Studio clears its state, so the Local AI app shows the install screen again.

## v2.12.0 - Zero-Flicker Bitmap Wallpaper & Universal Progress Bars — 2026-11-26

### Added
- **Operation progress cards:** one Liquid Glass progress card for every long-running job: title and status badge (*Running*, *Completed*, *Failed*), an animated 0–100% bar with a bold percentage, the current step with a *Step 3 of 5* counter, a 4-line log tail that expands to the full log with one click, and **Retry** / **Dismiss** when a job fails.
  - **Settings → System → Hardware & GPU:** Intel media / Quick Sync, NVIDIA driver + CUDA toolkit and AMD tool installs, and switches to or from vfio-pci passthrough mode, show the card instead of a raw log. The GPU badges refresh when the job reaches 100%; **Retry** reopens the same confirmation.
  - **App Center:** the install drawer and the app's card (grid and list view) show live progress; the catalog reloads at 100%, so the new container shows as installed. The host task log stays available under *Host task log*.
  - **Settings → System → Software & Repositories → OS Updates:** *Check for updates* and *Upgrade all* show their progress, parsed from the apt output.
  - **Notifications → Task Center:** progress cards for all running (and, for 10 minutes, finished) GPU, App Center, OS update and AI model jobs above the host task list; running backups show their percentage when the backup log reports one. Running jobs count towards the Task Center badge.
- **Unified job progress API** (`backend/app/task_progress.py`): every job reports `job_id`, `status` (`running` / `completed` / `failed`), `progress_percent`, `current_stage`, `stages[]`, `logs[]` and `error_message`, with weighted stages:
  - GPU: hardware check 10%, repositories 30%, drivers + container toolkit 60%, initramfs 85%, verification (nvidia-smi / render node) 95%, done 100%.
  - App Center: validation 10%, template download 30%, container provisioning + GPU / storage mounts 55%, application install 80%, health check + registration 95%, ready 100%.
  - OS updates: package lists 15%, downloads 45%, unpack + configure 75%, clean-up 95%, up to date 100%.
- New endpoints: `GET /api/system/tasks` (optional `?kind=gpu|app|os|ai`), `GET /api/tasks/{job_id}`, `GET /api/apps/jobs/{vmid}`, `GET /api/hardware/gpu-drivers/jobs/{job}` and `POST /api/system/os-updates/apply` (same as `POST /api/system/upgrade`). `GET /api/apps/deployments/{vmid}` and `GET /api/system/upgrade` now include `progress`.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Fixed
- **Desktop flicker, for good:** the wallpaper (theme art or custom image, blur and dimming) is painted once into an off-screen canvas and shown as one cached bitmap (`Blob` object URL in a single `<img>`), re-rendered only when a wallpaper setting or the window size changes. No live SVG filters or gradients stay mounted next to the 1 s telemetry widgets; old bitmaps are released on every change. Until the first bitmap is ready (or if a custom image cannot be read), the previous live layer is shown.
- The wallpaper layer is fixed under everything (`position: fixed; inset: 0; z-index: 0; pointer-events: none; contain: strict`), and `html`, `body` and the app root use the theme's base color, so a compositor tile dropped on a large display shows that color instead of a white or black flash.
- Glass cards inside an already blurred window or dialog no longer add a second backdrop blur.
- **GPU driver installs no longer fail at the very end:** after the drivers and container toolkit are installed, a warning from `update-initramfs` or `lsinitramfs` is reported in the log instead of failing the job. The initramfs check now reads the running kernel's image (`/boot/initrd.img-$(uname -r)`). A vfio-pci mode switch still fails when the initramfs cannot be rebuilt, because that rebuild is the change itself.
- **NVIDIA driver updates no longer abort after the installer's initramfs scan:** the official installer refuses to continue while an older `nvidia` module is loaded. The install now skips the installer when the latest driver already runs, otherwise stops `nvidia-persistenced` and unloads the old modules first; when a guest still uses the GPU it stops with a clear message (stop the guests that use the GPU, such as Local AI Studio, then install again) instead of the installer's abort.

## v2.11.0 - Themed Generative Wallpapers, Server-Name Branding & Flicker-Free Desktop — 2026-11-26

### Added
- **Wallpaper Studio** card in **Settings → System → General & Appearance**, below the wallpaper card: theme picker, the theme's 4 wallpaper variants and a live preview that shows the real server name.
- **Brand Watermark Overlay:** a glass badge on the desktop wallpaper with the glowing sun mark and the product name (*SolarDeck* or *SolarOS*). Choose **None** (default), **Logo + product name** or **Logo + server name**; the personalized badge adds *Running on <node>* (SolarDeck for Proxmox VE, the Proxmox VE node name) or *SolarOS [<host name>]*. Position (centered, bottom right, bottom center), opacity (10–100%) and size (50–200%) are adjustable. The badge follows the theme's font and Light / Dark Mode and stays off the lock screen.
- **Download as SVG:** `POST /api/system/themes/wallpapers/generate` draws a 1920×1080 vector wallpaper in the theme's colors (built-in and custom themes) in one of 4 styles (minimal glow, abstract orbs, cinematic laser grid, ambient contour lines) with the badge, logo, drop shadow and optional blur drawn in. Results are cached per setting; the response is served with a sandboxing Content-Security-Policy.
- `GET /api/system/branding/info` returns `hostname`, `display_host`, `platform_label`, `brand_mode` (`solardeck` / `solaros`) and, with `HYPERVISOR_DRIVER=proxmox`, `pve_node`.
- New `theme` preferences, validated by the backend with defaults for older clients: `brandOverlay`, `brandPosition`, `brandOpacityPct` and `brandSizePct`.
- Global Search and the Help manual find the card as *Wallpaper Studio*.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Fixed
- **Desktop flicker:** the wallpaper is a memoized layer on its own GPU compositing layer (`translate3d`, `backface-visibility: hidden`, `contain: strict`) that only follows the wallpaper settings (theme, light / dark mode, wallpaper pick or custom image, blur, dimming), so live CPU, memory, GPU, storage, network and clock updates never repaint it.
- Theme tokens are only written to the page when their value actually changes, so unrelated preference saves no longer invalidate every glass surface.
- Glass surfaces (desktop, Dock, App Gallery, dialogs, cards, window snap preview) no longer use catch-all transitions that also animated the backdrop blur; they transition only color, border, shadow, transform and opacity, so the blur stays cached.
- The desktop and its widgets subscribe only to the fields they show: tray, panel and widget-store changes no longer re-render the whole desktop.

### Changed
- **Smooth icon dragging everywhere:** the Dock, the bottom taskbar, the top bar / taskbar tray, the App Gallery, desktop shortcuts, the **Top Bar & Taskbar Tray** list in Settings and the Widget Studio list use one pointer-based reorder engine instead of browser drag-and-drop:
  - a drag only starts after the pointer moves 6 px, so a click still opens the app or flips the switch right away;
  - the dragged icon follows the pointer smoothly (slightly enlarged) while its neighbours glide aside, with no ghost image and no layout jumps;
  - places swap only when the icon passes the middle of a neighbour, with a short lock against back-and-forth jitter;
  - the new order is saved once, when you let go.
- Dock magnification pauses while you drag, so icons keep a fixed size and position.
- Desktop shortcuts can be rearranged by dragging (grid and list view). The order is saved in the new `layout.desktopIconOrder` preference and syncs across browsers.
- Widget Studio cards can be dragged into a new order. Move Up / Move Down stay available as the keyboard fallback, here and in the tray list.

## v2.10.1 - Overflow Chevron Next to View Settings — 2026-11-25

### Changed
- The tray's overflow chevron now sits directly left of the **View Settings** icon: in the top bar (`floating-dock` layout) between the tray icons and View Settings, and in the bottom taskbar between the tray icons and View Settings, next to the clock. The chevron stays left of View Settings when the clock is moved to the left of the tray.

## v2.10.0 - Compact Customizable Top Bar & Taskbar Tray, Search Tip — 2026-11-25

### Added
- **Customizable tray:** the status and quick-action icons (CPU, memory, storage health, Host Shell, App Gallery, language, light / dark mode, theme, help, updates, notifications) can be reordered by dragging them on the bar or in Settings, hidden one by one, and limited to 2–12 icons on the bar. The rest move behind an overflow chevron: **▾** in the `floating-dock` top bar, **▴** in the `bottom-taskbar` tray. Its popover shows the extra icons and a **Customize Bar... / Customize Taskbar...** link.
- **Top Bar & Taskbar Tray card** in **Settings → System → General & Appearance**, right below Desktop Layout: bar layout mode, a **Max visible tray icons** slider with a live preview of what sits on the bar and what goes behind the chevron, the drag-and-drop item list with a show / hide switch and move up / down buttons per item, the clock position for the bottom taskbar (right or left of the tray) and **Reset Search Tip Balloon**. Global Search finds it as *Top Bar & Taskbar Tray*.
- **Customize Bar & Tray...** shortcut in the right-click menu of the top bar, the taskbar and the Dock, and in the View Options popover; it opens the card and highlights it.
- **"Type to begin" tip:** a Liquid Glass balloon under the TopBar search field (*Search apps, settings, VLANs, storage & support guides (⌘K)*) with **Don't show me again** and **Got it**. It closes when the search field is used; with *Don't show me again* checked it stays away on every device.
- New `layout` preferences in `/api/system/preferences`, validated by the backend with defaults for older clients: `trayItemOrder`, `hiddenTrayItems`, `maxVisibleTrayItems` (2–12, default 6), `taskbarClockSide` (`right` / `left`) and `hideSearchIntroBalloon`.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Changed
- **Notifications and Task Center share the bell:** the separate Task Center icon is gone; the bell popover has **Notifications** and **Task Center** tabs. The bell shows the unread count and a pulsing dot while background tasks (scrubs, downloads, backups, updates) run; task progress and live logs stay in the Task Center tab.
- Tighter spacing in the top bar and the taskbar tray, and a wider TopBar search field (up to 2xl) so long queries stay readable.

### Fixed
- The documentation generator's update fixture now includes the update log, so the Software Updates screenshot renders again.

## v2.9.1 - Update Test Release — 2026-11-25

### Changed
- Maintenance release with no functional changes. Install it from **Settings → Software & Repositories → SolarDeck Updates** to see the Update Progress card, the Update Ready badge and the automatic reload in action.

## v2.9.0 - Live Update Progress, Automatic Reload & Update Schedule — 2026-11-25

### Added
- **Live update progress:** Settings → Software & Repositories → SolarDeck Updates shows an **Update Progress** card while an update runs: an animated progress bar with the percentage, the current step (backup 5%, fetching release tags 20%, checkout 40%, Python backend dependencies 60%, frontend build 80%, service restart 92%, done 100%), the elapsed time and the live, auto-scrolling log.
- **Automatic reload:** at 100% the card shows *Update installed (100%) — Reloading interface...* and the page reloads itself after 2 seconds, so the new version appears without a manual refresh. Polling every 1.5 seconds rides out the short 502 / network gap while the backend restarts.
- **Clear failures:** a failed step keeps its percentage and shows the failing step, the error and the full log, with a **Dismiss** button (`POST /api/system/updates/acknowledge`). A finished update clears itself after 2 minutes.
- **Automatic Updates & Schedule card:** choose **Manual Updates** (default) or **Automatic Scheduled Updates** daily, weekly or monthly at a set time (at most once per day), with background checks every 1, 6, 12 or 24 hours and, on a standalone SolarOS host, optional OS security packages. The card shows the next check and the next scheduled install. API: `GET / PUT /api/system/updates/schedule`.
- **Update Ready badge:** background checks show *Update Ready: <version>* in the top bar in the floating-dock layout, or in the taskbar tray in the bottom-taskbar layout (never both), and *Updating NN%* while an update runs. It opens SolarDeck Updates directly.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Changed
- The update runner writes its stage to `/run/<prefix>-update-progress.json` (the backend's own `/tmp` is private), so the progress survives the backend restart. Without `systemd-run` the runner starts in its own session instead.
- `GET /api/system/updates/status` also returns `update_status`, `progress_percent`, `current_stage`, `logs`, `current_version`, `latest_version` and `last_checked`.
- Earlier *Manual Only / Notify Me / Automatic Updates* choices carry over to the new schedule; `PUT /api/system/updates/settings` is replaced by `PUT /api/system/updates/schedule`.

## v2.8.0 - Global Desktop Search & Illustrated Manual — 2026-11-25

### Added
- **Global Search in the TopBar:** a Liquid Glass search field in the middle of the TopBar (`Search apps, settings, VLANs, ZFS, support...`) that expands into a results panel as you type. Open it with ⌘K / Ctrl+K, or `/` when you are not typing in a field; ↑ ↓ Enter and Esc work as usual. Results always come in seven groups, in this order, each with a match count: **Apps**, **Settings — Main Categories**, **Settings — Sub-Modules**, **Settings — Sub-Sub-Modules & Controls** (with the breadcrumb `Settings › Category › Sub-Module › Control`), **Support — Main Titles**, **Support — Subtitles** and **Support — Help Content** (with the matched words highlighted in a snippet). Live virtual machines, containers, pools, shares and quick actions follow below. The taskbar layout shows the same results in a centered panel.
- **Deep links with a highlight:** a Settings category result scrolls the Settings hub to that category; a sub-module opens it; a sub-sub-module opens its sub-module on the right tab, scrolls to the card and pulses it with a 2-second accent ring. A help result opens the article, scrolls to the section and highlights the search words.
- **Help & Support › Manual:** a two-pane documentation viewer with a collapsible category tree (Apps and the five Settings categories) and an instant filter on the left, and the article on the right: screenshots, numbered steps, tips and an **Open This Setting / App** button that jumps to the live screen. There is an article for every app, Settings category, sub-module and sub-sub-module.
- **One knowledge registry** (`frontend/src/data/knowledgeRegistry.ts`) feeds the search, the Manual and the documentation in the repository, so the three always match. Apps, categories and sub-modules come from the existing app and Settings registries.
- **Illustrated documentation:** `node scripts/generate-support-docs.mjs` starts the dev server, opens it in headless Chromium (1440×900, dark mode, 2× scale) with demo data, captures the desktop, the App Gallery, Global Search, every app, the Settings hub, every category, sub-module and major screen, and writes `docs/README.md`, `docs/apps.md` and `docs/settings-*.md`. The pictures ship with the web interface (`frontend/public/docs/screenshots/`) so the Manual works offline.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Fixed
- Links that open a Settings sub-module directly (the CPU, memory, storage and update pills in the TopBar, retired app shortcuts) opened the Settings hub instead of the sub-module.

## v2.7.1 - Settings Without Duplicates — 2026-11-25

### Fixed
- Several Settings sub-modules showed a whole app with every tab, so the same screens appeared in two or three places. Network Topology no longer contains DNS, DHCP, WireGuard, Router & NAT, Domains and Certificates; WireGuard VPN now shows only the WireGuard server and client; Firewall & Port Forwarding shows only the firewall rules and port forwarding; Users & Roles no longer contains the firewall and host logs, and Audit & System Logs shows only the audit log and host logs. Local AI Runtime shows only GPU assignment and model storage (chat and the model library stay in the Local AI app). A link to another screen (for example the map's WireGuard button) opens the sub-module that owns it.
- The Resource Monitor's live GPU tab is called **GPU & Sensors**, so it is no longer confused with Hardware & GPU.

### Changed
- New sub-modules under **Network & Services**: **DNS, AdBlock & DHCP** and **Domains & Certificates** (they were only reachable inside Network Topology before). Old links to those screens open them.
- **Automation & Alerts** and **System Services** moved to **System**.

## v2.7.0 - Visual Virtual Switch, Drag-and-Drop VLANs, Virtual NICs & Per-VLAN DHCP — 2026-11-25

### Added
- **Visual Switch** in Settings → Network & Services → Network & Virtual Switch (the previous host interface view is the **Host Interfaces** tab next to it). Every virtual switch renders as a rack faceplate with its IP address, a **VLAN-Aware** badge, **Edit IP / Switch** and **+ Add Virtual NIC**; physical ports on the left, VM, container and host virtual ports on the right. Each port jack has a link LED with speed badge, a ring in its VLAN color (striped for a trunk) and a readable label such as `Port 1 · enp3s0 (Uplink)` or `VM 101 · lab (net0)`.
- **Drag-and-drop VLAN patch panel:** color-coded VLAN cards (with templates and a color picker), a **Trunk Port · Carry Multiple VLANs** zone, an **Unplug** zone and animated patch cables from every port to its VLANs. Clicking a port opens a Port Inspector that explains access and trunk ports in plain words and offers the same actions. All of it goes through one endpoint, `POST /api/network/switch/assign-port`, which makes the switch VLAN-aware when needed and sets the port's untagged / tagged VLANs or the guest NIC's VLAN tag and trunks.
- **Virtual switches and IP settings:** create, edit and delete switches (bridged, NAT or isolated; VLAN-aware; MTU; autostart; member ports) and set static / DHCP addresses, gateway, IPv6, DNS, MTU and autostart on switches, ports and VLAN interfaces. The default switch and the one carrying the host's gateway cannot be deleted.
- **Virtual NICs:** add, edit and remove guest network cards (switch, VLAN tag, trunk VLANs, adapter model, MAC, bandwidth limit, cable plugged / unplugged) and host VLAN interfaces or dummy NICs.
- **60-second rollback guard:** host network edits are staged first (an **Apply safely** bar). Applying snapshots the network configuration, reloads it from a transient unit on the host and arms a host-side 60-second timer; the banner counts down with **Keep Settings** and **Revert Now**. Without a confirmation the previous configuration comes back by itself, so a wrong address cannot lock you out.
- **DHCP server per VLAN:** one switch per VLAN card runs an isolated DHCP server (DHCP only, bound to `<switch>.<vlan>`), creating the VLAN's gateway interface when it is missing. Gateway, subnet, range (with a visual range bar), DNS servers, lease time and static reservations; live leases with **Pin Static IP**. Offers to install the DHCP server software when it is missing (the system-wide instance stays disabled).
- API: `GET /api/network/switch/state`, `POST|PUT|DELETE /api/network/switch/bridges[/{name}]`, `PUT /api/network/switch/interfaces/{name}`, `POST /api/network/switch/{apply|confirm|revert|discard}`, `POST|DELETE /api/network/switch/vnics/host[/{name}]`, `POST|PUT|DELETE /api/network/switch/vnics/guest[/{type}/{id}/{net}]`, `POST|PUT|DELETE /api/network/switch/vlans[/{id}]`, `POST /api/network/switch/assign-port`, `PUT /api/network/switch/vlans/{id}/dhcp`, `GET /api/network/switch/vlans/{id}/leases`. Network applies and DHCP changes are recorded in the audit log.
- All new texts in English, Nederlands, Deutsch, Español and Français.

### Changed
- Guest network cards understand trunk VLANs and the unplugged-cable state on both editions where the platform supports them (VM trunks and VLAN tags on SolarOS still need a VLAN bridge; containers take both).

### Notes
- On SolarDeck for Proxmox VE the switch edits `/etc/network/interfaces` (options it does not manage are kept) and reloads with `ifreload -a`. On SolarOS it writes the merged Netplan configuration to SolarOS's own Netplan file (other Netplan files are parked, and restored by a rollback) and applies the port VLAN settings Netplan cannot express from a small boot-time service.

## v2.6.1 - SolarOS Release Branch Fix — 2026-11-25

### Fixed
- The v2.6.0 release check stopped because two shared files used terms of the Proxmox VE edition (a bridge name in the Network & Virtual Switch description and a service name in a self-check), so the SolarOS release branch was not published. Both are edition-neutral now; no behavior changes.

## v2.6.0 - Unified Settings Hub & a Clean App Gallery — 2026-11-25

### Added
- **Settings**, one app for every built-in administration tool. The landing view shows a host summary (hostname, platform, CPU, memory, release), a live **Filter settings & sub-modules** field (Enter opens the first match) and the EN / NL / DE / ES / FR language switch, then five category rows with their sub-module tiles:
  - **System:** General & Appearance, Hardware & GPU, BIOS & Firmware, Resource Monitor, Software & Repositories (SolarDeck updates and rollback, bug reports, OS repositories and OS updates), Host & Power.
  - **Storage & Data:** Storage & ZFS Pools, Backup & Restore, Shared Folders & SMB, ISO & Template Library.
  - **Privilege & Security:** Users & Roles, Security & 2FA, Security Posture & Hardening, Audit & System Logs (audit log and host logs).
  - **Network & Services:** Network & Virtual Switch, Network Topology, Firewall & Port Forwarding, WireGuard VPN, Automation & Alerts.
  - **Hypervisor & Runtime:** Hypervisor Defaults, Local AI Runtime, System Services.
  A sub-module opens in place with a breadcrumb (`← All Settings / Category / Sub-Module`), a **? Guide** button and a collapsible category sidebar. Every sub-module reuses the existing panels, so no screen or API call was dropped. Storage pool health and SolarDeck updates show a status dot on their tile.
- **Hypervisor Defaults:** default cores / memory / disk for new VMs and containers, a preferred storage target and container nesting, used by the New VM / New Container wizards and synced under `hypervisor` in `/api/system/preferences`. Shows the host's nested-virtualization status (`GET /api/system/nested-virt`).
- **System Services:** systemd services on the host with filter and start / stop / restart (`GET /api/system/services`, `POST /api/system/services/{unit}/{start|stop|restart}`; step-up confirmation, recorded in the audit log).
- An **Update available** badge in the top bar and taskbar.
- Settings sub-modules are searchable in Spotlight, and a Settings guide.

### Changed
- The App Gallery, launcher and desktop icons list Settings, Compute Manager, File Station, App Center, Terminal (the Host Shell), Local AI and Help & Support. Control Panel, System, Storage & ZFS, Backup Center, Network & Services, Network Shares, Resource Monitor and Datacenter are no longer separate apps.
- The default Dock / taskbar holds Settings, Compute, Files, App Center and Terminal. A saved Dock or App Gallery order is migrated once: the retired admin apps become one Settings entry in their place.
- Every old link still works: opening a retired app or one of its deep links (for example `storage → pools`, `controlpanel → power`, `netservices → wg`, `help → bios`) opens Settings at the matching sub-module.
- The CPU and memory pills open Resource Monitor, the pool pill opens Storage & ZFS Pools and Desktop **Edit Widgets** opens General & Appearance.
- Host & Power gained a host console shell button; SolarDeck updates and Report a Bug moved to Software & Repositories.

## v2.5.1 - Security Score: Correct Host Checks — 2026-11-25

### Fixed
- The security score reported "Automatic security updates" as missing even when they were on (and could miss an nftables default-deny firewall). The host check stopped reading early, which its strict error mode counted as a failure. Found while install-testing the v2.5.0 ISO; the fix was verified on a fresh SolarOS install.

## v2.5.0 - Phase 21: Security by Design — TOTP 2FA, Step-Up Auth, Encrypted Vault, Hash-Chained Audit Log, Security Posture Center & SolarOS Host Hardening — 2026-11-25

### Added
- **Two-factor sign-in, done properly:** enrollment shows a QR code plus 8 single-use recovery codes (stored hashed). With 2FA on, `POST /api/auth/login` returns `{"requires_2fa": true, "challenge_token": …}` and `POST /api/auth/login/2fa` finishes the sign-in with a 6-digit code or a recovery code. The sign-in screen switches to a code field with a "Use a recovery code" option. Turning 2FA off needs the password and a code.
- **Active sessions:** every sign-in gets a session id (device, address, signed-in and last-seen time) in `backend/data/sessions.json`. Control Panel lists them with **Revoke** and **Revoke All Other Sessions**; a revoked token stops working at once. Unlocking the screen replaces the session instead of adding one, and a password change signs out every other device.
- **Brute-force protection:** 5 failed sign-ins (or 2FA codes) within 10 minutes lock the address out for 1 minute, doubling up to an hour, with HTTP 429 and `Retry-After`. Survives restarts.
- **Step-up confirmation** (`POST /api/auth/step-up`, header `X-Step-Up-Token`, 5 minutes, bound to the session) for disk wipes, pool and dataset destruction, mirror member offline/detach, VM and container deletion, GPU driver and passthrough switching, firewall rule and option changes, host hardening and opening a root host shell. A dialog asks for the password or a 2FA code and the action continues by itself.
- **Encrypted secrets at rest:** Telegram bot token, Discord webhook URL, webhook bearer token, SMTP password and the TOTP secret are encrypted with a machine-local Fernet key (`backend/data/.vault.key`, `0600`). Existing plaintext files keep working and are encrypted on their next save.
- **Tamper-evident audit log** (`backend/data/audit_log.jsonl`): sign-ins and failures, lockouts, 2FA changes, session revocations, step-up confirmations, guest create/delete, ZFS pool/dataset/member changes, disk wipes, firewall edits, updates, GPU driver changes, password changes, host hardening and host shells. Each entry is hash-chained; `GET /api/security/audit-log/verify` and the **Verify Hash Chain** button report the first broken line. Filter, search and export as JSON or CSV.
- **Security Posture Center** (`GET /api/security/posture`, `POST /api/security/harden`): a 0–100 score over 8 weighted checks (strong password, 2FA, HTTPS, key-only SSH, default-deny firewall, kernel hardening, automatic security updates, audit chain) with **Apply Recommended Hardening** and per-check fixes that run as a host job with a live log.
- **Host hardening script** `deploy/host-hardening.sh` (check / apply): sysctl hardening, SSH hardening (key-only only once a person's key is authorized; root by key only), ufw default-deny incoming (80/443 tcp, 51820 udp, rate-limited 22 tcp, shares, DNS/DHCP when in use, guest NAT bridges), AppArmor and `unattended-upgrades`. The SolarOS installer and first boot apply it. On Proxmox VE the platform's own firewall is checked instead, and ufw is never added.
- **SolarOS console [7] Security & SSH Lock-Down:** block or allow SSH from the network (the local bridge for the Host Shell keeps working), firewall status and recent failed SSH and web sign-ins.
- A **Security Hardening & Two-Factor Sign-In** guide, and the new texts in all five languages.

### Changed
- Control Panel → User & Security is now **Security & Hardening**.
- nginx sends `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and a Content-Security-Policy on every response (including assets), and `server_tokens off`.
- The container edition's backend service runs with `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=true` and `ProtectHome=read-only` (only `/root/.acme.sh` stays writable, for certificates; acme.sh is installed without editing `~/.bashrc`); `/etc` stays writable because Network Shares create Samba users there. The SolarOS backend gets `PrivateTmp=yes`: it is the host's management layer (Netplan, users, packages), which the stricter options would block. Both keep `.env` and the SSH key at `0600` on every start.
- The updater copies itself to `/run` instead of `/tmp` (the backend's `/tmp` is now private).
- Installers, `deploy.sh` and the ISO builder never copy the vault key, sessions, sign-in limiter or audit log.

### Upgrade notes
- Everyone is signed out once after this update (sessions are tracked now).
- SSH password sign-in on SolarOS stays on until someone authorizes an SSH key; then apply the SSH fix from the security score.

## v2.4.4 - Updates Follow the Configured Branch — 2026-11-25

### Fixed
- Updates followed whatever branch the installation's checkout was on, not the configured release branch (`REPO_BRANCH` in `backend/.env`). An installation left on an old test branch therefore "updated" to that branch's outdated code. Updates now always use `REPO_BRANCH` (`main` for SolarDeck for Proxmox VE, `solaros` for SolarOS).

## v2.4.3 - SolarOS Name in the Control Panel — 2026-11-25

### Changed
- On SolarOS, the Control Panel now says "SolarOS" where it said "SolarDeck": the version and update card ("SolarOS Version"), update preferences, version history, the host bridge note and the power and bug report texts. SolarDeck for Proxmox VE keeps "SolarDeck".

## v2.4.2 - Updates Apply New Host Steps Immediately — 2026-11-25

### Fixed
- An update ran the previous release's updater, so host steps added in a release only ran on the update after it. For example, the switch to Zabbly's Incus in v2.4.0 didn't happen when updating to v2.4.0 or v2.4.1. After fetching the new release, the updater now continues with the new release's own updater. Settings are still saved before the checkout.

## v2.4.1 - SolarOS Update Check Fix — 2026-11-25

### Fixed
- A freshly installed SolarOS reported "update available" for the version it already ran, so the update screen offered nothing new. The ISO records its main-branch commit, which isn't on the SolarOS release branch. The first update check now records the release tag of the same version instead.

## v2.4.0 - SolarOS First-Run Setup: No Default Passwords — 2026-11-25

### Added
- **First-run setup:** a fresh SolarOS has no administrator and no generated or default password. The first visit to the web UI shows "Create your administrator".
  - The form needs the one-time **setup code** shown on the server's own screen (tty1), so nobody else on the network can claim the server first. After 10 wrong codes the form locks for 10 minutes.
  - You choose the user name and password (at least 10 characters, letters plus a digit or symbol).
- **One account for the web UI and the server:** the administrator also becomes a Linux user with sudo (and `libvirt`/`incus-admin`) with the same password; a password change keeps both in sync. The ISO's bootstrap user is locked and expired once the administrator exists; root keeps no password.
- Console option **[2] Reset Administrator** returns to first-run setup with a new setup code. It also switches two-factor sign-in off, for a forgotten password or a lost phone.

- **Current Incus from Zabbly:** SolarOS installs Incus from the upstream maintainers' Zabbly repository (Incus 7.x) instead of Ubuntu's frozen 6.0.0. Container install scripts that use newer Incus commands now work. Updates move existing installs over; containers, images and storage pools are kept. Only the container parts (`incus-base`, `incus-client`) are installed, because SolarOS runs virtual machines through libvirt. If the repository can't be reached, Ubuntu's package is kept.

### Fixed
- SolarOS installs whose first Incus initialization stopped halfway had no storage pool, so containers and apps could not be created. The installer and every SolarOS update now create the missing pool and attach it to the default profile (`hypervisor/ensure-incus-pool.sh`).

### Changed
- **Hashed passwords:** the administrator password is stored only as a scrypt hash (`ADMIN_PASSWORD_HASH`); a password change replaces an older install's plaintext `ADMIN_PASSWORD` (SolarDeck for Proxmox VE included). New passwords need at least 10 characters.
- **No password in the ISO:** `build-iso.sh` no longer prints or shares a console password between installs. The bootstrap user gets a random password nobody knows (`--password` remains for test builds).

## v2.3.2 - SolarOS First-Boot Fix — 2026-11-25

### Fixed
- **Fresh SolarOS v2.3.1 installs stopped at "incus admin init"**: installing without recommended packages also left out `dnsmasq-base`. SolarOS now installs the recommended packages it actually uses: `dnsmasq-base`, the QEMU network-boot ROMs, `qemu-block-extra`, `parted`, `netcat-openbsd`, `libxml2-utils`, `samba-vfs-modules` and `cpu-checker`. Existing installs were not affected.
- The minimal Ubuntu base's tracing tools (`bpftrace`, `bpfcc-tools`), which pull in LLVM/Clang, are removed. A fresh SolarOS install now uses about 3.3 GB of disk including the swap file (8.6 GB with v2.3.0).

## v2.3.1 - Slimmer SolarOS — 2026-11-25

### Changed
- **SolarOS installs the minimal Ubuntu Server base** with a 1 GiB swap file instead of Ubuntu's 4 GiB default.
- **Packages:** SolarOS installs only the packages it uses (no recommended extras such as desktop graphics stacks, no compilers), removes snapd when no snap is in use, and empties the APT cache after installing.
- **The solaros release branch ships the built desktop,** so SolarOS hosts need neither Node.js nor npm for installs or updates. SolarDeck for Proxmox VE keeps building it during updates.

### Fixed
- The release workflow publishes the solaros branch again (v2.3.0's job stopped on generated release notes inside the checkout). Edition trees are made from tracked files only.

## v2.3.0 - Separate Editions: SolarOS Without Any Proxmox VE Code, Neutral API and System Names — 2026-11-25

### Changed
- **One API path:** every route is `/api/v1/...`; `/api/pve/...` and its mirror are gone (frontend, nginx websocket location and installers follow).
- **Neutral settings:** `NODE_NAME` and `DEFAULT_BRIDGE` replace `PVE_NODE` / `PVE_BRIDGE`; existing `.env` files are migrated automatically. The default bridge comes from the backend (`capabilities.default_bridge`).
- **System names from `SYSTEM_PREFIX`:** everything SolarDeck creates on a host uses one prefix: helper, units, logs, Samba include, nginx site and certificate, network-service files, router unit and nftables table, driver files, guest and app tags.
  - SolarOS uses `solardeck`.
  - SolarDeck for Proxmox VE keeps its existing names through `SYSTEM_PREFIX=proxmox-os` (added automatically). A test checks every name against the previous release.
- **Backend split by driver:** all Proxmox VE code lives in `backend/providers/proxmox/`: the REST client and settings, its routes, help checks and platform constants. Shared modules talk to the hypervisor only through the provider.
  - The registry imports the active driver package by name and picks the only driver of a distribution on its own.
  - On SolarOS, the 33 routes that exist only for Proxmox VE answer "Not available on SolarOS".
- **Frontend editions:** edition-specific texts, help pages, product names, logos and the trademark notice live in `frontend/src/editions/<edition>/`, selected with `VITE_EDITION`. The SolarOS build contains no Proxmox reference. The API field `platform_version` replaces `pveversion` / `pve_version`.
- **Host helper split:** shared commands are in `deploy/solardeck-helper.sh`; the pct/qm commands are in an edition file that only the Proxmox VE installer adds.
- `build-iso.sh --copy-to <dir>` replaces `--deploy-to-pve`.

### Added
- **SolarOS distribution:** `deploy/make-edition-tree.sh` builds an edition's own source tree: it removes the other editions, adds edition-specific README, license and examples, and fails on any leftover reference. CI checks it on every push.
  - The ISO is built from the SolarOS tree.
  - Releases publish it to the `solaros` branch (tag `solaros-<version>`). SolarOS installs and updates fetch only that branch and its tags.

### Fixed
- On SolarOS, the hardware inventory and telemetry list the physical disks, and the network status shows the interfaces (they were empty).
- The NVIDIA driver install on SolarOS installs `linux-headers-$K` (it asked for headers that do not exist on Ubuntu).

## v2.2.5 - Delete VMs and Containers from the Desktop — 2026-11-25

### Added
- **Delete a VM or container** from its drawer (Options → Delete), in both editions. It is only available for a stopped guest, and you confirm by typing its name. The guest and its disks are removed (backups are kept); the task log follows the removal, then the list refreshes (`DELETE /api/pve/guests/{type}/{vmid}`).

## v2.2.4 - Windows Installs: Boot from ISO, Windows-Ready VMs on Proxmox VE, Memory Field Fix — 2026-11-25

### Added
- **Boot from ISO** button in the VM console (both editions). It restarts (or starts) the VM and presses Enter every half second for 12 seconds. Windows installers boot from their ISO only when a key is pressed within about 5 seconds of "Press any key to boot from CD or DVD", which a console that reconnects after the restart nearly always misses (`POST /api/pve/guests/qemu/{vmid}/boot-iso`).

### Fixed
- **Memory fields rejected normal values** such as 8192 MB in the VM drawer and wizard ("nearest valid values are 7952 and 8208"). The browser counted the 256 MB step from a 16/64 MB minimum; the fields now use 64 MB steps from 64 MB.
- **Windows VMs on SolarDeck for Proxmox VE** get a SATA disk and an e1000e network card, so Windows Setup sees the disk and the network without a virtio driver ISO (Linux VMs keep virtio-scsi and virtio).

## v2.2.3 - SolarOS: ISO Upload, CD/DVD Drive and Windows-Ready VMs — 2026-11-25

### Added
- **Upload an ISO from your computer** (SolarOS): ISO & Templates has an "Upload ISO from this computer" button with a progress bar. Use it for installers you cannot download by URL, such as Windows. The file is streamed straight into `/mnt/storage/isos`, with a free-space check, and an interrupted upload leaves no partial file (`POST /api/pve/storage/{storage}/upload`).
- **CD/DVD drive for existing VMs** (both editions): the Hardware tab has a CD/DVD drive card to load or eject an ISO (`PUT /api/pve/guests/qemu/{vmid}/cdrom`). On SolarOS a running VM swaps the disc at once; a VM without a drive gets one at its next start, and the screen says so.

### Fixed
- SolarOS VMs never booted from their ISO when a cloud-init drive was present: `<boot dev="cdrom"/>` only tries the first CD-ROM. VMs now use a per-device boot order: the disk first (an empty disk falls through), then the install CD.
- Windows VMs on SolarOS get SATA disks and an e1000e network card, so Windows Setup sees the disk and the network without an extra driver ISO.

## v2.2.2 - SolarOS: VM Creation Fix and VM / Container Editing — 2026-11-25

### Fixed
- **Creating a VM on SolarOS failed** with `virsh define failed: Failed to open file '/dev/stdin'`: virsh cannot open the socket that asyncio uses as stdin. The domain XML now goes through a private temp file (create, CPU resize and restore).
- A failed VM create now removes the disk it made, so a retry with the same VMID no longer stops at "already exists".
- **Creating a container on SolarOS failed** with "The device already exists". A successful `incus config device set` prints nothing, and that empty output was read as a failure (also when resizing a container disk).
- Container templates `alpine/3.20` and `fedora/41` are gone from the image server; they are now `alpine/3.22` and `fedora/43`.
- The VM wizard, App Center and VM drawer no longer say "Proxmox" for tasks that run on SolarOS's own hypervisor.

### Added
- **VM and container editing on SolarOS**. The Network, Hardware & Passthrough, Cloud-Init and Options tabs answered "This feature needs a Proxmox VE host"; they now run on libvirt and Incus (`backend/providers/native_ubuntu/guest_edit.py`).
  - VM network cards: bridge, model, MAC and rate limit. Changes are saved to the VM definition and apply at its next start.
  - Container network cards: bridge, VLAN (on bridges with VLAN filtering) and rate limit. If a change is rejected, the previous NIC is put back.
  - VM PCI/GPU passthrough (with the HDMI audio function) and USB passthrough by vendor:product.
  - Cloud-Init for VMs: user, password (stored only as a SHA-512 hash), SSH keys, DNS, IP per NIC and package upgrade, written to a NoCloud seed drive. "Regenerate" makes the guest apply it again.
  - Options for VMs: name (VM shut off), start at boot, guest agent, tablet, OS type. Options for containers: hostname (stopped), start at boot, protection, nesting. Anything else gets a clear "Not adjustable on SolarOS" message.
  - VLAN tags on VMs are refused with a hint to use a VLAN bridge, because libvirt cannot tag on a Linux bridge.

## v2.2.1 - SolarOS Name, Product Logos & ISO Live-Test Fixes — 2026-11-24

### Changed
- The standalone edition is now called **SolarOS** everywhere you can see it: sign-in and lock screen, top bar, About card, driver badge, Control Panel, browser tab, tty1 console, GRUB menu, installer messages and the ISO name (`SolarOS-v<version>-amd64.iso`, default host name `solaros`). The Proxmox VE edition is **SolarDeck for Proxmox VE**, installed as its own LXC container. The sign-in screen no longer reads "SolarDeck for SolarDeck Hypervisor". Internal names (`/opt/solardeck`, the `solardeck-*` units, `HYPERVISOR_DRIVER=native_ubuntu`) are unchanged, so existing installs update normally.
- The ISO card lists both `SolarOS-*.iso` and older `SolarDeck-Hypervisor-*.iso` builds.

### Added
- **Product logos** for SolarOS and SolarDeck for Proxmox VE (`frontend/public/brand/`): an orange sun with orbit arrows, a power symbol (SolarOS) or an app grid (SolarDeck), and a stroke-drawn wordmark. Each has a dark-background version, a light-mode version and an icon-only mark. They are used on the sign-in screen (following the color mode), as the browser tab icon and in the READMEs. Regenerate them with `python3 frontend/scripts/generate-logos.py frontend/public/brand`.

### Fixed (found by booting the v2.2.0 ISO in a nested Proxmox VE VM)
- `build-iso.sh` stopped every build with "unfilled placeholder": its check matched the template's own comment.
- The GRUB entry for the automated install showed blank space where the em dash was; it now uses a plain hyphen.
- `test-in-proxmox-vm.sh` boots `scsi0;ide2`, so the installed disk starts after the install instead of the installer running again.
- `install-hypervisor.sh --bundle` left `.build-commit` empty, so the updater showed no version.
- Console: libvirtd counts as ready when its socket is active (Ubuntu starts it on demand), and the screen repaints fully, so boot messages no longer stay on top of it.

## v2.2.0 - Phase 20: Offline-Capable Bootable ISO Builder, First-Boot Appliance Setup & Proxmox Nested-VM Test Harness — 2026-11-24

### Added
- **Self-contained ISO bundle**: `hypervisor/build-iso.sh` now builds the desktop (`npm ci && npm run build`) and downloads the backend's Python wheels for Ubuntu's CPython (`pip download --only-binary`) into the embedded SolarDeck bundle, so first boot needs no Node.js build and no PyPI. Missing build tools fall back to fetching that part on first boot. The default output is `./dist/SolarDeck-Hypervisor-v<version>-amd64.iso`, and the SHA-256 is printed.
- `build-iso.sh --auto-disk <device>` adds a **SolarDeck Hypervisor - Automated VM Test Install** boot entry that installs to that disk unattended. `--deploy-to-pve` copies the ISO to `/var/lib/vz/template/iso/` on a Proxmox VE host.
- **`hypervisor/firstboot-setup.sh`** (run once by `solardeck-firstboot.service`):
  - bridges the primary Ethernet port into `br0` with DHCP (`/etc/netplan/60-solardeck-bridge.yaml`). The installer's Netplan files are parked, and put back if the bridge gets no address.
  - runs `install-hypervisor.sh --bundle`.
  - puts the Incus `default` profile on `br0` and enables libvirtd, ZFS, smbd, nginx, `solardeck-backend` and `solardeck-console`.
  - disables itself.
- `install-hypervisor.sh --bundle <dir>`: installs from the bundled wheels and the prebuilt `frontend/dist`. Node.js 22 is still installed when reachable, for later updates. Without a default route, the bridge uses the first physical `en*`/`eth*` port.
- **tty1 console**:
  - the initial `admin` password is shown on the status screen until cleared with **[2] Reset / Clear Initial Password Display**.
  - new **[6] Show Nested Virtualization & Hardware Readiness**: VT-x/AMD-V, `/dev/kvm`, nested KVM, libvirtd, Incus, OpenZFS, `br0`, bare metal or VM.
- **`hypervisor/test-in-proxmox-vm.sh`**: one command on a Proxmox VE host creates and starts a nested test VM:
  - q35, OVMF + EFI disk, host CPU, 4 cores, 8 GiB.
  - a 32 GB OS disk and two 32 GB data disks for ZFS mirror/RAIDZ1, SMART and benchmark tests.
  - virtio NIC on `vmbr0`, the ISO on `ide2`, boot order `scsi0;ide2` (QEMU's boot order beats the installer's UEFI entry, so CD-first would reinstall on every reboot; the blank disk falls through to the ISO once).
  - it checks nested virtualization (`--enable-nested` turns it on when no VM runs), picks the next free VMID from 900 and `local-zfs`/`local-lvm`, never touches an existing VMID, and supports `--dry-run`.
- **Control Panel → System & Updates → Standalone Hypervisor ISO**: the build and test commands with copy buttons, and every built `SolarDeck-Hypervisor-*.iso` in `/mnt/storage/isos/` or `/var/lib/vz/template/iso/` with its size and SHA-256 (`GET /api/system/updates/iso`; each ISO is hashed once).
- README: **Testing SolarDeck Hypervisor ISO inside a Proxmox VE VM**.
- CI: release tags syntax-check `build-iso.sh`, `install-hypervisor.sh`, `firstboot-setup.sh` and `test-in-proxmox-vm.sh` before uploading `build-iso.sh` and `install-hypervisor.sh`.

### Changed
- The ISO's default boot entry is now **Install SolarDeck Hypervisor (Interactive Disk Selection)**. The old automatic entry, which erased the largest disk, is gone, so booting a server with data disks never wipes one unasked.
- The initial Web UI credentials are now stored in `/etc/solardeck/initial-credentials.txt` (0600). The console still reads the old `/root/solardeck-credentials.txt`.

## v1.14.0 - Phase 19: Native Linux Hypervisor Driver, Unified Updater, Console Dashboard & Bootable ISO — 2026-11-24

### Added
- **SolarDeck Hypervisor driver** (`HYPERVISOR_DRIVER=native_ubuntu`): the full `HypervisorProvider` contract on a standalone Ubuntu Server LTS host.
  - Host telemetry from `/proc` and `/sys` (CPU, RAM, ZFS ARC, load, uptime, network rate); hardware inventory, BIOS readiness, PCIe/IOMMU, USB, GPUs and host/VM-passthrough GPU modes through the same tools as on Proxmox VE (`dmidecode`, `lspci`, `sensors`, `smartctl`, `nvidia-smi`, `/etc/modprobe.d` + `update-initramfs`).
  - **VMs** with libvirt (QEMU/KVM): generated domain XML with CPU topology, memory, OVMF UEFI (`OVMF_CODE_4M.fd` + per-VM NVRAM, Secure Boot and TPM for Windows 11), virtio-scsi disks on sparse ZFS volumes or QCOW2 files, the `br0` bridge, optional Cloud-Init seed ISO, VNC on `127.0.0.1` and PCIe/GPU (+ HDMI audio) and USB `<hostdev>` passthrough. Power actions, resource editing (cores, memory, autostart, notes, disk growth), snapshots and deletion.
  - **Containers** with Incus: CPU/RAM limits, root disk size on any Incus storage pool, bridged networking, nesting, dataset bind mounts, snapshots, and container templates from the Incus image server.
  - **App Center and Local AI Studio** on Incus with the same install scripts: GPU targets `nvidia:<pci|index>`, `intel|amd:/dev/dri/renderD128` or `cpu`, `/mnt/storage/ai-models` mounted for Ollama, and the same `/api/ai/*` workflow.
  - **Storage**: ZFS pool create (single, mirror, RAID10, RAIDZ1-3) and destroy, member offline/online/replace/detach, datasets, disks with SMART, disk power settings, surface scans, `fio` benchmarks, wipe and GPT init.
  - **ISO library and backups** in `/mnt/storage/{isos,templates,backups}`: URL downloads with checksum verification, VM backups (`virsh dumpxml` + `zfs send` or QCOW2 copies) and container backups (`incus export`), restore with overwrite, and scheduled backup jobs with keep-last pruning.
  - **Local users, groups, roles, ACLs and pools** in `backend/data/local_rbac.json` (scrypt password hashes).
  - Networking from `ip -j` and Netplan, the network topology map, firewall rules from the `inet solardeck` nftables table, the system journal, APT updates and repositories, reboot/shutdown.
  - **Consoles**: noVNC bridged to the VM's local VNC port over WebSockets, container shells (`incus exec`), VM serial consoles (`virsh console`) and the Host Shell.
  - Task Center jobs for every long operation. `DELETE /api/pve/guests/{type}/{vmid}` (both drivers).
- **`hypervisor/`**: `install-hypervisor.sh` (single-command bare-metal installer with `--with-console-tui`), the `solardeck-console` tty1 dashboard (host summary, LAN IPs and web URL, ZFS pool health, network setup, admin password reset, update from Git, root shell, reboot/shut down), `build-iso.sh` + autoinstall template for a bootable installer ISO, and `solardeck-backend` / `solardeck-console` / `solardeck-firstboot` systemd units.
- **CI** (`.github/workflows/release.yml`): frontend build, both drivers and their routes, all backend self-checks and script syntax on every push to `main`; release notes and installer scripts attached on version tags.

### Changed
- **One updater for both editions**: Control Panel → System & Updates shows the edition (*Proxmox VE Deck* or *SolarDeck Standalone Hypervisor*), the driver and `origin/main`. `POST /api/system/updates/apply` takes `include_system_packages` on the standalone edition (`apt-get update && apt-get upgrade -y` on the host). `self-update.sh` keeps `.env`, `data/`, `.ssh/` and the Samba share config and, on the standalone edition, also refreshes the root helper and the console dashboard.
- The root helper's `storage-map` uses bind mounts under `/mnt/storage` on a host without `pct`.

## v1.13.0 - Phase 18: Provider / Adapter Architecture — 2026-11-24

### Added
- **Hypervisor provider layer** (`backend/providers/`): a typed, platform-neutral `HypervisorProvider` contract with domain models (capabilities, node metrics, guests, PCI/USB/GPU devices, ZFS pools and datasets, disks and SMART, benchmarks, storage content, backups and schedules, users, groups, roles, ACLs, pools, firewall rules, tasks, network interfaces and topology, console tickets).
- **Proxmox VE driver** (`ProxmoxProvider`) bound to the existing, tested Proxmox code. Overview, guest list and power actions now go through the active driver.
- **Standalone hypervisor scaffold** (`NativeUbuntuProvider`, `HYPERVISOR_DRIVER=native_ubuntu`): live capabilities (*SolarDeck Hypervisor*). Every other method answers HTTP 501 until Phase 19. The command mapping is in `backend/providers/PHASE19_DRIVER_SPEC.md`.
- `GET /api/system/capabilities` and `/api/v1/system/capabilities`, plus driver-neutral `/api/v1/...` aliases for every `/api/pve/...` route.
- Frontend `capabilitiesStore`: platform labels (sign-in screen, Host Shell button, Control Panel, Storage, Network Services, guides) and feature gates (VM/container creation, ZFS tabs, GPU targets in Local AI, RBAC realms, cluster log, package repositories, BIOS guide, Host Shell).
- **About SolarDeck** card and a hypervisor driver badge (*Proxmox VE* / *Standalone Hypervisor*) in Control Panel → System & Updates, in all five languages.

### Changed
- `HYPERVISOR_DRIVER=proxmox` is written on fresh installs and appended to existing `.env` files. Updates, downgrades and re-installs keep its value.
- `install.sh` and `deploy.sh` no longer overwrite `alert_channels.json`, `automation_rules.json` and `automation_logs.json`, and `deploy.sh` keeps `update_settings.json`. Local-checkout upgrades replace `backend/providers/` like the other source folders.

## v1.12.0 - Phase 17: Interactive Desktop Widget Studio, Automation Rules & External Alerts, Network Topology Map & Multi-Language Support — 2026-11-24

### Added
- **Widget Studio**: Edit Widgets mode (View Options → Customize Widgets, right-click the desktop → Customize Widgets, or the *Edit Widgets* pill under the widgets).
  - Switch each widget on or off, drag it to a new place or to another slot (left column, right column or the grid in the middle of the desktop), and pick Compact or Expanded. The drawer offers the same with buttons, for keyboard use.
  - Widgets: System Health, ZFS & Storage Pools, Compute Summary, GPU & Thermal Monitor (GPU load, VRAM, power, integrated GPU and drive temperatures), Live Network Throughput (RX/TX graph), Local AI Studio card (active model, VRAM, one-click Playground) and Quick Actions & Scratchpad (Host Shell, Backup Now, Lock Screen and admin notes).
  - The layout and notes are saved in the browser and under `widgets` in `/api/system/preferences`.
- **Automation & Alerts** in the Control Panel:
  - *Alert Channels*: Telegram Bot, Discord Webhook (rich embeds), Custom Webhook (POST or PUT, optional bearer token) and SMTP Email (STARTTLS or TLS on port 465), each with **Send Test** and the exact delivery result. Secrets are masked in the UI and kept in `backend/data/alert_channels.json` (mode 600).
  - *Automation Rules*: triggers `gpu_temp_above`, `disk_temp_above`, `zfs_pool_degraded`, `storage_usage_above`, `guest_stopped_unexpectedly` (keep-alive guest) and `scheduled_time` (HH:MM, every day or chosen weekdays); actions `send_external_alert`, `restart_guest`, `start_guest`, `stop_guest` and `prune_old_snapshots`. Plain-English summaries such as *When GPU Temperature > 80°C → Send Telegram & Discord Alert*, a cooldown per rule (default 15 minutes) and a live execution log.
  - Rule alerts and failed actions of the last 24 hours also appear in the top bar Notification Center.
  - API: `GET|PUT /api/automation/channels`, `POST /api/automation/channels/test`, `GET|POST /api/automation/rules`, `PUT|DELETE /api/automation/rules/{id}`, `GET /api/automation/logs`. Rules are checked every minute by the backend's scheduler.
- **Network Topology** (Network & Services, now the first tab): an interactive map from Internet / WAN through the host's NICs, bonds, bridges and VLANs to every VM, container, the WireGuard server and its peers, and port forwards. Click a node to highlight its links and see IP, MAC and link status, with Open Console, Configure Bridge, Edit Port Forward or Configure VPN. API: `GET /api/pve/network/topology` (`nodes[]`, `edges[]`).
- **Languages**: English, Nederlands, Deutsch, Español and Français for the login screen, top bar, Dock, taskbar, App Gallery, View Options, Control Panel, app names, widgets, Automation & Alerts and Network & Services tabs. Choose the language on the login screen, in the top bar or taskbar, or in Control Panel → Appearance & Themes. It is saved in the browser and under `i18n.language` in `/api/system/preferences`; on the first visit the browser language is used.

### Changed
- Control Panel → Appearance & Themes has Language and Desktop (widgets) cards; the widget switch and layout now follow you between browsers.

## v1.11.0 - Phase 16: Clean Desktop, Adaptive Dock/Taskbar App Gallery Button, Drag-and-Drop Icon Reordering & Real Usage Sorting — 2026-11-24

### Added
- **App Gallery** (replaces the old all-apps grid): a full-screen frosted-glass overlay with every app.
  - Instant **Search apps...** filter and category pills: All, System & Hardware, Storage & Backups, Compute & AI, Network & Shares.
  - **Sort**: Custom Order, Most Used, Name (A–Z), Name (Z–A), Recently Used. **Grid | List** toggle, remembered per browser and on the server.
  - **Drag-and-drop** any tile to a new slot; neighbours slide aside live. Dragging while another sort is active switches to Custom Order. **Reset Order** restores the default order.
  - **Real usage badges** (`14 opens`, `Top Used`): always shown under Most Used, on hover otherwise.
  - Right-click or the **…** badge on a tile: Open, **Pin to Bottom Bar** / **Unpin from Bottom Bar**, **Open App Guide**.
- **App usage tracking**: every app launch (Dock, taskbar, App Gallery, Spotlight, widgets, deep links) is counted right away in the browser and on the server.
  - API: `GET /api/system/app-usage`, `POST /api/system/app-usage/record` (`{"app_id": "<id>"}`), `DELETE /api/system/app-usage` (reset). Stored atomically in `backend/data/app_usage.json` as `launch_count` and `last_opened_at` (ISO 8601 UTC) per app.
- **Live drag-and-drop reordering** on the floating Dock and the bottom taskbar, with spring-like FLIP slide animations (switched off under *reduce motion*).

### Changed
- **Clean desktop by default**: app shortcuts no longer cover the wallpaper; the desktop shows the wallpaper, the widgets and your windows. Turn shortcuts back on with **Show Desktop Shortcuts** in View Options or Control Panel → Appearance.
- **Bottom bar styles**: *Floating Dock* (the App Gallery squircle leads the Dock and magnifies like its neighbours) or *Bottom Taskbar* (edge-to-edge; the App Gallery button sits in the far bottom-left corner, then a divider and your app buttons). With Desktop layout set to *Automatic*, the Redmond Mica theme picks the bottom taskbar.
- The taskbar's Start button and Start key now open the App Gallery. The old Start menu is gone; its account row (Control Panel, Lock, Log out) is at the bottom of the App Gallery in the taskbar layout.
- New preferences in `/api/system/preferences`: `layout.showDesktopIcons` (default `false`), `layout.galleryAppOrder`, `layout.gallerySortMode` (default `custom`) and `dock.dockAppOrder` (the bottom bar order, now kept on the server too). The bar style is the existing `layout.shellLayout` (`auto`, `dock`, `taskbar`).

## v1.10.0 - Phase 15: Multi-Theme Engine, Global Light/Dark Mode, 44 Built-in Wallpapers & Custom Theme Studio with Import/Export — 2026-11-24

### Added
- **Theme engine**: every window, table, modal, chart, widget, the lock screen, top bar, Dock and taskbar now follow the active theme in **Dark and Light Mode**. Surfaces, borders, text, accents, glass blur, corner radii and fonts come from CSS variables (`--sd-*`) on `<html>`, plus `data-color-mode` and `data-window-chrome`.
- **11 built-in themes**, each with Dark and Light palettes and 4 procedural wallpapers (44 in all, drawn as crisp SVG/CSS that adapts to the mode): SolarDeck Liquid Glass (default), Cupertino Frost, Redmond Mica, Aubergine Yaru, Nordic Slate, Vice Horizon, Nightcity 2099, Synthwave '84, Phosphor Terminal, Solarized Amber and Obsidian Gold.
  - Window chrome per theme: *Standard* (follows your Window buttons setting), *Traffic Dots* and *Angular HUD* (chamfered frames). Nightcity 2099 and Phosphor Terminal add a faint scanline overlay; Phosphor Terminal uses a monospace UI.
- **Top bar / taskbar**: a one-click **Light / Dark toggle** (sun and moon swap with a rotation) and a **Quick Theme Switcher** for the theme, mode and the active theme's 4 wallpapers.
- **Control Panel → Appearance & Themes** (was Appearance & Layout):
  - **Theme Gallery** with live Dark and Light previews, accent dots and an Active badge.
  - **Wallpaper** per theme: the 4 built-ins, **Upload Wallpaper** (PNG, JPG, WebP, SVG up to 15 MB), an https image URL or a two-color gradient. Each theme remembers its own wallpaper. **Wallpaper Blur** (0–24 px) and **Background Dimming** (0–60 %).
  - **Create / Edit Theme**: start from scratch or clone any theme; Background, Glass Surface, Glass Opacity, Blur, Primary and Secondary Accent and Text Color for both modes, Window Corner Radius, Window Button Style, Font Style (Modern Sans, Geometric, Monospace) and 4 wallpaper presets (any built-in artwork or a gradient).
  - **Export** on every theme downloads `<theme-name>.solardeck-theme.json`; **Import** takes a dropped or chosen file, validates it, previews both modes and adds it.
- API: `GET|POST /api/system/themes`, `PUT|DELETE /api/system/themes/{id}`, `POST /api/system/themes/wallpapers/upload`, `GET /api/system/themes/wallpapers/{file}`. Custom themes are stored in `backend/data/themes/custom_themes.json` (up to 50), uploads in `backend/data/themes/wallpapers/`.
- Theme preferences (`activeThemeId`, `colorMode`, `selectedWallpaperIndex`, `customWallpaperUrl`, `wallpaperBlurPx`, `wallpaperDimPct`, `perThemeWallpapers`) are validated and saved under `theme` in `/api/system/preferences`, so they follow you between browsers.

### Changed
- The five fixed wallpapers of earlier versions are replaced by the theme wallpapers; Aurora and its siblings live on in SolarDeck Liquid Glass.
- Primary buttons pick black or white text by contrast with the theme's accent.

## v1.9.0 - Domains and Let's Encrypt for SolarDeck — 2026-11-24

### Added
- **Network & Services → Domains**: add your own domain names and, per domain, host names with their IP address, for example `solardeck` → `192.168.68.230` (`@` is the domain itself).
  - Host names become local DNS records in SolarDeck's DNS service as soon as it is installed and on, and are kept until then. dnsmasq still checks every change, and a rejected change keeps the previous working set.
  - Domains are stored with the other network settings on the host (`/etc/proxmox-os/net/domains.json`), so they survive a container reinstall.
  - API: `GET|POST /api/domains`, `DELETE /api/domains/{name}`, `PUT /api/domains/{name}/hosts`.
- **Let's Encrypt certificate for SolarDeck** with a DNS-01 check, so SolarDeck never has to be reachable from the internet.
  - Pick a host name, a DNS provider (Cloudflare, Hetzner DNS, DigitalOcean, or any acme.sh DNS API plugin), its API token and an email address.
  - SolarDeck installs acme.sh (pinned 3.1.7) in its container, requests the certificate, installs it in nginx, and lets acme.sh's cron job renew and reload it automatically.
  - Credentials are entered in SolarDeck, passed to acme.sh as environment variables, masked in the progress log, and stored only in acme.sh's root-only settings file.
  - Certificates are only requested for domains you added. *Back to self-signed* stops renewing and restores SolarDeck's self-signed certificate.
  - API: `POST|DELETE /api/domains/certificate`, `GET /api/domains/certificate/job`.

## v1.8.2 - HTTPS Out of the Box — 2026-11-24

### Added
- **HTTPS on port 443** for every installation, through a self-signed certificate made by the new `deploy/selfsigned-cert.sh`. `install.sh` and the in-app updater both run it.
  - The certificate covers the container's IP addresses, `<hostname>`, `<hostname>.local` and `localhost`. It uses ECDSA P-256, CA:FALSE and serverAuth, and is valid for 825 days, the most Apple platforms and Chrome accept when you trust a certificate by hand.
  - It is renewed automatically when fewer than 30 days remain or when the container's addresses or hostname change.
  - A certificate you install in **Network & Services → Certificates** (custom or Let's Encrypt) is never replaced. Removing it there turns HTTPS off until the next update makes a new self-signed one.
  - Plain http keeps working; there is no forced redirect. Browsers show a warning for the self-signed certificate once.
- The installer's summary box shows the https address.
- On http, the taskbar's Full screen tooltip points to the https address, which the Start key needs (Keyboard Lock).

## v1.8.1 - Start Key Opens the Start Menu — 2026-11-24

### Added
- **Start key shortcut** (taskbar layout): tapping the keyboard's Start / logo key on its own opens or closes SolarDeck's Start menu. Combinations with other keys (Start+E, Start+D, …), holding the key, or clicking while it is held leave it alone.
- **Full screen** button in the taskbar tray. In full screen SolarDeck asks the browser to keep the Start key (Keyboard Lock), so only SolarDeck's Start menu opens. Keyboard Lock works in Chrome and Edge over **https**. Outside full screen, or over plain http, the computer may also open its own Start menu, which a web page cannot prevent.

## v1.8.0 - Taskbar Desktop Layout — 2026-11-24

### Added
- **Taskbar layout**: one bar along the bottom replaces the top bar and the Dock.
  - **Start** opens a menu with app search (Enter opens the first match), all apps, and your account with Control Panel, Lock and Log out.
  - Next to it: **Search** (the same as Ctrl+K), then your pinned apps and open apps. A bar under each running app shows it is open; the bar is wider and blue for the window in front. Click to open, bring forward or minimize. Right-click for Show / New window / Pin or unpin / Close window. Windows minimize into their taskbar button.
  - The tray on the right has the CPU, RAM and ZFS status, Host Shell, View Settings, Help, Tasks, Notifications, a two-line clock, and a thin **Show desktop** strip that minimizes every window. Menus open upwards.
- **Desktop layout** setting in Control Panel → Appearance & Layout (and View Settings): *Automatic* (default), *Top bar + Dock* or *Taskbar*. *Automatic* picks the taskbar on devices whose browser reports a Windows platform, and top bar + Dock elsewhere. The setting is saved with the other layout preferences.

### Changed
- Maximize, snapping, dragging and desktop icons keep clear of whichever bars the layout shows: the top bar in the Dock layout, the taskbar in the taskbar layout. Dragging a window to the very top edge maximizes it in the taskbar layout.
- The Help menu and the Dock's click behaviour are shared by both layouts (`HelpMenu`, `activateApp`).

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
- **Desktop icons sometimes showed sharp through open windows** in Chrome. Each icon had a CSS `drop-shadow` filter (on the icon and on its button), which puts it on its own GPU layer; Chrome's compositor intermittently painted those layers over the windows' `backdrop-filter` glass. The icon shadow is now an SVG filter inside the icon and the labels use `text-shadow`, so no CSS filters sit behind the windows. Same look, also in the Dock and App Launcher.

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
- **Desktop Grid View** fills columns from top to bottom and wraps into a new column based on the space between the 36 px top bar and the Dock, so no icon is clipped at the bottom edge. **List View** shows frosted rows with icon, title, a plain-English description (new `desc` field in `apps/registry.ts`) and a launch arrow; the App Launcher follows the same mode.
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
- **Dock & App Launcher**: cosine-curve magnification that resizes icon layout boxes (neighbours move aside, no overlap), pin/unpin from the right-click menu, drag to reorder, auto-hide, base size 36–64 px, and magnification Off/Subtle/Strong/Large. Settings are stored per browser (`useDock`) and editable in Control Panel → Appearance & Dock. The App Launcher button opens a full-screen grid of all apps with search.
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
