import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Rocket, SlidersHorizontal, X } from "lucide-react";
import { api } from "../../lib/api";
import { useIntent } from "../../lib/stores";
import { useTranslation } from "../../i18n";
import type { CatalogApp } from "../../lib/types";
import { useProduct } from "../../store/capabilitiesStore";
import { useFeatures } from "../../store/featureStore";
import { useOnboarding } from "../../store/onboardingStore";
import { FEATURES, FEATURE_DOMAINS, FEATURE_KEYS, ROLES, WIZARD_APPS, only, roleApps, roleFeatures, type FeatureKey, type RoleId } from "../../data/features";
import { GlassButton, GlassCheckbox, Notice } from "../ui/GlassKit";
import { OperationProgressCard, useJobProgress } from "../ui/OperationProgressCard";

/* ---------------- Glowing schematic wireframes (one per role) ---------------- */

const W: Record<RoleId, ReactNode> = {
  storage: (
    <>
      <rect x="14" y="10" width="40" height="60" rx="3" />
      {[18, 30, 42, 54].map((y) => <g key={y}><rect x="19" y={y} width="30" height="8" rx="1.5" /><circle cx="44" cy={y + 4} r="1.2" className="fill-current" /></g>)}
      <path d="M58 40h14" strokeDasharray="3 3" />
      <rect x="74" y="22" width="34" height="24" rx="2" />
      <path d="M87 29l8 5-8 5z" />
      <path d="M84 52h16M91 46v6" />
    </>
  ),
  virtualization: (
    <>
      <rect x="10" y="56" width="100" height="14" rx="3" />
      <path d="M20 63h20M90 63h8" />
      {[14, 47, 80].map((x) => <g key={x}><rect x={x} y="14" width="26" height="30" rx="2" /><path d={`M${x + 4} 22h18M${x + 4} 28h12M${x + 13} 44v12`} /></g>)}
    </>
  ),
  multiseat: (
    <>
      <rect x="44" y="40" width="32" height="32" rx="2" />
      <path d="M50 48h20M50 54h20M50 60h12" />
      {[8, 84].map((x) => <g key={x}><rect x={x} y="8" width="28" height="20" rx="2" /><path d={`M${x + 14} 28v6M${x + 8} 34h12`} /></g>)}
      <path d="M22 34l22 14M98 34L76 48" strokeDasharray="3 3" />
      <rect x="10" y="50" width="20" height="10" rx="2" />
      <rect x="90" y="50" width="20" height="10" rx="2" />
      <path d="M30 55h14M90 55H76" />
    </>
  ),
  cluster: (
    <>
      {[[16, 14], [76, 14], [46, 50]].map(([x, y]) => <g key={`${x}${y}`}><rect x={x} y={y} width="28" height="18" rx="2" /><path d={`M${x + 4} ${y + 6}h14M${x + 4} ${y + 11}h9`} /></g>)}
      <path d="M44 23h32M30 32l22 18M90 32L68 50" />
      <circle cx="60" cy="23" r="3" className="fill-current" />
    </>
  ),
  gateway: (
    <>
      <path d="M60 8l28 10v18c0 16-12 26-28 34C44 62 32 52 32 36V18z" />
      <path d="M48 36l8 8 16-16" />
      <path d="M4 38h22M94 38h22" strokeDasharray="3 3" />
      <circle cx="10" cy="38" r="3" />
      <circle cx="110" cy="38" r="3" />
    </>
  ),
  ai: (
    <>
      <rect x="30" y="18" width="60" height="40" rx="4" />
      <rect x="44" y="28" width="32" height="20" rx="2" />
      {[36, 48, 60, 72, 84].map((x) => <path key={x} d={`M${x} 18v-8M${x} 58v8`} />)}
      {[26, 38, 50].map((y) => <path key={y} d={`M30 ${y}h-10M90 ${y}h10`} />)}
      <path d="M52 38h4l3-5 4 10 3-5h4" />
    </>
  ),
  other: (
    <>
      <circle cx="60" cy="40" r="12" />
      <circle cx="60" cy="40" r="4" className="fill-current" />
      {[0, 60, 120, 180, 240, 300].map((a) => {
        const r = (a * Math.PI) / 180;
        const [x1, y1, x2, y2] = [60 + Math.cos(r) * 12, 40 + Math.sin(r) * 12, 60 + Math.cos(r) * 26, 40 + Math.sin(r) * 26];
        return <g key={a}><path d={`M${x1} ${y1}L${x2} ${y2}`} /><rect x={x2 - 5} y={y2 - 5} width="10" height="10" rx="2" /></g>;
      })}
    </>
  ),
};

function Wireframe({ role, active }: { role: RoleId; active: boolean }) {
  return (
    <svg viewBox="0 0 120 80" className={`h-24 w-full ${active ? "text-cyan-300" : "text-violet-300/70"}`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <defs>
        <filter id={`glow-${role}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g filter={`url(#glow-${role})`}>{W[role]}</g>
    </svg>
  );
}

/** Top-right checkmark of a wizard card. */
const Tick = ({ on }: { on: boolean }) => (
  <span className={`absolute top-2.5 right-2.5 flex h-6 w-6 items-center justify-center rounded-full border transition ${on ? "border-cyan-300 bg-cyan-400 text-slate-950 shadow-[0_0_12px_rgba(34,211,238,0.7)]" : "border-white/25 bg-white/5 text-transparent"}`} aria-hidden>
    <Check size={14} strokeWidth={3} />
  </span>
);

function Card({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative rounded-2xl border p-3 text-left transition active:scale-[0.99] ${on ? "border-cyan-300/60 bg-cyan-400/10 shadow-[0_0_24px_rgba(34,211,238,0.18)]" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]"}`}
    >
      <Tick on={on} />
      {children}
    </button>
  );
}

/** Live job progress; mounted only while setup runs, so nothing is polled before a job exists. */
function SetupProgress({ jobId, onDone, onRetry }: { jobId: string; onDone: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const progress = useJobProgress(`/tasks/${jobId}`, true, (ok) => ok && onDone());
  return progress ? <OperationProgressCard title={t("ob.title")} progress={progress} onRetry={onRetry} /> : <p className="text-xs text-slate-400">{t("ob.running")}</p>;
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
type Topology = "standalone" | "create_cluster" | "join_cluster";
const STEPS = ["roles", "services", "apps", "summary", "setup"] as const;

/** Full-screen Server Setup Wizard: first boot, or Settings › Features & Services › Re-run Setup Wizard. */
export default function ServerSetupWizard() {
  const { t } = useTranslation();
  const product = useProduct();
  const { wizard, state, closeWizard, load } = useOnboarding();
  const loadFeatures = useFeatures((s) => s.load);
  const go = useIntent((s) => s.go);
  const [step, setStep] = useState(0);
  const [roles, setRoles] = useState<RoleId[]>([]);
  const [topology, setTopology] = useState<Topology>("standalone");
  const [custom, setCustom] = useState<Record<FeatureKey, boolean> | null>(null);
  const [apps, setApps] = useState<string[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogApp[] | null>(null);
  const [skipTour, setSkipTour] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const firstRun = !!state && !state.onboarding_completed;

  useEffect(() => {
    if (!wizard) return;
    setStep(0), setCustom(null), setApps(null), setJobId(null), setFinished(false), setError("");
    setRoles((state?.selected_roles ?? []).filter((r): r is RoleId => ROLES.some((x) => x.id === r)));
    setTopology(state?.cluster_intent ?? "standalone");
    api<CatalogApp[]>("/apps/catalog").then((c) => setCatalog(c.filter((a) => WIZARD_APPS.includes(a.id))), () => setCatalog([]));
  }, [wizard]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!wizard) return null;

  // A cluster host always needs the cluster feature, whatever the roles say.
  const features = { ...(custom ?? only(roleFeatures(roles))), ...(topology !== "standalone" && { clustering: true }) };
  const picked = apps ?? roleApps(roles);
  const activeKeys = FEATURE_KEYS.filter((k) => features[k]);
  const name = STEPS[step];

  const next = () => {
    if (name === "roles") setStep(roles.includes("other") ? 1 : 2);
    else setStep(step + 1);
  };
  const back = () => setStep(name === "apps" && !custom && !roles.includes("other") ? 0 : step - 1);
  const skip = async () => {
    await api("/onboarding/skip", { method: "POST" }).catch(() => {});
    await load();
    closeWizard();
  };
  const setup = async () => {
    setError("");
    try {
      const r = await api<{ job_id: string }>("/onboarding/apply", {
        method: "POST",
        json: { selected_roles: roles, cluster_intent: topology, enabled_features: features, selected_app_ids: picked, skip_tour: skipTour },
      });
      setJobId(r.job_id);
      setStep(4);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const enter = async () => {
    await Promise.all([loadFeatures(), load()]);
    closeWizard();
    if (topology !== "standalone") go("settings", { module: "cluster-ha", tab: "cluster" });
  };

  return (
    <div className="fixed inset-0 z-[9700] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xl" role="dialog" aria-modal aria-label={t("ob.title")}>
      <div className="glass flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-3xl">
        <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
          <Rocket size={18} className="text-cyan-300" />
          <h2 className="text-sm font-semibold text-white">{t("ob.title")}</h2>
          <ol className="ml-4 flex flex-1 items-center gap-1.5 max-sm:hidden">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex items-center gap-1.5 text-[11px] ${i === step ? "text-cyan-200" : i < step ? "text-slate-300" : "text-slate-500"}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${i <= step ? "border-cyan-300/70 bg-cyan-400/15" : "border-white/15"}`}>{i < step ? <Check size={11} /> : i + 1}</span>
                {t(`ob.step.${s}`)}
                {i < STEPS.length - 1 && <ChevronRight size={11} className="text-slate-600" />}
              </li>
            ))}
          </ol>
          {name !== "setup" &&
            (firstRun ? (
              <button onClick={skip} className="ml-auto text-[11px] text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">{t("ob.skip")}</button>
            ) : (
              <button onClick={closeWizard} className="ml-auto rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white" aria-label={t("ob.close")}><X size={16} /></button>
            ))}
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {name === "roles" && (
            <>
              <h3 className="text-lg font-semibold text-white">{t("ob.roles.title")}</h3>
              <p className="mb-4 text-xs text-slate-400">{t("ob.roles.sub")}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {ROLES.map((r) => (
                  <Card key={r.id} on={roles.includes(r.id)} onClick={() => (setRoles(toggle(roles, r.id)), setCustom(null), setApps(null))} label={t(`ob.role.${r.id}`)}>
                    <Wireframe role={r.id} active={roles.includes(r.id)} />
                    <p className="mt-2 text-sm font-semibold text-white">{t(`ob.role.${r.id}`)}</p>
                    <p className="mt-1 text-[11px] leading-snug text-slate-400">{t(`ob.roleDesc.${r.id}`)}</p>
                  </Card>
                ))}
              </div>
              <div className="mt-5">
                <p className="mb-2 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t("ob.topology")}</p>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("ob.topology")}>
                  {(["standalone", "cluster"] as const).map((x) => {
                    const sel = x === "standalone" ? topology === "standalone" : topology !== "standalone";
                    return (
                      <button key={x} role="radio" aria-checked={sel} onClick={() => setTopology(x === "standalone" ? "standalone" : topology === "join_cluster" ? "join_cluster" : "create_cluster")}
                        className={`rounded-full border px-4 py-1.5 text-xs transition ${sel ? "border-cyan-300/60 bg-cyan-400/15 text-cyan-100" : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}>
                        {t(`ob.topo.${x}`)}
                      </button>
                    );
                  })}
                  {topology !== "standalone" &&
                    (["create_cluster", "join_cluster"] as const).map((x) => (
                      <button key={x} role="radio" aria-checked={topology === x} onClick={() => setTopology(x)}
                        className={`rounded-full border px-3 py-1.5 text-[11px] ${topology === x ? "border-violet-300/60 bg-violet-400/15 text-violet-100" : "border-white/10 text-slate-400 hover:text-slate-200"}`}>
                        {t(`ob.topo.${x}`)}
                      </button>
                    ))}
                </div>
              </div>
            </>
          )}

          {name === "services" && (
            <>
              <h3 className="text-lg font-semibold text-white">{t("ob.services.title")}</h3>
              <p className="mb-4 text-xs text-slate-400">{t("ob.services.sub")}</p>
              {FEATURE_DOMAINS.map((d) => (
                <section key={d} className="mb-4">
                  <h4 className="mb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t(`feat.domain.${d}`)}</h4>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {FEATURE_KEYS.filter((k) => FEATURES[k].domain === d).map((k) => {
                      const Icon = FEATURES[k].icon;
                      return (
                        <Card key={k} on={features[k]} onClick={() => setCustom({ ...features, [k]: !features[k] })} label={t(`feat.${k}`)}>
                          <div className="flex gap-2 pr-7">
                            <Icon size={16} className="mt-0.5 shrink-0 text-cyan-200" />
                            <div>
                              <p className="text-xs font-medium text-slate-100">{t(`feat.${k}`)}</p>
                              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{t(`featDesc.${k}`)}</p>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </section>
              ))}
            </>
          )}

          {name === "apps" && (
            <>
              <h3 className="text-lg font-semibold text-white">{t("ob.apps.title")}</h3>
              <p className="mb-4 text-xs text-slate-400">{t("ob.apps.sub")}</p>
              {catalog && !catalog.length && <p className="text-xs text-amber-200">{t("ob.apps.none")}</p>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(catalog ?? []).map((a) => (
                  <Card key={a.id} on={picked.includes(a.id)} onClick={() => setApps(toggle(picked, a.id))} label={a.name}>
                    <p className="pr-8 text-sm font-semibold text-white">{a.name}</p>
                    <p className="mt-1 text-[11px] leading-snug text-slate-400">{t(`ob.app.${a.id}` as never) || a.description}</p>
                    <p className="mt-2 text-[10px] text-cyan-200/80 tabular-nums">{t("ob.apps.footprint", { cpu: a.cores, ram: `${a.memory_mb / 1024} GB`, disk: a.disk_gb })}</p>
                  </Card>
                ))}
              </div>
            </>
          )}

          {name === "summary" && (
            <>
              <h3 className="mb-4 text-lg font-semibold text-white">{t("ob.sum.title")}</h3>
              <div className="grid gap-3 md:grid-cols-3">
                <section className="glass-soft rounded-2xl p-3">
                  <h4 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("ob.sum.roles")}</h4>
                  <ul className="mt-2 space-y-1 text-xs text-slate-100">{roles.map((r) => <li key={r}>✓ {t(`ob.role.${r}`)}</li>)}</ul>
                  <p className="mt-3 text-[11px] text-slate-400">{t("ob.sum.mode")}: <span className="text-slate-200">{t(`ob.topo.${topology === "standalone" ? "standalone" : topology}`)}</span></p>
                </section>
                <section className="glass-soft rounded-2xl p-3">
                  <h4 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("ob.sum.features")} ({activeKeys.length})</h4>
                  <ul className="mt-2 max-h-48 space-y-0.5 overflow-auto text-[11px] text-slate-200">{activeKeys.map((k) => <li key={k}>✓ {t(`feat.${k}`)}</li>)}</ul>
                  <p className="mt-2 text-[11px] text-slate-500">{t("ob.sum.hidden", { n: FEATURE_KEYS.length - activeKeys.length })}</p>
                  <GlassButton size="xs" className="mt-2" onClick={() => setStep(1)}><SlidersHorizontal size={11} /> {t("ob.customize")}</GlassButton>
                </section>
                <section className="glass-soft rounded-2xl p-3">
                  <h4 className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("ob.sum.apps")}</h4>
                  {picked.length ? (
                    <ul className="mt-2 space-y-1 text-xs text-slate-100">{picked.map((id) => <li key={id}>✓ {catalog?.find((a) => a.id === id)?.name ?? id}</li>)}</ul>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">{t("ob.sum.noApps")}</p>
                  )}
                </section>
              </div>
              <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <GlassCheckbox checked={skipTour} onChange={setSkipTour} label={<span className="text-xs text-slate-100">{t("ob.skipTour")}</span>} />
                <p className="mt-1 pl-5 text-[11px] text-slate-400">{t("ob.skipTourHint")}</p>
              </div>
              <Notice error={error} />
            </>
          )}

          {name === "setup" && (
            <div className="mx-auto max-w-xl py-4">
              {!finished ? (
                <>
                  <h3 className="mb-3 text-lg font-semibold text-white">{t("ob.running")}</h3>
                  {jobId && <SetupProgress key={jobId} jobId={jobId} onDone={() => setFinished(true)} onRetry={() => setStep(3)} />}
                </>
              ) : (
                <div className="text-center">
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300 shadow-[0_0_30px_rgba(52,211,153,0.4)]"><Check size={28} /></span>
                  <h3 className="mt-3 text-xl font-semibold text-white">{t("ob.done.title")}</h3>
                  <dl className="mx-auto mt-4 grid max-w-md gap-2 text-left text-xs">
                    <dt className="text-slate-500">{t("ob.done.url")}</dt>
                    <dd className="font-mono text-cyan-200">{location.origin}</dd>
                    <dt className="text-slate-500">{t("ob.done.roles")}</dt>
                    <dd className="text-slate-100">{roles.map((r) => t(`ob.role.${r}`)).join(", ") || "—"}</dd>
                    <dt className="text-slate-500">{t("ob.done.apps")}</dt>
                    <dd className="text-slate-100">{picked.map((id) => catalog?.find((a) => a.id === id)?.name ?? id).join(", ") || "—"}</dd>
                  </dl>
                  {topology !== "standalone" && <p className="mt-3 text-[11px] text-violet-200">{t("ob.done.cluster")}</p>}
                  <GlassButton variant="primary" size="md" className="mt-5" onClick={enter}>{t("ob.enter", { product: product.name })}</GlassButton>
                </div>
              )}
            </div>
          )}
        </div>

        {name !== "setup" && (
          <footer className="flex items-center gap-2 border-t border-white/10 px-5 py-3">
            {step > 0 && <GlassButton onClick={back}><ChevronLeft size={13} /> {t("ob.back")}</GlassButton>}
            {name === "roles" && <GlassButton onClick={() => setStep(1)} disabled={!roles.length}><SlidersHorizontal size={13} /> {t("ob.customize")}</GlassButton>}
            <span className="ml-auto text-[11px] text-slate-500">{name === "roles" && !roles.length ? t("ob.pickRole") : t("ob.stepOf", { n: step + 1, total: STEPS.length })}</span>
            {name === "summary" ? (
              <GlassButton variant="primary" size="md" onClick={setup}><Rocket size={14} /> {t("ob.setup")}</GlassButton>
            ) : (
              <GlassButton variant="primary" onClick={next} disabled={name === "roles" && !roles.length}>{t("ob.next")} <ChevronRight size={13} /></GlassButton>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
