import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft, ArrowUp, BrainCircuit, Check, ChevronDown, Copy, Cpu, Download, ExternalLink, Gauge, HardDrive, MessageSquare, Search,
  PanelLeft, Pencil, Settings as SettingsIcon, Square, SquarePen, Thermometer, Trash2, Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { bytes, copyText, pct } from "../lib/format";
import { useDismiss, usePoll } from "../lib/hooks";
import { useWindows } from "../lib/stores";
import type { AiHardware, AiStatus, LocalModel, OnlineModel, PullJob, VramFit } from "../lib/types";
import { ConfirmModal, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";

const CATEGORIES = ["All", "Coding", "General", "Reasoning", "Vision", "Embeddings"] as const;
const FIT_TONE: Record<VramFit, "success" | "warning" | "danger" | "neutral"> = { optimal_gpu: "success", tight_gpu: "warning", cpu_offload: "danger", cpu_only: "neutral" };

const shortGpu = (name?: string | null) => (name || "GPU").replace(/^NVIDIA\s+(GeForce\s+)?/i, "");

function fitLabel(fit: VramFit, gpu: string) {
  return { optimal_gpu: `Fits ${gpu} 100% VRAM`, tight_gpu: `Tight fit in ${gpu} VRAM`, cpu_offload: "Hybrid GPU+RAM", cpu_only: "CPU only" }[fit];
}

function Bar({ value, tone = "bg-sky-400" }: { value: number; tone?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

function PullProgress({ job }: { job: PullJob }) {
  return (
    <div className="space-y-1">
      <Bar value={job.state === "done" ? 100 : job.percent} tone={job.state === "error" ? "bg-rose-400" : job.state === "done" ? "bg-emerald-400" : "bg-sky-400"} />
      <p className="truncate text-[10px] text-slate-400 tabular-nums">
        {job.state === "error"
          ? job.error
          : job.state === "done"
            ? "Downloaded"
            : `${job.status}${job.total ? ` · ${bytes(job.completed)} / ${bytes(job.total)} · ${job.percent}%` : ""}${job.digest ? ` · ${job.digest.slice(7, 19)}` : ""}`}
      </p>
    </div>
  );
}

/* ---------------- Online Models ---------------- */

function OnlineModels({ status, jobs, onPull }: { status: AiStatus; jobs: PullJob[]; onPull: (tag: string) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("All");
  const [data, setData] = useState<{ models: OnlineModel[]; source: string; vram_gb: number } | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const gpu = shortGpu(status.gpu_name);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let stop = false;
    setData(null);
    api<{ models: OnlineModel[]; source: string; vram_gb: number }>(`/ai/models/online?q=${encodeURIComponent(debounced)}&category=${cat}`)
      .then((d) => !stop && (setData(d), setError("")))
      .catch((e) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [debounced, cat]);

  // Default tag: the largest one that still runs 100% on the GPU, else the smallest.
  const defaultTag = (m: OnlineModel) => [...m.tags].reverse().find((t) => t.vram_fit === "optimal_gpu")?.tag ?? m.tags[0]?.tag;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
        <label className="relative">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <GlassInput className="w-64 py-1.5 pl-8 text-xs max-sm:w-44" placeholder="Search the model library" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
        </label>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={cat === c}
              onClick={() => setCat(c)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${cat === c ? "bg-violet-500/30 text-white ring-1 ring-violet-300/40" : "bg-white/5 text-slate-400 hover:text-slate-200"}`}
            >
              {c}
            </button>
          ))}
        </div>
        {data && (
          <span className="ml-auto text-[10px] text-slate-500">
            {data.source === "ollama.com" ? "Live from ollama.com/library" : "Built-in catalog (library offline)"} · rated for {data.vram_gb ? `${data.vram_gb.toFixed(0)} GB VRAM` : "CPU"}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <Notice error={error} />
        {!data && !error && <p className="text-sm text-slate-400">Loading models…</p>}
        {data && data.models.length === 0 && <p className="text-sm text-slate-400">No models match.</p>}
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {data?.models.map((m) => {
            const tag = m.tags.find((t) => t.tag === (picked[m.name] ?? defaultTag(m))) ?? m.tags[0];
            const job = jobs.find((j) => j.model === tag?.tag && j.state !== "error") ?? jobs.find((j) => j.model === tag?.tag);
            return (
              <article key={m.name} className="glass-soft flex flex-col gap-2 rounded-xl p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-white">{m.name}</h3>
                    <p className="text-[10px] text-slate-500">
                      {m.category}
                      {m.pulls && ` · ${m.pulls} pulls`}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {m.capabilities.filter((c) => c !== "cloud").map((c) => (
                      <GlassBadge key={c} tone="info">
                        {c}
                      </GlassBadge>
                    ))}
                  </div>
                </div>
                <p className="line-clamp-2 text-[11px] text-slate-300">{m.description}</p>
                {tag && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <GlassSelect className="py-1 text-[11px]" value={tag.tag} onChange={(e) => setPicked((p) => ({ ...p, [m.name]: e.target.value }))} aria-label={`${m.name} size`}>
                        {m.tags.map((t) => (
                          <option key={t.tag} value={t.tag}>
                            {t.size}
                            {t.vram_required_gb ? ` · ${t.vram_required_gb} GB` : ""}
                          </option>
                        ))}
                      </GlassSelect>
                      <GlassBadge tone={FIT_TONE[tag.vram_fit]}>{fitLabel(tag.vram_fit, gpu)}</GlassBadge>
                    </div>
                    <p className="text-[10px] text-slate-400 tabular-nums">
                      {tag.params_b != null && `${tag.params_b}B parameters · `}
                      {tag.download_gb != null && `~${tag.download_gb} GB download · `}
                      {tag.vram_required_gb != null && `needs ~${tag.vram_required_gb} GB (Q4)`}
                    </p>
                    {job && job.state !== "done" ? (
                      <PullProgress job={job} />
                    ) : (
                      <GlassButton variant="primary" className="mt-auto" onClick={() => onPull(tag.tag)} disabled={!status.ollama_reachable}>
                        <Download size={12} /> {job?.state === "done" ? "Downloaded · pull again" : "Download Model"}
                      </GlassButton>
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Installed Models ---------------- */

function InstalledModels({ jobs, refreshKey, onChat }: { jobs: PullJob[]; refreshKey: number; onChat: (m: string) => void }) {
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [error, setError] = useState("");
  const [del, setDel] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    api<LocalModel[]>("/ai/models/local")
      .then((m) => (setModels(m), setError("")))
      .catch((e) => setError(e.message));
  }, []);
  usePoll(load, 5000);
  useEffect(load, [load, refreshKey]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const running = jobs.filter((j) => j.state === "running");
  const total = (models ?? []).reduce((a, m) => a + m.size, 0);

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      <Notice error={error} />
      {running.length > 0 && (
        <section className="glass-soft space-y-2 rounded-xl p-3">
          <h3 className="text-xs font-semibold text-white">Downloading</h3>
          {running.map((j) => (
            <div key={j.id}>
              <p className="text-[11px] text-slate-200">{j.model}</p>
              <PullProgress job={j} />
            </div>
          ))}
        </section>
      )}
      {models && (
        <p className="text-[11px] text-slate-400">
          {models.length} model{models.length === 1 ? "" : "s"} · {bytes(total)} on disk
        </p>
      )}
      {models?.length === 0 && <p className="text-sm text-slate-400">No models yet. Download one under Download models.</p>}
      <div className="space-y-1.5">
        {models?.map((m) => (
          <article key={m.name} className="glass-soft flex flex-wrap items-center gap-3 rounded-xl px-3 py-2">
            <BrainCircuit size={18} className={m.loaded ? "text-emerald-300" : "text-slate-500"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-white">{m.name}</h3>
                {m.loaded && <GlassBadge tone="success">In VRAM{m.size_vram ? ` · ${bytes(m.size_vram)}` : ""}</GlassBadge>}
              </div>
              <p className="text-[11px] text-slate-400">
                {[m.family, m.parameter_size, m.quantization, bytes(m.size)].filter(Boolean).join(" · ")}
              </p>
            </div>
            <GlassButton size="xs" onClick={() => onChat(m.name)}>
              <MessageSquare size={12} /> Chat
            </GlassButton>
            {m.loaded && (
              <GlassButton size="xs" disabled={busy === `u${m.name}`} onClick={() => act(`u${m.name}`, () => api("/ai/models/unload", { method: "POST", json: { model: m.name } }))}>
                Unload from VRAM
              </GlassButton>
            )}
            <GlassButton size="xs" variant="danger" onClick={() => setDel(m.name)} aria-label={`Delete ${m.name}`}>
              <Trash2 size={12} />
            </GlassButton>
          </article>
        ))}
      </div>
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title="Delete model"
        message={`Delete ${del} from the AI container? You can download it again later.`}
        confirmLabel="Delete"
        busy={busy === "del"}
        onConfirm={() => del && act("del", () => api(`/ai/models/${encodeURIComponent(del)}`, { method: "DELETE" })).then(() => setDel(null))}
      />
    </div>
  );
}

/* ---------------- Hardware & Performance ---------------- */

function HardwarePerf({ status, reload }: { status: AiStatus; reload: () => void }) {
  const [hw, setHw] = useState<AiHardware | null>(null);
  const [target, setTarget] = useState(status.compute_target ?? "cpu");
  const [flash, setFlash] = useState(status.flash_attention ?? true);
  const [kv, setKv] = useState(status.kv_cache_q8 ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ error: "", notice: "" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<AiHardware>("/ai/hardware").then(setHw).catch((e) => setMsg({ error: e.message, notice: "" }));
  }, []);
  const g = status.gpu;
  const dirty = target !== status.compute_target || flash !== status.flash_attention || kv !== status.kv_cache_q8;

  const apply = async () => {
    setBusy(true);
    setMsg({ error: "", notice: "" });
    try {
      await api("/ai/hardware/switch", { method: "POST", json: { compute_target: target, flash_attention: flash, kv_cache_q8: kv } });
      setMsg({ error: "", notice: "Applied. Ollama restarted with the new settings." });
      reload();
    } catch (e) {
      setMsg({ error: (e as Error).message, notice: "" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      {g ? (
        <section className="glass-soft space-y-3 rounded-xl p-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold text-white">
            <Zap size={14} className="text-emerald-300" /> {g.name}
          </h3>
          <div>
            <div className="mb-1 flex justify-between text-[11px] text-slate-300 tabular-nums">
              <span>VRAM</span>
              <span>
                {((g.vram_used_mib ?? 0) / 1024).toFixed(1)} / {((g.vram_total_mib ?? 0) / 1024).toFixed(0)} GB
              </span>
            </div>
            <Bar value={pct(g.vram_used_mib ?? 0, g.vram_total_mib ?? 0)} tone="bg-violet-400" />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { icon: Gauge, label: "GPU", value: g.util_pct != null ? `${g.util_pct}%` : "–" },
              { icon: Thermometer, label: "Temp", value: g.temp_c != null ? `${g.temp_c} °C` : "–" },
              { icon: Zap, label: "Power", value: g.power_w != null ? `${Math.round(g.power_w)} W` : "–" },
            ].map((x) => (
              <div key={x.label} className="rounded-lg bg-white/5 p-2">
                <x.icon size={14} className="mx-auto text-slate-400" />
                <p className="text-sm font-semibold text-white tabular-nums">{x.value}</p>
                <p className="text-[10px] text-slate-500">{x.label}</p>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <p className="text-[11px] text-slate-400">{status.compute_target === "cpu" ? "Running in CPU mode." : "GPU telemetry is shown for NVIDIA GPUs."}</p>
      )}

      <section className="glass-soft space-y-2 rounded-xl p-3">
        <h3 className="text-xs font-semibold text-white">Active hardware</h3>
        {!hw && <p className="text-[11px] text-slate-400">Detecting hardware…</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {hw?.targets.map((t) => (
            <button
              key={t.id}
              disabled={!t.driver_ready}
              onClick={() => setTarget(t.id)}
              aria-pressed={target === t.id}
              className={`rounded-xl p-2.5 text-left ring-1 transition disabled:opacity-40 ${target === t.id ? "bg-violet-500/20 ring-violet-300/50" : "bg-white/5 ring-white/10 hover:bg-white/10"}`}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-white">
                {t.kind === "cpu" ? <Cpu size={13} /> : <Zap size={13} />} {t.name}
              </span>
              <span className="block text-[10px] text-slate-400">
                {t.vram_total_mb ? `${(t.vram_total_mb / 1024).toFixed(0)} GB VRAM · ` : ""}
                {t.backend}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 pt-1">
          <GlassSwitch checked={flash} onChange={(v) => (setFlash(v), v || setKv(false))} label="Flash Attention" />
          <GlassSwitch checked={kv} disabled={!flash} onChange={setKv} label="KV Cache Quantization (q8_0)" />
        </div>
        <p className="text-[10px] text-slate-500">Switching between GPU and CPU restarts the AI container; toggles only restart Ollama.</p>
        <Notice {...msg} />
        <GlassButton variant="primary" disabled={!dirty || busy} onClick={apply}>
          {busy ? "Applying…" : "Apply"}
        </GlassButton>
      </section>

      <section className="glass-soft space-y-2 rounded-xl p-3">
        <h3 className="text-xs font-semibold text-white">API endpoints</h3>
        {status.openai_url && (
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-black/40 px-2 py-1 text-[11px] text-sky-200">{status.openai_url}</code>
            <GlassButton size="xs" onClick={() => copyText(status.openai_url!).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
              <Copy size={12} /> {copied ? "Copied" : "Copy"}
            </GlassButton>
          </div>
        )}
        <p className="text-[10px] text-slate-500">OpenAI-compatible: use any API key, and an installed model name as the model.</p>
        <p className="text-[11px] text-slate-400">Native Ollama API: {status.ollama_url}</p>
      </section>
    </div>
  );
}

/* ---------------- Local preferences (per browser) ---------------- */

const readPref = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return ""; // private mode / blocked storage
  }
};
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode / blocked storage */
  }
};

/* ---------------- Message formatting ---------------- */

/** `inline code` and **bold**; everything else stays plain text (React escapes it). */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((p, i) =>
        p.length > 2 && p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.92em] text-sky-200">
            {p.slice(1, -1)}
          </code>
        ) : p.length > 4 && p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-white">
            {p.slice(2, -2)}
          </strong>
        ) : (
          p
        ),
      )}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 overflow-hidden rounded-xl bg-black/50 ring-1 ring-white/10">
      <div className="flex items-center justify-between bg-white/5 px-3 py-1 text-[10px] text-slate-400">
        <span>{lang || "code"}</span>
        <button type="button" onClick={() => copyText(code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))} className="flex items-center gap-1 hover:text-white">
          <Copy size={11} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Minimal Markdown without a dependency: fenced code blocks (an unclosed fence while streaming still renders as code). */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const prose = (s: string) => {
    const t = s.replace(/^\n+|\n+$/g, "");
    if (t)
      out.push(
        <p key={out.length} className="whitespace-pre-wrap">
          <Inline text={t} />
        </p>,
      );
  };
  const re = /```([\w+#.-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    prose(text.slice(last, m.index));
    out.push(<CodeBlock key={out.length} lang={m[1]} code={m[2].replace(/\n$/, "")} />);
    last = re.lastIndex;
  }
  prose(text.slice(last));
  return <div className="space-y-2">{out}</div>;
}

/* ---------------- Chat ---------------- */

type Msg = { role: "user" | "assistant"; content: string; thinking?: string; tps?: number | null; tokens?: number; stopped?: boolean };

function ModelPicker({ models, value, onChange, onManage }: { models: LocalModel[]; value: string; onChange: (m: string) => void; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const cur = models.find((m) => m.name === value);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-200 transition hover:bg-white/10">
        <span className="font-medium">{value || "Choose a model"}</span>
        {cur?.parameter_size && <span className="text-slate-500">{cur.parameter_size}</span>}
        <ChevronDown size={12} className="text-slate-400" />
      </button>
      {open && (
        <div role="listbox" aria-label="Model" className="glass-panel absolute right-0 bottom-full z-20 mb-2 w-72 rounded-xl p-1.5">
          {models.length === 0 && <p className="px-2 py-1.5 text-xs text-slate-400">No models installed yet.</p>}
          {models.map((m) => (
            <button
              key={m.name}
              type="button"
              role="option"
              aria-selected={m.name === value}
              onClick={() => (onChange(m.name), setOpen(false))}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/10"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-white">{m.name}</span>
                <span className="block text-[10px] text-slate-400">
                  {[m.parameter_size, m.quantization, bytes(m.size)].filter(Boolean).join(" · ")}
                  {m.loaded && " · in VRAM"}
                </span>
              </span>
              {m.name === value && <Check size={13} className="text-violet-300" />}
            </button>
          ))}
          <div className="my-1 border-t border-white/10" />
          <button type="button" onClick={() => (setOpen(false), onManage())} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-sky-300 hover:bg-white/10">
            <Download size={12} /> Download more models
          </button>
        </div>
      )}
    </div>
  );
}

/** 12 hex chars; getRandomValues also works on plain-http LAN pages, unlike crypto.randomUUID. */
const newChatId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
const chatTitle = (msgs: Msg[]) => (msgs.find((m) => m.role === "user")?.content.split("\n")[0].trim() || "New chat").slice(0, 60);

function ChatView({ status, model, setModel, instructions, visible, activeId, chatKey, onCreated, onSaved, onManage }: {
  status: AiStatus; model: string; setModel: (m: string) => void; instructions: string; visible: boolean;
  activeId: string | null; chatKey: number; onCreated: (id: string) => void; onSaved: () => void; onManage: () => void;
}) {
  const idRef = useRef<string | null>(null); // the conversation on screen
  const [models, setModels] = useState<LocalModel[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  // Refresh the model list whenever the chat comes back into view (models may have been added in Settings).
  useEffect(() => {
    if (!visible) return;
    api<LocalModel[]>("/ai/models/local")
      .then((m) => {
        setModels(m);
        if (!m.some((x) => x.name === model) && m[0]) setModel(m[0].name);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on visibility only
  }, [visible]);
  useEffect(() => () => abort.current?.abort(), []); // closing the app stops a running reply on the GPU
  // Open a saved conversation, or start empty (New chat). A reply still streaming for the previous one is stopped.
  useEffect(() => {
    if (activeId && activeId === idRef.current) return; // this view just created the conversation itself
    abort.current?.abort();
    setError("");
    idRef.current = activeId;
    if (!activeId) {
      setMsgs([]);
      ta.current?.focus();
      return;
    }
    let stop = false;
    api<{ model: string; messages: Msg[] }>(`/ai/chats/${activeId}`)
      .then((c) => {
        if (stop) return;
        setMsgs(c.messages);
        if (!models.length || models.some((m) => m.name === c.model)) setModel(c.model);
      })
      .catch((e) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the selection only
  }, [activeId, chatKey]);
  // Block bodies: scroll methods return a Promise in newer Chrome, which React would call as an effect cleanup.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [msgs, busy]);
  useEffect(() => {
    const t = ta.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 192)}px`;
    }
  }, [input]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !input.trim() || !model) return;
    const next: Msg[] = [...msgs, { role: "user", content: input.trim() }];
    const id = idRef.current ?? newChatId();
    if (!idRef.current) {
      idRef.current = id;
      onCreated(id);
    }
    // Only paint into the conversation that is still on screen (the user may have switched chats meanwhile).
    const show = (m: Msg[]) => idRef.current === id && setMsgs(m);
    show(next);
    setInput("");
    setBusy(true);
    setError("");
    let content = "";
    let thinking = "";
    let final: Msg[] = next;
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        signal: ctl.signal,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, system: instructions.trim() || null, stream: true, messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => null))?.detail;
        throw new Error(typeof detail === "string" ? detail : res.statusText || "Chat failed");
      }
      // NDJSON from the backend: {delta, thinking} chunks, then {done, tokens_per_sec, eval_count} or {error}.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.error) throw new Error(ev.error);
          if (ev.done) {
            final = [...next, { role: "assistant", content, thinking, tps: ev.tokens_per_sec, tokens: ev.eval_count }];
          } else {
            content += ev.delta ?? "";
            thinking += ev.thinking ?? "";
            final = [...next, { role: "assistant", content, thinking }];
          }
          show(final);
        }
      }
    } catch (err) {
      if (ctl.signal.aborted) {
        // Keep what arrived; an empty reply leaves just the question.
        final = content || thinking ? [...next, { role: "assistant", content, thinking, stopped: true }] : next;
        show(final);
      } else if (idRef.current === id) {
        setError((err as Error).message);
      }
    } finally {
      if (abort.current === ctl) abort.current = null;
      setBusy(false);
      // Save after every reply, stopped or failed ones too, so the question is never lost.
      api(`/ai/chats/${id}`, {
        method: "PUT",
        json: { title: chatTitle(final), model, messages: final.map((m) => ({ ...m, thinking: m.thinking || undefined })) },
      })
        .then(onSaved)
        .catch(() => {}); // history is a convenience; the conversation stays on screen either way
    }
  };

  const composer = (
    <form onSubmit={send} className="glass-soft rounded-2xl px-3 pt-2.5 pb-2 ring-1 ring-white/10 transition focus-within:ring-violet-300/40">
      <textarea
        ref={ta}
        rows={1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={model ? `Message ${model}` : "Download a model in Settings to start chatting"}
        aria-label="Message"
        className="block max-h-48 w-full resize-none bg-transparent px-1 text-sm text-white placeholder:text-slate-500 focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <ModelPicker models={models} value={model} onChange={setModel} onManage={onManage} />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} aria-label="Stop" title="Stop" className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 transition hover:bg-slate-200">
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" aria-label="Send" title="Send (Enter)" disabled={!model || !input.trim()} className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-500 text-white transition hover:bg-violet-400 disabled:opacity-30">
            <ArrowUp size={16} />
          </button>
        )}
      </div>
    </form>
  );

  if (msgs.length === 0)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
        <div className="text-center">
          <BrainCircuit size={32} className="mx-auto text-violet-300" />
          <h2 className="mt-3 text-xl font-semibold text-white">What can I help with?</h2>
          <p className="mt-1 text-xs text-slate-400">
            Runs privately on your {status.compute_target === "cpu" ? "CPU" : shortGpu(status.gpu_name)}. Nothing you type leaves your server.
          </p>
        </div>
        <div className="w-full max-w-2xl space-y-2">
          {composer}
          <Notice error={error} />
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div ref={box} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-5">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-auto w-fit max-w-[80%] rounded-2xl bg-white/10 px-4 py-2.5 text-sm whitespace-pre-wrap text-white">
                {m.content}
              </div>
            ) : (
              <div key={i} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/25 ring-1 ring-violet-300/30">
                  <BrainCircuit size={14} className="text-violet-200" />
                </span>
                <div className="min-w-0 flex-1 text-sm leading-relaxed text-slate-100">
                  {m.thinking && (
                    <details open={!m.content} className="mb-2 rounded-lg bg-black/25 px-3 py-1.5 text-[12px] text-slate-400">
                      <summary className="cursor-pointer select-none">{m.content ? "Thought process" : "Thinking…"}</summary>
                      <p className="mt-1 whitespace-pre-wrap">{m.thinking}</p>
                    </details>
                  )}
                  <Markdown text={m.content} />
                  {(m.tps != null || m.stopped) && (
                    <div className="mt-2 flex items-center gap-2">
                      {m.tps != null && (
                        <GlassBadge tone="success">
                          <Zap size={10} /> {m.tps} tokens/sec · {m.tokens} tokens
                        </GlassBadge>
                      )}
                      {m.stopped && <GlassBadge tone="warning">Stopped</GlassBadge>}
                      <button type="button" onClick={() => copyText(m.content)} className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200" aria-label="Copy reply" title="Copy reply">
                        <Copy size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {busy && msgs[msgs.length - 1]?.role === "user" && (
            <p className="pl-10 text-[12px] text-slate-400">Loading the model and generating… (a large model can take up to a minute the first time)</p>
          )}
          <Notice error={error} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
    </div>
  );
}

/* ---------------- Settings ---------------- */

function StorageSettings({ status, reload }: { status: AiStatus; reload: () => void }) {
  const [path, setPath] = useState(status.model_storage ?? "/mnt/storage/ai-models");
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ error: "", notice: "" });
  const valid = /^\/(mnt|srv)(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/.test(path);
  const changed = path !== status.model_storage;

  const apply = async () => {
    setBusy(true);
    setMsg({ error: "", notice: "" });
    try {
      const r = await api<{ models_bytes: number | null }>("/ai/storage", { method: "POST", json: { path, move } });
      setMsg({ error: "", notice: `Models are now stored in ${path}${r.models_bytes != null ? ` (${bytes(r.models_bytes)})` : ""}.` });
      reload();
    } catch (e) {
      setMsg({ error: (e as Error).message, notice: "" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      <section className="glass-soft space-y-3 rounded-xl p-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-white">
          <HardDrive size={14} /> Model storage location
        </h3>
        <p className="text-[11px] text-slate-400">
          Current: <span className="font-mono text-slate-200">{status.model_storage ?? "inside the AI container's own disk"}</span>
        </p>
        <label className="block text-[11px] text-slate-400">
          Folder on the host (below /mnt or /srv)
          <GlassInput className="mt-1 w-full py-1.5 font-mono text-xs" value={path} onChange={(e) => setPath(e.target.value.trim())} placeholder="/mnt/storage/ai-models" aria-label="Model storage folder" />
        </label>
        {!valid && <p className="text-[11px] text-amber-300">Use a folder below /mnt or /srv, for example /mnt/tank/ai-models.</p>}
        <GlassSwitch checked={move} onChange={setMove} disabled={!status.model_storage} label="Move my downloaded models to the new folder" />
        <p className="text-[10px] text-slate-500">
          The AI container restarts. Moving to another disk copies every model first, which can take several minutes for large models.
          {!status.model_storage && " Models inside the container's own disk can't be moved; download them again afterwards."}
        </p>
        <Notice {...msg} />
        <GlassButton variant="primary" disabled={!valid || !changed || busy} onClick={apply}>
          {busy ? (move ? "Moving models and restarting…" : "Restarting…") : "Change location"}
        </GlassButton>
      </section>
    </div>
  );
}

function ChatSettings({ instructions, setInstructions }: { instructions: string; setInstructions: (v: string) => void }) {
  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      <section className="glass-soft space-y-2 rounded-xl p-3">
        <h3 className="text-xs font-semibold text-white">Custom instructions</h3>
        <p className="text-[11px] text-slate-400">Sent with every chat as the system prompt, for example your language, tone or role.</p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={6}
          maxLength={20000}
          placeholder="Always answer in Dutch. Be concise and show PowerShell examples when relevant."
          aria-label="Custom instructions"
          className="glass-field w-full resize-y p-2 text-xs"
        />
        <p className="text-[10px] text-slate-500">Saved in this browser.</p>
      </section>
    </div>
  );
}

type SettingsTab = "download" | "installed" | "hardware" | "storage" | "chat";

/* ---------------- Conversation list ---------------- */

type ChatSummary = { id: string; title: string; model: string; updated: number; messages: number; snippet?: string | null };

/** Today / Yesterday / Previous 7 days / Older, newest first (the API already sorts by `updated`). */
function groupChats(chats: ChatSummary[]): [string, ChatSummary[]][] {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const today = day.getTime() / 1000;
  const label = (t: number) => (t >= today ? "Today" : t >= today - 86400 ? "Yesterday" : t >= today - 7 * 86400 ? "Previous 7 days" : "Older");
  const groups = new Map<string, ChatSummary[]>();
  for (const c of chats) groups.set(label(c.updated), [...(groups.get(label(c.updated)) ?? []), c]);
  return [...groups];
}

const ROW_ICON = "rounded p-1 text-slate-500 opacity-0 transition group-hover:opacity-100 focus:opacity-100";

/** One conversation in the sidebar: click to open, double-click or the pencil to rename inline. */
function ChatRow({ c, active, onSelect, onRename, onDelete }: {
  c: ChatSummary; active: boolean; onSelect: (id: string) => void; onRename: (c: ChatSummary, title: string) => void; onDelete: (c: ChatSummary) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const settled = useRef(false); // Enter (or Escape) followed by the input's blur must not act twice
  const start = () => {
    setTitle(c.title);
    settled.current = false;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const t = title.trim();
    if (save && t && t !== c.title) onRename(c, t);
  };
  if (editing)
    return (
      <div className="rounded-lg bg-white/10 p-0.5">
        <input
          autoFocus
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              finish(e.key === "Enter");
            }
          }}
          onBlur={() => finish(true)}
          aria-label="Conversation name"
          className="glass-field w-full px-1.5 py-1 text-xs"
        />
      </div>
    );
  return (
    <div className={`group flex items-center rounded-lg ${active ? "bg-white/10" : "hover:bg-white/5"}`}>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        onDoubleClick={start}
        aria-current={active}
        title={`${c.title}\n${c.model} · ${c.messages} messages · double-click to rename`}
        className="min-w-0 flex-1 px-2 py-1.5 text-left"
      >
        <span className={`block truncate text-xs ${active ? "text-white" : "text-slate-300"}`}>{c.title}</span>
        {c.snippet && <span className="block truncate text-[10px] text-slate-500">{c.snippet}</span>}
      </button>
      <button type="button" onClick={start} aria-label={`Rename ${c.title}`} title="Rename" className={`${ROW_ICON} hover:text-sky-300`}>
        <Pencil size={12} />
      </button>
      <button type="button" onClick={() => onDelete(c)} aria-label={`Delete ${c.title}`} title="Delete conversation" className={`mr-1 ${ROW_ICON} hover:text-rose-300`}>
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function ChatList({ chats, activeId, query, onQuery, onSelect, onNew, onRename, onDelete }: {
  chats: ChatSummary[]; activeId: string | null; query: string; onQuery: (q: string) => void; onSelect: (id: string) => void;
  onNew: () => void; onRename: (c: ChatSummary, title: string) => void; onDelete: (c: ChatSummary) => void;
}) {
  const [q, setQ] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => onQuery(q.trim()), 250); // the server searches every message; don't ask on each key
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onQuery is a state setter
  }, [q]);
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-black/15 max-sm:w-48">
      <div className="space-y-2 p-2">
        <GlassButton className="w-full justify-start" onClick={onNew}>
          <SquarePen size={13} /> New chat
        </GlassButton>
        <label className="relative block">
          <Search size={12} className="absolute top-1/2 left-2 -translate-y-1/2 text-slate-500" />
          <GlassInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="w-full py-1.5 pl-7 text-xs" />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-auto px-2 pb-2" aria-label="Previous conversations">
        {chats.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-slate-500">{query ? `No conversations contain "${query}".` : "Your conversations will appear here."}</p>
        )}
        {query && chats.length > 0 && (
          <p className="px-2 pt-1 text-[10px] text-slate-500">
            {chats.length} result{chats.length === 1 ? "" : "s"}
          </p>
        )}
        {groupChats(chats).map(([label, items]) => (
          <div key={label} className="mb-2">
            <p className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
            {items.map((c) => (
              <ChatRow key={c.id} c={c} active={c.id === activeId} onSelect={onSelect} onRename={onRename} onDelete={onDelete} />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/* ---------------- Shell ---------------- */

export default function LocalAiApp() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [tab, setTab] = useState<SettingsTab>("download");
  const [jobs, setJobs] = useState<PullJob[]>([]);
  const [model, setModelState] = useState(() => readPref("solardeck-ai-model"));
  const [instructions, setInstructionsState] = useState(() => readPref("solardeck-ai-instructions"));
  const [chatKey, setChatKey] = useState(0);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebar, setSidebarState] = useState(() => readPref("solardeck-ai-sidebar") !== "0");
  const [del, setDel] = useState<ChatSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const open = useWindows((s) => s.open);
  const setModel = (m: string) => (setModelState(m), writePref("solardeck-ai-model", m));
  const setInstructions = (v: string) => (setInstructionsState(v), writePref("solardeck-ai-instructions", v));
  const setSidebar = (v: boolean) => (setSidebarState(v), writePref("solardeck-ai-sidebar", v ? "1" : "0"));
  const newChat = () => (setActiveId(null), setChatKey((k) => k + 1), setView("chat"));
  const [chatQuery, setChatQuery] = useState("");
  const loadChats = useCallback(() => {
    api<ChatSummary[]>(`/ai/chats${chatQuery ? `?q=${encodeURIComponent(chatQuery)}` : ""}`).then(setChats).catch(() => {});
  }, [chatQuery]);
  const renameChat = (c: ChatSummary, title: string) => {
    setChats((cs) => cs.map((x) => (x.id === c.id ? { ...x, title } : x))); // show the new name right away
    api(`/ai/chats/${c.id}`, { method: "PATCH", json: { title } })
      .then(loadChats)
      .catch((e) => (setError(e.message), loadChats()));
  };
  const installed = !!status?.installed;
  useEffect(() => {
    if (installed) loadChats();
  }, [installed, loadChats]);
  const deleteChat = async () => {
    if (!del) return;
    setDeleting(true);
    try {
      await api(`/ai/chats/${del.id}`, { method: "DELETE" });
      if (del.id === activeId) newChat();
      loadChats();
      setDel(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const loadStatus = useCallback(() => {
    api<AiStatus>("/ai/status")
      .then((s) => (setStatus(s), setError("")))
      .catch((e) => setError(e.message));
  }, []);
  usePoll(loadStatus, 5000);
  const loadJobs = useCallback(() => {
    if (!status?.installed) return;
    api<PullJob[]>("/ai/models/pull").then(setJobs).catch(() => {});
  }, [status?.installed]);
  usePoll(loadJobs, 2000);
  const finished = useMemo(() => jobs.filter((j) => j.state === "done").length, [jobs]);

  const pull = (m: string) =>
    api<PullJob>("/ai/models/pull", { method: "POST", json: { model: m } })
      .then((j) => setJobs((cur) => [j, ...cur.filter((x) => x.id !== j.id)]))
      .catch((e) => setError(e.message));
  const settings = (t: SettingsTab) => (setTab(t), setView("settings"));

  if (!status) return <div className="p-4 text-sm text-slate-400">{error || "Loading…"}</div>;
  if (!status.installed)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <BrainCircuit size={40} className="text-violet-300" />
        <h2 className="text-base font-semibold text-white">Local AI Studio is not installed</h2>
        <p className="max-w-md text-xs text-slate-400">
          {status.missing_vmid
            ? `Container ${status.missing_vmid} no longer exists. Install Local AI Studio again from App Center.`
            : "Install Local AI Studio (Ollama + Open WebUI) from App Center. You can pick your NVIDIA GPU, Intel/AMD graphics or CPU during setup."}
        </p>
        <GlassButton variant="primary" onClick={() => open("appcenter")}>
          Open App Center
        </GlassButton>
      </div>
    );

  const downloading = jobs.filter((j) => j.state === "running").length;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        {view === "chat" ? (
          <>
            <GlassButton size="xs" variant="ghost" onClick={() => setSidebar(!sidebar)} aria-label={sidebar ? "Hide conversations" : "Show conversations"} title={sidebar ? "Hide conversations" : "Show conversations"}>
              <PanelLeft size={14} />
            </GlassButton>
            {!sidebar && (
              <GlassButton size="xs" variant="ghost" onClick={newChat} title="Start a new chat">
                <SquarePen size={13} /> New chat
              </GlassButton>
            )}
          </>
        ) : (
          <>
            <GlassButton size="xs" variant="ghost" onClick={() => setView("chat")}>
              <ArrowLeft size={13} /> Back to chat
            </GlassButton>
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { id: "download", label: "Download models" },
                { id: "installed", label: "Installed models" },
                { id: "hardware", label: "Hardware" },
                { id: "storage", label: "Storage" },
                { id: "chat", label: "Chat" },
              ]}
            />
          </>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <GlassBadge tone={status.running && status.ollama_reachable ? "success" : status.running ? "warning" : "danger"}>
            {status.running ? (status.ollama_reachable ? `Ollama ${status.ollama_version ?? ""}` : "Ollama starting…") : "Container stopped"}
          </GlassBadge>
          <GlassBadge tone="info">{status.compute_target === "cpu" ? "CPU" : shortGpu(status.gpu_name) || status.compute_target}</GlassBadge>
          {downloading > 0 && (
            <button type="button" onClick={() => settings("installed")} className="text-[11px] text-sky-300 hover:underline">
              Downloading {downloading}…
            </button>
          )}
          {status.webui_url && (
            <a className="inline-flex items-center gap-1 text-[11px] text-sky-300 hover:underline" href={status.webui_url} target="_blank" rel="noreferrer">
              Open WebUI <ExternalLink size={11} />
            </a>
          )}
          {view === "chat" && (
            <GlassButton size="xs" variant="ghost" onClick={() => setView("settings")} aria-label="Settings" title="Models, hardware and storage">
              <SettingsIcon size={14} /> Settings
            </GlassButton>
          )}
        </span>
      </div>
      {error && <div className="bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>}
      {/* The chat stays mounted while Settings is open, so the conversation survives a trip to Settings. */}
      <div className={`min-h-0 flex-1 ${view === "chat" ? "flex" : "hidden"}`}>
        {sidebar && (
          <ChatList chats={chats} activeId={activeId} query={chatQuery} onQuery={setChatQuery} onSelect={setActiveId} onNew={newChat} onRename={renameChat} onDelete={setDel} />
        )}
        <div className="min-w-0 flex-1">
          <ChatView
            status={status}
            model={model}
            setModel={setModel}
            instructions={instructions}
            visible={view === "chat"}
            activeId={activeId}
            chatKey={chatKey}
            onCreated={setActiveId}
            onSaved={loadChats}
            onManage={() => settings("download")}
          />
        </div>
      </div>
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title="Delete conversation"
        message={`Delete "${del?.title}"? This can't be undone.`}
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={deleteChat}
      />
      {view === "settings" && (
        <div className="min-h-0 flex-1">
          {tab === "download" && <OnlineModels status={status} jobs={jobs} onPull={pull} />}
          {tab === "installed" && <InstalledModels jobs={jobs} refreshKey={finished} onChat={(m) => (setModel(m), newChat())} />}
          {tab === "hardware" && <HardwarePerf status={status} reload={loadStatus} />}
          {tab === "storage" && <StorageSettings status={status} reload={loadStatus} />}
          {tab === "chat" && <ChatSettings instructions={instructions} setInstructions={setInstructions} />}
        </div>
      )}
    </div>
  );
}
