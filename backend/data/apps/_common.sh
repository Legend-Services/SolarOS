# Prepended to every app install script. Runs as root inside the new Debian 12 container.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "==> Waiting for network"
for _ in $(seq 1 60); do getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done
getent hosts deb.debian.org >/dev/null || { echo "No network/DNS in container"; exit 1; }
echo "==> Updating base system"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg >/dev/null
