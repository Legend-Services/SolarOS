import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useTelemetry, useThermals } from "../lib/stores";
import { LEVEL_BAR, LEVEL_TEXT, SENSOR_KINDS, cpuProfile, recommendedLimits, tempLevel, type Limit, type Limits, type SensorKind } from "../lib/thermals";

export const SMOOTH = { min: 2, max: 60, default: 10 }; // seconds
export const TEMP_RANGE = { min: 30, max: 115 };

export interface ThermalPrefs {
  /** Averaging window for temperatures, seconds. */
  smoothSec: number;
  /** User limits per sensor; absent = the recommended limit (CPU: from the detected CPU type). */
  overrides: Partial<Record<SensorKind, Limit>>;
}

interface ThermalState extends ThermalPrefs {
  setSmooth: (s: number) => void;
  setLimit: (kind: SensorKind, l: Limit) => void;
  reset: (kind?: SensorKind) => void;
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);

/** Validate saved prefs (browser or server JSON): unknown kinds dropped, values clamped, orange always below red. */
export function sanitizeThermal(v: unknown): ThermalPrefs {
  const x = (v ?? {}) as Partial<ThermalPrefs>;
  const overrides: ThermalPrefs["overrides"] = {};
  for (const k of SENSOR_KINDS) {
    const o = x.overrides?.[k];
    if (!o) continue;
    const hot = clamp(o.hot, TEMP_RANGE.min + 1, TEMP_RANGE.max, NaN);
    const warn = clamp(o.warn, TEMP_RANGE.min, TEMP_RANGE.max - 1, NaN);
    if (Number.isFinite(hot) && Number.isFinite(warn)) overrides[k] = { warn: Math.min(warn, hot - 1), hot };
  }
  return { smoothSec: clamp(x.smoothSec, SMOOTH.min, SMOOTH.max, SMOOTH.default), overrides };
}

export const useThermalPrefs = create<ThermalState>()(
  persist(
    (set) => ({
      smoothSec: SMOOTH.default,
      overrides: {},
      setSmooth: (s) => set({ smoothSec: clamp(s, SMOOTH.min, SMOOTH.max, SMOOTH.default) }),
      setLimit: (kind, l) => set((st) => ({ overrides: { ...st.overrides, [kind]: { warn: Math.min(l.warn, l.hot - 1), hot: Math.max(l.hot, l.warn + 1) } } })),
      reset: (kind) => set((st) => ({ overrides: kind ? Object.fromEntries(Object.entries(st.overrides).filter(([k]) => k !== kind)) : {} })),
    }),
    {
      name: "solardeck-thermal",
      partialize: ({ smoothSec, overrides }) => ({ smoothSec, overrides }),
      merge: (saved, cur) => ({ ...cur, ...sanitizeThermal(saved) }),
    },
  ),
);

// The live stream averages over the user's window; keep it in step with the setting.
useThermals.getState().setWindow(useThermalPrefs.getState().smoothSec * 1000);
useThermalPrefs.subscribe((st, prev) => st.smoothSec !== prev.smoothSec && useThermals.getState().setWindow(st.smoothSec * 1000));

/** The host CPU model (for the profile), from the always-running overview poll. */
export const useCpuModel = () => useTelemetry((s) => s.overview?.cpuinfo.model ?? null);

/** Effective limits: recommended for this CPU, with the user's overrides on top. */
export function useLimits(): Limits {
  const model = useCpuModel();
  const overrides = useThermalPrefs((s) => s.overrides);
  return { ...recommendedLimits(model), ...overrides };
}

/** Colour helpers for temperatures: `text(c, kind)` for numbers, `bar(c, kind)` for bars. */
export function useTempColor() {
  const limits = useLimits();
  return {
    text: (c: number | null | undefined, kind: SensorKind) => LEVEL_TEXT[tempLevel(c, limits[kind])],
    bar: (c: number | null | undefined, kind: SensorKind) => LEVEL_BAR[tempLevel(c, limits[kind])],
  };
}

export { cpuProfile };
