#!/usr/bin/env bash
# ProxmoxOS self-updater. Started by the backend (POST /api/system/updates/apply|rollback) inside the ProxmoxOS
# container as a transient systemd unit:  self-update.sh <app dir> <repo url> <branch> [<target commit>]
# Without a target it updates to the tip of <branch>; with one it checks out that commit (update or downgrade).
# User state is snapshotted first and restored after the checkout: backend/.env, backend/data/, backend/.ssh/ and
# the Samba share config. New .env keys from deploy/env-defaults are appended; existing values are never changed.
# The PVE host helper is NOT updated here; re-run install.sh on the host when deploy/proxmox-os-helper.sh changes.
set -Eeuo pipefail
trap 'echo "proxmox-os: exit 1"' ERR

APP_DIR="${1:?app dir}"; REPO_URL="${2:?repo url}"; BRANCH="${3:?branch}"; TARGET="${4:-}"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid branch"; echo "proxmox-os: exit 2"; exit 2; }
[[ -z "$TARGET" || "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid target"; echo "proxmox-os: exit 2"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
cd "$APP_DIR"
# Private repositories: authenticate with GITHUB_TOKEN from backend/.env when it is set.
TOKEN="$(sed -n 's/^GITHUB_TOKEN=//p' backend/.env 2>/dev/null | head -n1 || true)"
AUTH=(); [[ -n "$TOKEN" ]] && AUTH=(-c "http.https://github.com/.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)")
# The tree may be owned by another uid (deploy.sh tarball); git refuses that without safe.directory.
git() { command git -c safe.directory='*' "${AUTH[@]}" "$@"; }

STATE=/tmp/proxmox-os-state-backup
echo "==> Saving settings and data to ${STATE}"
rm -rf "$STATE" && mkdir -p "$STATE"
[[ -f backend/.env ]] && cp -a backend/.env "$STATE/.env"
[[ -d backend/data ]] && cp -a backend/data "$STATE/data"
[[ -d backend/.ssh ]] && cp -a backend/.ssh "$STATE/.ssh"
[[ -f /etc/samba/proxmox-os-shares.conf ]] && cp -a /etc/samba/proxmox-os-shares.conf "$STATE/"

echo "==> Fetching ${BRANCH} and tags from ${REPO_URL}"
if [[ ! -d .git ]]; then
  # First update of a deploy.sh deployment: turn the copied tree into a checkout.
  git init -q -b "$BRANCH"
  git remote add origin "$REPO_URL"
fi
SHALLOW=(); [[ -f .git/shallow ]] && SHALLOW=(--unshallow)
git fetch -q --tags --force "${SHALLOW[@]}" origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
TARGET="${TARGET:-$(git rev-parse "origin/${BRANCH}")}"
git -c advice.detachedHead=false checkout -q -B "$BRANCH" "$TARGET"
git reset -q --hard "$TARGET"
git rev-parse HEAD >.build-commit
echo "    now at $(git log -1 --format='%h %s')"

echo "==> Restoring settings and data"
[[ -f "$STATE/.env" ]] && cp -a "$STATE/.env" backend/.env
[[ -d "$STATE/.ssh" ]] && { mkdir -p backend/.ssh; cp -a "$STATE/.ssh/." backend/.ssh/; }
if [[ -d "$STATE/data" ]]; then
  # User files (schedules, security, preferences, ...) win; files shipped by the release stay at the target version.
  (cd "$STATE/data" && find . -type f) | while read -r f; do
    dest="backend/data/${f#./}"
    git ls-files --error-unmatch "$dest" >/dev/null 2>&1 || { mkdir -p "$(dirname "$dest")"; cp -a "$STATE/data/$f" "$dest"; }
  done
fi
[[ -f deploy/merge-env.sh ]] && bash deploy/merge-env.sh backend/.env deploy/env-defaults

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
