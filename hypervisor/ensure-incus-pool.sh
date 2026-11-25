#!/usr/bin/env bash
# Make sure Incus has a storage pool and that the default profile puts container root disks on it.
# Run by install-hypervisor.sh and by every SolarOS update, so an install whose first Incus init stopped halfway heals.
set -euo pipefail
command -v incus >/dev/null || exit 0
if [[ -z "$(incus storage list --format csv 2>/dev/null)" ]]; then
  incus storage create default dir >/dev/null
  echo "incus: created storage pool default (dir)"
fi
pool="$(incus storage list --format csv | head -n1 | cut -d, -f1)"
if ! incus profile device get default root pool >/dev/null 2>&1; then
  incus profile device add default root disk path=/ pool="$pool" >/dev/null
  echo "incus: default profile root disk on pool ${pool}"
fi
