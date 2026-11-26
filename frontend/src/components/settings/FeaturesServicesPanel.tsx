import { useState } from "react";
import { Search, Sparkles, Wand2 } from "lucide-react";
import { useTranslation, type TKey } from "../../i18n";
import { useFeatures } from "../../store/featureStore";
import { useOnboarding } from "../../store/onboardingStore";
import { FEATURES, FEATURE_DOMAINS, FEATURE_KEYS, PRESETS, isFeature, on, only, parentOf, type FeatureKey, type PresetId } from "../../data/features";
import { GlassBadge, GlassButton, GlassInput, GlassSwitch, Notice } from "../ui/GlassKit";

/** Settings › Features & Services: show or hide every optional feature, with presets and the Setup Wizard. */
export default function FeaturesServicesPanel() {
  const { t } = useTranslation();
  const { enabled, save } = useFeatures();
  const openWizard = useOnboarding((s) => s.openWizard);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ error?: string; notice?: string }>({});
  const active = FEATURE_KEYS.filter((k) => on(enabled, k)).length;

  const apply = async (changes: Partial<Record<FeatureKey, boolean>>) => {
    setBusy(true);
    setMsg({});
    try {
      const warnings = await save(changes);
      setMsg(warnings.length ? { error: t("feat.warn", { list: warnings.join("; ") }) } : {});
    } catch (e) {
      setMsg({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const match = (k: FeatureKey) => !needle || `${t(`feat.${k}`)} ${t(`featDesc.${k}`)} ${k}`.toLowerCase().includes(needle);

  return (
    <div className="space-y-4 pb-10">
      <section className="glass-soft rounded-2xl p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              {t("set.mod.features-services")} <GlassBadge tone="info">{t("feat.count", { n: active, total: FEATURE_KEYS.length })}</GlassBadge>
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-slate-400">{t("feat.intro")}</p>
          </div>
          <GlassButton data-anchor="feat-wizard" variant="primary" onClick={openWizard}>
            <Wand2 size={13} /> {t("feat.rerun")}
          </GlassButton>
        </div>
        <div data-anchor="feat-presets" className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t("feat.presets")}</span>
          {(Object.keys(PRESETS) as PresetId[]).map((p) => (
            <GlassButton key={p} size="xs" disabled={busy} onClick={() => apply(only(PRESETS[p]))} title={t(`feat.presetDesc.${p}`)}>
              <Sparkles size={11} /> {t(`feat.preset.${p}`)}
            </GlassButton>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-slate-500">{t("feat.core")}</p>
        <div className="relative mt-3">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <GlassInput className="w-full pl-8" placeholder={t("feat.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("feat.search")} />
        </div>
        <Notice {...msg} />
      </section>

      {FEATURE_DOMAINS.map((d) => {
        const keys = FEATURE_KEYS.filter((k) => FEATURES[k].domain === d && match(k));
        if (!keys.length) return null;
        return (
          <section key={d} className="glass-soft rounded-2xl p-3">
            <h4 className="px-1 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t(`feat.domain.${d}`)}</h4>
            <div className="grid grid-cols-1 items-stretch gap-3.5 xl:grid-cols-2">
              {keys.map((k) => {
                const parent = parentOf(k);
                const Icon = FEATURES[k].icon;
                const blocked = isFeature(parent) && !on(enabled, parent);
                // Sub-features keep the grid tracks; the parent (a feature or a heading like WireGuard VPN) is a pill.
                const parentLabel = parent && t((isFeature(parent) ? `feat.${parent}` : `feat.group.${parent}`) as TKey);
                return (
                  <div key={k} className="contents">
                    <div className="flex h-full min-h-[88px] items-center justify-between gap-4 rounded-2xl border border-white/5 bg-white/[0.03] p-4">
                      <div className="flex min-w-0 flex-1 items-center gap-3.5">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400/30 to-violet-500/30 text-cyan-100">
                          <Icon size={17} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <p className="min-w-0 truncate text-sm leading-snug font-medium text-slate-100">{t(`feat.${k}`)}</p>
                            {parentLabel && <span className="shrink-0 rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium text-cyan-200/90">{parentLabel}</span>}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-400">{t(`featDesc.${k}`)}</p>
                          {blocked && <p className="mt-0.5 text-[10px] text-amber-300/80">{t("feat.needsParent", { parent: t(`feat.${parent}`) })}</p>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center">
                        <GlassSwitch checked={enabled[k] !== false} disabled={busy} onChange={(v) => apply({ [k]: v })} ariaLabel={t(`feat.${k}`)} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
