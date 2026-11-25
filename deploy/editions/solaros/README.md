<p><img src="frontend/public/brand/solaros-logo.svg" alt="SolarOS" height="96"></p>

*SolarOS* is an open-source hypervisor operating system with a web desktop: QEMU/KVM virtual machines (libvirt),
Linux containers (Incus), OpenZFS storage, disks, backups, network services and a console dashboard on the
server's own monitor, on top of Ubuntu Server LTS.

- Install from the bootable ISO (`hypervisor/build-iso.sh`) or on an existing Ubuntu Server with
  `hypervisor/install-hypervisor.sh --with-console-tui`.
- Details: [hypervisor/README.md](hypervisor/README.md).
- **Manual:** the illustrated guide to every app and setting is built in: open Help & Support → Manual. The TopBar
  search (⌘K / Ctrl+K) finds apps, settings and help in one place.
- Security by design: two-factor sign-in with recovery codes, confirmation before destructive actions, encrypted
  secrets, a tamper-evident audit log and a 0–100 security score with 1-click host hardening (sysctl, key-only SSH,
  ufw default-deny, AppArmor, automatic security updates) in Control Panel → Security & Hardening; console option
  [7] Security & SSH Lock-Down.
- Updates: Control Panel → System & Updates (the `solaros` release branch). Settings, users, data and shares are kept.

Licensed under the GNU AGPLv3 or a commercial license, see [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md).
