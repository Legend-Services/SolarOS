#!/usr/bin/env bash
# SolarOS installer: turns a clean Ubuntu Server 24.04 / 26.04 LTS machine into a SolarOS
# host (HYPERVISOR_DRIVER=native_ubuntu) with QEMU/KVM + libvirt, Incus containers, OpenZFS and the SolarDeck desktop.
# Run as root:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Legend-Services/SolarOS/solaros/hypervisor/install-hypervisor.sh)" -- --with-console-tui
# Options:
#   --with-console-tui   show the SolarDeck console dashboard on tty1 (the server's own monitor)
#   --src <dir>          install from a local source tree instead of cloning REPO_URL
#   --bundle <dir>       install from a SolarDeck ISO bundle: source tree + prebuilt frontend/dist + wheels/ (offline
#                        Python packages and no desktop build; APT packages still come from the Ubuntu mirrors)
#   --bridge-nic <nic>   NIC to enslave to br0 (default: the NIC of the default route)
#   --no-bridge          do not create br0 (guests then need an existing bridge named in DEFAULT_BRIDGE)
# Re-running is safe: backend/.env, backend/data/ and backend/.ssh/ are kept; code, dependencies and the build refresh.
set -Eeuo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/Legend-Services/SolarOS.git}"
REPO_BRANCH="${REPO_BRANCH:-solaros}"  # the SolarOS release branch
APP_DIR="/opt/solardeck"
STORAGE_ROOT="/mnt/storage"
BRIDGE="br0"
SETUP_CODE_FILE="/etc/solardeck/setup-code"  # one-time code for creating the administrator (tty1 shows it)
WITH_TUI="" SRC="" BRIDGE_NIC="" NO_BRIDGE="" BUNDLE=""

C_RESET=$'\e[0m'; C_BLUE=$'\e[1;34m'; C_GREEN=$'\e[1;32m'; C_YELLOW=$'\e[1;33m'; C_RED=$'\e[1;31m'
msg()  { echo "${C_BLUE}==>${C_RESET} $*"; }
ok()   { echo "${C_GREEN} ✓${C_RESET} $*"; }
warn() { echo "${C_YELLOW} !${C_RESET} $*" >&2; }
die()  { echo "${C_RED} ✗ $*${C_RESET}" >&2; exit 1; }
trap 'die "Failed at line $LINENO: $BASH_COMMAND"' ERR

while (($#)); do
  case "$1" in
    --with-console-tui) WITH_TUI=1; shift ;;
    --src) SRC="${2:?--src needs a directory}"; shift 2 ;;
    --bundle) SRC="${2:?--bundle needs a directory}"; BUNDLE=1; shift 2 ;;
    --bridge-nic) BRIDGE_NIC="${2:?--bridge-nic needs a NIC}"; shift 2 ;;
    --no-bridge) NO_BRIDGE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------- 1. Checks
[[ $EUID -eq 0 ]] || die "Run as root."
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || die "SolarOS needs Ubuntu Server LTS (found ${PRETTY_NAME:-unknown})."
case "${VERSION_ID:-}" in 24.04|26.04) ok "${PRETTY_NAME}" ;; *) warn "Tested on Ubuntu 24.04 / 26.04 LTS; found ${VERSION_ID}" ;; esac
grep -Eq 'vmx|svm' /proc/cpuinfo || warn "No hardware virtualization flags: enable VT-x / AMD-V in the BIOS for KVM"
UPGRADE=""; [[ -f "${APP_DIR}/backend/.env" ]] && UPGRADE=1 && msg "Existing installation found: Upgrade Mode"

# ---------------------------------------------------------------- 2. Packages
msg "Installing hypervisor packages (KVM/libvirt, Incus, OpenZFS, disk and sensor tools)"
# Only what SolarOS uses (no recommended extras such as desktop graphics stacks): what libvirt and ZFS would pull in
# through Recommends is listed explicitly.
PKGS=(qemu-kvm qemu-utils libvirt-daemon-system libvirt-daemon-driver-qemu libvirt-clients ovmf swtpm swtpm-tools
  zfsutils-linux zfs-zed bridge-utils smartmontools hdparm nvme-cli lm-sensors fio websockify samba
  samba-common-bin nginx python3-venv python3-pip git curl ca-certificates gnupg openssl rsync gdisk cloud-image-utils
  zstd acl pciutils usbutils dmidecode openssh-server jq iproute2 kmod less dnsmasq-base ipxe-qemu-256k-compat-efi-roms
  qemu-block-extra parted netcat-openbsd libxml2-utils samba-vfs-modules cpu-checker)
# Incus from Zabbly (current upstream) when its repository serves this release; else the distribution's package.
ZABBLY="$(dirname "$(readlink -f "${BASH_SOURCE[0]:-$0}")")/zabbly-incus.sh"
if [[ -f "$ZABBLY" ]]; then read -ra INCUS_PKGS <<<"$(bash "$ZABBLY")"; else INCUS_PKGS=(incus); fi
PKGS+=("${INCUS_PKGS[@]}")
apt-get update -qq
apt-get install -y -qq --no-install-recommends "${PKGS[@]}" >/dev/null
# Tracing tools of the minimal Ubuntu base pull in LLVM/Clang (~250 MB); SolarOS does not use them.
apt-get purge -y -qq bpftrace bpfcc-tools python3-bpfcc >/dev/null 2>&1 || true
# snapd is part of Ubuntu Server but SolarOS uses no snaps: drop it when nothing is installed through it.
if command -v snap >/dev/null && [[ -z "$(snap list 2>/dev/null | tail -n +2)" ]]; then
  apt-get purge -y -qq snapd >/dev/null 2>&1 && rm -rf /snap /var/snap /var/lib/snapd && ok "snapd removed (no snaps in use)"
fi
ok "Packages installed ($(virsh --version 2>/dev/null | sed 's/^/libvirt /'), incus $(incus --version 2>/dev/null))"
systemctl enable -q --now libvirtd ssh 2>/dev/null || systemctl enable -q --now libvirtd
modprobe zfs 2>/dev/null || warn "ZFS kernel module not loaded (reboot after a kernel update)"

# ---------------------------------------------------------------- 3. Network bridge
if [[ -z "$NO_BRIDGE" && ! -d "/sys/class/net/${BRIDGE}" ]]; then
  NIC="${BRIDGE_NIC:-$(ip -j route show default | jq -r '.[0].dev // empty')}"
  # No default route yet: the first physical Ethernet port.
  [[ -n "$NIC" ]] || NIC="$(for n in /sys/class/net/en* /sys/class/net/eth*; do [[ -e "$n/device" ]] && basename "$n"; done | head -n1)"
  [[ -n "$NIC" && -e "/sys/class/net/${NIC}" ]] || die "Could not find the uplink NIC; pass --bridge-nic <nic>"
  [[ -d "/sys/class/net/${NIC}/bridge" ]] && die "${NIC} is already a bridge; rerun with --no-bridge and set DEFAULT_BRIDGE"
  msg "Creating bridge ${BRIDGE} on ${NIC} (the IP address moves to the bridge)"
  # Keep a static address static; otherwise the bridge asks DHCP (same MAC, so usually the same lease).
  ADDR="$(ip -j -4 addr show dev "$NIC" | jq -r '[.[0].addr_info[] | select(.dynamic != true)][0] | "\(.local)/\(.prefixlen)" // empty' 2>/dev/null || true)"
  GW="$(ip -j route show default dev "$NIC" | jq -r '.[0].gateway // empty')"
  [[ "$ADDR" == null/null ]] && ADDR=""
  if [[ -n "$ADDR" ]]; then
    BR_CFG="{\"dhcp4\": false, \"addresses\": [\"${ADDR}\"], \"routes\": [{\"to\": \"default\", \"via\": \"${GW}\"}], \"nameservers\": {\"addresses\": [\"${GW}\"]}"
  else
    BR_CFG="{\"dhcp4\": true"
  fi
  cat >/etc/netplan/60-solardeck-bridge.yaml <<EOF
{"network": {"version": 2,
  "ethernets": {"${NIC}": {"dhcp4": false, "dhcp6": false}},
  "bridges": {"${BRIDGE}": ${BR_CFG}, "dhcp6": false, "interfaces": ["${NIC}"], "parameters": {"stp": false, "forward-delay": 0}}}}}
EOF
  chmod 600 /etc/netplan/60-solardeck-bridge.yaml
  netplan generate
  netplan apply
  for _ in $(seq 1 30); do ip -4 -o addr show dev "$BRIDGE" | grep -q inet && break; sleep 1; done
  ok "Bridge ${BRIDGE} up ($(ip -4 -o addr show dev "$BRIDGE" | awk '{print $4; exit}'))"
fi

# ---------------------------------------------------------------- 4. Incus
if [[ -z "$(incus storage list --format csv 2>/dev/null)" ]]; then
  msg "Initializing Incus"
  # A half-finished earlier init (e.g. its network exists) makes --minimal fail: then add the missing pieces.
  incus admin init --minimal 2>/dev/null || true
fi

# ---------------------------------------------------------------- 5. SolarDeck code
PREBUILT=""; [[ -n "$BUNDLE" && -f "${SRC%/}/frontend/dist/index.html" ]] && PREBUILT=1
msg "Deploying SolarDeck to ${APP_DIR}"
if [[ -z "$SRC" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/.." 2>/dev/null && pwd || true)"
  [[ -f "${HERE}/hypervisor/install-hypervisor.sh" && -d "${HERE}/backend" ]] && SRC="$HERE"
fi
if [[ -n "$SRC" && "$(realpath "$SRC")" != "$(realpath -m "$APP_DIR")" ]]; then
  mkdir -p "$APP_DIR"
  # User state is never overwritten; files shipped by the release are.
  rsync -a --exclude .git --exclude node_modules --exclude .venv --exclude dist --exclude __pycache__ --exclude .claude \
    --exclude backend/.env --exclude backend/.ssh --exclude 'backend/data/*.json' --exclude backend/data/themes \
    "${SRC%/}/" "${APP_DIR}/"
  cp "${SRC%/}/backend/data/app_catalog.json" "${APP_DIR}/backend/data/app_catalog.json"
  [[ -n "$PREBUILT" ]] && rsync -a --delete "${SRC%/}/frontend/dist/" "${APP_DIR}/frontend/dist/"
  [[ -f "${SRC%/}/.build-commit" ]] && cp "${SRC%/}/.build-commit" "${APP_DIR}/.build-commit"
  # A bundle has no .git: keep the .build-commit copied above instead of truncating it.
  COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "$COMMIT" ]]; then echo "$COMMIT" >"${APP_DIR}/.build-commit"; fi
elif [[ -d "${APP_DIR}/.git" ]]; then
  # Re-run on a git checkout: move to the tip of the branch (untracked state files are untouched).
  git -C "$APP_DIR" -c safe.directory='*' fetch -q --no-tags origin "+refs/heads/${REPO_BRANCH}:refs/remotes/origin/${REPO_BRANCH}" \
    "+refs/tags/${REPO_BRANCH}-*:refs/tags/${REPO_BRANCH}-*"
  git -C "$APP_DIR" -c safe.directory='*' checkout -q -f -B "$REPO_BRANCH" "origin/${REPO_BRANCH}"
  git -C "$APP_DIR" rev-parse HEAD >"${APP_DIR}/.build-commit"
else
  git clone -q --single-branch --no-tags --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  git -C "$APP_DIR" fetch -q --no-tags origin "+refs/tags/${REPO_BRANCH}-*:refs/tags/${REPO_BRANCH}-*" || true
  git -C "$APP_DIR" rev-parse HEAD >"${APP_DIR}/.build-commit"
fi
mkdir -p "${STORAGE_ROOT}"/{isos,templates,backups,ai-models}
ok "Code in ${APP_DIR} ($(cat "${APP_DIR}/.build-commit" 2>/dev/null | cut -c1-12))"
bash "${APP_DIR}/hypervisor/zabbly-incus.sh" --upgrade >/dev/null || warn "Could not switch to Zabbly's Incus; keeping $(incus --version)"
bash "${APP_DIR}/hypervisor/ensure-incus-pool.sh"
ok "Incus ready ($(incus storage list --format csv | cut -d, -f1 | paste -sd, -))"

# ---------------------------------------------------------------- 6. backend/.env
ENV_FILE="${APP_DIR}/backend/.env"
if [[ -z "$UPGRADE" ]]; then
  # No password is generated: the first visit to the web UI creates the administrator, after entering this code
  # from the server's console (so nobody else on the network can claim the server first).
  SETUP_CODE="$(python3 -c 'import secrets; a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; c = "".join(secrets.choice(a) for _ in range(8)); print(c[:4] + "-" + c[4:])')"
  umask 077
  cat >"$ENV_FILE" <<EOF
HYPERVISOR_DRIVER=native_ubuntu
NODE_NAME=$(hostname -s)
DEFAULT_BRIDGE=${BRIDGE}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
JWT_SECRET=$(openssl rand -hex 32)
STORAGE_ROOT=${STORAGE_ROOT}
HOST_SSH=
HOST_ROOT_TARGET=root@127.0.0.1
REPO_URL=${REPO_URL}
REPO_BRANCH=${REPO_BRANCH}
EOF
  umask 022
  mkdir -p "$(dirname "$SETUP_CODE_FILE")" && chmod 700 "$(dirname "$SETUP_CODE_FILE")"
  echo "$SETUP_CODE" >"$SETUP_CODE_FILE" && chmod 600 "$SETUP_CODE_FILE"
  ok "Wrote backend/.env"
else
  grep -q '^HYPERVISOR_DRIVER=native_ubuntu' "$ENV_FILE" || die "${ENV_FILE} belongs to another edition (HYPERVISOR_DRIVER)"
fi
bash "${APP_DIR}/deploy/merge-env.sh" "$ENV_FILE" "${APP_DIR}/deploy/env-defaults" >/dev/null

# ---------------------------------------------------------------- 7. Root helper + local SSH bridge
msg "Installing the root helper and the local SSH bridge"
install -m 755 "${APP_DIR}/deploy/solardeck-helper.sh" /usr/local/sbin/solardeck-helper
KEY="${APP_DIR}/backend/.ssh/id_ed25519"
mkdir -p "$(dirname "$KEY")" && chmod 700 "$(dirname "$KEY")"
[[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N '' -C solardeck-root -f "$KEY"
# Unrestricted root key (host shells, GPU drivers, network services), accepted from this machine only.
mkdir -p /root/.ssh && chmod 700 /root/.ssh
AUTH=/root/.ssh/authorized_keys
touch "$AUTH"
{ grep -v ' solardeck-root$' "$AUTH" || true; echo "from=\"127.0.0.1,::1\" $(cat "${KEY}.pub")"; } >"${AUTH}.tmp"
mv "${AUTH}.tmp" "$AUTH" && chmod 600 "$AUTH"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 \
  root@127.0.0.1 true && ok "SSH bridge root@127.0.0.1 works" \
  || warn "SSH bridge check failed (sshd must allow key logins for root: PermitRootLogin prohibit-password)"

# ---------------------------------------------------------------- 8. Backend + frontend
msg "Installing backend dependencies"
cd "${APP_DIR}/backend"
[[ -x .venv/bin/pip ]] || python3 -m venv .venv
if [[ -n "$BUNDLE" && -d "${SRC%/}/wheels" ]] && .venv/bin/pip install -q --no-index --find-links "${SRC%/}/wheels" -r requirements.txt; then
  ok "Python packages installed from the bundled wheels"
else
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi
# Release installs (ISO bundle, the solaros branch) ship the built desktop, so SolarOS needs neither Node.js nor npm.
if [[ -f "${APP_DIR}/frontend/dist/index.html" ]] && { [[ -n "$PREBUILT" ]] || git -C "$APP_DIR" -c safe.directory='*' ls-files --error-unmatch frontend/dist/index.html >/dev/null 2>&1; }; then
  ok "Desktop prebuilt"
else
  if ! node -v 2>/dev/null | grep -Eq '^v2[2-9]\.'; then
    msg "Installing Node.js 22 to build the desktop"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq --no-install-recommends nodejs >/dev/null
  fi
  msg "Building the desktop"
  cd "${APP_DIR}/frontend"
  npm ci --no-audit --no-fund --loglevel=error
  VITE_EDITION=solaros npm run build >/dev/null
  rm -rf node_modules
  ok "Desktop built"
fi

# ---------------------------------------------------------------- 9. Samba, nginx, services
touch /etc/samba/solardeck-shares.conf
grep -q 'solardeck-shares.conf' /etc/samba/smb.conf || printf '\n# SolarDeck Network Shares\ninclude = /etc/samba/solardeck-shares.conf\n' >>/etc/samba/smb.conf
systemctl enable -q smbd && systemctl restart smbd

msg "Configuring nginx"
install -m 644 "${APP_DIR}/deploy/nginx.conf" /etc/nginx/sites-available/solardeck
ln -sf /etc/nginx/sites-available/solardeck /etc/nginx/sites-enabled/solardeck
rm -f /etc/nginx/sites-enabled/default
bash "${APP_DIR}/deploy/selfsigned-cert.sh" || warn "Could not create the HTTPS certificate; SolarDeck stays on http"
nginx -t -q
systemctl enable -q nginx && (systemctl reload nginx || systemctl restart nginx)

install -m 644 "${APP_DIR}/hypervisor/solardeck-backend.service" /etc/systemd/system/solardeck-backend.service
install -m 755 "${APP_DIR}/hypervisor/solardeck-console-tui.py" /usr/local/bin/solardeck-console
if [[ -n "$WITH_TUI" ]]; then
  install -m 644 "${APP_DIR}/hypervisor/solardeck-console.service" /etc/systemd/system/solardeck-console.service
fi
systemctl daemon-reload
systemctl enable -q solardeck-backend
systemctl restart solardeck-backend
if [[ -n "$WITH_TUI" ]]; then
  systemctl disable -q getty@tty1 2>/dev/null || true
  systemctl enable -q solardeck-console
  systemctl restart solardeck-console
  ok "Console dashboard on tty1"
fi

msg "Health check http://127.0.0.1/api/health"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1/api/health >/dev/null 2>&1 && HEALTHY=1 && break
  sleep 2
done
[[ "${HEALTHY:-}" == 1 ]] || die "Health check failed. Inspect with: journalctl -u solardeck-backend -n 50"
ok "Healthy"

apt-get autoremove -y -qq --purge >/dev/null 2>&1 || true
apt-get clean

# ---------------------------------------------------------------- 10. Summary
trap - ERR
IP="$(ip -4 -o addr show dev "$BRIDGE" 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1)"
IP="${IP:-$(hostname -I | awk '{print $1}')}"
VERSION="$(python3 -c "import json; print(json.load(open('${APP_DIR}/frontend/package.json'))['version'])" 2>/dev/null || echo "?")"
BAR="════════════════════════════════════════════════════════════════════════════"
row() { printf "${C_GREEN}║${C_RESET}  %-16s %-56s ${C_GREEN}║${C_RESET}\n" "$1" "$2"; }
edge() { echo "${C_GREEN}$1${BAR}$2${C_RESET}"; }
echo
edge ╔ ╗
row "" "SolarOS v${VERSION} $([[ -n "$UPGRADE" ]] && echo upgraded || echo "is ready")"
edge ╠ ╣
row "Web UI URL:" "http://${IP}"
row "HTTPS:" "https://${IP} (self-signed certificate)"
if [[ -n "$UPGRADE" ]]; then
  row "Login:" "unchanged (your existing admin password)"
else
  row "Setup code:" "${SETUP_CODE}"
  row "" "Open the Web UI and create your administrator with this code."
fi
row "Edition:" "SolarOS (native_ubuntu)"
row "Bridge:" "${BRIDGE}"
row "Console:" "$([[ -n "$WITH_TUI" ]] && echo "dashboard on tty1" || echo "add --with-console-tui for the tty1 dashboard")"
edge ╠ ╣
row "Tip:" "Update anytime from Control Panel -> System & Updates."
edge ╚ ╝
echo
