#!/usr/bin/env bash
# Append keys from an example .env that are missing in the live one. Existing values are never changed.
#   merge-env.sh <live .env> <example .env>
set -euo pipefail
LIVE="${1:?live env}"; EXAMPLE="${2:?example env}"
[[ -f "$EXAMPLE" ]] || exit 0
touch "$LIVE"
# A .env from before HYPERVISOR_DRIVER existed: that edition's legacy defaults (env-defaults-legacy) first.
LEGACY="$(dirname "$EXAMPLE")/env-defaults-legacy"
if [[ -f "$LEGACY" && "$EXAMPLE" != "$LEGACY" ]] && ! grep -q "^HYPERVISOR_DRIVER=" "$LIVE"; then bash "$0" "$LIVE" "$LEGACY"; fi
# Renamed keys (env-renames next to the example: "OLD NEW" per line): the value is copied to the new name and the old
# line stays, so rolling back to a release that reads the old name keeps working.
RENAMES="$(dirname "$EXAMPLE")/env-renames"
if [[ -f "$RENAMES" ]]; then
  while read -r old new; do
    [[ "$old" =~ ^[A-Z][A-Z0-9_]*$ && "$new" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    if grep -q "^${old}=" "$LIVE" && ! grep -q "^${new}=" "$LIVE"; then
      [[ -z "$(tail -c1 "$LIVE")" ]] || echo >>"$LIVE"
      grep "^${old}=" "$LIVE" | tail -n1 | sed "s/^${old}=/${new}=/" >>"$LIVE"
      echo "    copied ${old} to ${new} in $(basename "$LIVE")"
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
# Edition defaults (env-defaults-<driver> next to the example), e.g. an edition's SYSTEM_PREFIX.
DRIVER="$(sed -n 's/^HYPERVISOR_DRIVER=//p' "$LIVE" | tail -n1 | tr -d "'\"")"
EDITION="$(dirname "$EXAMPLE")/env-defaults-${DRIVER}"
if [[ -n "$DRIVER" && -f "$EDITION" && "$EDITION" != "$EXAMPLE" ]]; then
  bash "$0" "$LIVE" "$EDITION"
fi
