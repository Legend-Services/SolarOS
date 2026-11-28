export function bytes(n: number, digits = 1): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

export function uptime(s: number): string {
  if (!s) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// 55 °C matches the backend's disk temperature alert threshold.
export const healthColor = (h?: string) =>
  !h ? "text-slate-400" : /ONLINE|PASSED|OK/i.test(h) ? "text-emerald-400" : /DEGRADED|UNKNOWN/i.test(h) ? "text-amber-400" : "text-rose-400";

export async function copyText(text: string) {
  // navigator.clipboard only exists in secure contexts; the UI is usually plain http on the LAN.
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** Accent color for blueprint SVG strokes/icons: as-is on the dark canvas, darkened (--bp-ink) on the light one. */
export const ink = (color: string) => `color-mix(in oklab, ${color}, black var(--bp-ink))`;
