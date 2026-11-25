#!/usr/bin/env bash
# SolarDeck for Proxmox VE: host-helper commands that need pct/qm. install.sh installs this file next to the helper as
# /usr/local/sbin/<prefix>-helper-edition; the helper sources it, so it may override map_storage / unmap_storage and
# handle extra commands in edition_command (return 1 for a command it does not know).

pos_ct() {
  local ct
  ct="$(pct list | awk -v p="$PREFIX" '$NF=="solardeck" || $NF==p {print $1; exit}')"
  [[ -n "$ct" ]] || die "SolarDeck container not found"
  echo "$ct"
}

# Drop the container mount points of a dataset (and its children) so it can be destroyed.
unmap_storage() {
  local ds="$1" ct mnt key src
  mnt="$(zfs get -H -o value mountpoint "$ds")"
  [[ "$mnt" == /* ]] || return 0
  ct="$(pos_ct)"
  while IFS=': ' read -r key src; do
    src="${src%%,*}"
    if [[ "$src" == "$mnt" || "$src" == "$mnt"/* ]]; then pct set "$ct" -delete "$key"; echo "unmapped $key"; fi
  done < <(pct config "$ct" | grep -E '^mp[0-9]+:')
}

# Bind-mount a dataset into the SolarDeck container at /mnt/storage/<dataset> (same layout as install.sh).
map_storage() {
  local ds="$1" mnt="$2" ct i
  ct="$(pos_ct)"
  if pct config "$ct" | sed -n 's/^mp[0-9]*: \([^,]*\),.*/\1/p' | grep -Fxq "$mnt"; then echo "already mapped"; exit 0; fi
  i=0; while pct config "$ct" | grep -q "^mp${i}:"; do i=$((i + 1)); done
  zfs set acltype=posixacl xattr=sa "$ds"
  # Unprivileged container root is uid/gid 100000 on the host; additive ACLs leave host ownership untouched.
  setfacl -R -P -m u:100000:rwX,g:100000:rwX,d:u:100000:rwX,d:g:100000:rwX "$mnt"
  pct set "$ct" "-mp${i}" "${mnt},mp=/mnt/storage/${ds}"
  echo "mapped mp${i}"
}

app_vmid() {
  local vmid="${ARGS[1]:-}"
  [[ "$vmid" =~ ^[0-9]+$ ]] || die "invalid vmid"
  # Only containers created by the App Center can be touched.
  pct config "$vmid" | grep -Eq "^tags:.*${PREFIX}-app" || die "container $vmid is not a SolarDeck app"
  echo "$vmid"
}

# Guests created by the SolarDeck VM/LXC wizards carry this tag; only they get root-only options.
guest_vmid() {
  local vmid="${ARGS[1]:-}" kind="$1"
  [[ "$vmid" =~ ^[0-9]+$ ]] || die "invalid vmid"
  if [[ "$kind" == lxc ]]; then pct config "$vmid"; else qm config "$vmid"; fi | grep -Eq "^tags:.*${PREFIX}-guest" \
    || die "guest $vmid was not created by SolarDeck"
  echo "$vmid"
}

edition_command() {
  case "$CMD" in
  app-configure)
    vmid="$(app_vmid)"
    for opt in "${ARGS[@]:2}"; do
      case "$opt" in
        storage)
          # Reuse the bind mounts of the SolarDeck container, so apps see the same /mnt/storage layout.
          src="$(pct list | awk -v p="$PREFIX" '$NF=="solardeck" || $NF==p {print $1; exit}')"
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
    *) return 1 ;;
  esac
}
