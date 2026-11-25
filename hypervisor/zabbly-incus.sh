#!/usr/bin/env bash
# Incus from Zabbly (the upstream maintainers' current builds) instead of Ubuntu's frozen 6.0.0, whose CLI lacks newer
# options that container scripts use (e.g. `incus storage list -f csv,noheader`). Only incus-base (daemon + containers)
# and incus-client: SolarOS runs virtual machines through libvirt, so Incus' bundled QEMU (`incus`, ~240 MB) is skipped.
#   zabbly-incus.sh            add the repository (installer, before the package install); prints the package names
#   zabbly-incus.sh --upgrade  also move an existing install to Zabbly's Incus (SolarOS updates)
set -euo pipefail
HERE="$(dirname "$(readlink -f "$0")")"
SRC=/etc/apt/sources.list.d/zabbly-incus-stable.sources
. /etc/os-release
if [[ ! -f "$SRC" ]]; then
  if [[ "${ID:-}" != ubuntu ]] || ! curl -fsS -m 20 -o /dev/null "https://pkgs.zabbly.com/incus/stable/dists/${VERSION_CODENAME}/Release"; then
    echo "zabbly: no Incus repository for ${ID:-?} ${VERSION_CODENAME:-?} (or offline): keeping the distribution's Incus" >&2
    echo incus
    exit 0
  fi
  # The signing key ships with SolarOS (fingerprint 4EFC 5906 96CB 15B8 7C73 A3AD 82CC 8797 C838 DCFD).
  install -D -m 644 "$HERE/zabbly-incus.asc" /etc/apt/keyrings/zabbly.asc
  cat >"$SRC" <<SOURCES
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${VERSION_CODENAME}
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
SOURCES
  echo "zabbly: Incus repository added" >&2
fi
echo incus-base incus-client
if [[ "${1:-}" == --upgrade ]] && ! dpkg-query -W -f '${Version}' incus-base 2>/dev/null | grep -q '^1:'; then
  apt-get update -qq
  # Ubuntu's `incus` package is replaced (removed, not purged: /var/lib/incus, containers and pools stay).
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends incus-base incus-client incus- >/dev/null
  systemctl enable -q --now incus.socket incus.service 2>/dev/null || true
  echo "zabbly: Incus is now $(incus --version)" >&2
fi
