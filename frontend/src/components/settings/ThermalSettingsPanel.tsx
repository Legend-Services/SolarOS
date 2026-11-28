import { RotateCcw, Thermometer, Timer } from "lucide-react";
import { openLink } from "../../lib/stores";
import { CPU_PROFILES, GENERIC_CPU, OTHER_LIMITS, SENSOR_KINDS, cpuProfile, recommendedLimits, type SensorKind } from "../../lib/thermals";
import { SMOOTH, TEMP_RANGE, useCpuModel, useLimits, useThermalPrefs } from "../../store/thermalStore";
import { useTranslation, type TKey } from "../../i18n";
import { GlassBadge, GlassButton, GlassSlider } from "../ui/GlassKit";

const KIND_KEY: Record<SensorKind, TKey> = { cpu: "th.kind.cpu", gpu: "th.kind.gpu", hotspot: "th.kind.hotspot", ssd: "th.kind.ssd", hdd: "th.kind.hdd", ram: "th.kind.ram" };
const COMPACT_KINDS: SensorKind[] = ["cpu", "gpu", "ssd", "hdd"];

/** Colour band preview: green below orange, orange below red, red above. */
function Bands({ warn, hot }: { warn: number; hot: number }) {
  const pct = (v: number) => `${((v - TEMP_RANGE.min) / (TEMP_RANGE.max - TEMP_RANGE.min)) * 100}%`;
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full" aria-hidden>
      <div className="absolute inset-y-0 left-0 bg-emerald-400/70" style={{ width: pct(warn) }} />
      <div className="absolute inset-y-0 bg-amber-400/80" style={{ left: pct(warn), width: `calc(${pct(hot)} - ${pct(warn)})` }} />
      <div className="absolute inset-y-0 right-0 bg-rose-400/80" style={{ left: pct(hot) }} />
    </div>
  );
}

function LimitRow({ kind }: { kind: SensorKind }) {
  const { t } = useTranslation();
  const limits = useLimits();
  const custom = useThermalPrefs((s) => !!s.overrides[kind]);
  const setLimit = useThermalPrefs((s) => s.setLimit);
  const reset = useThermalPrefs((s) => s.reset);
  const l = limits[kind];
  return (
    <div className="space-y-2 rounded-xl p-3" style={{ background: "var(--sd-surface-card)", border: "1px solid var(--sd-border-hairline)" }}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium" style={{ color: "var(--sd-text-primary)" }}>{t(KIND_KEY[kind])}</span>
        {custom ? <GlassBadge tone="info">{t("th.custom")}</GlassBadge> : <GlassBadge>{t("th.recommended")}</GlassBadge>}
        {custom && (
          <button onClick={() => reset(kind)} className="ml-auto flex items-center gap-1 text-[11px] hover:underline" style={{ color: "var(--sd-text-secondary)" }}>
            <RotateCcw size={11} /> {t("th.resetOne")}
          </button>
        )}
      </div>
      <Bands warn={l.warn} hot={l.hot} />
      <div className="grid gap-3 sm:grid-cols-2">
        <GlassSlider label={t("th.warn")} value={l.warn} min={TEMP_RANGE.min} max={TEMP_RANGE.max - 1} unit=" °C" onChange={(warn) => setLimit(kind, { warn, hot: Math.max(l.hot, warn + 1) })} />
        <GlassSlider label={t("th.hot")} value={l.hot} min={TEMP_RANGE.min + 1} max={TEMP_RANGE.max} unit=" °C" onChange={(hot) => setLimit(kind, { warn: Math.min(l.warn, hot - 1), hot })} />
      </div>
    </div>
  );
}

/**
 * Averaging window and orange/red limits per sensor. Full version (Settings › Resource & Thermal Monitor › Thermal Sensors)
 * adds the detected CPU profile and the table of recommended limits; the compact version sits in the widget's gear panel.
 */
export default function ThermalSettingsPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const model = useCpuModel();
  const profile = cpuProfile(model);
  const smoothSec = useThermalPrefs((s) => s.smoothSec);
  const setSmooth = useThermalPrefs((s) => s.setSmooth);
  const anyCustom = useThermalPrefs((s) => Object.keys(s.overrides).length > 0);
  const reset = useThermalPrefs((s) => s.reset);
  const rec = recommendedLimits(model);

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <section className={compact ? "space-y-1.5" : "glass-soft space-y-2 rounded-2xl p-4"}>
        {!compact && (
          <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--sd-text-primary)" }}>
            <Timer size={15} /> {t("th.smoothTitle")}
          </h3>
        )}
        <GlassSlider label={t("th.smooth")} value={smoothSec} min={SMOOTH.min} max={SMOOTH.max} unit=" s" onChange={setSmooth} />
        <p className="text-[11px] leading-snug" style={{ color: "var(--sd-text-muted)" }}>{t("th.smoothHint")}</p>
      </section>

      <section className={compact ? "space-y-2" : "glass-soft space-y-3 rounded-2xl p-4"}>
        <div className="flex flex-wrap items-center gap-2">
          {!compact && (
            <h3 className="flex flex-1 items-center gap-2 text-sm font-semibold" style={{ color: "var(--sd-text-primary)" }}>
              <Thermometer size={15} /> {t("th.limitsTitle")}
            </h3>
          )}
          {anyCustom && (
            <GlassButton size="xs" variant="ghost" onClick={() => reset()}>
              <RotateCcw size={12} /> {t("th.resetAll")}
            </GlassButton>
          )}
        </div>
        <p className="text-[11px] leading-snug" style={{ color: "var(--sd-text-secondary)" }}>
          {t("th.detected", { model: model ?? "—", profile: profile.label })}
        </p>
        <div className={compact ? "space-y-2" : "grid gap-3 xl:grid-cols-2"}>
          {(compact ? COMPACT_KINDS : SENSOR_KINDS).map((k) => (
            <LimitRow key={k} kind={k} />
          ))}
        </div>
        {compact && (
          <button onClick={() => openLink("settings", { module: "resource-monitor", tab: "sensors" })} className="text-[11px] hover:underline" style={{ color: "var(--sd-text-secondary)" }}>
            {t("th.more")} →
          </button>
        )}
      </section>

      {!compact && (
        <section className="glass-soft space-y-2 rounded-2xl p-4">
          <h3 className="text-sm font-semibold" style={{ color: "var(--sd-text-primary)" }}>{t("th.tableTitle")}</h3>
          <p className="text-[11px] leading-snug" style={{ color: "var(--sd-text-muted)" }}>{t("th.tableHint")}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead style={{ color: "var(--sd-text-muted)" }}>
                <tr>
                  {(["th.col.type", "th.col.max", "th.col.warn", "th.col.hot", "th.col.source"] as TKey[]).map((h) => (
                    <th key={h} className="py-1.5 pr-3 font-medium">{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...CPU_PROFILES, GENERIC_CPU].map((p) => (
                  <tr key={p.id} className="border-t" style={{ borderColor: "var(--sd-border-hairline)", color: "var(--sd-text-secondary)" }}>
                    <td className="py-1.5 pr-3" style={p.id === profile.id ? { color: "var(--sd-text-primary)", fontWeight: 600 } : undefined}>
                      {p.label} {p.id === profile.id && <GlassBadge tone="success">{t("th.thisCpu")}</GlassBadge>}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{p.max} °C</td>
                    <td className="py-1.5 pr-3 tabular-nums text-amber-400">{p.warn} °C</td>
                    <td className="py-1.5 pr-3 tabular-nums text-rose-400">{p.hot} °C</td>
                    <td className="py-1.5 pr-3">{p.source}</td>
                  </tr>
                ))}
                {(Object.keys(OTHER_LIMITS) as (keyof typeof OTHER_LIMITS)[]).map((k) => (
                  <tr key={k} className="border-t" style={{ borderColor: "var(--sd-border-hairline)", color: "var(--sd-text-secondary)" }}>
                    <td className="py-1.5 pr-3">{t(KIND_KEY[k])}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{OTHER_LIMITS[k].max} °C</td>
                    <td className="py-1.5 pr-3 tabular-nums text-amber-400">{rec[k].warn} °C</td>
                    <td className="py-1.5 pr-3 tabular-nums text-rose-400">{rec[k].hot} °C</td>
                    <td className="py-1.5 pr-3">{OTHER_LIMITS[k].source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
