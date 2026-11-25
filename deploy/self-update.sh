#!/usr/bin/env bash
# SolarDeck self-updater. Started by the backend (POST /api/system/updates/apply|rollback) inside the SolarDeck
# container (or on a SolarOS host) as a transient systemd unit:
#   self-update.sh <app dir> <repo url> <branch> [<target commit>] [<system packages 0|1>]
# Without a target it updates to the tip of <branch>; with one it checks out that commit (update or downgrade).
# Both editions update from the same branch; HYPERVISOR_DRIVER in backend/.env picks the service layout. With
# "system packages" = 1 (standalone hypervisor only) the host's APT packages are upgraded as well.
# User state is snapshotted first and restored after the checkout: backend/.env (ADMIN_PASSWORD, JWT_SECRET,
# GITHUB_TOKEN, HYPERVISOR_DRIVER, ...), backend/data/, backend/.ssh/ and
# the Samba share config. New .env keys from deploy/env-defaults are appended; existing values are never changed.
# Host-side names use SYSTEM_PREFIX from backend/.env (default solardeck). A helper on a separate hypervisor host is
# not updated here; re-run that edition's installer when deploy/solardeck-helper.sh changes.
# Every stage is written to /run/<prefix>-update-progress.json (status, percent, stage), which the backend reads, so the
# progress survives the backend restart near the end.
set -Eeuo pipefail
PROGRESS=""; PERCENT=0; STAGE=starting; LABEL="Starting the updater"
STARTED_AT="${STARTED_AT:-$(date -Iseconds)}"; export STARTED_AT
# progress <status> <percent> <stage> <label> [extra JSON members]: atomic, so a reader never sees half a file.
progress() {
  PERCENT="$2"; STAGE="$3"; LABEL="$4"
  [[ -n "$PROGRESS" ]] || return 0
  printf '{"status":"%s","percent":%s,"stage":"%s","stage_label":"%s","target":"%s","started_at":"%s","updated_at":"%s"%s}\n' \
    "$1" "$2" "$3" "$4" "${TARGET:-}" "$STARTED_AT" "$(date -Iseconds)" "${5:-}" >"${PROGRESS}.tmp" && mv -f "${PROGRESS}.tmp" "$PROGRESS" || true  # never fail the update over this
}
failed() {
  trap - ERR
  local cmd="${1//[\"\\]/}"; cmd="${cmd//[$'\n\r\t']/ }"
  progress failed "$PERCENT" "$STAGE" "$LABEL" ",\"finished_at\":\"$(date -Iseconds)\",\"error_message\":\"${LABEL} failed: ${cmd:0:200} (exit $2)\""
  echo "solardeck: exit 1"
}
trap 'failed "$BASH_COMMAND" $?' ERR

APP_DIR="${1:?app dir}"; REPO_URL="${2:?repo url}"; BRANCH="${3:?branch}"; TARGET="${4:-}"; SYSTEM_PACKAGES="${5:-0}"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid branch"; echo "solardeck: exit 2"; exit 2; }
[[ -z "$TARGET" || "$TARGET" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid target"; echo "solardeck: exit 2"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
cd "$APP_DIR"
DRIVER="$(sed -n 's/^HYPERVISOR_DRIVER=//p' backend/.env 2>/dev/null | tail -n1 | tr -d "'\"" || true)"
[[ -n "$DRIVER" || ! -f deploy/env-defaults-legacy ]] || DRIVER="$(sed -n 's/^HYPERVISOR_DRIVER=//p' deploy/env-defaults-legacy)"
PREFIX="$(sed -n 's/^SYSTEM_PREFIX=//p' backend/.env 2>/dev/null | tail -n1 | tr -d "'\"" || true)"
# Not in .env yet (first update to a release with SYSTEM_PREFIX): the edition default shipped with the code.
[[ -n "$PREFIX" || ! -f "deploy/env-defaults-${DRIVER}" ]] || PREFIX="$(sed -n 's/^SYSTEM_PREFIX=//p' "deploy/env-defaults-${DRIVER}")"
PREFIX="${PREFIX:-solardeck}"
[[ "$PREFIX" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "invalid SYSTEM_PREFIX"; echo "solardeck: exit 2"; exit 2; }
SHARES="/etc/samba/${PREFIX}-shares.conf"
PROGRESS="/run/${PREFIX}-update-progress.json"
echo "==> Driver ${DRIVER}, system prefix ${PREFIX}"
# Private repositories: authenticate with GITHUB_TOKEN from backend/.env when it is set.
TOKEN="$(sed -n 's/^GITHUB_TOKEN=//p' backend/.env 2>/dev/null | head -n1 || true)"
AUTH=(); [[ -n "$TOKEN" ]] && AUTH=(-c "http.https://github.com/.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)")
# The tree may be owned by another uid (deploy.sh tarball); git refuses that without safe.directory.
git() { command git -c safe.directory='*' "${AUTH[@]}" "$@"; }

STATE="/tmp/${PREFIX}-state-backup"
# A re-executed updater (see below) keeps the snapshot its first run took before the checkout.
if [[ -z "${UPDATER_REEXEC:-}" ]]; then
  progress running 5 prepare "Preparing update & backing up configuration and state"
  echo "==> Saving settings and data to ${STATE}"
  rm -rf "$STATE" && mkdir -p "$STATE"
  [[ -f backend/.env ]] && cp -a backend/.env "$STATE/.env"
  [[ -d backend/data ]] && cp -a backend/data "$STATE/data"
  [[ -d backend/.ssh ]] && cp -a backend/.ssh "$STATE/.ssh"
  [[ -f "$SHARES" ]] && cp -a "$SHARES" "$STATE/shares.conf"
fi

[[ -n "${UPDATER_REEXEC:-}" ]] || progress running 20 fetch "Fetching latest release tags from remote repository"
echo "==> Fetching ${BRANCH} and tags from ${REPO_URL}"
if [[ ! -d .git ]]; then
  # First update of a deploy.sh deployment: turn the copied tree into a checkout.
  git init -q -b "$BRANCH"
  git remote add origin "$REPO_URL"
fi
SHALLOW=(); [[ -f .git/shallow ]] && SHALLOW=(--unshallow)
# main carries every release tag; an edition release branch (e.g. solaros) only its own <branch>-* tags, so nothing
# outside that branch is downloaded.
if [[ "$BRANCH" == main ]]; then TAG_OPT=(--tags); TAG_REF=(); else TAG_OPT=(--no-tags); TAG_REF=("+refs/tags/${BRANCH}-*:refs/tags/${BRANCH}-*"); fi
git fetch -q --force "${TAG_OPT[@]}" "${SHALLOW[@]}" origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" "${TAG_REF[@]}"
TARGET="${TARGET:-$(git rev-parse "origin/${BRANCH}")}"
progress running 40 checkout "Checking out target release & verifying files"
# -f: a deploy.sh install has files that differ from HEAD; untracked state (.env, data/) is never touched.
git -c advice.detachedHead=false checkout -q -f -B "$BRANCH" "$TARGET"
git reset -q --hard "$TARGET"
git rev-parse HEAD >.build-commit
echo "    now at $(git log -1 --format='%h %s')"
# This file is the previous release's updater (copied before the checkout): continue with the new one, so steps added
# in this release (e.g. host package changes) run in this same update instead of the next one.
if [[ -z "${UPDATER_REEXEC:-}" ]] && ! cmp -s "$0" deploy/self-update.sh; then
  echo "==> Continuing with the updated updater"
  NEXT="$(mktemp "/tmp/${PREFIX}-self-update.XXXXXX")"
  cp deploy/self-update.sh "$NEXT"
  UPDATER_REEXEC=1 exec bash "$NEXT" "$APP_DIR" "$REPO_URL" "$BRANCH" "$(git rev-parse HEAD)" "$SYSTEM_PACKAGES"
fi

echo "==> Restoring settings and data"
[[ -f "$STATE/.env" ]] && cp -a "$STATE/.env" backend/.env
[[ -d "$STATE/.ssh" ]] && { mkdir -p backend/.ssh; cp -a "$STATE/.ssh/." backend/.ssh/; }
[[ -f "$STATE/shares.conf" && ! -f "$SHARES" ]] && cp -a "$STATE/shares.conf" "$SHARES"
if [[ -d "$STATE/data" ]]; then
  # User files (schedules, security, preferences, ...) win; files shipped by the release stay at the target version.
  (cd "$STATE/data" && find . -type f) | while read -r f; do
    dest="backend/data/${f#./}"
    git ls-files --error-unmatch "$dest" >/dev/null 2>&1 || { mkdir -p "$(dirname "$dest")"; cp -a "$STATE/data/$f" "$dest"; }
  done
fi
[[ -f deploy/merge-env.sh ]] && bash deploy/merge-env.sh backend/.env deploy/env-defaults

if [[ "$SYSTEM_PACKAGES" == 1 && "$DRIVER" == native_ubuntu ]]; then
  progress running 50 os-packages "Upgrading host system packages"
  echo "==> Upgrading host system packages"
  apt-get update -q
  apt-get upgrade -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
fi

progress running 60 backend "Installing & synchronizing Python backend dependencies"
echo "==> Syncing backend dependencies"
backend/.venv/bin/pip install -q -r backend/requirements.txt

progress running 80 frontend "Building frontend interface assets"
echo "==> Building frontend"
EDITION=""; [[ "$DRIVER" == native_ubuntu ]] && EDITION=solaros
if git ls-files --error-unmatch frontend/dist/index.html >/dev/null 2>&1; then
  echo "    prebuilt desktop shipped with the release"
else
  (cd frontend && npm ci --no-audit --no-fund --loglevel=error && VITE_EDITION="$EDITION" npm run build >/dev/null)
fi

progress running 92 restart "Restarting SolarDeck services & web server"
echo "==> Reloading services"
# New-name alias for the legacy install dir; the real path stays put so existing units and mounts keep working.
[[ -e /opt/solardeck ]] || ln -s "$APP_DIR" /opt/solardeck
install -m 644 deploy/nginx.conf "/etc/nginx/sites-available/${PREFIX}"
SYSTEM_PREFIX="$PREFIX" bash deploy/selfsigned-cert.sh || echo "!! Could not create the HTTPS certificate; SolarDeck stays on http"
nginx -t -q && (systemctl reload nginx || systemctl restart nginx)
if [[ "$DRIVER" == native_ubuntu ]]; then
  # Standalone host: the root helper and the console TUI run on this machine, so they update with the code.
  install -m 755 deploy/solardeck-helper.sh "/usr/local/sbin/${PREFIX}-helper"
  install -m 755 hypervisor/solardeck-console-tui.py /usr/local/bin/solardeck-console
  [[ -f hypervisor/zabbly-incus.sh ]] && { bash hypervisor/zabbly-incus.sh --upgrade >/dev/null || echo "!! could not switch to Zabbly's Incus"; }
  [[ -f hypervisor/ensure-incus-pool.sh ]] && { bash hypervisor/ensure-incus-pool.sh || echo "!! could not check the Incus storage pool"; }
  install -m 644 hypervisor/solardeck-backend.service /etc/systemd/system/solardeck-backend.service
  if [[ -f /etc/systemd/system/solardeck-console.service ]]; then
    install -m 644 hypervisor/solardeck-console.service /etc/systemd/system/solardeck-console.service
  fi
  systemctl daemon-reload
  systemctl try-restart solardeck-console || true
  systemctl restart solardeck-backend
else
  install -m 644 "deploy/${PREFIX}-backend.service" "/etc/systemd/system/${PREFIX}-backend.service"
  systemctl daemon-reload
  systemctl restart "${PREFIX}-backend"
fi
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' frontend/package.json | head -n1)"
progress completed 100 done "Update completed successfully" \
  ",\"finished_at\":\"$(date -Iseconds)\",\"completed_commit\":\"$(git rev-parse HEAD)\",\"completed_version\":\"${VERSION}\""
echo "==> Update complete"
echo "solardeck: exit 0"
