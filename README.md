<p><img src="frontend/public/brand/solaros-logo.svg" alt="SolarOS" height="96"></p>

*SolarOS* is an open-source hypervisor operating system with a web desktop: QEMU/KVM virtual machines (libvirt),
Linux containers (Incus), OpenZFS storage, disks, backups, network services and a console dashboard on the
server's own monitor, on top of Ubuntu Server LTS.

- Install from the bootable ISO (`hypervisor/build-iso.sh`) or on an existing Ubuntu Server with
  `hypervisor/install-hypervisor.sh --with-console-tui`.
- Details: [hypervisor/README.md](hypervisor/README.md).
- Updates: Control Panel → System & Updates (the `solaros` release branch). Settings, users, data and shares are kept.

Licensed under the GNU AGPLv3 or a commercial license, see [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md).
