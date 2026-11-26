import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, BookOpen, LibraryBig, Check, ChevronDown, Copy, Cpu, ExternalLink, HelpCircle, MousePointerClick, Printer, QrCode, RefreshCw, Search, Sparkles, Wand2, Wrench } from "lucide-react";
import { useOnboarding } from "../store/onboardingStore";
import { api } from "../lib/api";
import { useRunner } from "../lib/hooks";
import { openLink, useIntent, type Intents } from "../lib/stores";
import type { AppId } from "./registry";
import { APPS } from "./registry";
import { Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, Notice, Segmented } from "../components/ui/GlassKit";
import { useCapabilities } from "../store/capabilitiesStore";
import { JobLog } from "../components/JobLog";
import { CATEGORIES, FAQS, TUTORIALS, type Category, type Faq, type HelpLink, type Tutorial } from "./help/content";
import { rank } from "./help/search";
import Manual, { type HelpTarget } from "./help/Manual";
import { useTranslation } from "../i18n";

type Tab = Extract<NonNullable<Intents["help"]>, string>;
type Status = "ok" | "info" | "warning" | "error";

interface Diag {
  id: string;
  title: string;
  status: Status;
  summary: string;
  details: string;
  fix: { label: string; changes: string[]; reboot: boolean } | null;
  manual: string[];
  link: { app: AppId; intent?: string } | null;
  bios: string | null;
}

interface BiosGuide {
  id: string;
  title: string;
  why: string;
  verify: string;
  needed: boolean | null;
  steps: string[];
  text: string;
  qr: string[];
}

interface BiosInfo {
  facts: { manufacturer: string; board_vendor: string; board: string; bios_vendor: string; bios_version: string; cpu: string; virtualization: boolean; secure_boot: boolean };
  detected_vendor: string;
  vendor: string;
  vendors: { id: string; name: string }[];
  guides: BiosGuide[];
}

const TONE: Record<Status, "success" | "info" | "warning" | "danger"> = { ok: "success", info: "info", warning: "warning", error: "danger" };
const LABEL: Record<Status, string> = { ok: "ALL GOOD", info: "TIP", warning: "NEEDS ATTENTION", error: "PROBLEM" };
const EXAMPLES = ["My updates fail with 401", "Use my graphics card in a Windows VM", "Block ads on my network", "Connect from my phone when I'm away", "Back up my VMs automatically"];

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "manual", label: "help.manual", icon: <LibraryBig size={15} /> },
  { id: "ask", label: "Ask & search", icon: <Sparkles size={15} /> },
  { id: "fix", label: "Fix problems", icon: <Wrench size={15} /> },
  { id: "bios", label: "BIOS & firmware", icon: <Cpu size={15} /> },
  { id: "tutorials", label: "Tutorials", icon: <BookOpen size={15} /> },
  { id: "faq", label: "FAQ", icon: <HelpCircle size={15} /> },
];

const svgSrc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const tutorialFields = (t: Tutorial): [string, number][] => [[t.title, 3], [t.keywords, 2], [`${t.intro} ${t.steps.map((s) => s.text).join(" ")}`, 1]];
const faqFields = (f: Faq): [string, number][] => [[f.q, 3], [f.keywords, 2], [f.a, 1]];
const diagFields = (d: Diag): [string, number][] => [[d.title, 3], [`${d.id} ${d.bios ?? ""}`, 2], [`${d.summary} ${d.fix?.label ?? ""}`, 1]];

export default function HelpCenterApp() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("manual");
  const [doc, setDoc] = useState<HelpTarget | null>(null);
  const caps = useCapabilities((s) => s.capabilities);
  const [diags, setDiags] = useState<Diag[] | null>(null);
  const [diagError, setDiagError] = useState("");
  const [wizard, setWizard] = useState<Diag | null>(null);
  const [tutorial, setTutorial] = useState<Tutorial | null>(null);
  const [biosFocus, setBiosFocus] = useState<string | null>(null);
  const intent = useIntent((s) => s.help);
  const take = useIntent((s) => s.take);

  const load = useCallback(() => {
    setDiagError("");
    api<Diag[]>("/help/diagnostics").then(setDiags, (e) => setDiagError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!intent) return;
    if (typeof intent === "string") setTab(intent);
    else (setTab("manual"), setDoc(intent));
    take("help");
  }, [intent, take]);

  const follow = (l: HelpLink | Diag["link"]) => {
    if (!l) return;
    if (l.app === "help") return setTab((l.intent as Tab) || "fix");
    openLink(l.app, l.intent);
  };
  const showBios = (id: string) => {
    setBiosFocus(id);
    setTab("bios");
  };
  const fixById = (id: string) => diags?.find((d) => d.id === id);
  const problems = diags?.filter((d) => d.status === "error" || d.status === "warning") ?? [];

  const label = (l: string) => (l === "help.manual" ? t("help.manual") : l);
  const ctx: Ctx = { diags, problems, follow, setWizard, showBios, setTutorial, fixById, setTab };
  return (
    <div className="flex h-full">
      <nav className="w-48 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {TABS.filter((x) => x.id !== "bios" || caps.supports_bios_manager).map((x) => (
          <button
            key={x.id}
            onClick={() => setTab(x.id)}
            aria-current={tab === x.id}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${tab === x.id ? "bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
            title={label(x.label)}
          >
            {x.icon}
            <span className="flex-1 max-sm:hidden">{label(x.label)}</span>
            {x.id === "fix" && problems.length > 0 && <span className="rounded-full bg-amber-300 px-1.5 text-[10px] font-bold text-slate-900 max-sm:hidden">{problems.length}</span>}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {diagError && tab !== "tutorials" && tab !== "faq" && tab !== "manual" && (
          <div className="mb-3">
            <Notice error={`Could not run the health check: ${diagError}`} />
          </div>
        )}
        {tab === "manual" ? <Manual target={doc} /> : tab === "ask" ? <Ask ctx={ctx} /> : tab === "fix" ? <FixList ctx={ctx} reload={load} /> : tab === "bios" ? <Bios focus={biosFocus} /> : tab === "tutorials" ? <Tutorials ctx={ctx} /> : <FaqList follow={follow} />}
      </div>
      <FixWizard item={wizard} onClose={() => setWizard(null)} onFixed={load} follow={follow} showBios={showBios} />
      <TutorialModal tutorial={tutorial} onClose={() => setTutorial(null)} follow={follow} ctx={ctx} />
    </div>
  );
}

interface Ctx {
  diags: Diag[] | null;
  problems: Diag[];
  follow: (l: HelpLink | Diag["link"]) => void;
  setWizard: (d: Diag) => void;
  showBios: (id: string) => void;
  setTutorial: (t: Tutorial) => void;
  fixById: (id: string) => Diag | undefined;
  setTab: (t: Tab) => void;
}

/** Help & Support › Interactive Desktop Tour and the Server Setup Wizard. */
function TourCard() {
  const { t } = useTranslation();
  const { startTour, openWizard } = useOnboarding();
  return (
    <Section title={t("help.tour")} action={<GlassButton size="xs" variant="primary" onClick={startTour}><MousePointerClick size={12} /> {t("help.tourStart")}</GlassButton>}>
      <p className="text-xs text-slate-300">{t("help.tourDesc")}</p>
      <GlassButton size="xs" className="mt-2" onClick={openWizard}><Wand2 size={12} /> {t("feat.rerun")}</GlassButton>
    </Section>
  );
}

function Section({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="glass-soft rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ---------------- Ask & search ---------------- */

function Ask({ ctx }: { ctx: Ctx }) {
  const [q, setQ] = useState("");
  const fixes = useMemo(() => (q ? rank(q, (ctx.diags ?? []).filter((d) => d.status !== "ok" && (d.fix || d.bios)), diagFields, 0.6, 3) : []), [q, ctx.diags]);
  const guides = useMemo(() => (q ? rank(q, TUTORIALS, tutorialFields, 0.6, 4) : []), [q]);
  const answers = useMemo(() => (q ? rank(q, FAQS, faqFields, 0.8, 4) : []), [q]);
  const nothing = q.trim() && !fixes.length && !guides.length && !answers.length;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-white">How can SolarDeck help you?</h2>
        <p className="text-xs text-slate-400">Describe what you want to do or what isn't working, in your own words.</p>
      </div>
      <label className="relative block">
        <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
        <GlassInput autoFocus className="w-full rounded-xl py-3 pl-10 text-sm" placeholder="e.g. I want to use my graphics card in a Windows VM" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Ask SolarDeck" />
      </label>
      {!q && (
        <div className="flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} onClick={() => setQ(e)} className="glass-soft rounded-full px-3 py-1 text-[11px] text-slate-300 hover:text-white">
              {e}
            </button>
          ))}
        </div>
      )}
      {!q && <TourCard />}
      {!q && ctx.diags && (
        <Section title="Health check" action={<GlassButton size="xs" onClick={() => ctx.setTab("fix")}>Open <ArrowRight size={12} /></GlassButton>}>
          {ctx.problems.length ? (
            <p className="text-xs text-amber-200">
              SolarDeck found {ctx.problems.length} thing(s) to fix. Most can be fixed with one click — open <b>Fix problems</b>.
            </p>
          ) : (
            <p className="text-xs text-emerald-200">Everything looks good. No problems found.</p>
          )}
        </Section>
      )}
      {fixes.length > 0 && (
        <Section title="SolarDeck can fix this for you">
          <div className="space-y-2">
            {fixes.map((d) => (
              <DiagRow key={d.id} d={d} ctx={ctx} />
            ))}
          </div>
        </Section>
      )}
      {guides.length > 0 && (
        <Section title="Step-by-step guides">
          <div className="grid gap-2 sm:grid-cols-2">
            {guides.map((t) => (
              <TutorialCard key={t.id} t={t} onOpen={() => ctx.setTutorial(t)} />
            ))}
          </div>
        </Section>
      )}
      {answers.length > 0 && (
        <Section title="Answers">
          <FaqItems items={answers} follow={ctx.follow} />
        </Section>
      )}
      {nothing && (
        <Section title="No exact match">
          <p className="text-xs text-slate-300">Try simpler words (for example “backup”, “graphics card”, “update”), run the health check in <b>Fix problems</b>, or browse the <b>Tutorials</b>.</p>
        </Section>
      )}
    </div>
  );
}

/* ---------------- Fix problems ---------------- */

function DiagRow({ d, ctx }: { d: Diag; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-100">{d.title}</span>
            <GlassBadge tone={TONE[d.status]}>{LABEL[d.status]}</GlassBadge>
          </div>
          <p className="mt-1 text-xs text-slate-300">{d.summary}</p>
        </div>
        {d.status !== "ok" && (
          <div className="flex flex-wrap gap-1.5">
            {d.fix && (
              <GlassButton variant="primary" onClick={() => ctx.setWizard(d)}>
                <Wrench size={12} /> Fix it for me
              </GlassButton>
            )}
            {d.bios && (
              <GlassButton onClick={() => ctx.showBios(d.bios!)}>
                <QrCode size={12} /> BIOS steps
              </GlassButton>
            )}
            {d.manual.length > 0 && (
              <GlassButton variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                Do it myself <ChevronDown size={12} className={open ? "rotate-180" : ""} />
              </GlassButton>
            )}
            {d.link && (
              <GlassButton variant="ghost" onClick={() => ctx.follow(d.link)}>
                <ExternalLink size={12} /> {APPS[d.link.app].title}
              </GlassButton>
            )}
          </div>
        )}
      </div>
      {open && <Steps steps={d.manual} />}
    </div>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="mt-3 space-y-1.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2 text-xs text-slate-200">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-400/20 text-[10px] font-bold text-sky-200">{i + 1}</span>
          <span className="pt-0.5">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function FixList({ ctx, reload }: { ctx: Ctx; reload: () => void }) {
  const [showOk, setShowOk] = useState(false);
  const items = ctx.diags ?? [];
  const ok = items.filter((d) => d.status === "ok");
  const rest = items.filter((d) => d.status !== "ok");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-white">Health check</h2>
          <p className="text-[11px] text-slate-400">SolarDeck checks your server and explains every problem in plain words. “Fix it for me” shows exactly what will change before anything happens.</p>
        </div>
        <GlassButton onClick={() => (ctx.diags && reload())}>
          <RefreshCw size={13} /> Check again
        </GlassButton>
      </div>
      {!ctx.diags ? (
        <p className="text-sm text-slate-400">Checking your server… (this takes a few seconds)</p>
      ) : (
        <>
          {rest.length === 0 && <Notice notice="No problems found. Your server looks healthy." />}
          <div className="space-y-2">
            {rest.map((d) => (
              <DiagRow key={d.id} d={d} ctx={ctx} />
            ))}
          </div>
          {ok.length > 0 && (
            <div>
              <GlassButton variant="ghost" size="xs" onClick={() => setShowOk((v) => !v)}>
                <Check size={12} /> {ok.length} check(s) passed <ChevronDown size={12} className={showOk ? "rotate-180" : ""} />
              </GlassButton>
              {showOk && (
                <div className="mt-2 space-y-2">
                  {ok.map((d) => (
                    <DiagRow key={d.id} d={d} ctx={ctx} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const WIZARD_STEPS = ["The problem", "What will change", "Fixing", "Done"];

function FixWizard({ item, onClose, onFixed, follow, showBios }: { item: Diag | null; onClose: () => void; onFixed: () => void; follow: Ctx["follow"]; showBios: (id: string) => void }) {
  const [step, setStep] = useState(0);
  const [agree, setAgree] = useState(false);
  const [result, setResult] = useState<{ message: string; job?: string } | null>(null);
  const [jobOk, setJobOk] = useState<boolean | null>(null);
  const { busy, error, run, setError } = useRunner();
  useEffect(() => {
    setStep(0);
    setAgree(false);
    setResult(null);
    setJobOk(null);
    setError("");
  }, [item, setError]);
  const onJobDone = useCallback(
    (ok: boolean) => {
      setJobOk(ok);
      setStep(3);
      onFixed();
    },
    [onFixed],
  );
  if (!item) return null;
  const apply = () =>
    run(async () => {
      setStep(2);
      const r = await api<{ message: string; job?: string }>(`/help/fix/${item.id}`, { method: "POST" });
      setResult(r);
      if (!r.job) {
        setStep(3);
        onFixed();
      }
    }).then((ok) => !ok && setStep(1));
  const failed = jobOk === false;
  return (
    <GlassModal
      open
      onClose={onClose}
      width="max-w-xl"
      title={`Fix: ${item.title}`}
      footer={
        step === 0 ? (
          <>
            <GlassButton onClick={onClose}>Not now</GlassButton>
            <GlassButton variant="primary" onClick={() => setStep(1)}>
              Next <ArrowRight size={12} />
            </GlassButton>
          </>
        ) : step === 1 ? (
          <>
            <GlassButton onClick={() => setStep(0)}>Back</GlassButton>
            <GlassButton variant="primary" disabled={!agree || busy} onClick={apply}>
              <Wrench size={12} /> {item.fix?.label}
            </GlassButton>
          </>
        ) : step === 2 ? (
          <GlassButton disabled>Working… please keep this window open</GlassButton>
        ) : (
          <GlassButton variant="primary" onClick={onClose}>
            Close
          </GlassButton>
        )
      }
    >
      <ol className="mb-4 flex gap-1" aria-label="Progress">
        {WIZARD_STEPS.map((s, i) => (
          <li key={s} className={`flex-1 rounded-full py-1 text-center text-[10px] font-medium ${i === step ? "bg-sky-400/25 text-sky-100" : i < step ? "bg-emerald-400/15 text-emerald-200" : "bg-white/5 text-slate-500"}`}>
            {i < step ? "✓ " : `${i + 1}. `}
            {s}
          </li>
        ))}
      </ol>
      {step === 0 && (
        <div className="space-y-3 text-xs text-slate-200">
          <p className="text-sm">{item.summary}</p>
          {item.details && <p className="rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] text-slate-400">{item.details}</p>}
          <p className="text-slate-400">Press Next to see exactly what SolarDeck will change. Nothing happens until you confirm.</p>
        </div>
      )}
      {step === 1 && item.fix && (
        <div className="space-y-3 text-xs text-slate-200">
          <p>SolarDeck will:</p>
          <ul className="space-y-1.5">
            {item.fix.changes.map((c) => (
              <li key={c} className="flex gap-2">
                <Check size={14} className="shrink-0 text-emerald-300" /> {c}
              </li>
            ))}
          </ul>
          {item.fix.reboot && <Notice error="The server must be restarted afterwards for this to take effect. Your VMs will stop during the restart — do it when it suits you." />}
          {item.bios && <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-amber-100">This also needs a setting in your BIOS that only you can change. You will get step-by-step instructions with a QR code for your phone at the end.</p>}
          <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />I understand what will change. Go ahead.
          </label>
          <Notice error={error} />
        </div>
      )}
      {step === 2 && (
        <div className="space-y-3 text-xs text-slate-300">
          <p>{result?.message ?? "Applying the fix…"}</p>
          {result?.job && <JobLog name={result.job} active onDone={onJobDone} />}
        </div>
      )}
      {step === 3 && (
        <div className="space-y-4 text-xs text-slate-200">
          {failed ? <Notice error="The fix did not finish. The log below shows why; nothing else was changed. You can try again or follow the manual steps." /> : <Notice notice={result?.message.replace(/…$/, ".") ?? "Done."} />}
          {result?.job && <JobLog name={result.job} active={false} />}
          {item.fix?.reboot && !failed && <p className="text-amber-200">Remember: restart the server to finish (Settings → Host & Power → Reboot host).</p>}
          {item.bios && (
            <GlassButton variant="primary" onClick={() => (onClose(), showBios(item.bios!))}>
              <QrCode size={13} /> Show the BIOS steps + QR code
            </GlassButton>
          )}
          {item.manual.length > 0 && (
            <div className="glass-soft rounded-xl p-3">
              <p className="font-semibold text-slate-100">Next time, you can do this yourself:</p>
              <Steps steps={item.manual} />
            </div>
          )}
          {item.link && (
            <GlassButton variant="ghost" onClick={() => (onClose(), follow(item.link))}>
              <ExternalLink size={12} /> Open {APPS[item.link.app].title}
            </GlassButton>
          )}
        </div>
      )}
    </GlassModal>
  );
}

/* ---------------- BIOS & firmware ---------------- */

export function Bios({ focus }: { focus: string | null }) {
  const [vendor, setVendor] = useState("");
  const [info, setInfo] = useState<BiosInfo | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    api<BiosInfo>(`/help/bios${vendor ? `?vendor=${vendor}` : ""}`).then(setInfo, (e) => setError(e.message));
  }, [vendor]);
  useEffect(() => {
    if (info && focus) document.getElementById(`bios-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [info, focus]);
  if (error) return <Notice error={`Could not read the server's BIOS details: ${error}`} />;
  if (!info) return <p className="text-sm text-slate-400">Reading your motherboard details…</p>;
  const f = info.facts;
  return (
    <div className="space-y-4">
      <Section title="Your motherboard">
        <div className="flex flex-wrap items-end gap-4 text-xs">
          <div className="min-w-0 flex-1 space-y-0.5 text-slate-300">
            <p>
              <span className="text-slate-400">Board:</span> {[f.board_vendor, f.board].filter(Boolean).join(" ") || "Unknown"}
            </p>
            <p>
              <span className="text-slate-400">BIOS:</span> {f.bios_vendor} {f.bios_version}
            </p>
            <p>
              <span className="text-slate-400">Processor:</span> {f.cpu === "amd" ? "AMD" : "Intel"} · Virtualization {f.virtualization ? "on" : "OFF"} · Secure Boot {f.secure_boot ? "on" : "off"}
            </p>
          </div>
          <Field label="Menu style (change it if the steps don't match your screen)">
            <GlassSelect value={info.vendor} onChange={(e) => setVendor(e.target.value)}>
              {info.vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.id === info.detected_vendor ? " (detected)" : ""}
                </option>
              ))}
            </GlassSelect>
          </Field>
        </div>
        <p className="mt-3 rounded-lg bg-sky-400/10 px-3 py-2 text-[11px] text-sky-100">
          <QrCode size={12} className="mr-1 inline" />
          While you are in the BIOS, the server (and this page) is offline. Scan the QR code with your phone or tablet camera first — the instructions are stored inside the code itself, so they work without internet.
        </p>
      </Section>
      {info.guides.map((g) => (
        <BiosCard key={g.id} g={g} highlight={focus === g.id} />
      ))}
    </div>
  );
}

function BiosCard({ g, highlight }: { g: BiosGuide; highlight: boolean }) {
  const [copied, setCopied] = useState(false);
  const print = () => {
    const w = window.open("", "_blank", "width=720,height=900");
    if (!w) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    w.document.write(
      `<title>${esc(g.title)}</title><body style="font-family:system-ui;padding:24px"><pre style="white-space:pre-wrap;font-size:14px">${esc(g.text)}</pre>${g.qr
        .map((q) => `<img style="width:220px;margin:8px" src="${svgSrc(q)}">`)
        .join("")}<script>window.onload=()=>window.print()</script></body>`,
    );
    w.document.close();
  };
  return (
    <section id={`bios-${g.id}`} className={`glass-soft scroll-mt-4 rounded-2xl p-4 ${highlight ? "ring-2 ring-sky-400/60" : ""}`}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">{g.title}</h3>
            {g.needed === true && <GlassBadge tone="warning">NEEDED ON THIS SERVER</GlassBadge>}
            {g.needed === null && <GlassBadge tone="info">RECOMMENDED FOR GPU PASSTHROUGH</GlassBadge>}
            {g.needed === false && <GlassBadge>NOT NEEDED NOW</GlassBadge>}
          </div>
          <p className="text-xs text-slate-400">{g.why}</p>
          <Steps steps={g.steps} />
          <p className="mt-3 text-[11px] text-emerald-200/90">
            <Check size={12} className="mr-1 inline" />
            How to check it worked: {g.verify}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <GlassButton size="xs" onClick={print}>
              <Printer size={12} /> Print
            </GlassButton>
            <GlassButton size="xs" onClick={() => navigator.clipboard?.writeText(g.text).then(() => setCopied(true))}>
              <Copy size={12} /> {copied ? "Copied" : "Copy text"}
            </GlassButton>
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {g.qr.map((q, i) => (
            <figure key={i} className="text-center">
              <img src={svgSrc(q)} alt={`QR code with the instructions${g.qr.length > 1 ? `, part ${i + 1} of ${g.qr.length}` : ""}`} className="h-44 w-44 rounded-xl bg-white p-2" />
              <figcaption className="mt-1 text-[10px] text-slate-400">{g.qr.length > 1 ? `Part ${i + 1} of ${g.qr.length} — scan with your phone` : "Scan with your phone camera"}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Tutorials & FAQ ---------------- */

function TutorialCard({ t, onOpen }: { t: Tutorial; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="glass-soft flex flex-col items-start gap-1 rounded-xl p-3 text-left transition-[background-color,border-color,box-shadow,transform,scale,opacity] hover:bg-white/[0.08] active:scale-[0.99]">
      <span className="text-xs font-semibold text-slate-100">{t.title}</span>
      <span className="text-[11px] text-slate-400">{t.intro}</span>
      <span className="mt-1 text-[10px] text-sky-300">
        {t.category} · {t.minutes} min
      </span>
    </button>
  );
}

function Tutorials({ ctx }: { ctx: Ctx }) {
  const [cat, setCat] = useState<Category | "all">("all");
  const [q, setQ] = useState("");
  const shown = q ? rank(q, TUTORIALS, tutorialFields, 0.5, 30) : TUTORIALS.filter((t) => cat === "all" || t.category === cat);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <GlassInput className="w-64" placeholder="Search tutorials" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tutorials" />
        <GlassSelect value={cat} onChange={(e) => setCat(e.target.value as Category | "all")} aria-label="Category">
          <option value="all">All topics</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </GlassSelect>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t) => (
          <TutorialCard key={t.id} t={t} onOpen={() => ctx.setTutorial(t)} />
        ))}
      </div>
      {shown.length === 0 && <p className="text-xs text-slate-400">No tutorials match.</p>}
    </div>
  );
}

function TutorialModal({ tutorial: t, onClose, follow, ctx }: { tutorial: Tutorial | null; onClose: () => void; follow: Ctx["follow"]; ctx: Ctx }) {
  const [done, setDone] = useState<number[]>([]);
  useEffect(() => setDone([]), [t]);
  if (!t) return null;
  const fix = t.fix ? ctx.fixById(t.fix) : undefined;
  return (
    <GlassModal open onClose={onClose} title={t.title} width="max-w-xl" footer={<GlassButton onClick={onClose}>Close</GlassButton>}>
      <p className="mb-3 text-xs text-slate-300">{t.intro}</p>
      {fix && fix.status !== "ok" && fix.fix && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <span className="flex-1">SolarDeck can do part of this for you: {fix.summary}</span>
          <GlassButton variant="primary" size="xs" onClick={() => (onClose(), ctx.setWizard(fix))}>
            <Wrench size={12} /> Fix it for me
          </GlassButton>
        </div>
      )}
      <ol className="space-y-2">
        {t.steps.map((s, i) => (
          <li key={i} className={`flex gap-3 rounded-xl p-2.5 ${done.includes(i) ? "bg-emerald-400/10" : "bg-black/20"}`}>
            <button
              onClick={() => setDone((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i]))}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${done.includes(i) ? "bg-emerald-400 text-slate-900" : "bg-sky-400/20 text-sky-200"}`}
              aria-label={done.includes(i) ? `Step ${i + 1} done` : `Mark step ${i + 1} done`}
            >
              {done.includes(i) ? <Check size={13} /> : i + 1}
            </button>
            <div className="min-w-0 flex-1 text-xs text-slate-200">
              <p>{s.text}</p>
              {s.link && (
                <GlassButton size="xs" className="mt-2" onClick={() => (s.link!.app !== "help" && onClose(), follow(s.link!))}>
                  Show me <ArrowRight size={12} />
                </GlassButton>
              )}
            </div>
          </li>
        ))}
      </ol>
      {done.length === t.steps.length && <p className="mt-3 text-center text-xs text-emerald-200">🎉 All steps done!</p>}
    </GlassModal>
  );
}

function FaqItems({ items, follow }: { items: Faq[]; follow: Ctx["follow"] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="divide-y divide-white/5">
      {items.map((f) => (
        <div key={f.q} className="py-2">
          <button className="flex w-full items-center gap-2 text-left text-xs font-medium text-slate-100" onClick={() => setOpen(open === f.q ? null : f.q)} aria-expanded={open === f.q}>
            <span className="flex-1">{f.q}</span>
            <ChevronDown size={13} className={`shrink-0 text-slate-400 transition ${open === f.q ? "rotate-180" : ""}`} />
          </button>
          {open === f.q && (
            <div className="mt-2 text-xs text-slate-300">
              <p>{f.a}</p>
              {f.link && (
                <GlassButton size="xs" className="mt-2" onClick={() => follow(f.link!)}>
                  Open {APPS[f.link.app].title} <ArrowRight size={12} />
                </GlassButton>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FaqList({ follow }: { follow: Ctx["follow"] }) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<"all" | "search">("all");
  const items = q ? rank(q, FAQS, faqFields, 0.5, 30) : FAQS;
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="flex items-center gap-2">
        <GlassInput className="flex-1" placeholder="Search questions" value={q} onChange={(e) => (setQ(e.target.value), setView(e.target.value ? "search" : "all"))} aria-label="Search FAQ" />
        <Segmented value={view} onChange={(v) => (setView(v), v === "all" && setQ(""))} options={[{ id: "all", label: "All" }, { id: "search", label: "Matches" }]} />
      </div>
      <Section title="Frequently asked questions">{items.length ? <FaqItems items={items} follow={follow} /> : <p className="text-xs text-slate-400">No questions match.</p>}</Section>
    </div>
  );
}
