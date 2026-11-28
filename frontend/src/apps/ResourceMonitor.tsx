import { useEffect, useState, type ReactNode } from "react";
import { edition } from "@edition";
import { Cpu, Fan, HardDrive, MemoryStick, MonitorPlay, Network, SlidersHorizontal, Thermometer, Zap } from "lucide-react";
import { useLiveThermals, useTelemetry, type LiveThermals } from "../lib/stores";
import { bytes, healthColor, percent, uptime } from "../lib/format";
import { useTranslation, type TKey } from "../i18n";
import { AreaChart, Bar, Gauge, Legend } from "../components/charts";
import { LiveThermalsPill } from "./HardwarePanel";
import { driveKind } from "../lib/thermals";
import { useTempColor } from "../store/thermalStore";
import { TempText } from "../components/TempText";
import ThermalSettingsPanel from "../components/settings/ThermalSettingsPanel";

function Panel({ title, right, className = "", children }: { title: ReactNode; right?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`glass-soft rounded-xl p-4 ${className}`}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">{title}</h3>
        <span className="text-xs text-slate-400 tabular-nums">{right}</span>
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-400">{k}</dt>
          <dd className="min-w-0 break-words text-slate-100 tabular-nums">{v || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

const rate = (n: number) => `${bytes(n)}/s`;
const fmt = (v: number | null | undefined, unit: string, digits = 0) => (v == null ? "—" : `${v.toFixed(digits)} ${unit}`);
const grid = "grid h-full auto-rows-min gap-3 overflow-y-auto p-4 lg:grid-cols-2";

/* ---------------- CPU: load, temperatures, clocks, per-core sensors and cooling ---------------- */

function CoreGrid({ cores }: { cores: LiveThermals["cpu"]["cores"] }) {
  const tc = useTempColor();
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 xl:grid-cols-6">
      {cores.map((c) => (
        <div key={c.core_id} className="text-[11px] tabular-nums">
          <div className="flex justify-between text-slate-400">
            <span>Core {c.core_id}</span>
            <TempText c={c.temp_c} kind="cpu" />
          </div>
          {/* 100 °C ≈ Tjunction max of current desktop/mobile CPUs; without a core sensor the bar shows load. */}
          <Bar value={c.temp_c ?? c.load_pct ?? 0} className={c.temp_c != null ? tc.bar(c.temp_c, "cpu") : "bg-sky-400"} />
          <div className="mt-0.5 flex justify-between text-[10px] text-slate-500">
            <span>{c.freq_mhz != null ? `${c.freq_mhz} MHz` : ""}</span>
            <span>{c.load_pct != null ? `${c.load_pct.toFixed(0)}%` : ""}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CpuTab() {
  const { overview: o, history } = useTelemetry();
  const th = useLiveThermals();
  const cpu = th?.cpu;
  return (
    <div className={grid}>
      <Panel title="CPU load" right={o ? `${o.cpu.toFixed(1)}%` : ""}>
        <div className="h-36">
          <AreaChart max={100} series={[{ label: "CPU", color: "#38bdf8", values: history.map((h) => h.cpu) }]} />
        </div>
        <Legend items={[{ label: "Load avg", color: "#38bdf8", value: o?.loadavg.map((l) => l.toFixed(2)).join(" / ") ?? "—" }]} />
      </Panel>

      <Panel title={<><Thermometer size={14} /> Temperature & clock</>} right={<LiveThermalsPill />}>
        <div className="mb-3 flex items-end gap-6">
          <div>
            <div className="text-[11px] text-slate-400">Package</div>
            <div className="text-3xl font-semibold tabular-nums"><TempText c={cpu?.package_temp_c} kind="cpu" /></div>
          </div>
          <div>
            <div className="text-[11px] text-slate-400">Average clock</div>
            <div className="text-3xl font-semibold text-slate-100 tabular-nums">{fmt(cpu?.avg_freq_mhz, "MHz")}</div>
          </div>
        </div>
        <Facts
          rows={[
            ["Clock range", cpu?.min_freq_mhz != null ? `${cpu.min_freq_mhz}–${cpu.max_freq_mhz} MHz` : null],
            ["CPU", o?.cpuinfo.model],
            ["Topology", o && `${o.cpuinfo.sockets} socket(s) · ${o.cpuinfo.cores} cores · ${o.cpuinfo.cpus} threads`],
            ["Node", o?.node],
            ["Kernel", o?.kernel],
            [edition.versionLabel, o?.platform_version],
            ["Uptime", o && uptime(o.uptime)],
          ]}
        />
      </Panel>

      <Panel title={<><Cpu size={14} /> Cores</>} right={cpu?.cores.length ? `${cpu.cores.length} cores · temperature, clock and load` : ""} className="lg:col-span-2">
        {cpu?.cores.length ? (
          <CoreGrid cores={cpu.cores} />
        ) : (
          <p className="text-xs text-slate-400">{th ? "The host reports no per-core sensors (connect the SSH bridge to read them)." : "Reading sensors…"}</p>
        )}
      </Panel>

      {!!th?.chassis_fans.length && (
        <Panel title={<><Fan size={14} /> Fans</>} className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs tabular-nums sm:grid-cols-4">
            {th.chassis_fans.map((f, i) => (
              <div key={`${f.label}-${i}`} className="flex justify-between gap-2">
                <span className="min-w-0 break-words text-slate-400">{f.label}</span>
                <span className="text-slate-100">{f.rpm} RPM</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ---------------- Memory and network ---------------- */

function MemoryTab() {
  const { overview: o, history } = useTelemetry();
  const last = history[history.length - 1];
  const total = o?.memory.total ?? 0;
  return (
    <div className="h-full overflow-y-auto p-4">
      <Panel title="Memory" right={o ? `${percent(o.memory.used, total).toFixed(1)}% of ${bytes(total)}` : ""}>
        <div className="h-64">
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
    </div>
  );
}

function NetworkTab() {
  const { history } = useTelemetry();
  const last = history[history.length - 1];
  return (
    <div className="h-full overflow-y-auto p-4">
      <Panel title="Network" right="host total · 1-min average">
        <div className="h-64">
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
    </div>
  );
}

/* ---------------- GPU ---------------- */

type LiveGpu = LiveThermals["gpus"][number];

function GpuTab() {
  const hw = useTelemetry((s) => s.hardware);
  const th = useLiveThermals();
  // Live list (every GPU, 2 s); before the first answer, the 15 s summary of the first NVIDIA GPU.
  const fallback: LiveGpu[] = hw?.gpu.available
    ? [{ slot: "", name: hw.gpu.name ?? "GPU", temp_c: hw.gpu.temp_c, hotspot_temp_c: null, fan_rpm_or_pct: null, fan_unit: "%", power_w: hw.gpu.power_w, vram_used_mb: hw.gpu.vram_used_mb, vram_total_mb: hw.gpu.vram_total_mb, utilization_pct: hw.gpu.utilization_pct }]
    : [];
  const gpus = th?.gpus.length ? th.gpus : fallback;
  return (
    <div className={grid}>
      {gpus.length === 0 && (
        <Panel title="GPU" right={<LiveThermalsPill />} className="lg:col-span-2">
          <p className="text-xs text-slate-400">No GPU with live sensors found on the host (a GPU in passthrough mode reports to its VM instead).</p>
        </Panel>
      )}
      {gpus.map((g, i) => (
        <Panel key={g.slot || i} title={<><MonitorPlay size={14} /> {g.name}</>} right={i === 0 ? <LiveThermalsPill /> : <span className="font-mono">{g.slot}</span>}>
          <div className="space-y-3">
            <div className="flex items-center justify-around">
              {g.utilization_pct != null && <Gauge value={g.utilization_pct} label="GPU core" color="#22c55e" />}
              <div className="space-y-2 text-xs tabular-nums">
                <div className="flex items-center gap-1.5 text-slate-300">
                  <Thermometer size={14} /> <TempText c={g.temp_c} kind="gpu" />
                  {g.hotspot_temp_c != null && <span className="text-slate-400">· hotspot <TempText c={g.hotspot_temp_c} kind="hotspot" /></span>}
                </div>
                <div className="flex items-center gap-1.5 text-amber-300">
                  <Zap size={14} /> {fmt(g.power_w, "W", 1)}
                </div>
                {g.fan_rpm_or_pct != null && (
                  <div className="flex items-center gap-1.5 text-slate-300">
                    <Fan size={14} /> {g.fan_rpm_or_pct.toFixed(0)}{g.fan_unit === "%" ? "%" : " RPM"}
                  </div>
                )}
              </div>
            </div>
            {g.vram_total_mb != null && (
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                  <span>VRAM</span>
                  <span className="tabular-nums">
                    {fmt(g.vram_used_mb != null ? g.vram_used_mb / 1024 : null, "GB", 1)} / {fmt(g.vram_total_mb / 1024, "GB", 1)}
                  </span>
                </div>
                <Bar value={percent(g.vram_used_mb ?? 0, g.vram_total_mb)} className="bg-emerald-400" />
              </div>
            )}
          </div>
        </Panel>
      ))}

      {hw && (
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
      )}
    </div>
  );
}

/* ---------------- Drives ---------------- */

function DrivesTab() {
  const hw = useTelemetry((s) => s.hardware);
  const th = useLiveThermals();
  if (!hw) return <p className="p-4 text-sm text-slate-400">Loading hardware telemetry…</p>;
  const liveDrive = new Map(th?.drives.map((d) => [d.device, d.temp_c]));
  const disks = hw.disks.map((d) => ({ ...d, temp_c: liveDrive.get(d.devpath) ?? d.temp_c }));
  return (
    <div className="h-full overflow-y-auto p-4">
      <Panel title={<><HardDrive size={14} /> Drives</>} right={<LiveThermalsPill />}>
        {disks.length === 0 && <p className="text-xs text-slate-400">No physical disks reported.</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {disks.map((d) => (
            <div key={d.devpath} className="rounded-xl bg-white/5 p-3">
              <div className="flex items-center gap-2 text-xs">
                <HardDrive size={14} className="text-slate-400" />
                <span className="font-mono text-slate-100">{d.devpath}</span>
                <span className="ml-auto rounded bg-white/10 px-1.5 text-[10px] uppercase text-slate-300">{d.type || "disk"}</span>
              </div>
              <div className="mt-1 break-words text-[11px] text-slate-400">
                {d.model || "Unknown model"} · {bytes(d.size)}
              </div>
              <div className="mt-2 flex items-end justify-between">
                <span className="text-2xl font-semibold"><TempText c={d.temp_c} kind={driveKind(d.devpath, d.type)} unit="°C" /></span>
                <span className="text-right text-[11px] text-slate-400">
                  <span className={healthColor(d.health)}>SMART {d.health}</span>
                  <br />
                  {d.life_left_pct == null ? "Wearout N/A" : `${d.life_left_pct}% life left`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ---------------- Thermal sensor settings ---------------- */

function SensorsTab() {
  return (
    <div className="h-full overflow-y-auto p-4">
      <ThermalSettingsPanel />
    </div>
  );
}

/* ---------------- Shell ---------------- */

const TABS = [
  { id: "cpu", label: "rm.tab.cpu", icon: Cpu, body: CpuTab },
  { id: "memory", label: "rm.tab.memory", icon: MemoryStick, body: MemoryTab },
  { id: "network", label: "rm.tab.network", icon: Network, body: NetworkTab },
  { id: "gpu", label: "rm.tab.gpu", icon: MonitorPlay, body: GpuTab },
  { id: "drives", label: "rm.tab.drives", icon: HardDrive, body: DrivesTab },
  { id: "sensors", label: "rm.tab.sensors", icon: SlidersHorizontal, body: SensorsTab },
] as const satisfies readonly { id: string; label: TKey; icon: unknown; body: () => ReactNode }[];

type TabId = (typeof TABS)[number]["id"];
// Old links: "performance" was the combined graphs tab, "hardware" the GPU & Sensors tab.
const LEGACY: Record<string, TabId> = { performance: "cpu", hardware: "gpu" };
const toTab = (t?: string): TabId => TABS.find((x) => x.id === t)?.id ?? LEGACY[t ?? ""] ?? "cpu";

export default function ResourceMonitor({ initialTab }: { initialTab?: string } = {}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>(toTab(initialTab));
  useEffect(() => void (initialTab && setTab(toTab(initialTab))), [initialTab]);
  const Body = TABS.find((x) => x.id === tab)!.body;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b border-white/10 bg-black/20 px-3 py-1.5" role="tablist">
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
            <Icon size={13} /> {t(label)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Body />
      </div>
    </div>
  );
}
