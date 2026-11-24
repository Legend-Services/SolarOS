#!/usr/bin/env bash
# Deploy this checkout of SolarDeck onto a Proxmox VE host over SSH, without pushing to GitHub first.
#   ./deploy.sh [--host <IP>] [--user <USER>]
# Streams the repository to /tmp/proxmox-os-deploy on the host and runs install.sh there, which creates
# (or updates) the "proxmox-os" LXC container. Needs key-based SSH access; a non-root user needs sudo.
set -euo pipefail

HOST="192.168.68.220"
SSH_USER="root"
REMOTE_DIR="/tmp/proxmox-os-deploy"

usage() { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --user) SSH_USER="${2:?--user needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SSH_USER}@${HOST}"
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$TARGET")
SUDO=""; [[ "$SSH_USER" == root ]] || SUDO="sudo"

echo "==> Checking ${TARGET}"
"${SSH[@]}" 'command -v pveversion >/dev/null && pveversion' \
  || { echo "Cannot reach ${TARGET} over SSH, or it is not a Proxmox VE host." >&2; exit 1; }

echo "==> Uploading $(basename "$ROOT") to ${HOST}:${REMOTE_DIR}"
# COPYFILE_DISABLE stops BSD tar from adding ._* resource-fork files.
COPYFILE_DISABLE=1 tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=.venv --exclude=.env \
  --exclude=dist --exclude=__pycache__ --exclude=.claude --exclude=backend/data/schedules.json --exclude=backend/data/security.json --exclude=backend/data/user_preferences.json --exclude=backend/data/benchmarks.json --exclude=backend/data/local_ai.json --exclude=backend/data/ai_chats.json --exclude=backend/data/themes --exclude=backend/.ssh -czf - . \
  | "${SSH[@]}" "rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR} && tar -xzf - -C ${REMOTE_DIR}"

# No .git is uploaded; record the commit so the System Update card can show it and compare against GitHub.
COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
[[ -n "$COMMIT" ]] && "${SSH[@]}" "echo ${COMMIT} > ${REMOTE_DIR}/.build-commit"

echo "==> Running install.sh on ${HOST}"
"${SSH[@]}" "${SUDO} bash ${REMOTE_DIR}/install.sh"

# install.sh authorizes the backend's root key (backend/.ssh/id_ed25519); prove the bridge works end to end.
echo "==> Verifying the root SSH bridge from the SolarDeck container"
"${SSH[@]}" "${SUDO} bash -s" <<'EOF'
set -euo pipefail
CT="$(pct list | awk '$NF=="solardeck" || $NF=="proxmox-os" || $NF=="proxmos-os" {print $1; exit}')"
IP="$(ip -4 -o addr show dev vmbr0 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1 || true)"
[[ -n "$IP" ]] || IP="$(hostname -I | awk '{print $1}')"
K=/opt/proxmox-os/backend/.ssh
pct exec "$CT" -- ssh -i "$K/id_ed25519" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 "root@$IP" 'echo "    bridge OK: $(whoami)@$(hostname)"'
EOF
