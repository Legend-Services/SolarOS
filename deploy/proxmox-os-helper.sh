#!/usr/bin/env bash
# SolarDeck host helper. Installed by install.sh at /usr/local/sbin/proxmox-os-helper and reachable from the
# SolarDeck container only through a forced-command SSH key. It runs a fixed allowlist of root-only operations
# that the Proxmox API token cannot do. Every argument is re-validated here.
set -euo pipefail

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then read -r -a ARGS <<<"$SSH_ORIGINAL_COMMAND"; else ARGS=("$@"); fi
CMD="${ARGS[0]:-}"
die() { echo "error: $*" >&2; exit 2; }

DS_RE='^[A-Za-z0-9][A-Za-z0-9_.:/-]*$'
SNAP_RE='^[A-Za-z0-9][A-Za-z0-9_.:/-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*$'
snap_arg() { [[ "${ARGS[1]:-}" =~ $SNAP_RE ]] || die "invalid snapshot name"; echo "${ARGS[1]}"; }

CHILD_DS_RE='^[A-Za-z0-9][A-Za-z0-9_.:-]*/[A-Za-z0-9_.:/-]*[A-Za-z0-9_.:-]$'
child_ds_arg() { [[ "${ARGS[1]:-}" =~ $CHILD_DS_RE ]] || die "invalid dataset name (pool roots are not allowed)"; echo "${ARGS[1]}"; }

# Allowlisted ZFS properties for zfs-create / zfs-set.
prop_ok() {
  local k="${1%%=*}" v="${1#*=}"
  case "$k" in
    compression) [[ "$v" =~ ^(on|off|lz4|zstd|gzip|zle)$ ]] ;;
    recordsize) [[ "$v" =~ ^(4|8|16|32|64|128|256|512)K$|^1M$ ]] ;;
    quota) [[ "$v" =~ ^(none|[0-9]+[KMGTP]?)$ ]] ;;
    atime) [[ "$v" =~ ^(on|off)$ ]] ;;
    mountpoint) [[ "$v" =~ ^(none|legacy|/[A-Za-z0-9_./-]*)$ && "$v" != *..* ]] ;;
    *) false ;;
  esac || die "invalid property $1"
}

pos_ct() {
  local ct
  ct="$(pct list | awk '$NF=="solardeck" || $NF=="proxmox-os" || $NF=="proxmos-os" {print $1; exit}')"
  [[ -n "$ct" ]] || die "SolarDeck container not found"
  echo "$ct"
}

# Drop the container mount point of a dataset (and its children) so it can be destroyed.
unmap_storage() {
  local ds="$1" ct mnt key src
  mnt="$(zfs get -H -o value mountpoint "$ds")"
  [[ "$mnt" == /* ]] || return 0
  if ! command -v pct >/dev/null; then
    # SolarOS: drop the /mnt/storage bind mounts of the dataset (and its children).
    awk -v m="$mnt" '$1 == m || index($1, m "/") == 1 {print $2}' /etc/fstab | sort -r | while read -r tgt; do
      umount "$tgt" 2>/dev/null || true; echo "unmapped $tgt"; done
    awk -v m="$mnt" '!($1 == m || index($1, m "/") == 1) || $3 != "none"' /etc/fstab >/etc/fstab.solardeck && mv /etc/fstab.solardeck /etc/fstab
    return 0
  fi
  ct="$(pos_ct)"
  while IFS=': ' read -r key src; do
    src="${src%%,*}"
    if [[ "$src" == "$mnt" || "$src" == "$mnt"/* ]]; then pct set "$ct" -delete "$key"; echo "unmapped $key"; fi
  done < <(pct config "$ct" | grep -E '^mp[0-9]+:')
}

app_vmid() {
  local vmid="${ARGS[1]:-}"
  [[ "$vmid" =~ ^[0-9]+$ ]] || die "invalid vmid"
  # Only containers created by the App Center can be touched.
  pct config "$vmid" | grep -Eq '^tags:.*proxmox-os-app' || die "container $vmid is not a SolarDeck app"
  echo "$vmid"
}

# Guests created by the SolarDeck VM/LXC wizards carry this tag; only they get root-only options.
guest_vmid() {
  local vmid="${ARGS[1]:-}" kind="$1"
  [[ "$vmid" =~ ^[0-9]+$ ]] || die "invalid vmid"
  if [[ "$kind" == lxc ]]; then pct config "$vmid"; else qm config "$vmid"; fi | grep -Eq '^tags:.*proxmox-os-guest' \
    || die "guest $vmid was not created by SolarDeck"
  echo "$vmid"
}

case "$CMD" in
  zfs-list)
    zfs list -H -p -t filesystem,volume,snapshot -o name,type,used,refer,creation,mountpoint
    ;;
  zfs-snapshot)
    s="$(snap_arg)"; zfs snapshot "$s"
    ;;
  zfs-rollback)
    s="$(snap_arg)"
    # "force" adds -r, which destroys snapshots newer than the target.
    if [[ "${ARGS[2]:-}" == force ]]; then zfs rollback -r "$s"; else zfs rollback "$s"; fi
    ;;
  zfs-destroy)
    s="$(snap_arg)"; zfs destroy "$s"
    ;;
  zfs-datasets)
    zfs list -H -p -t filesystem,volume -o name,type,used,avail,refer,mountpoint,compression,recordsize,quota,atime,volsize
    ;;
  zfs-create)
    ds="$(child_ds_arg)"; opts=(); vol=""
    for kv in "${ARGS[@]:2}"; do
      if [[ "$kv" =~ ^volsize=([0-9]+[KMGTP]?)$ ]]; then vol="${BASH_REMATCH[1]}"; else prop_ok "$kv"; opts+=(-o "$kv"); fi
    done
    if [[ -n "$vol" ]]; then zfs create -V "$vol" "${opts[@]}" "$ds"; else zfs create "${opts[@]}" "$ds"; fi
    ;;
  zfs-set)
    ds="${ARGS[1]:-}"; [[ "$ds" =~ $DS_RE ]] || die "invalid dataset name"
    (( ${#ARGS[@]} > 2 )) || die "no properties"
    for kv in "${ARGS[@]:2}"; do prop_ok "$kv"; done
    zfs set "${ARGS[@]:2}" "$ds"
    ;;
  zfs-destroy-dataset)
    ds="$(child_ds_arg)"
    [[ "$ds" =~ /(vm|base|subvol|basevol)-[0-9]+- ]] && die "guest disks are managed by Proxmox, not here"
    unmap_storage "$ds"
    if [[ "${ARGS[2]:-}" == recursive ]]; then zfs destroy -r "$ds"; else zfs destroy "$ds"; fi
    ;;
  storage-map)
    # Bind-mount a dataset into the SolarDeck container at /mnt/storage/<dataset> (same layout as install.sh).
    ds="${ARGS[1]:-}"; [[ "$ds" =~ $DS_RE ]] || die "invalid dataset name"
    [[ "$(zfs get -H -o value type "$ds")" == filesystem ]] || die "not a filesystem dataset"
    [[ "$(zfs get -H -o value mounted "$ds")" == yes ]] || zfs mount "$ds"
    mnt="$(zfs get -H -o value mountpoint "$ds")"
    [[ "$mnt" == /* ]] || die "dataset has no mountpoint"
    if ! command -v pct >/dev/null; then
      # SolarOS: the backend runs on this host, so a bind mount (kept in fstab) is enough.
      tgt="/mnt/storage/${ds}"
      mkdir -p "$tgt"
      mountpoint -q "$tgt" || mount --bind "$mnt" "$tgt"
      grep -q "^${mnt} ${tgt} " /etc/fstab || echo "${mnt} ${tgt} none bind,nofail,x-systemd.requires=zfs-mount.service 0 0" >>/etc/fstab
      echo "mapped ${tgt}"; exit 0
    fi
    ct="$(pos_ct)"
    if pct config "$ct" | sed -n 's/^mp[0-9]*: \([^,]*\),.*/\1/p' | grep -Fxq "$mnt"; then echo "already mapped"; exit 0; fi
    i=0; while pct config "$ct" | grep -q "^mp${i}:"; do i=$((i + 1)); done
    zfs set acltype=posixacl xattr=sa "$ds"
    # Unprivileged container root is uid/gid 100000 on the host; additive ACLs leave host ownership untouched.
    setfacl -R -P -m u:100000:rwX,g:100000:rwX,d:u:100000:rwX,d:g:100000:rwX "$mnt"
    pct set "$ct" "-mp${i}" "${mnt},mp=/mnt/storage/${ds}"
    echo "mapped mp${i}"
    ;;
  zpool-scrub)
    pool="${ARGS[1]:-}"
    [[ "$pool" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || die "invalid pool name"
    zpool scrub "$pool"
    ;;
  apt-upgrade)
    # Runs detached in a transient systemd unit: a dropped SSH session or backend restart can't kill dpkg midway.
    unit=proxmox-os-apt-upgrade
    if systemctl is-active -q "$unit"; then die "an upgrade is already running"; fi
    systemctl reset-failed "$unit" 2>/dev/null || true
    systemd-run --quiet --unit="$unit" --collect -p StandardOutput=truncate:/var/log/proxmox-os-upgrade.log \
      -p StandardError=inherit -E DEBIAN_FRONTEND=noninteractive -E APT_LISTCHANGES_FRONTEND=none \
      bash -c '{ apt-get update && apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade; }; echo "proxmox-os: exit $?"'
    echo "started"
    ;;
  apt-upgrade-status)
    echo "state:$(systemctl is-active proxmox-os-apt-upgrade 2>/dev/null || true)"
    tail -n 400 /var/log/proxmox-os-upgrade.log 2>/dev/null || true
    ;;
  hw-info)
    # GPU probe for the telemetry API: "dri:<render node>:<PCI vendor>" and "nvidia:<csv>" lines.
    for dev in /dev/dri/renderD*; do
      [[ -e "$dev" ]] || continue
      echo "dri:${dev}:$(cat "/sys/class/drm/$(basename "$dev")/device/vendor" 2>/dev/null || true)"
    done
    if command -v nvidia-smi >/dev/null; then
      nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw \
        --format=csv,noheader,nounits 2>/dev/null | sed 's/^/nvidia:/' || true
    fi
    ;;
  app-configure)
    vmid="$(app_vmid)"
    for opt in "${ARGS[@]:2}"; do
      case "$opt" in
        storage)
          # Reuse the bind mounts of the SolarDeck container, so apps see the same /mnt/storage layout.
          src="$(pct list | awk '$NF=="solardeck" || $NF=="proxmox-os" || $NF=="proxmos-os" {print $1; exit}')"
          [[ -n "$src" ]] || die "SolarDeck container not found"
          i=0
          while read -r mp; do
            [[ "$mp" == /* ]] || continue
            pct set "$vmid" "-mp${i}" "$mp"
            i=$((i + 1))
          done < <(pct config "$src" | sed -n 's/^mp[0-9]*: //p')
          echo "storage: $i mount(s)"
          ;;
        igpu)
          i=0
          for dev in /dev/dri/renderD* /dev/dri/card*; do
            [[ -e "$dev" ]] || continue
            pct set "$vmid" "-dev${i}" "${dev},mode=0666"
            i=$((i + 1))
          done
          (( i )) || die "no /dev/dri devices on host"
          echo "igpu: $i device(s)"
          ;;
        keyctl)
          pct set "$vmid" -features nesting=1,keyctl=1
          echo "features: nesting=1,keyctl=1"
          ;;
        *) die "unknown option $opt" ;;
      esac
    done
    ;;
  guest-hostpci)
    # PCIe passthrough of raw host devices is root-only in PVE. Needs IOMMU enabled on the host.
    vmid="$(guest_vmid qemu)"; i=0
    for id in "${ARGS[@]:2}"; do
      [[ "$id" =~ ^([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}(\.[0-7])?$ ]] || die "invalid PCI id $id"
      qm set "$vmid" "-hostpci${i}" "${id},pcie=1" >/dev/null
      echo "hostpci${i}: ${id}"
      i=$((i + 1))
    done
    (( i )) || die "no PCI devices given"
    ;;
  guest-bindmount)
    # Bind-mount a ZFS dataset into a wizard-created container at /mnt/storage/<dataset>.
    vmid="$(guest_vmid lxc)"; ds="${ARGS[2]:-}"
    [[ "$ds" =~ $DS_RE ]] || die "invalid dataset name"
    [[ "$(zfs get -H -o value type "$ds")" == filesystem ]] || die "not a filesystem dataset"
    [[ "$(zfs get -H -o value mounted "$ds")" == yes ]] || zfs mount "$ds"
    mnt="$(zfs get -H -o value mountpoint "$ds")"
    [[ "$mnt" == /* ]] || die "dataset has no mountpoint"
    i=0; while pct config "$vmid" | grep -q "^mp${i}:"; do i=$((i + 1)); done
    zfs set acltype=posixacl xattr=sa "$ds"
    setfacl -R -P -m u:100000:rwX,g:100000:rwX,d:u:100000:rwX,d:g:100000:rwX "$mnt"
    pct set "$vmid" "-mp${i}" "${mnt},mp=/mnt/storage/${ds}"
    echo "mapped mp${i}"
    ;;
  app-provision)
    vmid="$(app_vmid)"
    # Install script arrives on stdin.
    pct exec "$vmid" -- env DEBIAN_FRONTEND=noninteractive bash -s
    ;;
  *)
    die "unknown command"
    ;;
esac
