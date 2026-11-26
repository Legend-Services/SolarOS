# Testing the SolarOS ISO inside a Proxmox VE VM

Part of SolarDeck for Proxmox VE (this file and `test-in-proxmox-vm.sh` are not shipped with SolarOS).

You can test the whole standalone edition (installer, first-boot setup, tty1 console, VMs, containers and ZFS) in a
nested VM on any Proxmox VE host. Run as root on the Proxmox host:

```bash
# 1. Build the ISO with an extra unattended entry for the test VM's first disk and copy it to local:iso
git clone https://github.com/Legend-Services/SolarOS.git && cd SolarOS
apt install -y xorriso squashfs-tools apt-utils   # + Node.js 22 and python3-pip to bundle the desktop and wheels
bash hypervisor/build-iso.sh --auto-disk /dev/sda --copy-to /var/lib/vz/template/iso

# 2. Create and start the test VM (q35, OVMF, host CPU, 4 cores, 8 GiB, 32 GB OS disk + two 32 GB data disks)
bash hypervisor/test-in-proxmox-vm.sh   # --vmid 950 --storage local-zfs --bridge vmbr0 --enable-nested --offline --dry-run
```

`test-in-proxmox-vm.sh` checks nested virtualization (`/sys/module/kvm_intel/parameters/nested` or `kvm_amd`) and
prints the `modprobe` command to turn it on (or does it with `--enable-nested` when no VM is running). It picks the
next free VMID from 900, `local-zfs` or `local-lvm` and `vmbr0` unless you pass them, and never touches an existing VM.
`--offline` creates `net0` with `link_down=1`, so the installer and the first boot run without any network: the proof
that the ISO is self-contained. Plug the cable back in afterwards with the `qm set ... link_down=0` line it prints.

Then open **Datacenter → your node → the VM → Console** (noVNC):

1. Choose **SolarOS - Automated VM Test Install** in the boot menu. The default entry,
   **Install SolarOS (Interactive Disk Selection)**, asks for the disk and is the one to use on real servers.
2. After the reboot, the first-boot setup bridges the NIC into `br0`, installs KVM/libvirt, Incus, OpenZFS and
   SolarDeck, and starts the tty1 console. It shows the web URL and the setup code for the administrator.
3. Sign in at `http://<VM IP>`, then build a ZFS mirror or RAIDZ1 from the two blank data disks in Storage & ZFS and
   check SMART health and disk benchmarks. Option **[6]** on the console checks `/dev/kvm`, nested virtualization,
   libvirtd, Incus, ZFS and `br0`.

Eject the ISO afterwards with `qm set <vmid> --ide2 none,media=cdrom`; remove the VM with `qm destroy <vmid> --purge`.
