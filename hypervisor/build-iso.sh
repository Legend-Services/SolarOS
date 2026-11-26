#!/usr/bin/env bash
# Build a bootable SolarOS installer ISO from an Ubuntu Server LTS live ISO (run on Linux, as root).
#   hypervisor/build-iso.sh [--source-iso ubuntu-24.04.x-live-server-amd64.iso] [--output dist/SolarOS-vX-amd64.iso]
#                           [--auto-disk /dev/sda] [--copy-to <dir>] [--ubuntu-release 24.04] [--hostname solaros]
#                           [--password <console user password>] [--no-offline-repo]
# Without --source-iso the latest official live-server ISO of --ubuntu-release is downloaded and SHA256-verified.
# The default boot entry is an Ubuntu autoinstall that asks for the target disk (safe on bare metal); --auto-disk adds
# a second, fully automatic entry that erases that disk (nested VM tests).
# The ISO installs with no network at all: its own package archive (<iso>/dists + <iso>/pool, the archive the Ubuntu
# installer always uses) is replaced by a signed APT repository with the complete .deb closure of the kernel, the boot
# loaders and every package SolarOS uses (resolved inside the ISO's own minimal root file system, so the build host may
# be any Linux), and <iso>/solardeck-bundle.tar.gz holds the SolarDeck source, the
# built desktop (frontend/dist) and the backend's Python wheels. Both are copied to /opt/solardeck-offline on the
# installed system; on first boot hypervisor/firstboot-setup.sh creates br0 and installs KVM/libvirt, Incus, OpenZFS,
# the tty1 console and SolarDeck (HYPERVISOR_DRIVER=native_ubuntu) from them.
# --no-offline-repo leaves the repository out (smaller ISO; the installer and first boot then need the internet).
# --copy-to <dir> also copies the finished ISO into that folder (for example a hypervisor's ISO library).
# The bundle is the SolarOS edition tree (deploy/make-edition-tree.sh): nothing of other editions is embedded.
# Needs: xorriso, curl, gzip, openssl (or mkpasswd); unsquashfs (squashfs-tools), gpg, apt-ftparchive (apt-utils) for
# the repository; npm (Node 22) and python3-pip to bundle the desktop and wheels. Building the repository needs internet.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "${ROOT}/frontend/package.json" | head -n1)"
SOURCE_ISO="" OUTPUT="" RELEASE="24.04" HOSTNAME_="solaros" PASSWORD="" AUTO_DISK="" COPY_TO="" NO_REPO=""
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
    --no-offline-repo) NO_REPO=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
if [[ -z "$NO_REPO" ]]; then
  [[ $EUID -eq 0 ]] || die "run as root: the offline package repository is resolved in a chroot (or pass --no-offline-repo)"
  for bin in unsquashfs mksquashfs gpg apt-ftparchive; do
    command -v "$bin" >/dev/null || die "missing $bin (apt install squashfs-tools gpg apt-utils), or pass --no-offline-repo"
  done
fi

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
  # Unknown to anyone (not printed): the setup wizard creates the real administrator and locks this bootstrap user.
  PASSWORD="$(openssl rand -base64 48 | tr -dc 'a-zA-Z0-9' | head -c 40)"
  GENERATED=1
fi
HASH="$(openssl passwd -6 "$PASSWORD" 2>/dev/null || mkpasswd -m sha-512 "$PASSWORD")" || die "need openssl 1.1.1+ or mkpasswd"

WORK="$(mktemp -d)"
trap 'umount -l "$WORK/chroot/dev" 2>/dev/null || true; rm -rf "$WORK"' EXIT
echo "==> Extracting $(basename "$SOURCE_ISO")"
xorriso -osirrox on -indev "$SOURCE_ISO" -extract / "$WORK/iso" 2>/dev/null
chmod -R u+w "$WORK/iso"
[[ -f "$WORK/iso/boot/grub/grub.cfg" ]] || die "not an Ubuntu live-server ISO (no boot/grub/grub.cfg)"
# Drop the stock package pool (2 GB of drivers, firmware and kernels for every variant) and the HWE kernel with its
# menu entry: the SolarOS repository below carries exactly the packages this installation needs.
rm -rf "$WORK/iso/pool" "$WORK/iso/casper/hwe-"* "$WORK/iso/casper/"*generic-hwe.*
awk '/^menuentry .*HWE kernel/ {skip=1} skip && /^}/ {skip=0; next} !skip' "$WORK/iso/boot/grub/grub.cfg" >"$WORK/grub.cfg"
mv "$WORK/grub.cfg" "$WORK/iso/boot/grub/grub.cfg"
sed -i -E '\#\./(pool/|casper/hwe-|casper/.*generic-hwe\.)#d' "$WORK/iso/md5sum.txt" 2>/dev/null || true

# ---------------------------------------------------------------- Offline package repository (signed)
REPO_KEY="$WORK/solardeck-offline.asc"
if [[ -z "$NO_REPO" ]]; then
  SQUASH="$WORK/iso/casper/ubuntu-server-minimal.squashfs"
  [[ -f "$SQUASH" ]] || die "no casper/ubuntu-server-minimal.squashfs in the source ISO"
  echo "==> Resolving the offline package repository in the ISO's minimal root file system"
  CH="$WORK/chroot"
  unsquashfs -q -n -d "$CH" "$SQUASH" >/dev/null || die "cannot unpack ${SQUASH##*/}"
  CODENAME="$(. "$CH/etc/os-release" && echo "$VERSION_CODENAME")"
  [[ "$CODENAME" =~ ^[a-z]+$ ]] || die "cannot read the release codename of the source ISO"
  # Device nodes for apt on a private tmpfs: works on build hosts whose disk forbids device files, and removing it can
  # never touch the host's own /dev (no bind mounts).
  mkdir -p "$CH/dev"
  mount -t tmpfs -o mode=755,size=1m solardeck-dev "$CH/dev"
  for n in "null 1 3" "zero 1 5" "random 1 8" "urandom 1 9"; do
    set -- $n; mknod -m 666 "$CH/dev/$1" c "$2" "$3"
  done
  rm -f "$CH/etc/resolv.conf" "$CH/etc/apt/sources.list" "$CH"/etc/apt/sources.list.d/*
  cp -L /etc/resolv.conf "$CH/etc/resolv.conf"
  cat >"$CH/etc/apt/sources.list.d/ubuntu.sources" <<EOF
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: ${CODENAME} ${CODENAME}-updates ${CODENAME}-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  inchroot() { chroot "$CH" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive "$@"; }
  APT_OPTS=(-q -y --download-only --no-install-recommends -o Dir::Cache::archives=/solardeck-debs -o APT::Sandbox::User=root)
  mkdir -p "$CH/solardeck-debs/partial"
  inchroot apt-get -q -o APT::Sandbox::User=root update >/dev/null || die "apt-get update failed in the chroot (internet needed)"
  # The package list of install-hypervisor.sh (single source of truth) plus the installer's kernel and extras.
  PKGS=()
  eval "$(sed -n '/^PKGS=(/,/)$/p' "${ROOT}/hypervisor/install-hypervisor.sh")"
  [[ ${#PKGS[@]} -gt 20 ]] || die "cannot read the package list of install-hypervisor.sh"
  SETS=(
    "${PKGS[*]} incus linux-generic openssh-server bolt v4l2loopback-dkms ffmpeg nodejs net-tools"
    "grub-efi-amd64 grub-efi-amd64-signed shim-signed efibootmgr mokutil"  # UEFI boot loader
    "grub-pc"                                                             # BIOS boot loader (conflicts with the EFI set)
  )
  for group in "${SETS[@]}"; do
    # shellcheck disable=SC2086
    inchroot apt-get "${APT_OPTS[@]}" install $group >"$WORK/apt.log" 2>&1 || { tail -n 20 "$WORK/apt.log" >&2; die "cannot resolve: ${group}"; }
  done
  # The installer always adds the ISO's own archive (file:///cdrom) as a package source: our repository takes its place,
  # so no stale index can point at the stock packages removed above.
  R="$WORK/iso"
  rm -rf "$R/dists" "$R/pool"
  sed -i -E '\#\./dists/#d' "$R/md5sum.txt" 2>/dev/null || true
  mkdir -p "$R/pool/main"
  mv "$CH"/solardeck-debs/*.deb "$R/pool/main/"
  umount "$CH/dev" && rm -rf "$CH"
  for p in linux-image- grub-efi-amd64-signed_ shim-signed_ grub-pc_ qemu-system-x86_ zfsutils-linux_ incus_; do
    compgen -G "$R/pool/main/${p}*.deb" >/dev/null || die "the repository lacks ${p%_}"
  done
  # subiquity lists all four components of the primary mirror: everything is in main, the others are empty.
  (
    cd "$R"
    for c in main restricted universe multiverse; do
      d="dists/${CODENAME}/${c}/binary-amd64"
      mkdir -p "$d"
      if [[ "$c" == main ]]; then apt-ftparchive packages pool/main >"$d/Packages" 2>/dev/null; else : >"$d/Packages"; fi
      gzip -9c "$d/Packages" >"$d/Packages.gz"
    done
    apt-ftparchive -o APT::FTPArchive::Release::Origin=SolarOS -o APT::FTPArchive::Release::Label="SolarOS Offline" \
      -o APT::FTPArchive::Release::Suite="$CODENAME" -o APT::FTPArchive::Release::Codename="$CODENAME" \
      -o APT::FTPArchive::Release::Architectures=amd64 \
      -o APT::FTPArchive::Release::Components="main restricted universe multiverse" \
      release "dists/${CODENAME}" >"$WORK/Release"
    mv "$WORK/Release" "dists/${CODENAME}/Release"
  )
  # A one-time signing key per build: the private half is thrown away with the work folder.
  export GNUPGHOME="$WORK/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-gen-key "SolarOS Offline Repository <offline@solaros.invalid>" ed25519 sign never
  gpg --batch --quiet --yes --armor --detach-sign -o "$R/dists/${CODENAME}/Release.gpg" "$R/dists/${CODENAME}/Release"
  gpg --batch --quiet --yes --clearsign -o "$R/dists/${CODENAME}/InRelease" "$R/dists/${CODENAME}/Release"
  gpg --batch --armor --export >"$REPO_KEY"
  cp "$REPO_KEY" "$R/solardeck-offline.asc"  # next to dists/ and pool/: late-commands copy all three
  gpg --batch --export >"$R/solardeck-offline.gpg"
  gpgconf --kill all 2>/dev/null || true
  unset GNUPGHOME
  # The installed system must trust the key before its first apt call: offline, subiquity drops the mirror entries of
  # the autoinstall (and their keys) and installs the boot loader from its own file:///cdrom line. So the key goes into
  # the root file system image the installer copies to the disk.
  echo "==> Adding the repository key to ${SQUASH##*/}"
  M="$WORK/minimal"
  unsquashfs -q -n -d "$M" "$SQUASH" >/dev/null || die "cannot unpack ${SQUASH##*/}"
  install -D -m 644 "$R/solardeck-offline.gpg" "$M/etc/apt/trusted.gpg.d/solardeck-offline.gpg"
  install -D -m 644 "$R/solardeck-offline.gpg" "$M/usr/share/keyrings/solardeck-offline.gpg"
  # The image's ubuntu.sources pins Ubuntu's keyring (curtin points it at file:///cdrom): accept ours too. Its package
  # lists from Ubuntu's build would make apt reject the archive's changed Origin: drop them (apt rebuilds them).
  sed -i -E 's|^(Signed-By: /usr/share/keyrings/ubuntu-archive-keyring\.gpg)$|\1 /usr/share/keyrings/solardeck-offline.gpg|' \
    "$M/etc/apt/sources.list.d/ubuntu.sources" 2>/dev/null || true
  find "$M/var/lib/apt/lists" -maxdepth 1 -type f ! -name lock -delete 2>/dev/null || true
  COMP="$(unsquashfs -s "$SQUASH" | sed -n 's/^Compression //p')"
  mksquashfs "$M" "$SQUASH.new" -comp "${COMP:-xz}" -noappend -quiet >/dev/null || die "cannot repack ${SQUASH##*/}"
  du -sx --block-size=1 "$M" | cut -f1 >"${SQUASH%.squashfs}.size"
  mv "$SQUASH.new" "$SQUASH"
  rm -rf "$M"
  sed -i -E '\#\./casper/ubuntu-server-minimal\.(squashfs|size)$#d' "$R/md5sum.txt" 2>/dev/null || true
  echo "    repository: $(ls "$R/pool/main" | wc -l) packages, $(du -sh "$R/pool" | cut -f1) (${CODENAME}, signed)"
fi

# ---------------------------------------------------------------- autoinstall seeds
for mode in manual ${AUTO_DISK:+auto}; do
  mkdir -p "$WORK/iso/nocloud/$mode"
  inter="interactive-sections: [storage]" match=""
  [[ "$mode" == auto ]] && inter="" match="match: {path: ${AUTO_DISK}}"
  sed -e "s|@@INTERACTIVE@@|${inter}|" -e "s|@@DISK_MATCH@@|${match}|" -e "s|@@HOSTNAME@@|${HOSTNAME_}|" -e "s|@@PASSWORD_HASH@@|${HASH}|" \
    "${ROOT}/hypervisor/autoinstall/user-data.template" >"$WORK/user-data"
  if [[ -n "$NO_REPO" ]]; then
    sed -i '/@@OFFLINE_BEGIN@@/,/@@OFFLINE_END@@/d' "$WORK/user-data"
  else
    # Keep the offline blocks (minus their markers) and put the repository key into the primary mirror entry.
    awk -v keyfile="$REPO_KEY" '/@@OFFLINE_(BEGIN|END)@@/ {next}
      /@@REPO_KEY@@/ {ind = $0; sub(/@@REPO_KEY@@.*/, "", ind); while ((getline l < keyfile) > 0) print ind l; next} {print}' \
      "$WORK/user-data" >"$WORK/user-data.new"
    mv "$WORK/user-data.new" "$WORK/user-data"
  fi
  mv "$WORK/user-data" "$WORK/iso/nocloud/$mode/user-data"
  cp "${ROOT}/hypervisor/autoinstall/meta-data" "$WORK/iso/nocloud/$mode/meta-data"
  grep -qE '@@[A-Z_]+@@' "$WORK/iso/nocloud/$mode/user-data" && die "unfilled placeholder in user-data"
done

# ---------------------------------------------------------------- Embedded SolarDeck bundle (source + desktop + wheels)
mkdir -p "$WORK/src"
if git -C "$ROOT" rev-parse -q HEAD >/dev/null 2>&1; then
  echo "==> Embedding SolarDeck $(git -C "$ROOT" describe --tags --always 2>/dev/null) (committed HEAD)"
  git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK/src"
  git -C "$ROOT" rev-parse HEAD >"$WORK/src/.build-commit"
  [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || echo "    note: uncommitted changes are not included"
else
  # An installed copy without .git (ISO or deploy.sh install): embed the tree itself, minus state and build output.
  echo "==> Embedding SolarDeck from ${ROOT}"
  tar -C "$ROOT" --exclude=.git --exclude=node_modules --exclude=.venv --exclude=dist --exclude=__pycache__ \
    --exclude=hypervisor/.cache --exclude=backend/.env --exclude=backend/.ssh --exclude='backend/data/*.json' --exclude='backend/data/*.jsonl' \
    --exclude=backend/data/.vault.key --exclude=backend/data/themes --exclude='*.iso' -cf - . | tar -x -C "$WORK/src"
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
# shortcut: without Node.js 22 / pip on the build host the ISO is not fully offline; install both for release builds.
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
tar -czf "$WORK/iso/solardeck-bundle.tar.gz" -C "$WORK/src" .
echo "    bundle: $(du -h "$WORK/iso/solardeck-bundle.tar.gz" | cut -f1)$([[ -d "$WORK/src/frontend/dist" ]] && echo ", desktop prebuilt")$([[ -d "$WORK/src/wheels" ]] && echo ", $(ls "$WORK/src/wheels" | wc -l) wheels")"

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
[[ -n "${GENERATED:-}" ]] || echo "  Bootstrap console user: solardeck / ${PASSWORD} (from --password; locked after setup)"
echo "  Administrator: created in the Web UI on first visit, with the setup code shown on the server's console (tty1)."
echo "  SHA-256: $(sha256sum "$OUTPUT" | cut -d' ' -f1)"
if [[ -n "$COPY_TO" ]]; then
  cp "$OUTPUT" "${COPY_TO%/}/$(basename "$OUTPUT")"
  echo "  Copied to ${COPY_TO%/}/$(basename "$OUTPUT")"
  for t in "${ROOT}"/hypervisor/test-in-*-vm.sh; do
    [[ -f "$t" ]] && echo "  Test it in a nested VM: bash ${t} --iso ${COPY_TO%/}/$(basename "$OUTPUT")"
  done
fi
