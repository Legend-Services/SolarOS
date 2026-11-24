#!/usr/bin/env bash
# SolarDeck self-updater. Started by the backend (POST /api/system/updates/apply|rollback) inside the SolarDeck
# container (or on a SolarOS host) as a transient systemd unit:
#   self-update.sh <app dir> <repo url> <branch> [<target commit>] [<system packages 0|1>]
# Without a target it updates to the tip of <branch>; with one it checks out that commit (update or downgrade).
# Both editions update from the same branch; HYPERVISOR_DRIVER in backend/.env picks the service layout. With
# "system packages" = 1 (standalone hypervisor only) the host's APT packages are upgraded as well.
# User state is snapshotted first and restored after the checkout: backend/.env (PVE_*, ADMIN_PASSWORD, JWT_SECRET,
# GITHUB_TOKEN, HYPERVISOR_DRIVER, ...), backend/data/, backend/.ssh/ and
# the Samba share config. New .env keys from deploy/env-defaults are appended; existing values are never changed.
# The PVE host helper is NOT updated here; re-run install.sh on the host when deploy/proxmox-os-helper.sh changes.
set -Eeuo pipefail
trap 'echo "proxmox-os: exit 1"' ERR

APP_DIR="${1:?app dir}"; REPO_URL="${2:?repo url}"; BRANCH="${3:?branch}"; TARGET="${4:-}"; SYSTEM_PACKAGES="${5:-0}"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid branch"; echo "proxmox-os: exit 2"; exit 2; }
[[ -z "$TARGET" || "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid target"; echo "proxmox-os: exit 2"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
cd "$APP_DIR"
DRIVER="$(sed -n 's/^HYPERVISOR_DRIVER=//p' backend/.env 2>/dev/null | tail -n1 | tr -d "'\"" || true)"
DRIVER="${DRIVER:-proxmox}"
echo "==> Edition: $([[ "$DRIVER" == native_ubuntu ]] && echo "SolarOS" || echo "SolarDeck for Proxmox VE") (driver ${DRIVER})"
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
# -f: a deploy.sh install has files that differ from HEAD; untracked state (.env, data/) is never touched.
git -c advice.detachedHead=false checkout -q -f -B "$BRANCH" "$TARGET"
git reset -q --hard "$TARGET"
git rev-parse HEAD >.build-commit
echo "    now at $(git log -1 --format='%h %s')"

echo "==> Restoring settings and data"
[[ -f "$STATE/.env" ]] && cp -a "$STATE/.env" backend/.env
[[ -d "$STATE/.ssh" ]] && { mkdir -p backend/.ssh; cp -a "$STATE/.ssh/." backend/.ssh/; }
[[ -f "$STATE/proxmox-os-shares.conf" && ! -f /etc/samba/proxmox-os-shares.conf ]] \
  && cp -a "$STATE/proxmox-os-shares.conf" /etc/samba/proxmox-os-shares.conf
if [[ -d "$STATE/data" ]]; then
  # User files (schedules, security, preferences, ...) win; files shipped by the release stay at the target version.
  (cd "$STATE/data" && find . -type f) | while read -r f; do
    dest="backend/data/${f#./}"
    git ls-files --error-unmatch "$dest" >/dev/null 2>&1 || { mkdir -p "$(dirname "$dest")"; cp -a "$STATE/data/$f" "$dest"; }
  done
fi
[[ -f deploy/merge-env.sh ]] && bash deploy/merge-env.sh backend/.env deploy/env-defaults

if [[ "$SYSTEM_PACKAGES" == 1 && "$DRIVER" == native_ubuntu ]]; then
  echo "==> Upgrading host system packages"
  apt-get update -q
  apt-get upgrade -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
fi

echo "==> Syncing backend dependencies"
backend/.venv/bin/pip install -q -r backend/requirements.txt

echo "==> Building frontend"
(cd frontend && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null)

echo "==> Reloading services"
# New-name alias for the legacy install dir; the real path stays put so existing units and mounts keep working.
[[ -e /opt/solardeck ]] || ln -s "$APP_DIR" /opt/solardeck
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/proxmox-os
bash deploy/selfsigned-cert.sh || echo "!! Could not create the HTTPS certificate; SolarDeck stays on http"
nginx -t -q && (systemctl reload nginx || systemctl restart nginx)
if [[ "$DRIVER" == native_ubuntu ]]; then
  # Standalone host: the root helper and the console TUI run on this machine, so they update with the code.
  install -m 755 deploy/proxmox-os-helper.sh /usr/local/sbin/proxmox-os-helper
  install -m 755 hypervisor/solardeck-console-tui.py /usr/local/bin/solardeck-console
  install -m 644 hypervisor/solardeck-backend.service /etc/systemd/system/solardeck-backend.service
  if [[ -f /etc/systemd/system/solardeck-console.service ]]; then
    install -m 644 hypervisor/solardeck-console.service /etc/systemd/system/solardeck-console.service
  fi
  systemctl daemon-reload
  systemctl try-restart solardeck-console || true
  systemctl restart solardeck-backend
else
  install -m 644 deploy/proxmox-os-backend.service /etc/systemd/system/proxmox-os-backend.service
  systemctl daemon-reload
  systemctl restart proxmox-os-backend
fi
echo "==> Update complete"
echo "proxmox-os: exit 0"
