/** One-time copy of pre-rename localStorage keys. Imported first in main.tsx so it runs before the stores hydrate. */
export const RENAMED: Record<string, string> = {
  "proxmoxos-prefs": "solardeck-prefs",
  "proxmoxos-dock": "solardeck-dock",
  "proxmoxos-layout": "solardeck-layout",
  "proxmoxos-wizard": "solardeck-wizard",
  "proxmoxos.seenAlerts": "solardeck.seenAlerts",
};

export function migrateStorage(store: Storage) {
  for (const [from, to] of Object.entries(RENAMED)) {
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
