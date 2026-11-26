<img src="../frontend/public/brand/solaros-logo.svg" alt="SolarOS" height="96">

# SolarOS (standalone edition)

This folder turns a plain **Ubuntu Server 24.04 / 26.04 LTS** machine into **SolarOS**, where SolarDeck itself manages
QEMU/KVM virtual machines (libvirt), Linux containers (Incus), OpenZFS storage, disks, backups and the network.
`HYPERVISOR_DRIVER=native_ubuntu` in `backend/.env` selects the SolarOS driver.

| File | Purpose |
|---|---|
| `install-hypervisor.sh` | Single-command installer for a clean Ubuntu Server host (run as root) |
| `solardeck-console-tui.py` | Console dashboard for the server's own monitor (tty1), installed as `/usr/local/bin/solardeck-console` |
| `solardeck-backend.service` | Backend unit (`/opt/solardeck/backend`, runs as root on the host) |
| `solardeck-console.service` | Runs the dashboard on tty1 instead of the login prompt |
| `solardeck-firstboot.service`, `firstboot-setup.sh` | ISO installs only: first-boot appliance setup (br0, installer in bundle mode, Incus profile), then disables itself |
| `build-iso.sh`, `autoinstall/` | Builds a bootable, fully offline installer ISO (Ubuntu autoinstall, a signed APT repository with every package, SolarDeck source, prebuilt desktop and Python wheels) |

## Install on an existing Ubuntu Server

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/solaros/hypervisor/install-hypervisor.sh)" -- --with-console-tui
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
4. deploys SolarDeck to `/opt/solardeck`, writes `backend/.env` with
   `HYPERVISOR_DRIVER=native_ubuntu` and a generated `JWT_SECRET`, and writes a one-time setup code to
   `/etc/solardeck/setup-code` (mode 0600),
5. installs the root helper locally and authorizes the backend's SSH key for `root@127.0.0.1` only,
6. builds the desktop, configures nginx (HTTP + self-signed HTTPS) and Samba, starts `solardeck-backend`,
7. with `--with-console-tui`, replaces the tty1 login prompt with the dashboard,
8. prints the web URL and the setup code. The first visit to the web UI asks for that code and creates the
   administrator (password stored only as a scrypt hash). The same user becomes a Linux administrator with sudo and
   the same password; the ISO's bootstrap user is locked and root keeps no password.

Re-running it is safe: `.env`, `data/` and `.ssh/` are kept.

## Console dashboard

On the server's monitor: host name, kernel, CPU and RAM, every LAN IPv4 address with its `http://<IP>` management
URL, the setup code (until the administrator exists), ZFS pool health, and:

```
[1] Configure Network Interface / Static IP (Netplan)
[2] Reset Administrator (new setup code; also switches two-factor sign-in off, for a lost password or phone)
[3] Update SolarDeck from Git (main)
[4] Open Root Diagnostic Shell
[5] Reboot or Shut Down Server
[6] Show Nested Virtualization & Hardware Readiness (VT-x/AMD-V, /dev/kvm, nested KVM, libvirtd, Incus, ZFS, br0)
```

Anyone at the physical console can use these, like on other appliance consoles. Keep the server in a locked room.
`solardeck-console --self-test` checks its parsers without a terminal.

## Bootable installer ISO

On a Linux machine, as root, with `xorriso`, `curl`, `openssl`, `squashfs-tools`, `gpg` and `apt-utils` (plus Node.js 22
and `python3-pip` to bundle the desktop and the Python wheels):

```bash
sudo bash hypervisor/build-iso.sh                 # -> ./dist/SolarOS-v2.2.1-amd64.iso
# options: --source-iso ubuntu-24.04.3-live-server-amd64.iso  --output <path>  --auto-disk /dev/sda  --copy-to <dir>
#          --ubuntu-release 26.04  --hostname hv1  --password <console user password>  --no-offline-repo
```

Without `--source-iso` the latest official live-server ISO of the release is downloaded and checked against
`SHA256SUMS`. The ISO installs with no network at all: Ubuntu's own package archive on the ISO (`dists/` + `pool/`) and
the HWE kernel are replaced by a signed APT repository with the complete `.deb` closure of the kernel, both boot
loaders (UEFI and BIOS) and every package SolarOS uses. It is resolved inside the ISO's own minimal root file system, so any Linux build
host works, and signed with a one-time key whose public half goes into the autoinstall seed. The installer uses it as
its only mirror (no Ubuntu mirror, snap store or online DNS; Ethernet is optional), and `late-commands` copy it with the
SolarDeck bundle to `/opt/solardeck-offline`. `--no-offline-repo` builds the smaller online ISO instead. The default boot entry, **Install SolarOS (Interactive Disk Selection)**, asks for the
target disk, so it is safe on servers with data disks. `--auto-disk <device>` adds **SolarOS - Automated
VM Test Install**, which erases that disk without asking. `--copy-to <dir>` also copies the finished ISO into a
folder, for example a hypervisor's ISO library.

The ISO embeds the SolarDeck source (the committed `HEAD` of a checkout), the built desktop (`frontend/dist`) and the
backend's Python wheels for Ubuntu's Python. If Node.js or pip is missing on the build machine, that part is fetched on
first boot instead. Ubuntu installs with the console user `solardeck` (password printed by `build-iso.sh`). On first
boot `solardeck-firstboot.service` runs `firstboot-setup.sh`. It:

1. bridges the primary Ethernet port into `br0` with DHCP (`/etc/netplan/60-solardeck-bridge.yaml`; the installer's
   Netplan files are parked in `/etc/solardeck/netplan-installer/` and restored if the bridge gets no address),
2. points APT at `/opt/solardeck-offline/repo` (`/etc/apt/sources.list.d/solardeck-offline.list`); the Ubuntu mirrors
   in `ubuntu.sources` are enabled only when they can be reached, otherwise they stay listed with `Enabled: no`,
3. runs `install-hypervisor.sh --bundle /opt/solardeck-src --with-console-tui`: KVM/libvirt, Incus, OpenZFS, Samba and
   nginx from that repository, and SolarDeck from the bundled wheels and desktop, with no Node.js build,
3. puts the Incus `default` profile on `br0`, enables libvirtd, ZFS, smbd, nginx, `solardeck-backend` and
   `solardeck-console`, then disables itself.

The tty1 console then shows the web URL and the setup code for creating the administrator.


## Updates

Settings → System → Info shows *SolarOS* and tracks the `solaros` release branch.
**Install Update Now** can also upgrade the host's Ubuntu packages
(`include_system_packages`). Settings, users, data, keys and shares are kept; the root helper and the console
dashboard are refreshed with the code.
