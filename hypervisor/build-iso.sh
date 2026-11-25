#!/usr/bin/env bash
# Build a bootable SolarOS installer ISO from an Ubuntu Server LTS live ISO (run on Linux).
#   hypervisor/build-iso.sh [--source-iso ubuntu-24.04.x-live-server-amd64.iso] [--output dist/SolarOS-vX-amd64.iso]
#                           [--auto-disk /dev/sda] [--copy-to <dir>] [--ubuntu-release 24.04] [--hostname solaros]
#                           [--password <console user password>]
# Without --source-iso the latest official live-server ISO of --ubuntu-release is downloaded and SHA256-verified.
# The default boot entry is an Ubuntu autoinstall that asks for the target disk (safe on bare metal); --auto-disk adds
# a second, fully automatic entry that erases that disk (nested VM tests). The ISO embeds the SolarDeck source, the
# built desktop (frontend/dist) and the backend's Python wheels; on first boot hypervisor/firstboot-setup.sh creates
# br0, installs KVM/libvirt, Incus, OpenZFS, the tty1 console and SolarDeck (HYPERVISOR_DRIVER=native_ubuntu).
# --copy-to <dir> also copies the finished ISO into that folder (for example a hypervisor's ISO library).
# The bundle is the SolarOS edition tree (deploy/make-edition-tree.sh): nothing of other editions is embedded.
# Needs: xorriso, curl, openssl (or mkpasswd), gzip; npm (Node 22) and python3-pip to bundle the desktop and wheels.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "${ROOT}/frontend/package.json" | head -n1)"
SOURCE_ISO="" OUTPUT="" RELEASE="24.04" HOSTNAME_="solaros" PASSWORD="" AUTO_DISK="" COPY_TO=""
CACHE="${ROOT}/hypervisor/.cache"

die() { echo "build-iso: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --source-iso) SOURCE_ISO="${2:?}"; shift 2 ;;
    --output) OUTPUT="${2:?}"; shift 2 ;;
    --ubuntu-release) RELEASE="${2:?}"; shift 2 ;;
    --hostname) HOSTNAME_="${2:?}"; shift 2 ;;
    --password) PASSWORD="${2:?}"; shift 2 ;;
    --auto-disk) AUTO_DISK="${2:?}"; shift 2 ;;
    --copy-to) COPY_TO="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$HOSTNAME_" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "invalid --hostname"
[[ "$RELEASE" =~ ^[0-9]{2}\.04$ ]] || die "invalid --ubuntu-release (e.g. 24.04)"
[[ -z "$AUTO_DISK" || "$AUTO_DISK" =~ ^/dev/[a-z][a-z0-9/_-]*$ ]] || die "invalid --auto-disk (e.g. /dev/sda or /dev/vda)"
[[ -z "$COPY_TO" || -d "$COPY_TO" ]] || die "--copy-to: ${COPY_TO} is not a directory"
OUTPUT="${OUTPUT:-${PWD}/dist/SolarOS-v${VERSION}-amd64.iso}"
mkdir -p "$(dirname "$OUTPUT")"
for bin in xorriso curl gzip; do command -v "$bin" >/dev/null || die "missing $bin (apt install xorriso curl git)"; done

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
# Keep the ISO under GitHub's 2 GiB release-asset limit: drop the offline package pool (drivers, firmware, kernels;
# APT fetches them from the mirror, and first boot needs the network anyway) and the HWE kernel with its menu entry.
rm -rf "$WORK/iso/pool" "$WORK/iso/casper/hwe-"* "$WORK/iso/casper/"*generic-hwe.*
awk '/^menuentry .*HWE kernel/ {skip=1} skip && /^}/ {skip=0; next} !skip' "$WORK/iso/boot/grub/grub.cfg" >"$WORK/grub.cfg"
mv "$WORK/grub.cfg" "$WORK/iso/boot/grub/grub.cfg"
sed -i -E '\#\./(pool/|casper/hwe-|casper/.*generic-hwe\.)#d' "$WORK/iso/md5sum.txt" 2>/dev/null || true

# ---------------------------------------------------------------- autoinstall seeds
for mode in manual ${AUTO_DISK:+auto}; do
  mkdir -p "$WORK/iso/nocloud/$mode"
  inter="interactive-sections: [storage]" match=""
  [[ "$mode" == auto ]] && inter="" match="match: {path: ${AUTO_DISK}}"
  sed -e "s|@@INTERACTIVE@@|${inter}|" -e "s|@@DISK_MATCH@@|${match}|" -e "s|@@HOSTNAME@@|${HOSTNAME_}|" -e "s|@@PASSWORD_HASH@@|${HASH}|" \
    "${ROOT}/hypervisor/autoinstall/user-data.template" >"$WORK/iso/nocloud/$mode/user-data"
  cp "${ROOT}/hypervisor/autoinstall/meta-data" "$WORK/iso/nocloud/$mode/meta-data"
  grep -qE '@@[A-Z_]+@@' "$WORK/iso/nocloud/$mode/user-data" && die "unfilled placeholder in user-data"
done

# ---------------------------------------------------------------- Embedded SolarDeck bundle (source + desktop + wheels)
mkdir -p "$WORK/src" "$WORK/iso/solardeck"
if git -C "$ROOT" rev-parse -q HEAD >/dev/null 2>&1; then
  echo "==> Embedding SolarDeck $(git -C "$ROOT" describe --tags --always 2>/dev/null) (committed HEAD)"
  git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK/src"
  git -C "$ROOT" rev-parse HEAD >"$WORK/src/.build-commit"
  [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || echo "    note: uncommitted changes are not included"
else
  # An installed copy without .git (ISO or deploy.sh install): embed the tree itself, minus state and build output.
  echo "==> Embedding SolarDeck from ${ROOT}"
  tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=.venv --exclude=dist --exclude=__pycache__ \
    --exclude=hypervisor/.cache --exclude=backend/.env --exclude=backend/.ssh --exclude='backend/data/*.json' \
    --exclude=backend/data/themes --exclude='*.iso' -cf - . | tar -x -C "$WORK/src"
  cp "${ROOT}/backend/data/app_catalog.json" "$WORK/src/backend/data/"
  cp "${ROOT}/.build-commit" "$WORK/src/.build-commit" 2>/dev/null || true
fi
if [[ -d "$WORK/src/deploy/editions" ]]; then
  echo "==> Reducing the tree to the SolarOS edition"
  bash "$WORK/src/deploy/make-edition-tree.sh" solaros "$WORK/src" "$WORK/edition" || die "the SolarOS tree check failed"
  cp "$WORK/src/.build-commit" "$WORK/edition/" 2>/dev/null || true
  rm -rf "$WORK/src" && mv "$WORK/edition" "$WORK/src"
fi
# Each piece is optional: what is missing here is fetched on first boot instead (needs internet there).
if command -v npm >/dev/null && node -v 2>/dev/null | grep -Eq '^v(2[2-9]|[3-9][0-9])\.'; then
  echo "==> Building the desktop (frontend/dist)"
  (cd "$WORK/src/frontend" && npm ci --no-audit --no-fund --loglevel=error && VITE_EDITION=solaros npm run build >/dev/null) || die "desktop build failed"
  rm -rf "$WORK/src/frontend/node_modules"
else
  echo "    note: Node.js 22+ not found; the desktop is built on first boot (needs internet)"
fi
# The installed system runs Ubuntu's python3, so fetch wheels for that interpreter, not this machine's.
case "$RELEASE" in 24.04) PYV=3.12 ;; 26.04) PYV=3.14 ;; *) PYV="" ;; esac
if [[ -n "$PYV" ]] && python3 -m pip --version >/dev/null 2>&1; then
  echo "==> Downloading Python wheels for CPython ${PYV}"
  python3 -m pip download -q -r "$WORK/src/backend/requirements.txt" -d "$WORK/src/wheels" --only-binary=:all: \
    --implementation cp --python-version "$PYV" --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 \
    --platform manylinux_2_34_x86_64 --platform linux_x86_64 \
    || { echo "    note: wheel download failed; Python packages are installed from PyPI on first boot"; rm -rf "$WORK/src/wheels"; }
else
  echo "    note: pip not found; Python packages are installed from PyPI on first boot"
fi
tar -czf "$WORK/iso/solardeck/solardeck-src.tar.gz" -C "$WORK/src" .
echo "    bundle: $(du -h "$WORK/iso/solardeck/solardeck-src.tar.gz" | cut -f1)$([[ -d "$WORK/src/frontend/dist" ]] && echo ", desktop prebuilt")$([[ -d "$WORK/src/wheels" ]] && echo ", $(ls "$WORK/src/wheels" | wc -l) wheels")"

# ---------------------------------------------------------------- Boot menu
CFG="$WORK/iso/boot/grub/grub.cfg"
KERNEL="$(grep -m1 -oE 'linux\s+\S+' "$CFG" | awk '{print $2}')"
INITRD="$(grep -m1 -oE 'initrd\s+\S+' "$CFG" | awk '{print $2}')"
[[ -n "$KERNEL" && -n "$INITRD" ]] || die "cannot find the kernel/initrd in grub.cfg"
ENTRIES="$WORK/entries.cfg"
cat >"$ENTRIES" <<EOF
menuentry "Install SolarOS (Interactive Disk Selection)" {
	set gfxpayload=keep
	linux	${KERNEL} autoinstall ds=nocloud\\;s=/cdrom/nocloud/manual/ ---
	initrd	${INITRD}
}
EOF
[[ -n "$AUTO_DISK" ]] && cat >>"$ENTRIES" <<EOF
menuentry "SolarOS - Automated VM Test Install (erases ${AUTO_DISK})" {
	set gfxpayload=keep
	linux	${KERNEL} autoinstall ds=nocloud\\;s=/cdrom/nocloud/auto/ ---
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
echo "SolarOS installer ISO: ${OUTPUT} ($(du -h "$OUTPUT" | cut -f1))"
echo "  Console user: solardeck / ${PASSWORD}$([[ -n "${GENERATED:-}" ]] && echo "  (generated; keep it)")"
echo "  Web UI admin password: generated on first boot, shown on the server's console (tty1)."
echo "  SHA-256: $(sha256sum "$OUTPUT" | cut -d' ' -f1)"
if [[ -n "$COPY_TO" ]]; then
  cp "$OUTPUT" "${COPY_TO%/}/$(basename "$OUTPUT")"
  echo "  Copied to ${COPY_TO%/}/$(basename "$OUTPUT")"
  for t in "${ROOT}"/hypervisor/test-in-*-vm.sh; do
    [[ -f "$t" ]] && echo "  Test it in a nested VM: bash ${t} --iso ${COPY_TO%/}/$(basename "$OUTPUT")"
  done
fi
