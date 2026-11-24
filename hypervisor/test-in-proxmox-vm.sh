#!/usr/bin/env bash
# Boot the SolarOS installer ISO in a nested test VM on a Proxmox VE host (run as root on the host).
#   hypervisor/test-in-proxmox-vm.sh [--iso <path|storage:iso/name.iso>] [--vmid <id>] [--storage <pool>]
#                                    [--bridge vmbr0] [--enable-nested] [--dry-run]
# Defaults: --iso /var/lib/vz/template/iso/SolarOS-v<version>-amd64.iso, --vmid the next free id >= 900,
# --storage local-zfs or local-lvm (else the first pool that holds VM disks), --bridge vmbr0.
# The VM: q35 + OVMF (EFI disk), host CPU, 4 cores, 8 GiB RAM, a 32 GB OS disk (scsi0) plus two 32 GB data disks
# (scsi1, scsi2) for ZFS mirror / RAIDZ, SMART and benchmark tests, virtio NIC, the ISO on ide2, boot order scsi0;ide2
# (the blank disk falls through to the ISO once; after the install the disk boots, so no reinstall loop).
# --enable-nested turns on KVM nested virtualization on this host when it is off and no VM is running.
# An existing VMID is never touched. --dry-run prints the qm commands instead of running them.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "${ROOT}/frontend/package.json" 2>/dev/null | head -n1)"
ISO_DIR="/var/lib/vz/template/iso"
ISO="${ISO_DIR}/SolarOS-v${VERSION:-2.2.1}-amd64.iso"
VMID="" STORAGE="" BRIDGE="vmbr0" ENABLE_NESTED="" DRY=""

die() { echo "test-in-proxmox-vm: $*" >&2; exit 1; }
run() { if [[ -n "$DRY" ]]; then printf '  %q' "$@"; echo; else "$@"; fi; }
while (($#)); do
  case "$1" in
    --iso) ISO="${2:?}"; shift 2 ;;
    --vmid) VMID="${2:?}"; shift 2 ;;
    --storage) STORAGE="${2:?}"; shift 2 ;;
    --bridge) BRIDGE="${2:?}"; shift 2 ;;
    --enable-nested) ENABLE_NESTED=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
command -v qm >/dev/null && command -v pvesm >/dev/null || die "run this on a Proxmox VE host (qm/pvesm not found)"
[[ $EUID -eq 0 ]] || die "run as root"

# ---------------------------------------------------------------- 1. Nested virtualization on the host
if grep -qw vmx /proc/cpuinfo; then MOD=kvm_intel; elif grep -qw svm /proc/cpuinfo; then MOD=kvm_amd; else die "no VT-x/AMD-V on this host"; fi
NESTED="$(cat "/sys/module/${MOD}/parameters/nested" 2>/dev/null || echo "?")"
if [[ "$NESTED" == Y || "$NESTED" == 1 ]]; then
  echo "==> Nested virtualization: enabled (${MOD})"
elif [[ -n "$ENABLE_NESTED" && -z "$DRY" ]]; then
  qm list 2>/dev/null | awk 'NR > 1 && $3 == "running" {found = 1} END {exit !found}' \
    && die "VMs are running; stop them or reboot after: echo 'options ${MOD} nested=1' > /etc/modprobe.d/kvm-nested.conf"
  echo "options ${MOD} nested=1" >/etc/modprobe.d/kvm-nested.conf
  modprobe -r "$MOD" && modprobe "$MOD"
  echo "==> Nested virtualization: enabled now and on every boot (${MOD})"
else
  echo "!!  Nested virtualization is OFF: SolarDeck boots, but its own VMs cannot use KVM. To enable it (no VMs running):"
  echo "      echo 'options ${MOD} nested=1' > /etc/modprobe.d/kvm-nested.conf && modprobe -r ${MOD} && modprobe ${MOD}"
  echo "    or rerun this script with --enable-nested."
fi

# ---------------------------------------------------------------- 2. Inputs
if [[ "$ISO" == *:* ]]; then
  ISO_VOL="$ISO"  # already a Proxmox volume id (storage:iso/name.iso)
else
  [[ -f "$ISO" ]] || die "ISO not found: ${ISO} (build it with hypervisor/build-iso.sh --deploy-to-pve)"
  if [[ "$(dirname "$(realpath "$ISO")")" != "$ISO_DIR" ]]; then
    echo "==> Copying $(basename "$ISO") to ${ISO_DIR}"
    run cp "$ISO" "${ISO_DIR}/"
  fi
  ISO_VOL="local:iso/$(basename "$ISO")"
fi
if [[ -z "$STORAGE" ]]; then
  POOLS="$(pvesm status --content images 2>/dev/null | awk 'NR > 1 && $3 == "active" {print $1}')"
  for s in local-zfs local-lvm $POOLS; do grep -qx "$s" <<<"$POOLS" && STORAGE="$s" && break; done
  [[ -n "$STORAGE" ]] || die "no active storage for VM disks; pass --storage <pool>"
fi
[[ -d "/sys/class/net/${BRIDGE}" || -n "$DRY" ]] || die "bridge ${BRIDGE} not found; pass --bridge <vmbr>"
if [[ -z "$VMID" ]]; then
  VMID=900
  until pvesh get /cluster/nextid --vmid "$VMID" >/dev/null 2>&1; do
    VMID=$((VMID + 1)); ((VMID < 100000)) || die "no free VMID >= 900 (is pvesh working?)"
  done
else
  [[ "$VMID" =~ ^[0-9]+$ ]] || die "invalid --vmid"
  pvesh get /cluster/nextid --vmid "$VMID" >/dev/null 2>&1 || die "VMID ${VMID} is already in use"
fi

# ---------------------------------------------------------------- 3. VM
echo "==> Creating VM ${VMID} (storage ${STORAGE}, bridge ${BRIDGE}, ISO ${ISO_VOL})"
DISK="discard=on,ssd=1,iothread=1"
run qm create "$VMID" --name "solaros-test-${VMID}" --ostype l26 --machine q35 --bios ovmf \
  --efidisk0 "${STORAGE}:1,efitype=4m,pre-enrolled-keys=0" --cpu host --cores 4 --sockets 1 --memory 8192 --balloon 0 \
  --scsihw virtio-scsi-single --scsi0 "${STORAGE}:32,${DISK}" --scsi1 "${STORAGE}:32,${DISK}" --scsi2 "${STORAGE}:32,${DISK}" \
  --net0 "virtio,bridge=${BRIDGE}" --ide2 "${ISO_VOL},media=cdrom" --boot "order=scsi0;ide2" --vga std --agent 0 \
  --description "SolarOS installer test VM (created by hypervisor/test-in-proxmox-vm.sh)"
run qm start "$VMID"

NODE="$(hostname -s)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

SolarOS test VM ${VMID} is booting.
  1. Open the noVNC console: https://${IP:-<proxmox-host>}:8006 -> ${NODE} -> ${VMID} (solaros-test-${VMID}) -> Console
  2. In the boot menu pick "SolarOS - Automated VM Test Install" (ISO built with --auto-disk /dev/sda)
     or "Install SolarOS (Interactive Disk Selection)" and choose the 32 GB disk on scsi0.
  3. After the reboot, first-boot setup runs (watch it on the console); then the SolarOS console on tty1 shows the
     web URL and the initial admin password. scsi1 + scsi2 are blank for a ZFS mirror / RAIDZ test in Storage & ZFS.
  Find the VM's address on the console screen (br0 gets its own MAC, so the NIC's MAC does not show it in ARP).
  Eject the ISO after the install:  qm set ${VMID} --ide2 none,media=cdrom
  Remove the test VM:               qm stop ${VMID} && qm destroy ${VMID} --purge
EOF
