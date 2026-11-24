/** Offline "Ask ProxmoxOS" matcher: scores plain-language questions against help content (no external service). */

const STOP = new Set(
  "a an the i im my me to of in on at for and or is are be it its how do does did can could cant with what why not want need please help this that there when where which who get got make use using from into about any some still dont doesnt wont isnt".split(
    " ",
  ),
);
// Everyday words people type → the words the help content uses.
const SYNONYMS: Record<string, string> = {
  graphics: "gpu", videocard: "gpu", nvidia: "gpu", radeon: "gpu", rtx: "gpu", card: "gpu",
  ram: "memory", ads: "adblock", advertising: "adblock", advert: "adblock", pihole: "adblock",
  remote: "vpn", outside: "vpn", away: "vpn", wireguard: "vpn",
  upgrade: "update", updates: "update", patch: "update", "401": "update",
  machine: "vm", windows: "vm", vms: "vm", virtual: "vm",
  restart: "reboot", shutdown: "power", password: "login", locked: "login",
  terminal: "shell", cli: "shell", ssh: "shell", command: "shell",
  nas: "storage", drive: "disk", drives: "disk", hdd: "disk", ssd: "disk",
  backups: "backup", restore: "backup", copy: "backup",
  bios: "bios", uefi: "bios", vtd: "iommu", "vt-d": "iommu", passthrough: "iommu",
  clock: "time", ntp: "time", date: "time", certificate: "https", ssl: "https",
};

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => SYNONYMS[t] ?? t);
}

/** Average best-field weight per query word; prefix matches (≥4 letters) count half. 0 = unrelated. */
export function score(query: string, fields: [string, number][]): number {
  const q = tokens(query);
  if (!q.length) return 0;
  const bags = fields.map(([text, w]) => [tokens(text), w] as const);
  let total = 0;
  for (const t of q) {
    let best = 0;
    for (const [words, w] of bags) {
      if (words.includes(t)) best = Math.max(best, w);
      else if (t.length >= 4 && words.some((x) => x.length >= 4 && (x.startsWith(t) || t.startsWith(x)))) best = Math.max(best, w / 2);
    }
    total += best;
  }
  return total / q.length;
}

export function rank<T>(query: string, items: T[], fields: (t: T) => [string, number][], min = 0.6, max = 6): T[] {
  return items
    .map((item) => ({ item, s: score(query, fields(item)) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.item);
}
