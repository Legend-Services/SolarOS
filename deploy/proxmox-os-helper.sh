#!/usr/bin/env bash
# ProxmoxOS host helper. Installed by install.sh at /usr/local/sbin/proxmox-os-helper and reachable from the
# ProxmoxOS container only through a forced-command SSH key. It runs a fixed allowlist of root-only operations
# that the Proxmox API token cannot do. Every argument is re-validated here.
set -euo pipefail

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then read -r -a ARGS <<<"$SSH_ORIGINAL_COMMAND"; else ARGS=("$@"); fi
CMD="${ARGS[0]:-}"
die() { echo "error: $*" >&2; exit 2; }

DS_RE='^[A-Za-z0-9][A-Za-z0-9_.:/-]*$'
SNAP_RE='^[A-Za-z0-9][A-Za-z0-9_.:/-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*$'
snap_arg() { [[ "${ARGS[1]:-}" =~ $SNAP_RE ]] || die "invalid snapshot name"; echo "${ARGS[1]}"; }

app_vmid() {
  local vmid="${ARGS[1]:-}"
  [[ "$vmid" =~ ^[0-9]+$ ]] || die "invalid vmid"
  # Only containers created by the App Center can be touched.
  pct config "$vmid" | grep -Eq '^tags:.*proxmox-os-app' || die "container $vmid is not a ProxmoxOS app"
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
  app-configure)
    vmid="$(app_vmid)"
    for opt in "${ARGS[@]:2}"; do
      case "$opt" in
        storage)
          # Reuse the bind mounts of the ProxmoxOS container, so apps see the same /mnt/storage layout.
          src="$(pct list | awk '$NF=="proxmox-os" {print $1; exit}')"
          [[ -n "$src" ]] || die "proxmox-os container not found"
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
  app-provision)
    vmid="$(app_vmid)"
    # Install script arrives on stdin.
    pct exec "$vmid" -- env DEBIAN_FRONTEND=noninteractive bash -s
    ;;
  *)
    die "unknown command"
    ;;
esac
