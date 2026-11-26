# Docker Engine & Compose. Used as the isolated runtime container (after _common.sh) and, as is, on the host.
set -euo pipefail
if command -v docker >/dev/null 2>&1 && systemctl is-active -q docker; then
  echo "==> Docker Engine is already running"
else
  mkdir -p /etc/docker
  # Keep the host's FORWARD policy: Docker would otherwise drop forwarded traffic of VMs and containers on the bridges.
  [ -s /etc/docker/daemon.json ] || printf '{\n  "ip-forward-no-drop": true,\n  "log-driver": "local"\n}\n' >/etc/docker/daemon.json
  echo "==> Installing Docker Engine and Compose"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker
fi
docker --version
docker compose version
echo "==> Docker Engine ready"
