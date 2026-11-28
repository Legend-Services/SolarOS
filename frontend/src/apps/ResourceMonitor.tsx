import { useState, type ReactNode } from "react";
import { edition } from "@edition";
import { Cpu, HardDrive, MonitorPlay, Thermometer, Zap } from "lucide-react";
import { useLiveThermals, useTelemetry } from "../lib/stores";
import { bytes, healthColor, percent, tempColor, uptime } from "../lib/format";
import { AreaChart, Bar, Gauge, Legend } from "../components/charts";

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-soft rounded-xl p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <span className="text-xs text-slate-400 tabular-nums">{right}</span>
      </div>
      {children}
    </section>
  );
}

const rate = (n: number) => `${bytes(n)}/s`;
const fmt = (v: number | null, unit: string, digits = 0) => (v == null ? "—" : `${v.toFixed(digits)} ${unit}`);

function HardwareTab() {
  const hw = useTelemetry((s) => s.hardware);
  const th = useLiveThermals();
  if (!hw) return <p className="p-4 text-sm text-slate-400">Loading hardware telemetry…</p>;
  // The 2 s thermals stream (shared with Settings › Hardware) overrides the 15 s summary where it has a value.
  const lg = th?.gpus.find((x) => x.name === hw.gpu.name);
  const g = lg
    ? { ...hw.gpu, temp_c: lg.temp_c ?? hw.gpu.temp_c, power_w: lg.power_w ?? hw.gpu.power_w, utilization_pct: lg.utilization_pct ?? hw.gpu.utilization_pct, vram_used_mb: lg.vram_used_mb ?? hw.gpu.vram_used_mb }
    : hw.gpu;
  const liveDrive = new Map(th?.drives.map((d) => [d.device, d.temp_c]));
  const disks = hw.disks.map((d) => ({ ...d, temp_c: liveDrive.get(d.devpath) ?? d.temp_c }));

  return (
    <div className="grid h-full auto-rows-min gap-3 overflow-y-auto p-4 lg:grid-cols-2">
      <Panel title="NVIDIA GPU" right={g.available ? g.name : "not detected"}>
        {!g.available ? (
          <p className="text-xs text-slate-400">No NVIDIA GPU found on the host (or nvidia-smi is not installed).</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-around">
              <Gauge value={g.utilization_pct ?? 0} label="GPU core" color="#22c55e" />
              <div className="space-y-2 text-xs">
                <div className={`flex items-center gap-1.5 ${tempColor(g.temp_c)}`}>
                  <Thermometer size={14} /> {fmt(g.temp_c, "°C")}
                </div>
                <div className="flex items-center gap-1.5 text-amber-300">
                  <Zap size={14} /> {fmt(g.power_w, "W", 1)}
                </div>
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                <span>VRAM</span>
                <span className="tabular-nums">
                  {fmt(g.vram_used_mb && g.vram_used_mb / 1024, "GB", 1)} / {fmt(g.vram_total_mb && g.vram_total_mb / 1024, "GB", 1)}
                </span>
              </div>
              <Bar value={percent(g.vram_used_mb ?? 0, g.vram_total_mb ?? 0)} className="bg-emerald-400" />
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Intel Quick Sync" right={hw.igpu.quicksync ? "available" : "unavailable"}>
        <div className="flex items-center gap-2 text-xs">
          <MonitorPlay size={16} className={hw.igpu.quicksync ? "text-emerald-400" : "text-slate-500"} />
          <span className="text-slate-200">
            {hw.igpu.quicksync
              ? "Intel iGPU render node found; hardware transcoding can be passed to apps."
              : hw.igpu.available
                ? "Render node found, but it is not an Intel GPU."
                : "No /dev/dri render node on the host."}
          </span>
        </div>
        {hw.igpu.render_nodes.length > 0 && (
          <ul className="mt-2 space-y-1 font-mono text-[11px] text-slate-400">
            {hw.igpu.render_nodes.map((n) => (
              <li key={n.path}>
                {n.path} <span className="text-slate-500">vendor {n.vendor || "?"}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <section className="glass-soft rounded-xl p-4 lg:col-span-2">
        <h3 className="mb-3 text-sm font-semibold text-slate-100">Drives</h3>
        {disks.length === 0 && <p className="text-xs text-slate-400">No physical disks reported.</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {disks.map((d) => (
            <div key={d.devpath} className="rounded-xl bg-white/5 p-3">
              <div className="flex items-center gap-2 text-xs">
                <HardDrive size={14} className="text-slate-400" />
                <span className="font-mono text-slate-100">{d.devpath}</span>
                <span className="ml-auto rounded bg-white/10 px-1.5 text-[10px] uppercase text-slate-300">{d.type || "disk"}</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-slate-400" title={d.model}>
                {d.model || "Unknown model"} · {bytes(d.size)}
              </div>
              <div className="mt-2 flex items-end justify-between">
                <span className={`text-2xl font-semibold tabular-nums ${tempColor(d.temp_c)}`}>{d.temp_c == null ? "—" : `${d.temp_c}°C`}</span>
                <span className="text-right text-[11px] text-slate-400">
                  <span className={healthColor(d.health)}>SMART {d.health}</span>
                  <br />
                  {d.life_left_pct == null ? "Wearout N/A" : `${d.life_left_pct}% life left`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const TABS = [
  { id: "performance", label: "Performance", icon: Cpu },
  { id: "hardware", label: "GPU & Sensors", icon: Thermometer },
] as const;

export default function ResourceMonitor({ initialTab }: { initialTab?: (typeof TABS)[number]["id"] } = {}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>(initialTab === "hardware" ? "hardware" : "performance");
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-white/10 bg-black/20 px-3 py-1.5" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs ${
              tab === id ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{tab === "performance" ? <Performance /> : <HardwareTab />}</div>
    </div>
  );
}

function Performance() {
  const { overview: o, history } = useTelemetry();
  const last = history[history.length - 1];
  const total = o?.memory.total ?? 0;

  return (
    <div className="grid h-full auto-rows-min gap-3 overflow-y-auto p-4 lg:grid-cols-2">
      <Panel title="CPU" right={o ? `${o.cpu.toFixed(1)}%` : ""}>
        <div className="h-36">
          <AreaChart max={100} series={[{ label: "CPU", color: "#38bdf8", values: history.map((h) => h.cpu) }]} />
        </div>
        <Legend items={[{ label: "Load avg", color: "#38bdf8", value: o?.loadavg.map((l) => l.toFixed(2)).join(" / ") ?? "—" }]} />
      </Panel>

      <Panel title="Memory" right={o ? `${percent(o.memory.used, total).toFixed(1)}% of ${bytes(total)}` : ""}>
        <div className="h-36">
          <AreaChart
            stacked
            max={total || undefined}
            series={[
              { label: "Used", color: "#a78bfa", values: history.map((h) => h.memApp) },
              { label: "ZFS ARC", color: "#f59e0b", values: history.map((h) => h.memArc) },
              { label: "Free", color: "#34d399", values: history.map((h) => h.memFree) },
            ]}
          />
        </div>
        <Legend
          items={[
            { label: "Used", color: "#a78bfa", value: bytes(last?.memApp ?? 0) },
            { label: "ZFS ARC", color: "#f59e0b", value: bytes(last?.memArc ?? 0) },
            { label: "Free", color: "#34d399", value: bytes(last?.memFree ?? 0) },
            { label: "Swap", color: "#64748b", value: o ? `${bytes(o.swap.used)} / ${bytes(o.swap.total)}` : "—" },
          ]}
        />
      </Panel>

      <Panel title="Network" right="host total · 1-min average">
        <div className="h-36">
          <AreaChart
            series={[
              { label: "In", color: "#22d3ee", values: history.map((h) => h.netIn) },
              { label: "Out", color: "#f472b6", values: history.map((h) => h.netOut) },
            ]}
          />
        </div>
        <Legend
          items={[
            { label: "In", color: "#22d3ee", value: rate(last?.netIn ?? 0) },
            { label: "Out", color: "#f472b6", value: rate(last?.netOut ?? 0) },
          ]}
        />
      </Panel>

      <Panel title="Hardware">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          {[
            ["Node", o?.node],
            ["CPU", o?.cpuinfo.model],
            ["Topology", o && `${o.cpuinfo.sockets} socket(s) · ${o.cpuinfo.cores} cores · ${o.cpuinfo.cpus} threads`],
            ["Memory", o && bytes(o.memory.total)],
            ["Kernel", o?.kernel],
            [edition.versionLabel, o?.platform_version],
            ["Uptime", o && uptime(o.uptime)],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-slate-400">{k}</dt>
              <dd className="truncate text-slate-100" title={v || ""}>
                {v || "—"}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
