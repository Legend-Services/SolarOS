# Feature Deep Dives

How the bigger SolarDeck features work under the hood, for both hypervisor drivers (SolarDeck for Proxmox VE and
SolarOS). For step-by-step instructions per screen see the [Manual](README.md); for installation, architecture and
development see [TECHNICAL.md](TECHNICAL.md).

[← Manual](README.md)

## Visual Virtual Switch, VLANs & Per-VLAN DHCP

Open **Settings → Network & Services → Network & Virtual Switch**:

- **Switch faceplates.** Each virtual switch shows its physical ports (link LED, speed badge) and the virtual ports of its VMs, containers and host NICs. A port's colored ring is its VLAN; a striped ring is a trunk.
- **Drag and drop VLANs.** Drag a port onto a VLAN card to make it an access port on that VLAN, onto **Trunk Port** to tick the VLANs it carries, or onto **Unplug**. Animated patch cables show which port sits on which VLAN. Click a port for a plain-English inspector with the same actions. Switches become VLAN-aware by themselves when a VLAN needs it.
- **Virtual NICs.** Add a network card to any VM or container (switch, VLAN, adapter model, MAC), or a host VLAN interface / dummy NIC; edit bandwidth limits and plug or unplug the virtual cable.
- **IP configurator.** Static or DHCP addresses, gateway, DNS, MTU and autostart for switches, ports and VLAN interfaces; bridged, NAT and isolated switches.
- **Safe by default.** Host changes are staged first. **Apply safely** snapshots the network config, reloads it and starts a 60-second countdown on the host: confirm to keep the new settings, or they are restored by themselves, even when the change cut off the browser.
- **DHCP per VLAN.** Flip one switch to run an isolated DHCP server on a VLAN, bound only to that VLAN's interface (created with the gateway IP when missing). See live leases and pin any device to a static address with one click.

## Virtual Hardware, Retro Throttling & Isolated Labs

Open a guest in **Compute** and pick the **Virtual Hardware & Lab** tab:

- **Virtual devices.** Press **+ Add Virtual Device** and pick from *Audio & Voice* (HD Audio Card + Microphone, Retro Sound Card AC97 / SB16), *Video & Capture* (Virtual Webcam fed by a test pattern, an RTSP camera, a looping video file or another VM's screen; containers), *Storage Controllers* (SAS / RAID HBA, virtual NVMe drive), *Communication & Legacy* (Virtual 56k Modem with a built-in AT-command emulator that dials host:port over TCP/IP, Retro 10/100 Mbps Ethernet) and *Security & Reliability* (TPM 2.0, USB SmartCard Reader, Hardware Watchdog, Hardware Entropy). Every device works with the guest's universal inbox drivers; legacy PCI / ISA devices are marked when a running VM needs a power cycle.
- **CPU Speed Limiter.** Limit a guest to 5–100 % of its vCPUs and pick a CPU architecture (*Modern Host*, *Standard 64-bit*, *Retro Pentium*, *Retro 486*) for speed-sensitive retro software.
- **Network Link Speed & Latency Simulator.** Per network card: *Native*, *100 Mbps*, *10 Mbps*, *56k Modem* (~120 ms), *4G Mobile* (25 Mbps, 45 ms, 10 ms jitter) or *Custom* bandwidth, latency, jitter and packet loss. Shaping uses Linux traffic control on the guest's host-side interface, is non-destructive and comes back after every guest start.
- **Isolated Lab Sandbox.** In **Compute** or **Settings → Network & Services → Network & Virtual Switch → Isolated Labs**, name a lab (e.g. *Retro Gaming LAN*), pick a private subnet and DHCP range and the guests to isolate, and press **Launch lab**: SolarDeck creates a virtual switch without physical ports, a lab VLAN with its own DHCP server, moves the guests' first network card onto it and blocks every route in or out (*Air-Gapped · Zero LAN Leak*). **Tear down** puts the guests back on their previous network.

## Multi-Seat Workstations & Physical Ports

Open **Compute → Multi-Seat** (or **Settings → System → Hardware, BIOS/Firmware & Multi-Seat → Multi-Seat**):

- **Seats.** Press **+ Create Seat** and pick the seat's VM, or press **Create New Seat VM**. Each seat card shows its power state with **Start Seat** / **Stop Seat**; **Start All Seats** starts every enabled seat, 3 seconds apart.
- **Display & GPU output.** Choose the GPU whose monitors the seat uses: every GPU is listed with its PCIe slot, a *Boot GPU* badge for the card the server starts on, external Thunderbolt / USB4 GPUs (authorized from the studio), its HDMI / DisplayPort connectors (*HDMI-1: Connected*, *DP-1: Ready*) and *GPU Audio Included* for the card's own audio function. When a seat uses the boot GPU, SolarDeck releases it from the server's console before the seat starts, so every GPU in the machine can drive a desk.
- **Physical USB ports & hubs.** Press **Plug to Assign** and plug a mouse, keyboard, game controller, audio DAC or USB hub into any port of the server within 30 seconds: the port is bound to the seat by its physical position (`1-4`, `3-2.1`), so two identical mice on different ports go to different seats. A whole USB controller can be passed through too, for hot-plug and full bandwidth.
- **CPU core pinning.** Click core pairs (a physical core with its Hyper-Threading sibling) or press **Auto-Balance Cores Across Seats**. Seats never share a core, and the first core(s) stay reserved for the server itself.

## Multi-Host Cluster, Live Migration & High Availability

Open **Settings → Hypervisor & Runtime → Cluster & High Availability**:

- **Standalone to cluster without downtime.** A fresh install is a standalone host with a readiness list (network address, clock sync, ZFS pool, SSH keys & certificates). **Create New Cluster** turns it into the coordinator and shows a single-use **join token** (copy it or scan the QR code); **Join Existing Cluster** on another host adds it with its running guests, storage pools and settings. With Proxmox VE this is a regular Corosync cluster (`pvecm`); with SolarOS it is the SolarOS Cluster Control Plane (its own certificate authority, signed peer calls and 3-second heartbeats).
- **2-host clusters.** Add a **quorum witness** (a QDevice with Proxmox VE, any other SolarOS host with SolarOS) so the surviving host keeps quorum and can fail over without split-brain.
- **Live migration.** In **Compute** press **Migrate to Host…** on any workload: VMs move while running (memory and disks), containers move with a short restart, followed live from 0 to 100 %. **Enter Maintenance (Drain)** on a host card live-migrates every running workload away first.
- **Active/passive HA.** Per workload: a preferred active host, one or more passive standby hosts kept in sync with incremental ZFS replication every 1, 5, 15 or 60 minutes, a failover timeout (10–120 s) and optional **auto-failback**. When the active host goes down the first healthy standby starts the workload from its latest replica, the event goes to the audit log and to your Telegram / Discord / webhook / email alerts. **Switchover Now** swaps active and standby on purpose. A host that loses quorum stops its HA workloads itself.
- **Clustered virtual switches & floating VIPs.** Turn on **Clustered Switch (Sync Across All Hosts)** in the Visual Switch and the switch and its VLANs exist on every host, so workloads migrate without network changes. **Floating VIPs** keep a service reachable at one IPv4/IPv6 address that follows the healthy host (VRRP).

## Security by Design & Hardening

The same security layer runs in both editions (SolarDeck for Proxmox VE and SolarOS). Open **Settings →
Privilege & Security** to see it all in one place.

- **Two-factor sign-in (TOTP).** Scan a QR code with any authenticator app. You also get 8 single-use recovery codes.
  With 2FA on, the password step returns a short-lived challenge and the sign-in finishes only with a valid code.
- **Sessions you can end.** Every sign-in is tracked (device, address, last seen). Revoke one device or all others; the
  token stops working immediately. Changing the password signs out every other device.
- **Brute-force protection.** After 5 failed sign-ins within 10 minutes an address is locked out for 1 minute, then 2,
  4, 8 … (at most an hour), with a `Retry-After` header.
- **Step-up confirmation.** Wiping a disk, destroying a pool or dataset, taking a mirror disk offline, deleting a VM or
  container, switching a GPU to passthrough, editing firewall rules, applying host hardening and opening a root host
  shell all ask for the password (or a 2FA code) again. The confirmation lasts 5 minutes and only for that sign-in.
- **Encrypted secrets.** Alert tokens, webhook URLs, the SMTP password and the TOTP secret are stored encrypted
  (Fernet) with a machine-local key in `backend/data/.vault.key` (`0600`). Older plaintext files keep working and are
  encrypted on the next save.
- **Tamper-evident audit log.** Sign-ins, 2FA changes, session revocations, step-up confirmations, guest and ZFS
  changes, disk wipes, firewall edits, updates and host shells go to `backend/data/audit_log.jsonl`. Each entry stores
  `sha256(previous hash + entry)`, so **Verify Hash Chain** spots any edited, removed or reordered line. Export as
  JSON or CSV.
- **Security score (0–100).** Eight weighted checks: strong admin password, 2FA, HTTPS, key-only SSH, default-deny
  firewall, kernel hardening, automatic security updates and audit log integrity. Host fixes are one click.
- **Host hardening** (`deploy/host-hardening.sh`, applied by the SolarOS installer and from the security score):
  `/etc/sysctl.d/99-solardeck-hardening.conf` (ASLR, symlink/hardlink protection, `kptr_restrict`, `dmesg_restrict`,
  SYN cookies, no ICMP redirects); SSH via `/etc/ssh/sshd_config.d/10-solardeck-hardening.conf` (key-only once a
  person's key is authorized, so you are never locked out; root by key only); `ufw` default-deny incoming with
  80/443 tcp, 51820 udp, rate-limited 22 tcp, shares and guest networks allowed; AppArmor; `unattended-upgrades`.
  On Proxmox VE the platform's own firewall is checked instead of adding ufw.
- **Web server and service.** nginx sends `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy` and a Content-Security-Policy, and hides its version. The container edition's backend runs
  with `NoNewPrivileges`, a private `/tmp` and read-only `/usr`, `/boot` and home directories; `.env` and the SSH key
  are kept at `0600`.
- **On the server's own screen** (SolarOS console): **[7] Security & SSH Lock-Down** blocks or allows SSH from the
  network, shows the firewall and lists recent failed SSH and web sign-ins.
