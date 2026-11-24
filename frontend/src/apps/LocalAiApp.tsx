import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BrainCircuit, Copy, Cpu, Download, ExternalLink, Gauge, MessageSquare, Search, Send, Thermometer, Trash2, Zap } from "lucide-react";
import { api } from "../lib/api";
import { bytes, copyText, pct } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { useWindows } from "../lib/stores";
import type { AiHardware, AiStatus, LocalModel, OnlineModel, PullJob, VramFit } from "../lib/types";
import { ConfirmModal, GlassBadge, GlassButton, GlassInput, GlassSelect, GlassSwitch, Notice, Segmented } from "../components/ui/GlassKit";

type Tab = "online" | "installed" | "hardware" | "chat";
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
      {models?.length === 0 && <p className="text-sm text-slate-400">No models yet. Download one from Online Models.</p>}
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
        {status.model_storage && <p className="text-[11px] text-slate-400">Models stored on {status.model_storage}</p>}
      </section>
    </div>
  );
}

/* ---------------- Playground Chat ---------------- */

type Msg = { role: "user" | "assistant"; content: string; tps?: number | null; tokens?: number };

function Playground({ initial }: { initial: string }) {
  const [models, setModels] = useState<LocalModel[]>([]);
  const [model, setModel] = useState(initial);
  const [system, setSystem] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api<LocalModel[]>("/ai/models/local")
      .then((m) => (setModels(m), setModel((cur) => cur || m[0]?.name || "")))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs.length, busy]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !model) return;
    const next: Msg[] = [...msgs, { role: "user", content: input.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const r = await api<{ text: string; tokens_per_sec: number | null; eval_count: number }>("/ai/chat", {
        method: "POST",
        json: { model, system: system || null, messages: next.map(({ role, content }) => ({ role, content })) },
      });
      setMsgs([...next, { role: "assistant", content: r.text, tps: r.tokens_per_sec, tokens: r.eval_count }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
        <GlassSelect className="py-1.5 text-xs" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          {models.length === 0 && <option value="">No models installed</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </GlassSelect>
        <GlassInput className="min-w-0 flex-1 py-1.5 text-xs" placeholder="System prompt (optional), e.g. You are a concise senior engineer." value={system} onChange={(e) => setSystem(e.target.value)} aria-label="System prompt" />
        <GlassButton size="xs" variant="ghost" onClick={() => setMsgs([])} disabled={!msgs.length}>
          Clear
        </GlassButton>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {msgs.length === 0 && <p className="text-sm text-slate-400">Ask anything to test the model. The first reply also loads it into memory.</p>}
        {msgs.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-xl px-3 py-2 text-xs whitespace-pre-wrap ${m.role === "user" ? "ml-auto bg-violet-500/25 text-white" : "glass-soft text-slate-100"}`}>
            {m.content}
            {m.role === "assistant" && m.tps != null && (
              <div className="mt-1.5">
                <GlassBadge tone="success">
                  <Zap size={10} /> {m.tps} tokens/sec · {m.tokens} tokens
                </GlassBadge>
              </div>
            )}
          </div>
        ))}
        {busy && <p className="text-[11px] text-slate-400">Generating…</p>}
        <Notice error={error} />
        <div ref={end} />
      </div>
      <form onSubmit={send} className="flex gap-2 border-t border-white/10 p-3">
        <GlassInput className="flex-1 py-2 text-xs" placeholder="Message" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Message" disabled={busy} />
        <GlassButton type="submit" variant="primary" disabled={busy || !model || !input.trim()}>
          <Send size={12} /> Send
        </GlassButton>
      </form>
    </div>
  );
}

/* ---------------- Shell ---------------- */

export default function LocalAiApp() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("online");
  const [jobs, setJobs] = useState<PullJob[]>([]);
  const [chatModel, setChatModel] = useState("");
  const open = useWindows((s) => s.open);

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

  const pull = (model: string) =>
    api<PullJob>("/ai/models/pull", { method: "POST", json: { model } })
      .then((j) => setJobs((cur) => [j, ...cur.filter((x) => x.id !== j.id)]))
      .catch((e) => setError(e.message));

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { id: "online", label: "Online Models" },
            { id: "installed", label: "Installed Models" },
            { id: "hardware", label: "Hardware & Performance" },
            { id: "chat", label: "Playground Chat" },
          ]}
        />
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <GlassBadge tone={status.running && status.ollama_reachable ? "success" : status.running ? "warning" : "danger"}>
            {status.running ? (status.ollama_reachable ? `Ollama ${status.ollama_version ?? ""}` : "Ollama starting…") : "Container stopped"}
          </GlassBadge>
          <GlassBadge tone="info">{status.compute_target === "cpu" ? "CPU" : shortGpu(status.gpu_name) || status.compute_target}</GlassBadge>
          {status.webui_url && (
            <a className="inline-flex items-center gap-1 text-[11px] text-sky-300 hover:underline" href={status.webui_url} target="_blank" rel="noreferrer">
              Open WebUI <ExternalLink size={11} />
            </a>
          )}
        </span>
      </div>
      {error && <div className="bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>}
      <div className="min-h-0 flex-1">
        {tab === "online" && <OnlineModels status={status} jobs={jobs} onPull={pull} />}
        {tab === "installed" && <InstalledModels jobs={jobs} refreshKey={finished} onChat={(m) => (setChatModel(m), setTab("chat"))} />}
        {tab === "hardware" && <HardwarePerf status={status} reload={loadStatus} />}
        {tab === "chat" && <Playground key={chatModel} initial={chatModel} />}
      </div>
    </div>
  );
}
