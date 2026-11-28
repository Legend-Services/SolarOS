/**
 * Live thermals: types of GET /api/hardware/thermals, time-window averaging, and the temperature colour limits
 * (per CPU type, plus GPU, drives and memory). Dependency-free so scripts/check-thermals.mjs can test it directly.
 */

export interface LiveThermals {
  cpu: {
    package_temp_c: number | null;
    cores: { core_id: number; temp_c: number | null; freq_mhz: number | null; load_pct: number | null }[];
    avg_freq_mhz: number | null;
    min_freq_mhz: number | null;
    max_freq_mhz: number | null;
  };
  gpus: { slot: string; name: string; temp_c: number | null; hotspot_temp_c: number | null; fan_rpm_or_pct: number | null; fan_unit: "%" | "rpm"; power_w: number | null; vram_used_mb: number | null; vram_total_mb: number | null; utilization_pct: number | null }[];
  drives: { device: string; model: string | null; temp_c: number | null; wear_pct: number | null }[];
  /** DIMM sensors (jc42 / spd5118) when the board has them. */
  memory: { label: string; temp_c: number }[];
  chassis_fans: { label: string; rpm: number }[];
  timestamp: number;
}

export interface Sample {
  at: number; // ms
  d: LiveThermals;
}

/* ---------------- Averaging ---------------- */

const mean = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

/**
 * The newest sample with every temperature replaced by its average over the last `windowMs`
 * (clocks, loads, power and fans stay current). A short spike moves the average a little; only a sustained rise
 * moves it far enough to change colour.
 */
export function smooth(samples: Sample[], windowMs: number): LiveThermals | null {
  const last = samples.at(-1);
  if (!last) return null;
  const win = samples.filter((s) => s.at >= last.at - windowMs).map((s) => s.d);
  const pick = <T, K>(list: (d: LiveThermals) => T[], key: (x: T) => K, want: K, val: (x: T) => number | null) =>
    mean(win.map((d) => list(d).find((x) => key(x) === want)).map((x) => (x ? val(x) : null)));
  const d = last.d;
  return {
    ...d,
    cpu: {
      ...d.cpu,
      package_temp_c: mean(win.map((x) => x.cpu.package_temp_c)),
      cores: d.cpu.cores.map((c) => ({ ...c, temp_c: c.temp_c == null ? null : pick((x) => x.cpu.cores, (x) => x.core_id, c.core_id, (x) => x.temp_c) })),
    },
    gpus: d.gpus.map((g) => ({
      ...g,
      temp_c: g.temp_c == null ? null : pick((x) => x.gpus, (x) => x.slot, g.slot, (x) => x.temp_c),
      hotspot_temp_c: g.hotspot_temp_c == null ? null : pick((x) => x.gpus, (x) => x.slot, g.slot, (x) => x.hotspot_temp_c),
    })),
    drives: d.drives.map((r) => ({ ...r, temp_c: r.temp_c == null ? null : pick((x) => x.drives, (x) => x.device, r.device, (x) => x.temp_c) })),
    memory: (d.memory ?? []).map((m) => ({ ...m, temp_c: pick((x) => x.memory ?? [], (x) => x.label, m.label, (x) => x.temp_c) ?? m.temp_c })),
  };
}

/* ---------------- Colour limits ---------------- */

export type SensorKind = "cpu" | "gpu" | "hotspot" | "ssd" | "hdd" | "ram";
export const SENSOR_KINDS: SensorKind[] = ["cpu", "gpu", "hotspot", "ssd", "hdd", "ram"];
export interface Limit {
  warn: number; // orange from
  hot: number; // red from
}
export type Limits = Record<SensorKind, Limit>;

export interface CpuProfile {
  id: string;
  label: string;
  match: RegExp;
  /** Maximum junction / load temperature the vendor specifies, °C. */
  max: number;
  warn: number;
  hot: number;
  source: string;
}

/**
 * Recommended CPU limits. Red sits at (or just under) the vendor's maximum: there the CPU throttles to protect itself.
 * Orange marks the last ~10-15 °C before that. First match wins, so specific families come before general ones.
 */
export const CPU_PROFILES: CpuProfile[] = [
  { id: "intel-arrow", label: "Intel Core Ultra 200S / 200HX", match: /Core\(?T?M?\)? Ultra [579] 2\d\d/i, max: 105, warn: 90, hot: 100, source: "Reported 105 °C TjMax (Arrow Lake)" },
  { id: "intel-k", label: "Intel Core 13th/14th gen K / KF / KS (desktop)", match: /i[3579]-1[34]\d{3}K/i, max: 100, warn: 88, hot: 97, source: "Intel ARK: 14900K TjMax 100 °C" },
  { id: "intel-hx", label: "Intel Core 13th/14th gen HX (laptop)", match: /i[3579]-1[34]\d{3}HX/i, max: 100, warn: 88, hot: 97, source: "Intel: TjMax 100 °C" },
  { id: "intel-core", label: "Intel Core 12th-14th gen (other)", match: /i[3579]-1[234]\d{3}/i, max: 100, warn: 85, hot: 95, source: "Intel: TjMax 100 °C" },
  { id: "intel-n", label: "Intel N-series / Atom / Celeron / Pentium", match: /\bN\d{2,3}\b|Atom|Celeron|Pentium/i, max: 105, warn: 85, hot: 100, source: "Intel: TjMax 100-110 °C per product" },
  { id: "intel-xeon", label: "Intel Xeon", match: /Xeon/i, max: 90, warn: 75, hot: 88, source: "Varies per SKU (often specified as case temperature)" },
  { id: "intel-older", label: "Intel Core (older generations)", match: /Intel.*Core/i, max: 100, warn: 80, hot: 95, source: "Intel: TjMax usually 100 °C" },
  { id: "amd-x3d", label: "AMD Ryzen 7000 / 9000 X3D", match: /Ryzen [3579] [79]\d{2}0X3D/i, max: 89, warn: 78, hot: 87, source: "AMD: 7000X3D TjMax 89 °C" },
  { id: "amd-zen4-5", label: "AMD Ryzen 7000 / 9000 (desktop)", match: /Ryzen [3579] [79]\d{3}(?![UH])/i, max: 95, warn: 85, hot: 95, source: "AMD: 95 °C is the normal load limit" },
  { id: "amd-mobile", label: "AMD Ryzen (laptop U / H / HS / HX)", match: /Ryzen.*\d{4}(U|H|HS|HX)\b/i, max: 95, warn: 85, hot: 95, source: "AMD mobile: 95-100 °C" },
  { id: "amd-zen3", label: "AMD Ryzen 5000 (desktop)", match: /Ryzen [3579] 5\d{3}/i, max: 90, warn: 80, hot: 90, source: "AMD: 90 °C typical at full load" },
  { id: "amd-server", label: "AMD EPYC / Threadripper", match: /EPYC|Threadripper/i, max: 95, warn: 80, hot: 92, source: "AMD: 95 °C class" },
  { id: "amd-older", label: "AMD Ryzen (older)", match: /Ryzen/i, max: 95, warn: 80, hot: 92, source: "AMD: 85-95 °C class" },
];
export const GENERIC_CPU: CpuProfile = { id: "generic", label: "Other / unknown CPU", match: /$^/, max: 95, warn: 80, hot: 90, source: "Conservative default" };

export const cpuProfile = (model: string | null | undefined): CpuProfile => CPU_PROFILES.find((p) => model && p.match.test(model)) ?? GENERIC_CPU;

/** Recommended limits for the other sensors (vendor throttle points, with orange well before them). */
export const OTHER_LIMITS: Record<Exclude<SensorKind, "cpu">, Limit & { max: number; source: string }> = {
  gpu: { warn: 80, hot: 88, max: 93, source: "NVIDIA: boost drops above ~83 °C, max 90-95 °C" },
  hotspot: { warn: 95, hot: 105, max: 110, source: "AMD: junction up to 110 °C is within spec" },
  ssd: { warn: 60, hot: 70, max: 70, source: "NVMe drives throttle around 70 °C" },
  hdd: { warn: 45, hot: 55, max: 55, source: "Most hard disks are rated 5-55 °C; failure rate doubles at a sustained 55 °C" },
  ram: { warn: 70, hot: 85, max: 85, source: "DDR5 SPD hub: refresh doubles / throttling from ~85 °C" },
};

export const recommendedLimits = (model: string | null | undefined): Limits => {
  const p = cpuProfile(model);
  return { cpu: { warn: p.warn, hot: p.hot }, ...Object.fromEntries(Object.entries(OTHER_LIMITS).map(([k, v]) => [k, { warn: v.warn, hot: v.hot }])) } as Limits;
};

export type Level = "ok" | "warn" | "hot" | "none";
export const tempLevel = (c: number | null | undefined, l: Limit): Level => (c == null ? "none" : c >= l.hot ? "hot" : c >= l.warn ? "warn" : "ok");
export const LEVEL_TEXT: Record<Level, string> = { none: "text-slate-400", ok: "text-emerald-400", warn: "text-amber-400", hot: "text-rose-400" };
export const LEVEL_BAR: Record<Level, string> = { none: "bg-slate-500", ok: "bg-emerald-400", warn: "bg-amber-400", hot: "bg-rose-400" };

/** Drive kind from its device path / reported type (NVMe and SATA SSDs share the SSD limits). */
export const driveKind = (device: string, type?: string | null): SensorKind => (/nvme/.test(device) || /ssd|nvme/i.test(type ?? "") ? "ssd" : type ? (/hdd/i.test(type) ? "hdd" : "ssd") : "hdd");
