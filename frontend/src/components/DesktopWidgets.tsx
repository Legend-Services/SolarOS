import { useCallback, useState, type DragEvent, type ReactNode } from "react";
import {
  ArchiveRestore, Boxes, BrainCircuit, Container, Database, EyeOff, Gauge as GaugeIcon, GripVertical, HeartPulse, Lock, Maximize2, Minimize2, Monitor,
  NotebookPen, Activity, SquareTerminal, Zap,
} from "lucide-react";
import { useAuth, useIntent, useTelemetry, useWindows } from "../lib/stores";
import { bytes, healthColor, percent, tempColor, uptime } from "../lib/format";
import { api } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useTranslation, type TKey } from "../i18n";
import { useWidgets, type WidgetCfg, type WidgetId, type WidgetSlot } from "../store/widgetStore";
import { AreaChart, Bar, Gauge } from "./charts";

export const WIDGET_META: Record<WidgetId, { title: TKey; desc: TKey; icon: ReactNode }> = {
  health: { title: "widget.health", desc: "widget.healthDesc", icon: <HeartPulse size={14} /> },
  storage: { title: "widget.storage", desc: "widget.storageDesc", icon: <Database size={14} /> },
  compute: { title: "widget.compute", desc: "widget.computeDesc", icon: <Boxes size={14} /> },
  gpu: { title: "widget.gpu", desc: "widget.gpuDesc", icon: <GaugeIcon size={14} /> },
  network: { title: "widget.network", desc: "widget.networkDesc", icon: <Activity size={14} /> },
  ai: { title: "widget.ai", desc: "widget.aiDesc", icon: <BrainCircuit size={14} /> },
  actions: { title: "widget.actions", desc: "widget.actionsDesc", icon: <Zap size={14} /> },
};

type T = ReturnType<typeof useTranslation>["t"];

/* ---------------- Widget bodies ---------------- */

function HealthWidget({ compact, t }: { compact: boolean; t: T }) {
  const o = useTelemetry((s) => s.overview);
  const mem = o ? percent(o.memory.used, o.memory.total) : 0;
  return compact ? (
    <div className="space-y-2 text-[11px] text-slate-300">
      <div className="flex justify-between"><span>{t("widget.cpu")}</span><span className="tabular-nums">{o?.cpu.toFixed(0) ?? "–"}%</span></div>
      <Bar value={o?.cpu ?? 0} className="bg-sky-400" />
      <div className="flex justify-between"><span>{t("widget.memory")}</span><span className="tabular-nums">{mem.toFixed(0)}%</span></div>
      <Bar value={mem} className="bg-violet-400" />
    </div>
  ) : (
    <>
      <div className="flex justify-around">
        <Gauge value={o?.cpu ?? 0} label={t("widget.cpu")} sub={o ? t("widget.threads", { n: o.cpuinfo.cpus }) : ""} color="#38bdf8" />
        <Gauge value={mem} label={t("widget.memory")} sub={o ? `${bytes(o.memory.used)} / ${bytes(o.memory.total)}` : ""} color="#a78bfa" />
      </div>
      <div className="mt-3 flex justify-between text-[11px] text-slate-400">
        <span>{t("widget.uptime", { v: o ? uptime(o.uptime) : "—" })}</span>
        <span>{t("widget.load", { v: o?.loadavg.map((l) => l.toFixed(2)).join(" ") ?? "—" })}</span>
      </div>
    </>
  );
}

function StorageWidget({ compact, t }: { compact: boolean; t: T }) {
  const storage = useTelemetry((s) => s.storage);
  const open = useWindows((s) => s.open);
  if (!storage) return <p className="text-xs text-slate-400">{t("common.loading")}</p>;
  if (!storage.pools.length) return <p className="text-xs text-slate-400">{t("widget.noPools")}</p>;
  return (
    <ul className={compact ? "space-y-2" : "space-y-3"}>
      {storage.pools.map((p) => (
        <li key={p.name}>
          <button onClick={() => open("storage")} className="w-full text-left">
            <div className="mb-1 flex justify-between text-xs">
              <span className="font-medium text-slate-100">{p.name}</span>
              <span className={healthColor(p.health)}>{compact ? `${percent(p.alloc, p.size).toFixed(0)}% · ${p.health}` : p.health}</span>
            </div>
            <Bar value={percent(p.alloc, p.size)} className="bg-amber-400" />
            {!compact && <div className="mt-1 text-[11px] text-slate-400">{t("widget.usedOf", { used: bytes(p.alloc), total: bytes(p.size) })}</div>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ComputeWidget({ compact, t }: { compact: boolean; t: T }) {
  const o = useTelemetry((s) => s.overview);
  const open = useWindows((s) => s.open);
  return (
    <div className="grid grid-cols-2 gap-3">
      {[
        { label: t("widget.vms"), icon: <Monitor size={16} />, c: o?.vms },
        { label: t("widget.containers"), icon: <Container size={16} />, c: o?.containers },
      ].map(({ label, icon, c }) => (
        <button key={label} onClick={() => open("compute")} className={`rounded-xl bg-white/5 text-left hover:bg-white/10 ${compact ? "p-2" : "p-3"}`}>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            {icon}
            <span className="truncate">{label}</span>
          </div>
          <div className={`mt-1 font-semibold text-white tabular-nums ${compact ? "text-lg" : "text-2xl"}`}>{c?.running ?? "–"}</div>
          {!compact && <div className="text-[11px] text-slate-400">{t("widget.runningStopped", { n: c?.stopped ?? 0 })}</div>}
        </button>
      ))}
    </div>
  );
}

function GpuWidget({ compact, t }: { compact: boolean; t: T }) {
  const hw = useTelemetry((s) => s.hardware);
  const open = useWindows((s) => s.open);
  const gpu = hw?.gpu;
  const disks = (hw?.disks ?? []).filter((d) => d.temp_c !== null).sort((a, b) => (b.temp_c ?? 0) - (a.temp_c ?? 0));
  return (
    <button onClick={() => open("monitor")} className="w-full space-y-2 text-left">
      {gpu?.available ? (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="truncate font-medium text-slate-100">{gpu.name}</span>
            <span className="shrink-0 pl-2 tabular-nums text-slate-300">
              <span className={tempColor(gpu.temp_c)}>{gpu.temp_c ?? "—"}°C</span> · {gpu.power_w?.toFixed(0) ?? "—"} W
            </span>
          </div>
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>{t("widget.core", { n: gpu.utilization_pct ?? 0 })}</span>
            <span className="tabular-nums">{t("widget.vram", { used: ((gpu.vram_used_mb ?? 0) / 1024).toFixed(1), total: ((gpu.vram_total_mb ?? 0) / 1024).toFixed(1) })}</span>
          </div>
          <Bar value={percent(gpu.vram_used_mb ?? 0, gpu.vram_total_mb ?? 0)} className="bg-emerald-400" />
        </>
      ) : (
        <p className="text-xs text-slate-400">{t("widget.noGpu")}</p>
      )}
      {hw?.igpu.available && (
        <div className="flex justify-between text-[11px] text-slate-400">
          <span>{t("widget.igpu")}</span>
          <span>{hw.igpu.quicksync ? "Quick Sync" : hw.igpu.render_nodes.map((n) => n.path.split("/").pop()).join(", ")}</span>
        </div>
      )}
      <div className="border-t border-white/10 pt-2 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{t("widget.drives")}</div>
      {disks.length ? (
        <ul className="space-y-1 text-[11px]">
          {disks.slice(0, compact ? 3 : 8).map((d) => (
            <li key={d.devpath} className="flex justify-between gap-2">
              <span className="truncate text-slate-300">{d.model || d.devpath}</span>
              <span className={`tabular-nums ${tempColor(d.temp_c)}`}>{d.temp_c}°C</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-slate-500">{t("widget.noDrives")}</p>
      )}
    </button>
  );
}

function NetworkWidget({ compact, t }: { compact: boolean; t: T }) {
  const history = useTelemetry((s) => s.history);
  const last = history[history.length - 1];
  return (
    <div>
      <div style={{ height: compact ? 48 : 96 }}>
        <AreaChart
          height={compact ? 48 : 96}
          series={[
            { label: "rx", color: "#38bdf8", values: history.map((h) => h.netIn) },
            { label: "tx", color: "#f472b6", values: history.map((h) => h.netOut) },
          ]}
        />
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular-nums">
        <span className="text-sky-300">↓ {compact ? "" : `${t("widget.rx")} `}{bytes(last?.netIn ?? 0)}/s</span>
        <span className="text-pink-300">↑ {compact ? "" : `${t("widget.tx")} `}{bytes(last?.netOut ?? 0)}/s</span>
      </div>
    </div>
  );
}

interface AiStatus {
  installed: boolean;
  running?: boolean;
  gpu?: { name?: string; memory_used_mb?: number; memory_total_mb?: number } | null;
}
interface AiModel {
  name: string;
  loaded: boolean;
  size_vram: number | null;
}

function AiWidget({ compact, t }: { compact: boolean; t: T }) {
  const open = useWindows((s) => s.open);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const load = useCallback(() => {
    api<AiStatus>("/ai/status")
      .then((s) => {
        setStatus(s);
        if (s.installed && s.running) api<AiModel[]>("/ai/models/local").then((m) => setModels(m.filter((x) => x.loaded)), () => setModels([]));
        else setModels([]);
      })
      .catch(() => setStatus({ installed: false }));
  }, []);
  usePoll(load, 30000);
  const active = models[0];
  const hw = useTelemetry((s) => s.hardware?.gpu);
  return (
    <div className="space-y-2 text-xs">
      {!status ? (
        <p className="text-slate-400">{t("common.loading")}</p>
      ) : !status.installed ? (
        <p className="text-slate-400">{t("widget.aiNotInstalled")}</p>
      ) : !status.running ? (
        <p className="text-amber-300">{t("widget.aiStopped")}</p>
      ) : active ? (
        <>
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">{t("widget.aiModel")}</span>
            <span className="truncate font-medium text-slate-100">{active.name}</span>
          </div>
          {!compact && active.size_vram != null && hw?.vram_total_mb ? (
            <>
              <div className="flex justify-between text-[11px] text-slate-400 tabular-nums">
                <span>VRAM</span>
                <span>{bytes(active.size_vram)} / {(hw.vram_total_mb / 1024).toFixed(1)} GB</span>
              </div>
              <Bar value={percent(active.size_vram, hw.vram_total_mb * 1024 * 1024)} className="bg-fuchsia-400" />
            </>
          ) : null}
        </>
      ) : (
        <p className="text-slate-400">{t("widget.aiNoModel")}</p>
      )}
      <button onClick={() => open("local-ai")} className="glass-btn mt-1 w-full rounded-lg px-3 py-1.5 text-[11px] font-medium text-slate-100">
        {t("widget.aiPlayground")}
      </button>
    </div>
  );
}

function ActionsWidget({ compact, t }: { compact: boolean; t: T }) {
  const open = useWindows((s) => s.open);
  const go = useIntent((s) => s.go);
  const lock = useAuth((s) => s.lock);
  const notes = useWidgets((s) => s.notes);
  const setNotes = useWidgets((s) => s.setNotes);
  const btn = (icon: ReactNode, label: string, fn: () => void) => (
    <button onClick={fn} className="flex flex-col items-center gap-1 rounded-xl bg-white/5 p-2 text-[10px] text-slate-200 hover:bg-white/10" title={label}>
      {icon}
      <span className="line-clamp-1">{label}</span>
    </button>
  );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {btn(<SquareTerminal size={16} />, t("widget.hostShell"), () => open("terminal"))}
        {btn(<ArchiveRestore size={16} />, t("widget.backupNow"), () => go("backup", "now"))}
        {btn(<Lock size={16} />, t("widget.lock"), lock)}
      </div>
      <label className="block">
        <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
          <NotebookPen size={11} /> {t("widget.notes")}
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("widget.notesPlaceholder")}
          rows={compact ? 3 : 6}
          className="glass-field w-full resize-y text-[11px] leading-snug"
          // Typing must not trigger desktop shortcuts or the widget drag.
          onKeyDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.preventDefault()}
        />
      </label>
    </div>
  );
}

const BODIES: Record<WidgetId, (p: { compact: boolean; t: T }) => ReactNode> = {
  health: HealthWidget,
  storage: StorageWidget,
  compute: ComputeWidget,
  gpu: GpuWidget,
  network: NetworkWidget,
  ai: AiWidget,
  actions: ActionsWidget,
};

/* ---------------- Frame + slots (Edit Widgets mode) ---------------- */

const DRAG_TYPE = "application/x-solardeck-widget";

function WidgetCard({ w, editing, t }: { w: WidgetCfg; editing: boolean; t: T }) {
  const { update, move } = useWidgets();
  const [over, setOver] = useState(false);
  const meta = WIDGET_META[w.id];
  const Body = BODIES[w.id];
  const drop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE) as WidgetId;
    setOver(false);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    move(id, w.slot, w.id);
  };
  return (
    <section
      className={`glass rounded-2xl p-4 transition-shadow ${editing ? "cursor-grab ring-1 ring-sky-300/40 ring-dashed active:cursor-grabbing" : ""} ${over ? "ring-2 ring-sky-300" : ""} ${
        w.slot === "grid" && w.size === "expanded" ? "md:col-span-2" : ""
      }`}
      draggable={editing}
      onDragStart={(e) => (e.dataTransfer.setData(DRAG_TYPE, w.id), (e.dataTransfer.effectAllowed = "move"))}
      onDragOver={(e) => editing && e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      aria-label={t(meta.title)}
    >
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-300 uppercase">
        {editing && <GripVertical size={14} className="text-slate-500" aria-label={t("studio.drag")} />}
        {meta.icon}
        <span className="flex-1 truncate">{t(meta.title)}</span>
        {editing && (
          <>
            <button
              onClick={() => update(w.id, { size: w.size === "compact" ? "expanded" : "compact" })}
              className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white"
              aria-label={w.size === "compact" ? t("studio.expanded") : t("studio.compact")}
              title={w.size === "compact" ? t("studio.expanded") : t("studio.compact")}
            >
              {w.size === "compact" ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
            </button>
            <button onClick={() => update(w.id, { enabled: false })} className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label={t("studio.hide")} title={t("studio.hide")}>
              <EyeOff size={13} />
            </button>
          </>
        )}
      </h2>
      {/* Widgets stay live while editing, but clicks go to the frame so a drag never opens an app. */}
      <div className={editing ? "pointer-events-none select-none" : ""}>
        <Body compact={w.size === "compact"} t={t} />
      </div>
    </section>
  );
}

/** The widgets of one slot: a column (left / right) or the responsive grid in the middle of the desktop. */
export function WidgetSlotArea({ slot, className = "" }: { slot: WidgetSlot; className?: string }) {
  const { t } = useTranslation();
  const items = useWidgets((s) => s.items);
  const editing = useWidgets((s) => s.editing);
  const move = useWidgets((s) => s.move);
  const [over, setOver] = useState(false);
  const shown = items.filter((w) => w.enabled && w.slot === slot);
  if (!shown.length && !editing) return null;
  const grid = slot === "grid";
  return (
    <div
      className={`${grid ? "hidden auto-rows-min gap-4 md:grid md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]" : "hidden w-80 shrink-0 flex-col gap-4 md:flex"} ${className}`}
      onDragOver={(e) => editing && e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), setOver(true))}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE) as WidgetId;
        if (id) (e.preventDefault(), move(id, slot, null));
      }}
    >
      {shown.map((w) => (
        <WidgetCard key={w.id} w={w} editing={editing} t={t} />
      ))}
      {editing && (
        <div className={`flex min-h-20 items-center justify-center rounded-2xl border-2 border-dashed text-[11px] text-slate-400 transition ${over ? "border-sky-300 bg-sky-400/10" : "border-white/15"}`}>
          {t("studio.dropHere")} · {t(`studio.slot.${slot}`)}
        </div>
      )}
    </div>
  );
}
