import { ArrowLeft, ArrowRight, BookOpen, Check, Lightbulb, Sparkles } from "lucide-react";
import { openLink } from "../../lib/stores";
import { useWizard } from "../../store/wizardStore";
import { GUIDES, type Guide, type GuideAction } from "../../data/wizardGuides";
import { usePlatformLabel } from "../../store/capabilitiesStore";
import { GlassButton, GlassModal, GlassSwitch } from "../ui/GlassKit";
import { AppIcon } from "../icons/AppIcons";

/** Every "{platform}" in a guide's text becomes the active hypervisor label. Guides are plain JSON data. */
export const fillPlatform = (g: Guide, platform: string): Guide =>
  JSON.parse(JSON.stringify(g).replaceAll("{platform}", JSON.stringify(platform).slice(1, -1)));

/** Global multi-step guide dialog. Rendered once in App; opened with useWizard.show(guideId). */
export default function GuidedWizardModal() {
  const { guide: id, step, show, setStep, close, welcomeAuto, setWelcomeAuto } = useWizard();
  const platform = usePlatformLabel();
  const g = id && GUIDES[id] ? fillPlatform(GUIDES[id], platform) : undefined;
  if (!g) return null;
  const s = g.steps[Math.min(step, g.steps.length - 1)];
  const last = step >= g.steps.length - 1;
  const welcome = g.id === "welcome";
  const go = (a: GuideAction) => {
    close();
    openLink(a.app, a.intent);
  };
  const finish = () => {
    if (welcome) setWelcomeAuto(false); // a finished tour doesn't come back on its own; replay it from the Help menu
    close();
  };

  return (
    // Above windows (z ≤ topZ), the TopBar and the Dock (z 9000).
    <div className="relative z-[9600]">
      <GlassModal
        open
        onClose={close}
        width="max-w-xl"
        title={
          <span className="flex items-center gap-2">
            {welcome ? <Sparkles size={16} className="text-sky-300" /> : <AppIcon id={g.app} size={20} />}
            {g.title}
          </span>
        }
        footer={
          <div className="flex w-full flex-wrap items-center gap-2">
            {welcome && (
              <GlassSwitch checked={!welcomeAuto} onChange={(v) => setWelcomeAuto(!v)} label="Don't show automatically again" className="mr-auto" />
            )}
            <span className={`text-[11px] text-slate-400 tabular-nums ${welcome ? "" : "mr-auto"}`}>
              Step {step + 1} of {g.steps.length}
            </span>
            <GlassButton disabled={step === 0} onClick={() => setStep(step - 1)}>
              <ArrowLeft size={13} /> Back
            </GlassButton>
            {last ? (
              <GlassButton variant="primary" onClick={finish}>
                <Check size={13} /> Finish
              </GlassButton>
            ) : (
              <GlassButton variant="primary" onClick={() => setStep(step + 1)}>
                Next <ArrowRight size={13} />
              </GlassButton>
            )}
          </div>
        }
      >
        <div className="space-y-4 text-xs text-slate-300">
          {/* Clickable step pills double as the progress indicator. */}
          <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
            {g.steps.map((x, i) => (
              <li key={x.title}>
                <button
                  onClick={() => setStep(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition ring-inset ${
                    i === step ? "bg-sky-400/25 text-white ring-sky-300/40" : i < step ? "bg-emerald-400/10 text-emerald-200 ring-emerald-300/20" : "bg-white/[0.05] text-slate-400 ring-white/10 hover:text-slate-200"
                  }`}
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-black/25 text-[10px]">{i < step ? <Check size={10} /> : i + 1}</span>
                  {x.title}
                </button>
              </li>
            ))}
          </ol>

          <h4 className="text-base font-semibold text-white">{s.title}</h4>
          {s.body && <p className="leading-relaxed">{s.body}</p>}
          {s.cards && (
            <div className="grid gap-2 sm:grid-cols-2">
              {s.cards.map((c) => (
                <div key={c.title} className="glass-soft rounded-xl p-3">
                  <div className="mb-1 text-[13px] font-semibold text-slate-100">{c.title}</div>
                  <p className="leading-relaxed text-slate-400">{c.body}</p>
                </div>
              ))}
            </div>
          )}
          {s.bullets && (
            <ul className="space-y-1.5">
              {s.bullets.map((b) => (
                <li key={b} className="flex gap-2 leading-relaxed">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-300" />
                  {b}
                </li>
              ))}
            </ul>
          )}
          {s.numbered && (
            <ol className="space-y-2">
              {s.numbered.map((n, i) => (
                <li key={n} className="flex gap-2.5 leading-relaxed">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-400/20 text-[10px] font-semibold text-sky-100 ring-1 ring-sky-300/30 ring-inset">{i + 1}</span>
                  {n}
                </li>
              ))}
            </ol>
          )}
          {s.tip && (
            <p className="flex gap-2 rounded-xl bg-amber-400/10 px-3 py-2 leading-relaxed text-amber-100 ring-1 ring-amber-300/20 ring-inset">
              <Lightbulb size={14} className="mt-0.5 shrink-0" />
              {s.tip}
            </p>
          )}
          {s.action && (
            <GlassButton variant="primary" size="md" onClick={() => go(s.action!)}>
              <Sparkles size={14} /> Show Me: {s.action.label}
            </GlassButton>
          )}
          {last && g.related && (
            <div className="space-y-1.5 border-t border-white/10 pt-3">
              <div className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">More step-by-step guides</div>
              {g.related.map((r) => (
                <button
                  key={r}
                  onClick={() => show(r)}
                  className="glass-soft flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.09]"
                >
                  <BookOpen size={14} className="shrink-0 text-sky-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-slate-100">{GUIDES[r].title}</span>
                    <span className="block text-[11px] text-slate-400">{GUIDES[r].blurb}</span>
                  </span>
                  <ArrowRight size={13} className="text-slate-500" />
                </button>
              ))}
            </div>
          )}
        </div>
      </GlassModal>
    </div>
  );
}

/** Subtle "Need help?" strip for empty states and complex dialogs; launches that feature's guide. */
export function GuideBanner({ guide, text = "New to this? Follow a plain-English walkthrough.", className = "" }: { guide: string; text?: string; className?: string }) {
  const show = useWizard((s) => s.show);
  return (
    <div className={`glass-soft flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[11px] text-slate-300 ${className}`}>
      <Lightbulb size={14} className="shrink-0 text-sky-300" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-slate-100">Need help? </span>
        {text}
      </span>
      <GlassButton size="xs" onClick={() => show(guide)}>
        <BookOpen size={12} /> Launch Step-by-Step Guide
      </GlassButton>
    </div>
  );
}
