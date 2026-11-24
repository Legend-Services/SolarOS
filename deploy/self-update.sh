#!/usr/bin/env bash
# ProxmoxOS self-updater. Started by the backend (POST /api/system/update/apply) inside the ProxmoxOS container
# as a transient systemd unit:  self-update.sh <app dir> <repo url> <branch>
# Pulls the branch, syncs backend dependencies, rebuilds the frontend and reloads the services. Untracked files
# (backend/.env, backend/data/*.json, .venv, node_modules) are preserved. The PVE host helper is NOT updated here;
# re-run install.sh / deploy.sh on the host when deploy/proxmox-os-helper.sh changes.
set -Eeuo pipefail
trap 'echo "proxmox-os: exit 1"' ERR

APP_DIR="${1:?app dir}"; REPO_URL="${2:?repo url}"; BRANCH="${3:?branch}"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid branch"; echo "proxmox-os: exit 2"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
cd "$APP_DIR"

echo "==> Fetching ${BRANCH} from ${REPO_URL}"
if [[ ! -d .git ]]; then
  # First update of a deploy.sh/install.sh deployment: turn the copied tree into a checkout.
  git init -q -b "$BRANCH"
  git remote add origin "$REPO_URL"
fi
git fetch -q --depth 1 origin "$BRANCH"
git reset -q --hard FETCH_HEAD
git rev-parse HEAD >.build-commit
echo "    now at $(git log -1 --format='%h %s')"

echo "==> Syncing backend dependencies"
backend/.venv/bin/pip install -q -r backend/requirements.txt

echo "==> Building frontend"
(cd frontend && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null)

echo "==> Reloading services"
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/proxmox-os
nginx -t -q && (systemctl reload nginx || systemctl restart nginx)
install -m 644 deploy/proxmox-os-backend.service /etc/systemd/system/proxmox-os-backend.service
systemctl daemon-reload
systemctl restart proxmox-os-backend
echo "==> Update complete"
echo "proxmox-os: exit 0"
