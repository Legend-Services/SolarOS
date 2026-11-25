import { edition } from "@edition";

/** One-time copy of pre-rename localStorage keys (per edition). Imported first in main.tsx so it runs before the stores hydrate. */
export function migrateStorage(store: Storage) {
  for (const [from, to] of Object.entries(edition.legacyStorageKeys)) {
    const v = store.getItem(from);
    if (v === null) continue;
    if (store.getItem(to) === null) store.setItem(to, v);
    store.removeItem(from);
  }
}

try {
  migrateStorage(localStorage);
} catch {
  // Storage blocked (private mode or sandboxed preview): nothing to migrate.
}
