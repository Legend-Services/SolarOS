#!/usr/bin/env bash
# SolarOS first-boot appliance setup, run once by solardeck-firstboot.service after the ISO's autoinstall.
#   firstboot-setup.sh [--bundle /opt/solardeck-src]
# 1. Bridges the primary Ethernet port into br0 (DHCP) with a clean Netplan file, replacing the installer's config.
# 2. Runs install-hypervisor.sh in bundle mode: KVM/libvirt, Incus, OpenZFS, Samba, nginx, SolarDeck in /opt/solardeck
#    from the bundled wheels and desktop build, backend/.env with a generated
#    JWT_SECRET, a one-time setup code for the administrator, the tty1 console dashboard and the host hardening
#    (sysctl, SSH, ufw default-deny, AppArmor, automatic security updates; deploy/host-hardening.sh).
# 3. Puts the Incus default profile on br0, enables the hypervisor services and disables itself.
# The setup code is on tty1 (and in /etc/solardeck/setup-code, 0600). Log: journalctl -u solardeck-firstboot
set -Eeuo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive

BUNDLE="/opt/solardeck-src"
BRIDGE="br0"
NETPLAN="/etc/netplan/60-solardeck-bridge.yaml"
STATE="/etc/solardeck"
[[ "${1:-}" == --bundle ]] && BUNDLE="${2:?--bundle needs a directory}"

log() { echo "solardeck-firstboot: $*"; }
[[ $EUID -eq 0 ]] || { log "run as root"; exit 1; }
mkdir -p "$STATE" && chmod 700 "$STATE"

# ---------------------------------------------------------------- 0. APT: the offline repository from the ISO
# The installer left the ISO (/cdrom) as the package source. Use the copy in /opt/solardeck-offline/repo instead, so
# every package installs without internet; the Ubuntu mirrors are enabled only when they can be reached (otherwise they
# stay listed with "Enabled: no": set it to yes once the server is online to get updates).
OFFLINE="/opt/solardeck-offline"
if [[ -f "${OFFLINE}/repo/solardeck-offline.gpg" ]]; then
  . /etc/os-release
  install -D -m 644 "${OFFLINE}/repo/solardeck-offline.gpg" /etc/apt/keyrings/solardeck-offline.gpg
  echo "deb [signed-by=/etc/apt/keyrings/solardeck-offline.gpg] file://${OFFLINE}/repo ${VERSION_CODENAME} main" \
    >/etc/apt/sources.list.d/solardeck-offline.list
  [[ -f /etc/apt/sources.list ]] && sed -i -E 's|^([^#].*file:/+cdrom)|# \1|' /etc/apt/sources.list
  ONLINE=no
  curl -fsS -m 10 -o /dev/null "http://archive.ubuntu.com/ubuntu/dists/${VERSION_CODENAME}/Release" 2>/dev/null && ONLINE=yes
  cat >/etc/apt/sources.list.d/ubuntu.sources <<EOF
# Ubuntu mirrors. Enabled: ${ONLINE} at first boot (no = there was no internet); set it to yes to get online updates.
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: ${VERSION_CODENAME} ${VERSION_CODENAME}-updates ${VERSION_CODENAME}-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Enabled: ${ONLINE}

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: ${VERSION_CODENAME}-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Enabled: ${ONLINE}
EOF
  log "APT uses the offline repository ${OFFLINE}/repo (Ubuntu mirrors enabled: ${ONLINE})"
fi

# ---------------------------------------------------------------- 1. br0 on the primary NIC
primary_nic() {
  local nic
  nic="$(ip -o -4 route show to default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") {print $(i + 1); exit}}')"
  # No default route (no DHCP yet): the first physical Ethernet port.
  [[ -n "$nic" ]] || nic="$(for n in /sys/class/net/en* /sys/class/net/eth*; do [[ -e "$n/device" ]] && basename "$n"; done | head -n1)"
  echo "$nic"
}

BRIDGE_ARGS=()
if [[ ! -d "/sys/class/net/${BRIDGE}" ]]; then
  NIC="$(primary_nic)"
  if [[ -z "$NIC" ]]; then
    log "no Ethernet port found; continuing without ${BRIDGE}"
    BRIDGE_ARGS=(--no-bridge)
  else
    log "bridging ${NIC} into ${BRIDGE} (DHCP)"
    # The installer's config matches en*/eth* by glob and would win over the bridge member; park it and stop cloud-init
    # from writing it back.
    mkdir -p "${STATE}/netplan-installer"
    for f in /etc/netplan/*.yaml; do [[ -e "$f" && "$f" != "$NETPLAN" ]] && mv "$f" "${STATE}/netplan-installer/"; done
    mkdir -p /etc/cloud/cloud.cfg.d
    echo 'network: {config: disabled}' >/etc/cloud/cloud.cfg.d/99-solardeck-disable-network-config.cfg
    # JSON is valid YAML.
    cat >"$NETPLAN" <<EOF
{"network": {"version": 2,
  "ethernets": {"${NIC}": {"dhcp4": false, "dhcp6": false}},
  "bridges": {"${BRIDGE}": {"dhcp4": true, "dhcp6": false, "interfaces": ["${NIC}"], "parameters": {"stp": false, "forward-delay": 0}}}}}
EOF
    chmod 600 "$NETPLAN"
    if netplan generate && netplan apply; then
      for _ in $(seq 1 45); do ip -4 -o addr show dev "$BRIDGE" 2>/dev/null | grep -q inet && break; sleep 1; done
    fi
    if ! ip -4 -o addr show dev "$BRIDGE" 2>/dev/null | grep -q inet; then
      log "${BRIDGE} got no address; restoring the installer's network configuration"
      rm -f "$NETPLAN" /etc/cloud/cloud.cfg.d/99-solardeck-disable-network-config.cfg
      mv "${STATE}"/netplan-installer/*.yaml /etc/netplan/ 2>/dev/null || true
      netplan apply || true
      ip link delete "$BRIDGE" 2>/dev/null || true
      BRIDGE_ARGS=(--no-bridge)
    else
      log "${BRIDGE} is up: $(ip -4 -o addr show dev "$BRIDGE" | awk '{print $4; exit}')"
    fi
  fi
fi

# ---------------------------------------------------------------- 2. SolarDeck + hypervisor stack
bash "${BUNDLE}/hypervisor/install-hypervisor.sh" --bundle "$BUNDLE" --with-console-tui "${BRIDGE_ARGS[@]}"

# ---------------------------------------------------------------- 3. Incus on br0, services, done
if [[ -d "/sys/class/net/${BRIDGE}" ]] && ! incus profile device get default eth0 parent 2>/dev/null | grep -qx "$BRIDGE"; then
  incus profile device remove default eth0 >/dev/null 2>&1 || true
  incus profile device add default eth0 nic nictype=bridged parent="$BRIDGE" name=eth0 >/dev/null \
    && log "Incus default profile uses ${BRIDGE}" || log "could not attach the Incus default profile to ${BRIDGE}"
fi
for unit in libvirtd qemu-kvm zfs-import-cache zfs-mount zfs.target smbd nginx solardeck-backend solardeck-console; do
  systemctl enable -q "$unit" 2>/dev/null || true  # qemu-kvm only exists on some releases
done
systemctl disable -q solardeck-firstboot.service 2>/dev/null || true
touch /var/lib/solardeck-firstboot.done
log "done; open the Web UI and create the administrator with the setup code shown on tty1"
