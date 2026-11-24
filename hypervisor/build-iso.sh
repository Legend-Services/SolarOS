#!/usr/bin/env bash
# Build a bootable SolarDeck Hypervisor installer ISO from an Ubuntu Server LTS live ISO (run on Linux).
#   hypervisor/build-iso.sh [--source-iso ubuntu-24.04.x-live-server-amd64.iso] [--output SolarDeck-Hypervisor-vX-amd64.iso]
#                           [--ubuntu-release 24.04] [--hostname solardeck] [--password <console user password>]
# Without --source-iso the latest official live-server ISO of --ubuntu-release is downloaded and SHA256-verified.
# The result boots into an unattended Ubuntu install (autoinstall, nocloud) that copies the embedded SolarDeck
# source to the disk; on first boot it installs KVM/libvirt, Incus, OpenZFS, the console dashboard and SolarDeck
# (HYPERVISOR_DRIVER=native_ubuntu). Needs: xorriso, curl, openssl (or mkpasswd), git, gzip.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "${ROOT}/frontend/package.json" | head -n1)"
SOURCE_ISO="" OUTPUT="" RELEASE="24.04" HOSTNAME_="solardeck" PASSWORD=""
CACHE="${ROOT}/hypervisor/.cache"

die() { echo "build-iso: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --source-iso) SOURCE_ISO="${2:?}"; shift 2 ;;
    --output) OUTPUT="${2:?}"; shift 2 ;;
    --ubuntu-release) RELEASE="${2:?}"; shift 2 ;;
    --hostname) HOSTNAME_="${2:?}"; shift 2 ;;
    --password) PASSWORD="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$HOSTNAME_" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "invalid --hostname"
[[ "$RELEASE" =~ ^[0-9]{2}\.04$ ]] || die "invalid --ubuntu-release (e.g. 24.04)"
OUTPUT="${OUTPUT:-${ROOT}/SolarDeck-Hypervisor-v${VERSION}-amd64.iso}"
for bin in xorriso curl git gzip; do command -v "$bin" >/dev/null || die "missing $bin (apt install xorriso curl git)"; done

# ---------------------------------------------------------------- Source ISO
if [[ -z "$SOURCE_ISO" ]]; then
  mkdir -p "$CACHE"
  BASE="https://releases.ubuntu.com/${RELEASE}"
  echo "==> Looking up the Ubuntu Server ${RELEASE} live ISO"
  SUMS="$(curl -fsSL "${BASE}/SHA256SUMS")" || die "cannot reach ${BASE}"
  LINE="$(grep -E 'live-server-amd64\.iso$' <<<"$SUMS" | tail -n1)"
  [[ -n "$LINE" ]] || die "no live-server-amd64 ISO listed in ${BASE}/SHA256SUMS"
  SHA="${LINE%% *}"; NAME="${LINE##*[ *]}"
  SOURCE_ISO="${CACHE}/${NAME}"
  if ! { [[ -f "$SOURCE_ISO" ]] && echo "${SHA}  ${SOURCE_ISO}" | sha256sum -c --status; }; then
    echo "==> Downloading ${NAME}"
    curl -fL --retry 3 -o "${SOURCE_ISO}.part" "${BASE}/${NAME}"
    echo "${SHA}  ${SOURCE_ISO}.part" | sha256sum -c --status || die "checksum mismatch for ${NAME}"
    mv "${SOURCE_ISO}.part" "$SOURCE_ISO"
  fi
fi
[[ -f "$SOURCE_ISO" ]] || die "source ISO not found: ${SOURCE_ISO}"

# ---------------------------------------------------------------- Console user password
if [[ -z "$PASSWORD" ]]; then
  PASSWORD="$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 12)"
  GENERATED=1
fi
HASH="$(openssl passwd -6 "$PASSWORD" 2>/dev/null || mkpasswd -m sha-512 "$PASSWORD")" || die "need openssl 1.1.1+ or mkpasswd"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "==> Extracting $(basename "$SOURCE_ISO")"
xorriso -osirrox on -indev "$SOURCE_ISO" -extract / "$WORK/iso" 2>/dev/null
chmod -R u+w "$WORK/iso"
[[ -f "$WORK/iso/boot/grub/grub.cfg" ]] || die "not an Ubuntu live-server ISO (no boot/grub/grub.cfg)"

# ---------------------------------------------------------------- autoinstall seeds
for mode in auto manual; do
  mkdir -p "$WORK/iso/nocloud/$mode"
  inter=""; [[ "$mode" == manual ]] && inter="interactive-sections: [storage]"
  sed -e "s|@@INTERACTIVE@@|${inter}|" -e "s|@@HOSTNAME@@|${HOSTNAME_}|" -e "s|@@PASSWORD_HASH@@|${HASH}|" \
    "${ROOT}/hypervisor/autoinstall/user-data.template" >"$WORK/iso/nocloud/$mode/user-data"
  cp "${ROOT}/hypervisor/autoinstall/meta-data" "$WORK/iso/nocloud/$mode/meta-data"
  grep -q '@@' "$WORK/iso/nocloud/$mode/user-data" && die "unfilled placeholder in user-data"
done

# ---------------------------------------------------------------- Embedded SolarDeck source (committed HEAD)
echo "==> Embedding SolarDeck $(git -C "$ROOT" describe --tags --always 2>/dev/null)"
mkdir -p "$WORK/src" "$WORK/iso/solardeck"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK/src"
git -C "$ROOT" rev-parse HEAD >"$WORK/src/.build-commit"
tar -czf "$WORK/iso/solardeck/solardeck-src.tar.gz" -C "$WORK/src" .
[[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo "    note: uncommitted changes are not included"

# ---------------------------------------------------------------- Boot menu
CFG="$WORK/iso/boot/grub/grub.cfg"
KERNEL="$(grep -m1 -oE 'linux\s+\S+' "$CFG" | awk '{print $2}')"
INITRD="$(grep -m1 -oE 'initrd\s+\S+' "$CFG" | awk '{print $2}')"
[[ -n "$KERNEL" && -n "$INITRD" ]] || die "cannot find the kernel/initrd in grub.cfg"
ENTRIES="$WORK/entries.cfg"
cat >"$ENTRIES" <<EOF
menuentry "Install SolarDeck Hypervisor (automatic, erases the largest disk)" {
	set gfxpayload=keep
	linux	${KERNEL} autoinstall ds=nocloud\\;s=/cdrom/nocloud/auto/ ---
	initrd	${INITRD}
}
menuentry "Install SolarDeck Hypervisor (choose the target disk)" {
	set gfxpayload=keep
	linux	${KERNEL} autoinstall ds=nocloud\\;s=/cdrom/nocloud/manual/ ---
	initrd	${INITRD}
}
EOF
awk -v f="$ENTRIES" 'BEGIN{done=0} /^menuentry/ && !done {while ((getline l < f) > 0) print l; done=1} {print}' "$CFG" >"$CFG.new"
sed -i -e 's/^set timeout=.*/set timeout=10/' -e 's/^set default=.*/set default=0/' "$CFG.new"
mv "$CFG.new" "$CFG"

# ---------------------------------------------------------------- Repack with the original boot layout (BIOS + UEFI)
echo "==> Writing $(basename "$OUTPUT")"
mapfile -t OPTS < <(xorriso -indev "$SOURCE_ISO" -report_el_torito as_mkisofs 2>/dev/null)
[[ ${#OPTS[@]} -gt 0 ]] || die "cannot read the El Torito boot layout of the source ISO"
eval "xorriso -as mkisofs ${OPTS[*]} -o \"\$OUTPUT\" \"\$WORK/iso\"" 2>&1 | grep -vE '^(xorriso|libisofs|Drive current|Media current|Media status|Added to ISO)' || true
[[ -s "$OUTPUT" ]] || die "xorriso did not write ${OUTPUT}"

echo
echo "SolarDeck Hypervisor ISO: ${OUTPUT} ($(du -h "$OUTPUT" | cut -f1))"
echo "  Console user: solardeck / ${PASSWORD}$([[ -n "${GENERATED:-}" ]] && echo "  (generated; keep it)")"
echo "  Web UI admin password: generated on first boot, shown on the server's console (tty1)."
