#!/usr/bin/env bash
# Append keys from an example .env that are missing in the live one. Existing values are never changed.
#   merge-env.sh <live .env> <example .env>
set -euo pipefail
LIVE="${1:?live env}"; EXAMPLE="${2:?example env}"
[[ -f "$EXAMPLE" ]] || exit 0
touch "$LIVE"
# Renamed keys (env-renames next to the example: "OLD NEW" per line) keep their value under the new name.
RENAMES="$(dirname "$EXAMPLE")/env-renames"
if [[ -f "$RENAMES" ]]; then
  while read -r old new; do
    [[ "$old" =~ ^[A-Z][A-Z0-9_]*$ && "$new" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    if grep -q "^${old}=" "$LIVE" && ! grep -q "^${new}=" "$LIVE"; then
      sed -i.bak "s/^${old}=/${new}=/" "$LIVE" && rm -f "$LIVE.bak"
      echo "    renamed ${old} to ${new} in $(basename "$LIVE")"
    fi
  done <"$RENAMES"
fi
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
  key="${BASH_REMATCH[1]}"
  grep -q "^${key}=" "$LIVE" && continue
  [[ -z "$(tail -c1 "$LIVE")" ]] || echo >>"$LIVE"
  echo "$line" >>"$LIVE"
  echo "    added ${key} to $(basename "$LIVE")"
done <"$EXAMPLE"
# Edition defaults (env-defaults-<driver> next to the example), e.g. the Proxmox VE edition's SYSTEM_PREFIX.
DRIVER="$(sed -n 's/^HYPERVISOR_DRIVER=//p' "$LIVE" | tail -n1 | tr -d "'\"")"
EDITION="$(dirname "$EXAMPLE")/env-defaults-${DRIVER:-proxmox}"
if [[ -f "$EDITION" && "$EDITION" != "$EXAMPLE" ]]; then
  bash "$0" "$LIVE" "$EDITION"
fi
