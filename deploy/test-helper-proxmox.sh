#!/bin/bash
# Host helper: shared commands alone and with the Proxmox VE edition file (stub zfs/pct/mount). Run: bash deploy/test-helper-proxmox.sh
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T=$(mktemp -d)
mkdir -p "$T/bin" "$T/sbin" "$T/etc"
cat >"$T/bin/zfs" <<'EOF'
#!/bin/bash
case "$*" in
  "get -H -o value type tank/media") echo filesystem ;;
  "get -H -o value mounted tank/media") echo yes ;;
  "get -H -o value mountpoint tank/media") echo /tank/media ;;
  *) echo "zfs $*" ;;
esac
EOF
cat >"$T/bin/pct" <<'EOF'
#!/bin/bash
case "$1" in
  list) printf 'VMID Status Lock Name\n100 running  solardeck\n' ;;
  config) [[ "$2" == 105 ]] && echo "tags: solardeck-app;pos-x" || echo "mp0: /other,mp=/mnt/storage/other" ;;
  *) echo "pct $*" ;;
esac
EOF
printf '#!/bin/bash\nexit 1\n' >"$T/bin/mountpoint"
printf '#!/bin/bash\necho "mount $*"\n' >"$T/bin/mount"
printf '#!/bin/bash\n:\n' >"$T/bin/setfacl"
chmod +x "$T"/bin/*
cp "$REPO/deploy/solardeck-helper.sh" "$T/sbin/solardeck-helper"
# fstab edits go to a scratch copy
sed -i.bak "s#/etc/fstab#$T/etc/fstab#g" "$T/sbin/solardeck-helper" && touch "$T/etc/fstab"
sed -i.bak "s#mkdir -p \"\$tgt\"#:#" "$T/sbin/solardeck-helper"
export PATH="$T/bin:$PATH"
fail=0
check() { if grep -q -- "$2" <<<"$3"; then echo "ok   $1"; else echo "FAIL $1: $3"; fail=1; fi; }
out=$(bash "$T/sbin/solardeck-helper" storage-map tank/media 2>&1); check "shared storage-map binds" "mapped /mnt/storage/tank/media" "$out"
out=$(bash "$T/sbin/solardeck-helper" app-provision 105 2>&1); check "shared rejects edition command" "unknown command" "$out"
out=$(bash "$T/sbin/solardeck-helper" zpool-scrub 'bad;rm' 2>&1); check "argument validation" "invalid pool name" "$out"
cp "$REPO/deploy/solardeck-helper-proxmox.sh" "$T/sbin/solardeck-helper-edition"
out=$(bash "$T/sbin/solardeck-helper" storage-map tank/media 2>&1); check "edition storage-map via pct" "mapped mp1" "$out"
out=$(echo 'echo hi' | bash "$T/sbin/solardeck-helper" app-provision 105 2>&1); check "edition command runs" "pct exec 105" "$out"
out=$(bash "$T/sbin/solardeck-helper" nope 2>&1); check "still unknown" "unknown command" "$out"
rm -rf "$T"
exit $fail
