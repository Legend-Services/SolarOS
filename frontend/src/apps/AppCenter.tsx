import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BrainCircuit, Clapperboard, Container, Cpu, ExternalLink, FolderTree, HardDrive, Images, LayoutGrid, Network, Package,
  Search, Server, Settings2, ShieldCheck, Sparkles, Trash2, Waypoints, X, Zap, type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import type { AiHardware, AppInstance, CatalogApp, Deployment, JobProgress } from "../lib/types";
import { usePoll } from "../lib/hooks";
import { useTranslation } from "../i18n";
import { OperationProgressCard } from "../components/ui/OperationProgressCard";
import { TaskLog } from "../components/TaskCenter";
import { ViewToggle } from "../components/ViewOptions";
import { useAppView } from "../store/layoutStore";
import { GlassButton, GlassInput, GlassModal } from "../components/ui/GlassKit";
import { OsiButton } from "../components/osi/OsiArchitecturePanel";
import { osiValues } from "../data/osiModelRegistry";

/** OSI target of a catalog app: its container veth, mapped web port, TLS and web interface. */
const appOsi = (a: CatalogApp) => ({
  kind: "app_instance" as const,
  name: a.name,
  values: osiValues({ model: "veth", ports: a.web_port ? [`TCP ${a.web_port}`] : [], tls: a.web_scheme === "https" ? "TLS (HTTPS)" : null, app: a.web_port ? `${a.web_scheme.toUpperCase()} Web UI` : null }),
});
import {
  ManageInstancesModal, NATIVE_FEATURES, UninstallInstanceModal, appsChanged, displayName, hostnameFor, onAppsChanged, useAppInstances,
} from "../components/AppInstances";

const ICONS: Record<string, LucideIcon> = { Clapperboard, Container, FolderTree, ShieldCheck, Waypoints, Images, BrainCircuit };

const CATEGORIES: { id: string; label: string; icon: LucideIcon; color: string }[] = [
  { id: "all", label: "All Apps", icon: LayoutGrid, color: "" },
  { id: "Media", label: "Media", icon: Clapperboard, color: "from-pink-400 to-rose-600" },
  { id: "Infrastructure", label: "Infrastructure", icon: Server, color: "from-sky-400 to-blue-600" },
  { id: "Network", label: "Network", icon: Network, color: "from-emerald-300 to-teal-600" },
  { id: "AI & Compute", label: "AI & Compute", icon: Cpu, color: "from-violet-400 to-fuchsia-600" },
];

function AppIcon({ app, size = 22 }: { app: CatalogApp; size?: number }) {
  const Icon = ICONS[app.icon] ?? Package;
  const color = CATEGORIES.find((c) => c.id === app.category)?.color || "from-slate-400 to-slate-600";
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-lg ${color}`} style={{ width: size * 2, height: size * 2 }}>
      <Icon size={size} className="text-white" />
    </span>
  );
}

function Progress({ app, vmid, upid, onClose }: { app: CatalogApp; vmid: number; upid: string; onClose: () => void }) {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [error, setError] = useState("");
  const { t } = useTranslation();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stop = false;
    const tick = () =>
      api<Deployment>(`/apps/deployments/${vmid}`)
        .then((d) => {
          if (stop) return;
          setDep(d);
          if (d.phase !== "done" && d.phase !== "error") timer = setTimeout(tick, 2000);
        })
        .catch((e) => !stop && setError(e.message));
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [vmid]);

  const url = dep?.ip && dep.web_port ? `${dep.web_scheme}://${dep.ip}:${dep.web_port}` : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <AppIcon app={app} size={18} />
        <div>
          <h3 className="text-sm font-semibold text-white">{t("progress.title.appInstall", { name: app.name })}</h3>
          <p className="text-[11px] text-slate-400">Container {vmid}</p>
        </div>
      </div>
      {dep && <OperationProgressCard title={app.name} progress={dep.progress} onDismiss={onClose} />}
      <details className="text-[11px] text-slate-400">
        <summary className="cursor-pointer select-none hover:text-slate-200">{t("progress.hostTask")}</summary>
        <TaskLog upid={upid} className="mt-1 h-28" />
      </details>
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex justify-end gap-2">
        {url && (
          <a className="btn border-sky-400/40 bg-sky-500/20" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Open {app.name}
          </a>
        )}
        <button className="btn" onClick={onClose}>
          {dep?.phase === "done" || dep?.phase === "error" ? "Close" : "Run in background"}
        </button>
      </div>
    </div>
  );
}

const STARTER_MODELS = [
  { tag: "llama3.1:8b", label: "Llama 3.1 8B", note: "Fast everyday assistant · 4.9 GB" },
  { tag: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B", note: "Coding · 9 GB" },
  { tag: "deepseek-r1:14b", label: "DeepSeek R1 14B", note: "Step-by-step reasoning · 9 GB" },
  { tag: "gemma3:12b", label: "Gemma 3 12B", note: "Vision + chat · 8.1 GB" },
  { tag: "nomic-embed-text", label: "Nomic Embed Text", note: "Document search (RAG) · 274 MB" },
];

/** Compute Hardware Selector for Local AI Studio: one card per detected GPU / CPU from GET /api/ai/hardware. */
function ComputeSelector({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [hw, setHw] = useState<AiHardware | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api<AiHardware>("/ai/hardware")
      .then((h) => {
        setHw(h);
        if (!value) onChange(h.default);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detect once when the drawer opens
  }, []);

  const prepare = async (action: string, gpu: string) => {
    setError("");
    try {
      await api(`/hardware/gpu-drivers/${action}`, { method: "POST", json: { gpu } });
      setNotice("Host driver job started. Follow it in Settings → Hardware, GPU & BIOS → GPU & Drivers; reboot the host if it asks, then reopen this installer.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[11px] text-slate-400">Compute hardware</legend>
      {!hw && !error && <p className="text-[11px] text-slate-400">Detecting GPUs and CPU…</p>}
      {hw && !hw.ssh_bridge_connected && <p className="text-[11px] text-amber-300">Host SSH bridge offline: only CPU mode is available ({hw.message}).</p>}
      {hw?.targets.map((t) => {
        const selected = value === t.id;
        return (
          <div
            key={t.id}
            role="radio"
            aria-checked={selected}
            aria-disabled={!t.driver_ready}
            tabIndex={t.driver_ready ? 0 : -1}
            onClick={() => t.driver_ready && onChange(t.id)}
            onKeyDown={(e) => (e.key === " " || e.key === "Enter") && t.driver_ready && (e.preventDefault(), onChange(t.id))}
            className={`rounded-xl p-2.5 ring-1 transition ${t.driver_ready ? "cursor-pointer" : "opacity-80"} ${
              selected ? "bg-violet-500/20 ring-violet-300/60" : "bg-white/5 ring-white/10 hover:bg-white/10"
            }`}
          >
            <div className="flex items-center gap-2">
              {t.kind === "cpu" ? <Cpu size={15} className="text-slate-300" /> : <Zap size={15} className={t.kind === "nvidia" ? "text-emerald-300" : "text-sky-300"} />}
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
                {t.name}
                {t.vram_total_mb ? ` — ${(t.vram_total_mb / 1024).toFixed(0)} GB VRAM` : t.kind === "cpu" && t.ram_total_mb ? ` — ${t.threads ?? "?"} threads, ${Math.round(t.ram_total_mb / 1024)} GB RAM` : ""}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${t.driver_ready ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>
                {t.kind === "cpu" ? "Ready" : t.driver_ready ? `Driver ${t.driver_version ?? "ready"}` : t.driver === "vfio-pci" ? "Bound to VM passthrough" : "Driver missing"}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-slate-400">
              {t.backend} · {t.recommendation}
            </p>
            {t.prepare && (
              <button
                type="button"
                className="btn mt-1.5 border-amber-400/40 bg-amber-500/20 py-1 text-[11px] text-amber-100"
                onClick={(e) => (e.stopPropagation(), prepare(t.prepare!.action, t.prepare!.gpu))}
              >
                {t.prepare.action === "mode-host" ? "Switch GPU back to host mode" : "Prepare host NVIDIA driver"}
              </button>
            )}
          </div>
        );
      })}
      {notice && <p className="text-[11px] text-emerald-300">{notice}</p>}
      {error && <p className="text-[11px] text-rose-300">{error}</p>}
    </fieldset>
  );
}

function InstallDrawer({ app, label = "", autoStart = false, onClose }: { app: CatalogApp; label?: string; autoStart?: boolean; onClose: (deployed: boolean) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    hostname: hostnameFor(app.id, label),
    cores: app.cores,
    memory: app.memory_mb,
    disk_gb: app.disk_gb,
    net: "dhcp" as "dhcp" | "static",
    cidr: "",
    gateway: "",
    mount_storage: app.supports_storage_mount || !!app.compute_selector,
    enable_igpu: app.supports_igpu,
    compute_target: "",
    install_open_webui: true,
    starter_models: [] as string[],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<{ vmid: number; upid: string } | null>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const deploy = async () => {
    setBusy(true);
    setError("");
    try {
      setJob(
        await api<{ vmid: number; upid: string }>("/apps/deploy", {
          method: "POST",
          json: {
            app_id: app.id,
            instance_label: label,
            hostname: form.hostname,
            cores: form.cores,
            memory: form.memory,
            disk_gb: form.disk_gb,
            ip_config: form.net === "dhcp" ? "dhcp" : { cidr: form.cidr, gateway: form.gateway },
            mount_storage: form.mount_storage,
            enable_igpu: form.enable_igpu,
            ...(app.compute_selector && {
              compute_target: form.compute_target || "cpu",
              install_open_webui: form.install_open_webui,
              starter_models: form.starter_models,
            }),
          },
        }),
      );
      appsChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    deploy();
  };
  const started = useRef(false);
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      deploy();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once when opened from the naming dialog
  }, []);

  const num = (k: "cores" | "memory" | "disk_gb", label: string, min: number, max: number, step = 1) => (
    <label className="block text-[11px] text-slate-400">
      {label}
      <input type="number" className="input mt-1 w-full py-1.5 text-xs" min={min} max={max} step={step} value={form[k]} onChange={(e) => set(k, Number(e.target.value))} required />
    </label>
  );

  return (
    <div className="absolute inset-0 z-10 flex justify-end bg-black/50 backdrop-blur-sm" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose(!!job)}>
      <div className="glass flex h-full w-full max-w-md flex-col overflow-auto border-y-0 border-r-0 p-4" role="dialog" aria-label={`Install ${app.name}`}>
        <button className="absolute top-3 right-3 rounded p-1 text-slate-400 hover:bg-white/10" onClick={() => onClose(!!job)} aria-label="Close" disabled={busy}>
          <X size={16} />
        </button>
        {job ? (
          <Progress app={app} vmid={job.vmid} upid={job.upid} onClose={() => onClose(true)} />
        ) : autoStart && !error ? (
          <p className="text-xs text-slate-400">{t("inst.preparing")}</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex items-center gap-3">
              <AppIcon app={app} size={18} />
              <div>
                <h3 className="text-sm font-semibold break-words text-white">{t("progress.title.appInstall", { name: displayName(app.name, label) })}</h3>
                <p className="text-[11px] text-slate-400">Unprivileged Debian 12 LXC · nesting enabled</p>
              </div>
            </div>
            <label className="block text-[11px] text-slate-400">
              Hostname
              <input
                className="input mt-1 w-full py-1.5 text-xs"
                value={form.hostname}
                onChange={(e) => set("hostname", e.target.value.toLowerCase())}
                pattern="[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?"
                title="Lowercase letters, digits and hyphens"
                required
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              {num("cores", "CPU cores", 1, 64)}
              {num("memory", "Memory (MB)", 256, 262144, 256)}
              {num("disk_gb", "Disk (GB)", 2, 4096)}
            </div>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[11px] text-slate-400">Network</legend>
              <div className="flex rounded-lg bg-black/30 p-0.5 text-xs" role="radiogroup">
                {(["dhcp", "static"] as const).map((n) => (
                  <button
                    type="button"
                    key={n}
                    role="radio"
                    aria-checked={form.net === n}
                    onClick={() => set("net", n)}
                    className={`flex-1 rounded-md py-1 ${form.net === n ? "bg-white/15 text-white" : "text-slate-400"}`}
                  >
                    {n === "dhcp" ? "DHCP" : "Static IP"}
                  </button>
                ))}
              </div>
              {form.net === "static" && (
                <div className="grid grid-cols-2 gap-2">
                  <input className="input py-1.5 text-xs" placeholder="192.168.1.50/24" value={form.cidr} onChange={(e) => set("cidr", e.target.value)} aria-label="IP address with prefix" required />
                  <input className="input py-1.5 text-xs" placeholder="Gateway 192.168.1.1" value={form.gateway} onChange={(e) => set("gateway", e.target.value)} aria-label="Gateway" required />
                </div>
              )}
            </fieldset>
            {app.compute_selector && (
              <>
                <ComputeSelector value={form.compute_target} onChange={(id) => set("compute_target", id)} />
                <label className="flex items-start gap-2 rounded-lg bg-white/5 p-2.5 text-xs text-slate-200">
                  <input type="checkbox" className="mt-0.5" checked={form.mount_storage} onChange={(e) => set("mount_storage", e.target.checked)} />
                  <span>
                    <span className="flex items-center gap-1">
                      <HardDrive size={12} /> Store models on ZFS (/mnt/storage/ai-models)
                    </span>
                    <span className="block text-[11px] text-slate-400">Models survive reinstalls and do not fill the container disk.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg bg-white/5 p-2.5 text-xs text-slate-200">
                  <input type="checkbox" className="mt-0.5" checked={form.install_open_webui} onChange={(e) => set("install_open_webui", e.target.checked)} />
                  <span>
                    Install Open WebUI (port 3000)
                    <span className="block text-[11px] text-slate-400">A ChatGPT-style web chat for your whole household. Adds several minutes to setup.</span>
                  </span>
                </label>
                <fieldset className="space-y-1">
                  <legend className="mb-1 text-[11px] text-slate-400">Starter models (downloaded after setup)</legend>
                  {STARTER_MODELS.map((m) => (
                    <label key={m.tag} className="flex items-center gap-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        checked={form.starter_models.includes(m.tag)}
                        onChange={(e) => set("starter_models", e.target.checked ? [...form.starter_models, m.tag] : form.starter_models.filter((x) => x !== m.tag))}
                      />
                      {m.label}
                      <span className="text-[10px] text-slate-500">{m.note}</span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {app.supports_storage_mount && (
              <label className="flex items-start gap-2 rounded-lg bg-white/5 p-2.5 text-xs text-slate-200">
                <input type="checkbox" className="mt-0.5" checked={form.mount_storage} onChange={(e) => set("mount_storage", e.target.checked)} />
                <span>
                  Mount ZFS Storage (/mnt/storage)
                  <span className="block text-[11px] text-slate-400">Same datasets File Station sees, bind-mounted into the container.</span>
                </span>
              </label>
            )}
            {app.supports_igpu && (
              <label className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-xs text-amber-100">
                <input type="checkbox" className="mt-0.5" checked={form.enable_igpu} onChange={(e) => set("enable_igpu", e.target.checked)} />
                <span>
                  <span className="flex items-center gap-1 font-medium">
                    <Zap size={12} /> Enable Intel Quick Sync iGPU (/dev/dri)
                  </span>
                  <span className="block text-[11px] text-amber-200/70">Passes the host's render devices through for hardware transcoding.</span>
                </span>
              </label>
            )}
            {error && <p className="text-xs text-rose-300">{error}</p>}
            <button className="btn w-full justify-center border-sky-400/40 bg-sky-500/30 py-2 text-white hover:bg-sky-500/40" disabled={busy}>
              {busy ? "Preparing template & creating container…" : "Install"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const PRESETS = ["production", "dev", "staging", "testing", "lab", "backup"] as const;

/** Next free "Instance N" label (N = installed count + 1, skipping labels already taken). */
function nextLabel(t: ReturnType<typeof useTranslation>["t"], count: number, taken: string[]) {
  let n = count + 1;
  while (taken.includes(t("inst.defaultLabel", { n }))) n++;
  return count ? t("inst.defaultLabel", { n }) : "";
}

/** Configure Instance: label (pre-filled), preset chips and a live preview of the display name and host name. */
function ConfigureInstanceModal({ app, initial, onClose, onStart }: { app: CatalogApp; initial: string; onClose: () => void; onStart: (label: string, advanced: boolean) => void }) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(initial);
  const clean = label.replace(/\s+/g, " ").trim().slice(0, 40);
  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("inst.configureTitle")}
      footer={
        <>
          <GlassButton variant="ghost" onClick={() => onStart(clean, true)} className="mr-auto">
            <Settings2 size={12} /> {t("inst.advanced")}
          </GlassButton>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" onClick={() => onStart(clean, false)}>
            {t("inst.install")}
          </GlassButton>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onStart(clean, false);
        }}
      >
        <div className="flex items-center gap-3">
          <AppIcon app={app} size={16} />
          <p className="min-w-0 text-sm font-semibold break-words text-white">{app.name}</p>
        </div>
        <label className="block text-[11px] text-slate-400">
          {t("inst.label")}
          <GlassInput className="mt-1 w-full" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} autoFocus placeholder={t("inst.labelPlaceholder")} />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("inst.presets")}>
          {PRESETS.map((p) => {
            const v = t(`inst.preset.${p}`);
            return (
              <button
                type="button"
                key={p}
                onClick={() => setLabel(v)}
                aria-pressed={clean === v}
                className={`rounded-full px-2.5 py-1 text-[11px] ring-1 transition ${clean === v ? "bg-sky-500/30 text-white ring-sky-300/60" : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"}`}
              >
                {v}
              </button>
            );
          })}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-white/5 p-3 text-xs ring-1 ring-white/10">
          <dt className="text-slate-400">{t("inst.previewName")}</dt>
          <dd className="break-words text-white">{displayName(app.name, clean)}</dd>
          <dt className="text-slate-400">{t("inst.previewHost")}</dt>
          <dd className="font-mono break-all text-white">{hostnameFor(app.id, clean)}</dd>
        </dl>
        <p className="text-[11px] text-slate-500">{t("inst.labelHint")}</p>
      </form>
    </GlassModal>
  );
}

export default function AppCenter() {
  const { t } = useTranslation();
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState<{ app: CatalogApp; label: string; autoStart: boolean } | null>(null);
  const [naming, setNaming] = useState<CatalogApp | null>(null);
  const [managing, setManaging] = useState<CatalogApp | null>(null);
  const [removing, setRemoving] = useState<AppInstance | null>(null);
  const { instances } = useAppInstances();
  const instancesOf = (a: CatalogApp) => (instances ?? []).filter((i) => i.app_id === a.id);
  const [error, setError] = useState("");
  const [view] = useAppView("appcenter");

  const load = useCallback(() => {
    api<CatalogApp[]>("/apps/catalog")
      .then((a) => {
        setApps(a);
        setError("");
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => onAppsChanged(load), [load]);

  // Install progress on the app tiles (in-memory App Center jobs only, so polling is cheap); the catalog reloads when
  // a job reaches 100 % so the new container shows as installed.
  const [jobs, setJobs] = useState<JobProgress[]>([]);
  const running = useRef(new Set<string>());
  const pollJobs = useCallback(() => {
    api<{ tasks: JobProgress[] }>("/system/tasks?kind=app").then(({ tasks }) => {
      if (tasks.some((j) => j.status === "completed" && running.current.has(j.job_id))) appsChanged();
      running.current = new Set(tasks.filter((j) => j.status === "running").map((j) => j.job_id));
      setJobs(tasks);
    }, () => {});
  }, []);
  usePoll(pollJobs, 3000);
  const jobFor = (a: CatalogApp) => jobs.find((j) => j.subject === a.name);

  const badge = (a: CatalogApp) =>
    a.installed.length > 0 && (
      <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-emerald-300" title={a.installed.map((i) => `${i.name} (${i.vmid}, ${i.status})`).join("\n")}>
        {a.installed.length === 1 ? t("inst.installed") : t("inst.count", { count: a.installed.length })}
      </span>
    );
  const install = (a: CatalogApp) => (a.installed.length ? setNaming(a) : setInstalling({ app: a, label: "", autoStart: false }));
  const actions = (a: CatalogApp, grid: boolean) => {
    const mine = instancesOf(a);
    return (
      <div className={`flex shrink-0 flex-wrap items-center gap-1.5 ${grid ? "mt-3" : ""}`}>
        <button className={`btn border-sky-400/30 bg-sky-500/20 text-white hover:bg-sky-500/30 ${grid ? "flex-1 justify-center" : ""}`} onClick={() => install(a)}>
          {a.installed.length ? t("inst.installAnother") : t("inst.install")}
        </button>
        {a.installed.length === 0 && (
          <button className="text-[11px] text-sky-300 underline-offset-2 hover:underline" onClick={() => setNaming(a)}>
            {t("inst.customName")}
          </button>
        )}
        {a.installed.length > 0 && (
          <button
            className="btn border-rose-400/30 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
            disabled={!mine.length}
            onClick={() => (mine.length === 1 ? setRemoving(mine[0]) : setManaging(a))}
          >
            {mine.length === 1 ? <Trash2 size={12} /> : <Settings2 size={12} />} {mine.length === 1 ? t("inst.uninstall") : t("inst.manage")}
          </button>
        )}
      </div>
    );
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? [])
      .filter((a) => (category === "all" || a.category === category) && (!q || `${a.name} ${a.description}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(!!b.featured) - Number(!!a.featured));
  }, [apps, category, query]);
  const needle = query.trim().toLowerCase();
  const native = needle.length > 1 ? Object.entries(NATIVE_FEATURES).filter(([, f]) => f.words.test(needle)) : [];

  return (
    <div className="relative flex h-full">
      <nav className="w-44 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            aria-current={category === c.id}
            title={c.label}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${
              category === c.id ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <c.icon size={15} />
            <span className="max-sm:hidden">{c.label}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 p-3">
          <h2 className="text-sm font-semibold text-white">{CATEGORIES.find((c) => c.id === category)?.label}</h2>
          <span className="ml-auto">
            <ViewToggle app="appcenter" />
          </span>
          <label className="relative">
            <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
            <input className="input w-56 py-1.5 pl-8 text-xs max-sm:w-36" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search apps" />
          </label>
        </div>
        {error && <div className="bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div>}
        {native.map(([id, f]) => (
          <div key={id} role="note" className="flex items-center gap-2 border-b border-white/10 bg-sky-500/[0.07] px-4 py-2 text-[11px] text-sky-100">
            <Sparkles size={12} className="shrink-0 text-sky-300" />
            <span className="min-w-0 flex-1">{t(f.hint, { path: f.path.map((k) => t(k)).join(" › ") })}</span>
            <GlassButton size="xs" onClick={f.open}>
              {t("ac.native.open")}
            </GlassButton>
          </div>
        ))}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!apps && !error && <p className="text-sm text-slate-400">Loading…</p>}
          {apps && shown.length === 0 && <p className="text-sm text-slate-400">No apps match.</p>}
          {view === "list" ? (
            <div className="space-y-1.5">
              {shown.map((a) => (
                <article key={a.id} className="glass-soft flex items-center gap-3 rounded-xl px-3 py-2">
                  <AppIcon app={a} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="min-w-0 truncate text-sm font-semibold text-white" title={a.name}>{a.name}</h3>
                      <span className="shrink-0 text-[10px] text-slate-500">{a.category}</span>
                      {badge(a)}
                    </div>
                    <p className="truncate text-[11px] text-slate-400">{a.description}</p>
                    {jobFor(a) && <OperationProgressCard compact className="mt-1.5" title={a.name} progress={jobFor(a)!} />}
                  </div>
                  <span className="hidden shrink-0 text-[10px] text-slate-400 tabular-nums md:block">
                    {a.cores} vCPU · {a.memory_mb / 1024} GB · {a.disk_gb} GB{a.supports_igpu && " · iGPU"}
                  </span>
                  <OsiButton {...appOsi(a)} />
                  {actions(a, false)}
                </article>
              ))}
            </div>
          ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((a) => (
              <article key={a.id} className={`glass-soft flex flex-col rounded-xl p-4 ${a.featured ? "ring-1 ring-violet-400/50 sm:col-span-2 xl:col-span-1" : ""}`}>
                <div className="flex items-start gap-3">
                  <AppIcon app={a} />
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-2 text-sm leading-snug font-semibold break-words text-white" title={a.name}>{a.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-slate-400">{a.category}</span>
                      {a.featured && (
                        <span className="flex items-center gap-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-violet-200">
                          <Sparkles size={10} /> {t("inst.featured")}
                        </span>
                      )}
                      {badge(a)}
                    </div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 flex-1 text-xs text-slate-300">{a.description}</p>
                {jobFor(a) && <OperationProgressCard compact className="mt-3" title={a.name} progress={jobFor(a)!} />}
                <div className="mt-3 flex flex-wrap gap-1 text-[10px] text-slate-400">
                  <span className="rounded bg-white/5 px-1.5 py-0.5">{a.cores} vCPU</span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5">{a.memory_mb / 1024} GB RAM</span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5">{a.disk_gb} GB disk</span>
                  {a.supports_igpu && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-300">iGPU</span>}
                  {a.compute_selector && <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-emerald-300">NVIDIA / Intel / AMD / CPU</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <OsiButton strip {...appOsi(a)} />
                </div>
                {actions(a, true)}
              </article>
            ))}
          </div>
          )}
        </div>
      </div>
      {installing && (
        <InstallDrawer
          app={installing.app}
          label={installing.label}
          autoStart={installing.autoStart}
          onClose={(deployed) => {
            setInstalling(null);
            if (deployed) appsChanged();
          }}
        />
      )}
      {naming && (
        <ConfigureInstanceModal
          app={naming}
          initial={nextLabel(t, naming.installed.length, instancesOf(naming).map((i) => i.instance_label))}
          onClose={() => setNaming(null)}
          onStart={(label, advanced) => {
            setInstalling({ app: naming, label, autoStart: !advanced });
            setNaming(null);
          }}
        />
      )}
      {managing && <ManageInstancesModal appName={managing.name} instances={instancesOf(managing)} onClose={() => setManaging(null)} />}
      <UninstallInstanceModal instance={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
