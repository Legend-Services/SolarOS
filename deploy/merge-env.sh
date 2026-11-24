#!/usr/bin/env bash
# Append keys from an example .env that are missing in the live one. Existing values are never changed.
#   merge-env.sh <live .env> <example .env>
set -euo pipefail
LIVE="${1:?live env}"; EXAMPLE="${2:?example env}"
[[ -f "$EXAMPLE" ]] || exit 0
touch "$LIVE"
while IFS= read -r line; do
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]] || continue
  key="${BASH_REMATCH[1]}"
  grep -q "^${key}=" "$LIVE" && continue
  [[ -z "$(tail -c1 "$LIVE")" ]] || echo >>"$LIVE"
  echo "$line" >>"$LIVE"
  echo "    added ${key} to $(basename "$LIVE")"
done <"$EXAMPLE"
