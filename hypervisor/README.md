# SolarDeck Hypervisor (standalone edition)

SolarDeck normally runs on top of Proxmox VE (`install.sh`, the *Proxmox VE Deck*). This folder turns a plain
**Ubuntu Server 24.04 / 26.04 LTS** machine into a standalone **SolarDeck Hypervisor**, where SolarDeck itself manages
QEMU/KVM virtual machines (libvirt), Linux containers (Incus), OpenZFS storage, disks, backups and the network.
Both editions are built from the same `main` branch; `HYPERVISOR_DRIVER` in `backend/.env` selects the driver.

| File | Purpose |
|---|---|
| `install-hypervisor.sh` | Single-command installer for a clean Ubuntu Server host (run as root) |
| `solardeck-console-tui.py` | Console dashboard for the server's own monitor (tty1), installed as `/usr/local/bin/solardeck-console` |
| `solardeck-backend.service` | Backend unit (`/opt/solardeck/backend`, runs as root on the host) |
| `solardeck-console.service` | Runs the dashboard on tty1 instead of the login prompt |
| `solardeck-firstboot.service` | ISO installs only: runs the installer once on first boot |
| `build-iso.sh`, `autoinstall/` | Builds a bootable installer ISO (Ubuntu autoinstall + embedded SolarDeck source) |

## Install on an existing Ubuntu Server

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/main/hypervisor/install-hypervisor.sh)" -- --with-console-tui
```

From a checkout: `sudo hypervisor/install-hypervisor.sh --with-console-tui`.

The installer:

1. installs `qemu-kvm`, `libvirt-daemon-system`, `libvirt-clients`, `ovmf`, `swtpm`, `incus`, `zfsutils-linux`,
   `bridge-utils`, `smartmontools`, `hdparm`, `nvme-cli`, `lm-sensors`, `fio`, `websockify`, `samba`, `nginx`,
   `python3-venv`, `python3-pip`, `cloud-image-utils` and Node.js 22,
2. creates the `br0` bridge on the uplink NIC if there is none (Netplan `60-solardeck-bridge.yaml`; a static address
   stays static). Run it from the console, or expect a short network drop over SSH. `--bridge-nic <nic>` or
   `--no-bridge` change this,
3. initializes Incus (`incus admin init --minimal`) if needed,
4. deploys SolarDeck to `/opt/solardeck` (`/opt/proxmox-os` links to it), writes `backend/.env` with
   `HYPERVISOR_DRIVER=native_ubuntu` and a generated `ADMIN_PASSWORD` and `JWT_SECRET`,
5. installs the root helper locally and authorizes the backend's SSH key for `root@127.0.0.1` only,
6. builds the desktop, configures nginx (HTTP + self-signed HTTPS) and Samba, starts `solardeck-backend`,
7. with `--with-console-tui`, replaces the tty1 login prompt with the dashboard,
8. prints the web URL and the admin credentials (also saved in `/root/solardeck-credentials.txt`).

Re-running it is safe: `.env`, `data/` and `.ssh/` are kept.

## Console dashboard

On the server's monitor: host name, kernel, CPU and RAM, every LAN IPv4 address with its `http://<IP>` management
URL, ZFS pool health, and:

```
[1] Configure Network Interface / Static IP (Netplan)
[2] Reset Web UI Admin Password (shows the new password)
[3] Update SolarDeck from Git (main)
[4] Open Root Diagnostic Shell
[5] Reboot or Shut Down Server
```

Anyone at the physical console can use these, like on other appliance consoles. Keep the server in a locked room.
`solardeck-console --self-test` checks its parsers without a terminal.

## Bootable installer ISO

On a Linux machine with `xorriso`, `curl`, `git` and `openssl`:

```bash
hypervisor/build-iso.sh --output SolarDeck-Hypervisor-v1.14.0-amd64.iso
# or: --source-iso ubuntu-24.04.3-live-server-amd64.iso   --ubuntu-release 26.04   --hostname hv1   --password <pw>
```

Without `--source-iso` the latest official live-server ISO of the release is downloaded and checked against
`SHA256SUMS`. The ISO boot menu offers **automatic** (erases the largest disk) and **choose the target disk**.
Ubuntu installs with the console user `solardeck` (password printed by `build-iso.sh`); on first boot
`solardeck-firstboot.service` runs `install-hypervisor.sh --with-console-tui` from the embedded source, which needs
the network. The dashboard then shows the web URL and the admin password.

The ISO embeds the committed `HEAD` of the checkout; uncommitted changes are not included.

## Updates

Control Panel → System & Updates shows *SolarDeck Standalone Hypervisor* and tracks `origin/main`, the same branch as
the Proxmox VE edition. **Install Update Now** can also upgrade the host's Ubuntu packages
(`include_system_packages`). Settings, users, data, keys and shares are kept; the root helper and the console
dashboard are refreshed with the code.
