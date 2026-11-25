#!/usr/bin/env bash
# SolarDeck host hardening, shared by both editions (run as root on the hypervisor host).
#   host-hardening.sh check [<prefix>]             print key=value facts for the Security Posture Center
#   host-hardening.sh apply [<prefix>] <part>...   apply parts: sysctl ssh firewall updates apparmor, or "all"
# Used by hypervisor/install-hypervisor.sh (SolarOS) and POST /api/security/harden (over the root SSH bridge).
# NO_UFW=1 skips the ufw part on hosts whose platform ships its own firewall (the backend sets it there).
# Safe to re-run: every part rewrites only its own files and never removes rules someone added.
set -uo pipefail
MODE="${1:-check}"; PREFIX="${2:-solardeck}"; shift 2 2>/dev/null || shift $#
[[ "$PREFIX" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "invalid prefix"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
SYSCTL_FILE=/etc/sysctl.d/99-solardeck-hardening.conf
# sshd keeps the FIRST value it reads, so this file sorts before distribution drop-ins such as 50-cloud-init.conf.
SSHD_FILE=/etc/ssh/sshd_config.d/10-solardeck-hardening.conf
SYSCTL=(kernel.randomize_va_space=2 fs.protected_symlinks=1 fs.protected_hardlinks=1 kernel.kptr_restrict=2
  kernel.dmesg_restrict=1 net.ipv4.tcp_syncookies=1 net.ipv4.conf.all.accept_redirects=0
  net.ipv4.conf.all.send_redirects=0)

# Authorized SSH keys of people (not SolarDeck's own bridge and helper keys).
user_keys() {
  cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null | grep -vE '^\s*(#|$)' \
    | grep -vcE "(${PREFIX}|solardeck)-(root|helper)\s*$" || true
}
root_password_locked() { [[ "$(passwd -S root 2>/dev/null | awk '{print $2}')" =~ ^(L|NP|LK)$ ]]; }

check() {
  local ok=1 kv fw=inactive kind=none
  for kv in "${SYSCTL[@]}"; do [[ "$(sysctl -n "${kv%%=*}" 2>/dev/null)" == "${kv#*=}" ]] || ok=0; done
  echo "sysctl_file=$([[ -f $SYSCTL_FILE ]] && echo 1 || echo 0)"
  echo "sysctl_active=${ok}"
  echo "ssh_installed=$(command -v sshd >/dev/null && echo 1 || echo 0)"
  echo "ssh_active=$(systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null || true)"
  echo "ssh_password=$(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}')"
  echo "ssh_root=$(sshd -T 2>/dev/null | awk '$1 == "permitrootlogin" {print $2}')"
  echo "ssh_user_keys=$(user_keys)"
  if command -v ufw >/dev/null && ufw status verbose 2>/dev/null | grep -q '^Status: active'; then
    kind=ufw; ufw status verbose | grep -qE '(deny|reject) \(incoming\)' && fw=active || fw=open
  elif nft list ruleset 2>/dev/null | grep -qE 'hook input .*policy drop'; then
    kind=nftables; fw=active
  fi
  echo "firewall=${fw}"; echo "firewall_kind=${kind}"
  local uu=0
  dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'ok installed' \
    && apt-config dump 2>/dev/null | grep -q 'APT::Periodic::Unattended-Upgrade "1"' && uu=1
  echo "auto_updates=${uu}"
  echo "apparmor=$(aa-enabled 2>/dev/null || echo No)"
}

apply_sysctl() {
  { echo "# SolarDeck kernel hardening (Security & Hardening in the Control Panel)"; printf '%s\n' "${SYSCTL[@]}"; } >"$SYSCTL_FILE"
  sysctl -q -p "$SYSCTL_FILE" && echo "sysctl: kernel hardening active"
}

apply_ssh() {
  [[ -d /etc/ssh/sshd_config.d ]] || { echo "ssh: no OpenSSH server drop-in directory; skipped"; return 0; }
  local keys; keys="$(user_keys)"
  {
    echo "# SolarDeck SSH hardening (Security & Hardening in the Control Panel)"
    # Never lock people out: password sign-in stays until someone has an SSH key.
    if ((keys > 0)); then
      echo "PasswordAuthentication no"
    else
      echo "ssh: no SSH key for a person is authorized; password sign-in stays on (add a key and apply again)" >&2
    fi
    if ((keys > 0)) || root_password_locked; then echo "PermitRootLogin prohibit-password"; fi
    echo "KbdInteractiveAuthentication no"
    echo "PermitEmptyPasswords no"
    echo "MaxAuthTries 4"
    echo "X11Forwarding no"
  } >"${SSHD_FILE}.new"
  mv "${SSHD_FILE}.new" "$SSHD_FILE" && chmod 644 "$SSHD_FILE"
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    echo "ssh: hardened (passwords $(sshd -T 2>/dev/null | awk '$1 == "passwordauthentication" {print $2}'))"
  else
    rm -f "$SSHD_FILE"; echo "ssh: sshd rejected the configuration; reverted"; return 1
  fi
}

apply_firewall() {
  if [[ -n "${NO_UFW:-}" ]]; then echo "firewall: this platform has its own firewall; enable it in Datacenter -> Firewall"; return 0; fi
  command -v ufw >/dev/null || apt-get install -y -qq --no-install-recommends ufw >/dev/null || { echo "firewall: could not install ufw"; return 1; }
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw default allow routed >/dev/null  # guests' own traffic is forwarded, not addressed to the host
  ufw limit 22/tcp comment 'SSH (rate limited)' >/dev/null
  ufw allow 80/tcp comment 'SolarDeck web UI' >/dev/null
  ufw allow 443/tcp comment 'SolarDeck web UI (HTTPS)' >/dev/null
  ufw allow 51820/udp comment 'WireGuard' >/dev/null
  local f port br
  for f in /etc/wireguard/*.conf; do
    port="$(sed -n 's/^\s*ListenPort\s*=\s*\([0-9]\+\).*/\1/p' "$f" 2>/dev/null | head -n1)"
    [[ -n "$port" ]] && ufw allow "${port}/udp" comment 'WireGuard' >/dev/null
  done
  [[ -f "/etc/samba/${PREFIX}-shares.conf" ]] && ufw allow 445/tcp comment 'Network shares' >/dev/null && ufw allow 139/tcp comment 'Network shares' >/dev/null
  if [[ -f "/etc/dnsmasq.d/${PREFIX}-dns.conf" ]]; then ufw allow 53 comment 'DNS server' >/dev/null; fi
  if [[ -f "/etc/dnsmasq.d/${PREFIX}-dhcp.conf" ]]; then ufw allow 67/udp comment 'DHCP server' >/dev/null; fi
  # Guest NAT networks need DHCP/DNS from the host.
  for br in incusbr0 virbr0; do ufw allow in on "$br" comment 'guest network' >/dev/null; done
  ufw --force enable >/dev/null && echo "firewall: ufw active, incoming denied except the allowed services"
}

apply_updates() {
  dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'ok installed' \
    || apt-get install -y -qq --no-install-recommends unattended-upgrades >/dev/null || { echo "updates: could not install unattended-upgrades"; return 1; }
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable -q --now unattended-upgrades 2>/dev/null || true
  echo "updates: automatic security updates on"
}

apply_apparmor() {
  command -v aa-enabled >/dev/null || { echo "apparmor: not installed; skipped"; return 0; }
  systemctl enable -q --now apparmor 2>/dev/null || true
  # libvirt confines each VM with its own profile unless security_driver is "none"; Incus does so automatically.
  if grep -qE '^\s*security_driver\s*=\s*"none"' /etc/libvirt/qemu.conf 2>/dev/null; then
    echo "apparmor: libvirt has security_driver = \"none\" in /etc/libvirt/qemu.conf; VMs run unconfined"
  fi
  echo "apparmor: $(aa-enabled 2>/dev/null || echo No)"
}

case "$MODE" in
  check) check ;;
  apply)
    parts=("$@"); [[ ${#parts[@]} -eq 0 || " ${parts[*]} " == *" all "* ]] && parts=(sysctl ssh firewall updates apparmor)
    rc=0
    for p in "${parts[@]}"; do
      case "$p" in sysctl|ssh|firewall|updates|apparmor) "apply_$p" || rc=1 ;; *) echo "unknown part: $p"; rc=2 ;; esac
    done
    exit "$rc" ;;
  *) echo "usage: $0 check|apply [<prefix>] [<part>...]"; exit 2 ;;
esac
