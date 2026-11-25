#!/usr/bin/env bash
# Build the source tree of one edition from the shared repository.
#   deploy/make-edition-tree.sh <edition> <source dir> <output dir>
# For every OTHER edition E listed as deploy/editions/E.paths it removes the paths in that file and every path whose
# name contains E, lays deploy/editions/<edition>/ over the result (edition-specific README, license, examples), drops
# the build metadata and fails when a word from deploy/editions/E.words is still present anywhere in the output.
# Used by hypervisor/build-iso.sh (ISO bundle) and the release workflow (the edition's update branch).
set -Eeuo pipefail

EDITION="${1:?edition}"; SRC="$(cd "${2:?source dir}" && pwd)"; OUT="${3:?output dir}"
[[ "$EDITION" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "make-edition-tree: invalid edition ${EDITION}" >&2; exit 2; }
META="${SRC}/deploy/editions"
[[ -d "$META" ]] || { echo "make-edition-tree: ${META} not found" >&2; exit 2; }

rm -rf "$OUT" && mkdir -p "$OUT"
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # A checkout: only files under version control, so stray local files (build output, notes) never ship.
  git -C "$SRC" ls-files -z | tar -C "$SRC" --null -T - -cf - | tar -x -C "$OUT"
else
tar -C "$SRC" --exclude=.git --exclude=node_modules --exclude=.venv --exclude=__pycache__ --exclude=hypervisor/.cache \
  --exclude=backend/.env --exclude=backend/.ssh --exclude='*.iso' --exclude=frontend/dist --exclude='*.tsbuildinfo' -cf - . | tar -x -C "$OUT"
fi

others=()
for list in "$META"/*.paths; do
  [[ -e "$list" ]] || continue
  other="$(basename "$list" .paths)"
  [[ "$other" == "$EDITION" ]] && continue
  others+=("$other")
  while IFS= read -r path; do
    [[ -z "$path" || "$path" == \#* ]] && continue
    [[ "$path" != /* && "$path" != *..* ]] || { echo "make-edition-tree: unsafe path ${path}" >&2; exit 2; }
    rm -rf "${OUT:?}/${path}"
  done <"$list"
  # Deepest first, so a removed directory does not hide paths below it.
  find "$OUT" -depth -iname "*${other}*" -exec rm -rf {} +
  # The TypeScript path list names every edition folder; keep the ones that still exist.
  [[ -f "$OUT/frontend/tsconfig.json" ]] && sed -i.bak -E "s#\"\./src/editions/${other}/edition\", ?##" "$OUT/frontend/tsconfig.json" && rm -f "$OUT/frontend/tsconfig.json.bak"
done
[[ -d "${META}/${EDITION}" ]] && cp -a "${META}/${EDITION}/." "$OUT/"
rm -rf "${OUT:?}/deploy/editions" "${OUT:?}/.github" "${OUT:?}/deploy/make-edition-tree.sh"

bad=0
for other in "${others[@]}"; do
  words="${META}/${other}.words"
  [[ -f "$words" ]] || continue
  if hits="$(grep -rIilE -f <(grep -vE '^(#|$)' "$words") "$OUT")"; then
    echo "make-edition-tree: ${EDITION} tree still mentions the ${other} edition in:" >&2
    echo "$hits" | sed "s#^${OUT}/#  #" >&2
    bad=1
  fi
done
exit "$bad"
