#!/usr/bin/env bash
# SolarDeck host helper. Installed as /usr/local/sbin/<prefix>-helper and reachable from the
# backend locally or through a forced-command SSH key. It runs a fixed allowlist of root-only operations.
# Every argument is re-validated here.
set -euo pipefail
# Host-side names follow the name this helper was installed under (<prefix>-helper).
PREFIX="$(basename "$0")"; PREFIX="${PREFIX%-helper}"; [[ "$PREFIX" =~ ^[a-z][a-z0-9-]*$ ]] || PREFIX=solardeck

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

# Default storage mapping: the backend runs on this host, so a bind mount kept in fstab is enough.
map_storage() {
  local ds="$1" mnt="$2" tgt="/mnt/storage/$1"
  mkdir -p "$tgt"
  mountpoint -q "$tgt" || mount --bind "$mnt" "$tgt"
  grep -q "^${mnt} ${tgt} " /etc/fstab || echo "${mnt} ${tgt} none bind,nofail,x-systemd.requires=zfs-mount.service 0 0" >>/etc/fstab
  echo "mapped ${tgt}"
}

# Drop the /mnt/storage bind mounts of a dataset (and its children) so it can be destroyed.
unmap_storage() {
  local ds="$1" mnt
  mnt="$(zfs get -H -o value mountpoint "$ds")"
  [[ "$mnt" == /* ]] || return 0
  awk -v m="$mnt" '$1 == m || index($1, m "/") == 1 {print $2}' /etc/fstab | sort -r | while read -r tgt; do
    umount "$tgt" 2>/dev/null || true; echo "unmapped $tgt"; done
  awk -v m="$mnt" '!($1 == m || index($1, m "/") == 1) || $3 != "none"' /etc/fstab >/etc/fstab.solardeck && mv /etc/fstab.solardeck /etc/fstab
}

# Edition-specific commands and overrides (installed next to this helper as <prefix>-helper-edition).
EDITION_FILE="$(dirname "$(readlink -f "$0")")/$(basename "$0")-edition"
# shellcheck source=/dev/null
[[ -r "$EDITION_FILE" ]] && . "$EDITION_FILE"

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
    [[ "$ds" =~ /(vm|base|subvol|basevol)-[0-9]+- ]] && die "guest disks are managed by the hypervisor, not here"
    unmap_storage "$ds"
    if [[ "${ARGS[2]:-}" == recursive ]]; then zfs destroy -r "$ds"; else zfs destroy "$ds"; fi
    ;;
  storage-map)
    ds="${ARGS[1]:-}"; [[ "$ds" =~ $DS_RE ]] || die "invalid dataset name"
    [[ "$(zfs get -H -o value type "$ds")" == filesystem ]] || die "not a filesystem dataset"
    [[ "$(zfs get -H -o value mounted "$ds")" == yes ]] || zfs mount "$ds"
    mnt="$(zfs get -H -o value mountpoint "$ds")"
    [[ "$mnt" == /* ]] || die "dataset has no mountpoint"
    map_storage "$ds" "$mnt"
    ;;
  zpool-scrub)
    pool="${ARGS[1]:-}"
    [[ "$pool" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]*$ ]] || die "invalid pool name"
    zpool scrub "$pool"
    ;;
  apt-upgrade)
    # Runs detached in a transient systemd unit: a dropped SSH session or backend restart can't kill dpkg midway.
    unit="${PREFIX}-apt-upgrade"
    if systemctl is-active -q "$unit"; then die "an upgrade is already running"; fi
    systemctl reset-failed "$unit" 2>/dev/null || true
    systemd-run --quiet --unit="$unit" --collect -p StandardOutput="truncate:/var/log/${PREFIX}-upgrade.log" \
      -p StandardError=inherit -E DEBIAN_FRONTEND=noninteractive -E APT_LISTCHANGES_FRONTEND=none \
      bash -c '{ apt-get update && apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade; }; echo "solardeck: exit $?"'
    echo "started"
    ;;
  apt-upgrade-status)
    echo "state:$(systemctl is-active "${PREFIX}-apt-upgrade" 2>/dev/null || true)"
    tail -n 400 "/var/log/${PREFIX}-upgrade.log" 2>/dev/null || true
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
  *)
    if declare -F edition_command >/dev/null && edition_command; then :; else die "unknown command"; fi
    ;;
esac
