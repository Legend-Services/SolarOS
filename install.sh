#!/usr/bin/env bash
# ProxmoxOS zero-touch installer.
# Run on a Proxmox VE host as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/main/install.sh)"
# Re-running is safe: an existing "proxmox-os" container is reused and redeployed.
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/Legend-Services/SolarOS.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
CT_HOSTNAME="proxmox-os"
APP_DIR="/opt/proxmox-os"
STORAGE_ROOT="/mnt/storage"
PVE_USER="pve-desktop@pve"
TOKEN_NAME="webui"
MAX_MOUNTS=100

C_RESET=$'\e[0m'; C_BLUE=$'\e[1;34m'; C_GREEN=$'\e[1;32m'; C_YELLOW=$'\e[1;33m'; C_RED=$'\e[1;31m'
msg()  { echo "${C_BLUE}==>${C_RESET} $*"; }
ok()   { echo "${C_GREEN} ✓${C_RESET} $*"; }
warn() { echo "${C_YELLOW} !${C_RESET} $*" >&2; }
die()  { echo "${C_RED} ✗ $*${C_RESET}" >&2; exit 1; }
trap 'die "Failed at line $LINENO: $BASH_COMMAND"' ERR

# Run a script inside the container with strict mode and no apt prompts.
ct() { pct exec "$CTID" -- env DEBIAN_FRONTEND=noninteractive bash -euo pipefail -c "$1"; }

# ---------------------------------------------------------------- 1. Discovery
[[ $EUID -eq 0 ]] || die "Run as root."
command -v pveversion >/dev/null || die "This does not look like a Proxmox VE host (pveversion not found)."
for bin in pct pvesh pvesm pveam pveum python3 openssl; do command -v "$bin" >/dev/null || die "Missing $bin"; done
msg "Proxmox VE $(pveversion | cut -d/ -f2)"

PVE_NODE="$(hostname)"
HOST_IP="$(hostname -I | awk '{print $1}')"
PVE_HOST="https://${HOST_IP}:8006"
ok "Node ${PVE_NODE}, API ${PVE_HOST}"

# Local source tree, first match wins: $SRC_DIR, the script's own directory (checkout, tarball or deploy.sh
# upload), then /opt/proxmox-os on the host. Empty means clone REPO_URL (piped through bash -c "$(curl ...)").
export DEBIAN_FRONTEND=noninteractive
CANDIDATES=("${SRC_DIR:-}")
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CANDIDATES+=("$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")
fi
CANDIDATES+=("$APP_DIR")
SRC_DIR=""
for d in "${CANDIDATES[@]}"; do
  if [[ -n "$d" && -d "$d/backend" && -d "$d/frontend" ]]; then SRC_DIR="$d"; break; fi
done
if [[ -n "$SRC_DIR" ]]; then ok "Installing from local source ${SRC_DIR}"; else ok "Installing from ${REPO_URL} (${REPO_BRANCH})"; fi

EXISTING_CTID="$(pct list | awk -v h="$CT_HOSTNAME" 'NR>1 && $NF==h {print $1; exit}')"

if [[ -n "$EXISTING_CTID" ]]; then
  CTID="$EXISTING_CTID"
  ok "Reusing existing container ${CTID} (${CT_HOSTNAME})"
else
  CTID="$(pvesh get /cluster/nextid)"

  # Rootfs storage: prefer ZFS, then local-lvm, then local, then anything with rootdir.
  ROOTDIR_STORES="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1, $2}')"
  ROOT_STORAGE="$(awk '$2=="zfspool" {print $1; exit}' <<<"$ROOTDIR_STORES")"
  [[ -z "$ROOT_STORAGE" ]] && ROOT_STORAGE="$(awk '$1=="local-lvm" {print $1; exit}' <<<"$ROOTDIR_STORES")"
  [[ -z "$ROOT_STORAGE" ]] && ROOT_STORAGE="$(awk '$1=="local" {print $1; exit}' <<<"$ROOTDIR_STORES")"
  [[ -z "$ROOT_STORAGE" ]] && ROOT_STORAGE="$(awk 'NR==1 {print $1}' <<<"$ROOTDIR_STORES")"
  [[ -n "$ROOT_STORAGE" ]] || die "No active storage supports container root disks (rootdir)."
  ok "Container ID ${CTID}, rootfs on ${ROOT_STORAGE}"

  # Template.
  TMPL_STORAGE="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -x local || true)"
  [[ -z "$TMPL_STORAGE" ]] && TMPL_STORAGE="$(pvesm status -content vztmpl | awk 'NR>1 && $3=="active" {print $1; exit}')"
  [[ -n "$TMPL_STORAGE" ]] || die "No active storage supports container templates (vztmpl)."
  msg "Refreshing template index"
  pveam update >/dev/null || warn "pveam update failed; using cached index"
  TEMPLATE="$(pveam available --section system | awk '$2 ~ /^debian-12-standard_/ {print $2}' | sort -V | tail -n1)"
  [[ -n "$TEMPLATE" ]] || die "Could not find a debian-12-standard template."
  if pveam list "$TMPL_STORAGE" | grep -F "$TEMPLATE" >/dev/null; then
    ok "Template ${TEMPLATE} already cached on ${TMPL_STORAGE}"
  else
    msg "Downloading ${TEMPLATE}"
    pveam download "$TMPL_STORAGE" "$TEMPLATE" >/dev/null
    ok "Template downloaded"
  fi

  # Network.
  BRIDGE="vmbr0"
  ip link show "$BRIDGE" >/dev/null 2>&1 || BRIDGE="$(ip -o link show type bridge | awk -F': ' '{print $2; exit}')"
  [[ -n "$BRIDGE" ]] || die "No Linux bridge found (expected vmbr0)."
  BRIDGE_CIDR="$(ip -4 -o addr show dev "$BRIDGE" | awk '{print $4; exit}')"
  BASE_IP="${BRIDGE_CIDR%/*}"; BASE_IP="${BASE_IP:-$HOST_IP}"
  PREFIX="${BRIDGE_CIDR#*/}"; [[ "$BRIDGE_CIDR" == */* ]] || PREFIX=24
  GATEWAY="$(ip route | awk '/default/ {print $3; exit}')"
  CT_IP="dhcp"
  if [[ -n "$GATEWAY" && "$PREFIX" -le 24 ]]; then
    msg "Scanning ${BASE_IP%.*}.230-249 for a free static IP"
    for i in $(seq 230 249); do
      cand="${BASE_IP%.*}.$i"
      [[ "$cand" == "$BASE_IP" || "$cand" == "$GATEWAY" ]] && continue
      # An ARP entry after the ping means something answered even if ICMP is blocked.
      if ! ping -c 1 -W 1 "$cand" >/dev/null 2>&1 && ! ip neigh show "$cand" | grep lladdr >/dev/null; then
        CT_IP="$cand"; break
      fi
    done
  fi
  if [[ "$CT_IP" == "dhcp" ]]; then
    NET0="name=eth0,bridge=${BRIDGE},ip=dhcp"
    warn "No free static IP found; container will use DHCP"
  else
    NET0="name=eth0,bridge=${BRIDGE},ip=${CT_IP}/${PREFIX},gw=${GATEWAY}"
    ok "Static IP ${CT_IP}/${PREFIX} via ${GATEWAY} on ${BRIDGE}"
  fi
fi

# ZFS datasets to expose in File Station (every mounted filesystem outside rpool, except guest volumes).
MOUNTS=()
if command -v zpool >/dev/null; then
  while read -r pool; do
    [[ -z "$pool" || "$pool" == "rpool" ]] && continue
    while IFS=$'\t' read -r name mnt mounted; do
      [[ "$mounted" == "yes" && "$mnt" == /* ]] || continue
      [[ "$name" =~ /(subvol|basevol)-[0-9]+- ]] && continue
      MOUNTS+=("${name}"$'\t'"${mnt}")
    done < <(zfs list -H -t filesystem -o name,mountpoint,mounted -r "$pool")
  done < <(zpool list -H -o name)
fi
if (( ${#MOUNTS[@]} > MAX_MOUNTS )); then
  warn "Found ${#MOUNTS[@]} datasets; only the first ${MAX_MOUNTS} are mounted"
  MOUNTS=("${MOUNTS[@]:0:MAX_MOUNTS}")
fi

grant_storage_access() {
  # Unprivileged container root is uid/gid 100000 on the host. Grant it access with additive ACLs
  # instead of chown, so existing host ownership is untouched.
  command -v setfacl >/dev/null || { apt-get install -y -qq acl >/dev/null; }
  local name mnt
  for entry in "${MOUNTS[@]}"; do
    IFS=$'\t' read -r name mnt <<<"$entry"
    zfs set acltype=posixacl xattr=sa "$name"
    msg "Granting container access to ${mnt} (may take a while on large datasets)"
    setfacl -R -P -m u:100000:rwX,g:100000:rwX,d:u:100000:rwX,d:g:100000:rwX "$mnt" \
      || warn "Some ACLs on ${mnt} could not be set; those files will be read-only or hidden in File Station"
  done
}

# ---------------------------------------------------------------- 2. API user + token
msg "Configuring Proxmox API user ${PVE_USER}"
pveum user add "$PVE_USER" --comment "ProxmoxOS Web Desktop" >/dev/null 2>&1 || true
# Administrator (not PVEAdmin): the System app needs Sys.Modify (repositories, updates) and Sys.PowerMgmt.
pveum acl modify / --users "$PVE_USER" --roles Administrator
pveum user token remove "$PVE_USER" "$TOKEN_NAME" >/dev/null 2>&1 || true
PVE_TOKEN_SECRET="$(pveum user token add "$PVE_USER" "$TOKEN_NAME" --privsep 0 --output-format json \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["value"])')"
[[ -n "$PVE_TOKEN_SECRET" ]] || die "Failed to create API token."
JWT_SECRET="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 14)"
ok "API token ${PVE_USER}!${TOKEN_NAME} created"

# ---------------------------------------------------------------- 3. Container
if [[ -z "$EXISTING_CTID" ]]; then
  msg "Creating unprivileged container ${CTID}"
  pct create "$CTID" "${TMPL_STORAGE}:vztmpl/${TEMPLATE}" \
    --hostname "$CT_HOSTNAME" --description "ProxmoxOS web desktop" \
    --ostype debian --unprivileged 1 --features nesting=1 --onboot 1 \
    --cores 2 --memory 2048 --swap 512 \
    --rootfs "${ROOT_STORAGE}:16" --net0 "$NET0" >/dev/null

  if (( ${#MOUNTS[@]} )); then
    i=0
    for entry in "${MOUNTS[@]}"; do
      IFS=$'\t' read -r name mnt <<<"$entry"
      pct set "$CTID" "-mp${i}" "${mnt},mp=${STORAGE_ROOT}/${name}" >/dev/null
      ok "Mounted ${mnt} -> ${STORAGE_ROOT}/${name}"
      i=$((i + 1))
    done
    grant_storage_access
  else
    # No data pools: give File Station a host folder to work with.
    mkdir -p "$STORAGE_ROOT"
    chown 100000:100000 "$STORAGE_ROOT"
    pct set "$CTID" -mp0 "${STORAGE_ROOT},mp=${STORAGE_ROOT}" >/dev/null
    ok "No data pools found; mounted host ${STORAGE_ROOT}"
  fi
else
  # shortcut: mount points of an existing container are kept as-is; delete the CT to pick up new pools.
  if (( ${#MOUNTS[@]} )); then grant_storage_access; fi
fi

[[ "$(pct status "$CTID")" == *running* ]] || pct start "$CTID"
msg "Waiting for container network"
for _ in $(seq 1 60); do
  pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1' && break
  sleep 2
done
pct exec "$CTID" -- bash -c 'getent hosts deb.debian.org >/dev/null 2>&1' || die "Container has no DNS/network after 120s."
ok "Container is online"

if [[ "${CT_IP:-}" == "" || "$CT_IP" == "dhcp" ]]; then
  CT_IP="$(pct config "$CTID" | sed -n 's/^net0:.*ip=\([0-9.]*\)\/.*/\1/p')"
  [[ -z "$CT_IP" ]] && CT_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
fi

msg "Installing system packages (this takes a few minutes)"
ct "apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git build-essential python3 python3-venv python3-pip nginx \
  samba samba-common-bin openssh-client >/dev/null
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi"
ok "Packages installed ($(pct exec "$CTID" -- node -v))"

msg "Deploying application to ${APP_DIR}"
if [[ -n "$SRC_DIR" ]]; then
  TARBALL="$(mktemp --suffix=.tar.gz)"
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=dist --exclude=.venv --exclude=.git \
    --exclude=backend/.env --exclude=__pycache__ --exclude=.claude --exclude=backend/data/schedules.json \
    -czf "$TARBALL" .
  pct push "$CTID" "$TARBALL" /tmp/proxmox-os.tar.gz
  rm -f "$TARBALL"
  ct "mkdir -p ${APP_DIR} && tar -xzf /tmp/proxmox-os.tar.gz -C ${APP_DIR} && rm /tmp/proxmox-os.tar.gz"
  ok "Copied local checkout ${SRC_DIR}"
else
  ct "if [ -d ${APP_DIR}/.git ]; then
  git -C ${APP_DIR} fetch -q --depth 1 origin ${REPO_BRANCH}
  git -C ${APP_DIR} reset -q --hard FETCH_HEAD
else
  rm -rf ${APP_DIR}
  git clone -q --depth 1 -b ${REPO_BRANCH} ${REPO_URL} ${APP_DIR}
fi"
  ok "Cloned ${REPO_URL} (${REPO_BRANCH})"
fi

# ---------------------------------------------------------------- Host helper (root-only operations)
# ZFS snapshots, bind mounts, /dev/dri passthrough and app provisioning (pct exec) are not possible with the API
# token, so the container gets an SSH key that can only run the allowlisted helper on this host.
msg "Installing host helper"
pct pull "$CTID" "${APP_DIR}/deploy/proxmox-os-helper.sh" /usr/local/sbin/proxmox-os-helper
chmod 755 /usr/local/sbin/proxmox-os-helper
ct "mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f /root/.ssh/proxmox-os-helper ] || ssh-keygen -q -t ed25519 -N '' -C proxmox-os-helper -f /root/.ssh/proxmox-os-helper"
PUB_FILE="$(mktemp)"
pct pull "$CTID" /root/.ssh/proxmox-os-helper.pub "$PUB_FILE"
AUTH_KEYS=/root/.ssh/authorized_keys
mkdir -p /root/.ssh && touch "$AUTH_KEYS"
AUTH_TMP="$(mktemp)"
{ grep -v ' proxmox-os-helper$' "$AUTH_KEYS" || true; echo "command=\"/usr/local/sbin/proxmox-os-helper\",restrict $(cat "$PUB_FILE")"; } >"$AUTH_TMP"
# cat > instead of mv: on PVE authorized_keys is a symlink into /etc/pve.
cat "$AUTH_TMP" >"$AUTH_KEYS"
rm -f "$AUTH_TMP" "$PUB_FILE"
if pct exec "$CTID" -- ssh -i /root/.ssh/proxmox-os-helper -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 "root@${HOST_IP}" zfs-list >/dev/null 2>&1; then
  ok "Host helper reachable from the container"
else
  warn "Host helper check failed (no ZFS, or root SSH login disabled); ZFS snapshots and App Center host options may not work"
fi

msg "Configuring Samba"
ct "touch /etc/samba/proxmox-os-shares.conf
# Appended at the end so included share sections never swallow [global] options.
grep -q 'proxmox-os-shares.conf' /etc/samba/smb.conf || printf '\n# ProxmoxOS Network Shares\ninclude = /etc/samba/proxmox-os-shares.conf\n' >>/etc/samba/smb.conf
testparm -s >/dev/null 2>&1
systemctl enable -q smbd
systemctl restart smbd"
ok "Samba ready (shares managed in Network Shares)"

PVE_BRIDGE="$(pct config "$CTID" | sed -n 's/^net0:.*bridge=\([^,]*\).*/\1/p')"

ENV_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"
cat >"$ENV_FILE" <<EOF
PVE_HOST=${PVE_HOST}
PVE_NODE=${PVE_NODE}
PVE_TOKEN_ID=${PVE_USER}!${TOKEN_NAME}
PVE_TOKEN_SECRET=${PVE_TOKEN_SECRET}
PVE_VERIFY_SSL=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
JWT_SECRET=${JWT_SECRET}
STORAGE_ROOT=${STORAGE_ROOT}
PVE_BRIDGE=${PVE_BRIDGE:-vmbr0}
HOST_SSH=root@${HOST_IP}
EOF
pct push "$CTID" "$ENV_FILE" "${APP_DIR}/backend/.env" --perms 600
rm -f "$ENV_FILE"
ok "Wrote backend/.env"

msg "Installing backend"
ct "cd ${APP_DIR}/backend
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
install -m 644 ${APP_DIR}/deploy/proxmox-os-backend.service /etc/systemd/system/proxmox-os-backend.service
systemctl daemon-reload
systemctl enable -q proxmox-os-backend
systemctl restart proxmox-os-backend"
ok "Backend service running"

msg "Building frontend"
ct "cd ${APP_DIR}/frontend && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null"
ok "Frontend built"

msg "Configuring nginx"
ct "install -m 644 ${APP_DIR}/deploy/nginx.conf /etc/nginx/sites-available/proxmox-os
ln -sf /etc/nginx/sites-available/proxmox-os /etc/nginx/sites-enabled/proxmox-os
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl enable -q nginx
systemctl reload nginx || systemctl restart nginx"
ok "nginx configured"

msg "Health check http://${CT_IP}/api/health"
for _ in $(seq 1 30); do
  if curl -fsS "http://${CT_IP}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
[[ "${HEALTHY:-}" == 1 ]] || die "Health check failed. Inspect with: pct exec ${CTID} -- journalctl -u proxmox-os-backend -n 50"
ok "Healthy"

trap - ERR
cat <<EOF

${C_GREEN}╔══════════════════════════════════════════════════════╗
║              ProxmoxOS is ready                      ║
╚══════════════════════════════════════════════════════╝${C_RESET}
  Web UI:    http://${CT_IP}
  Username:  admin
  Password:  ${ADMIN_PASSWORD}

  Container: ${CTID} (${CT_HOSTNAME})
  Storage:   ${STORAGE_ROOT} (${#MOUNTS[@]} ZFS dataset(s) mounted)
  SMB:       smb://${CT_IP}/<share>  (create shares in Network Shares)
  Re-run this installer any time to update; it rotates the password and API token.

EOF
