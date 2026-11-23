import type { ReactNode } from "react";
import { useTelemetry } from "../lib/stores";
import { bytes, pct, uptime } from "../lib/format";
import { AreaChart, Legend } from "../components/charts";

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

export default function ResourceMonitor() {
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

      <Panel title="Memory" right={o ? `${pct(o.memory.used, total).toFixed(1)}% of ${bytes(total)}` : ""}>
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
            ["PVE", o?.pveversion],
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
