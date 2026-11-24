import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Boxes, Container, Database, Gauge as GaugeIcon, HeartPulse, Monitor } from "lucide-react";
import { useDock, usePrefs, useTelemetry, useWindows } from "../lib/stores";
import { useLayout } from "../store/layoutStore";
import { bytes, healthColor, pct, tempColor, uptime } from "../lib/format";
import { APPS, APP_IDS, type AppId } from "../apps/registry";
import { AppListRow } from "./ViewOptions";
import { TOP } from "./WindowFrame";
import { Bar, Gauge } from "./charts";
import { AppIcon } from "./icons/AppIcons";
import DesktopContextMenu from "./DesktopContextMenu";

function Widget({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="glass rounded-2xl p-4">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-300 uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Desktop() {
  const open = useWindows((s) => s.open);
  const { overview: o, storage, hardware, error } = useTelemetry();
  const gpu = hardware?.gpu;
  const widgets = usePrefs((s) => s.widgets);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { desktopView, iconSize, colGap, rowGap } = useLayout();
  const dockSize = useDock((s) => s.baseSize);

  // Shortcuts fill columns top to bottom and wrap into a new column when the next one would pass the Dock.
  // Row height is fixed per mode so `repeat(auto-fill, …)` can count how many rows fit.
  const font = Math.round(Math.min(14, Math.max(10, iconSize * 0.2)));
  const list = desktopView === "list";
  const listIcon = Math.round(Math.min(56, Math.max(28, iconSize * 0.6)));
  const cellW = list ? 300 : Math.max(84, iconSize + 32);
  const cellH = list ? Math.max(listIcon, 38) + 18 : iconSize + 22 + Math.ceil(font * 1.25 * 2); // list: two text lines need ~38px
  const launch = (id: AppId) => ({
    onDoubleClick: () => open(id),
    onKeyDown: (e: KeyboardEvent) => e.key === "Enter" && open(id),
    // Single tap opens on touch devices, which have no double-click.
    onPointerUp: (e: PointerEvent) => e.pointerType === "touch" && open(id),
  });

  return (
    <div
      className="absolute inset-0 flex gap-6 overflow-auto px-4"
      style={{ paddingTop: TOP + 20, paddingBottom: dockSize + 52 }}
      onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY }))}
    >
      <DesktopContextMenu at={menu} onClose={() => setMenu(null)} />
      {/* Shortcuts */}
      <div
        className="grid h-full shrink-0 content-start"
        style={{ gridAutoFlow: "column", gridTemplateRows: `repeat(auto-fill, ${cellH}px)`, gridAutoColumns: cellW, columnGap: colGap, rowGap }}
      >
        {APP_IDS.map((id) =>
          list ? (
            <AppListRow key={id} id={id} iconSize={listIcon} title={`Double-click to open ${APPS[id].title}`} {...launch(id)} />
          ) : (
            <button
              key={id}
              {...launch(id)}
              className="group flex flex-col items-center gap-1.5 rounded-xl p-2 text-center text-slate-100 drop-shadow hover:bg-white/10 focus:bg-white/10 focus:outline-none"
              style={{ fontSize: font, lineHeight: 1.25 }}
            >
              <AppIcon id={id} size={iconSize} className="shrink-0 transition-transform group-hover:scale-105 group-active:scale-95" />
              <span className="line-clamp-2">{APPS[id].title}</span>
            </button>
          ),
        )}
      </div>

      {/* Widgets */}
      <div className={`ml-auto hidden w-80 shrink-0 flex-col gap-4 ${widgets ? "md:flex" : ""}`}>
        {error && <div className="glass rounded-xl px-3 py-2 text-xs text-rose-300">{error}</div>}
        <Widget title="System Health" icon={<HeartPulse size={14} />}>
          <div className="flex justify-around">
            <Gauge value={o?.cpu ?? 0} label="CPU" sub={o ? `${o.cpuinfo.cpus} threads` : ""} color="#38bdf8" />
            <Gauge
              value={o ? pct(o.memory.used, o.memory.total) : 0}
              label="Memory"
              sub={o ? `${bytes(o.memory.used)} / ${bytes(o.memory.total)}` : ""}
              color="#a78bfa"
            />
          </div>
          <div className="mt-3 flex justify-between text-[11px] text-slate-400">
            <span>Uptime {o ? uptime(o.uptime) : "—"}</span>
            <span>Load {o?.loadavg.map((l) => l.toFixed(2)).join(" ") ?? "—"}</span>
          </div>
        </Widget>

        {gpu?.available && (
          <Widget title="GPU" icon={<GaugeIcon size={14} />}>
            <button onClick={() => open("monitor")} className="w-full space-y-2 text-left">
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-medium text-slate-100">{gpu.name}</span>
                <span className="shrink-0 pl-2 tabular-nums text-slate-300">
                  <span className={tempColor(gpu.temp_c)}>{gpu.temp_c ?? "—"}°C</span> · {gpu.power_w?.toFixed(0) ?? "—"} W
                </span>
              </div>
              <div className="flex justify-between text-[11px] text-slate-400">
                <span>Core {gpu.utilization_pct ?? 0}%</span>
                <span className="tabular-nums">
                  VRAM {((gpu.vram_used_mb ?? 0) / 1024).toFixed(1)} / {((gpu.vram_total_mb ?? 0) / 1024).toFixed(1)} GB
                </span>
              </div>
              <Bar value={pct(gpu.vram_used_mb ?? 0, gpu.vram_total_mb ?? 0)} className="bg-emerald-400" />
            </button>
          </Widget>
        )}

        <Widget title="ZFS Storage" icon={<Database size={14} />}>
          {!storage ? (
            <p className="text-xs text-slate-400">Loading…</p>
          ) : storage.pools.length === 0 ? (
            <p className="text-xs text-slate-400">No ZFS pools found.</p>
          ) : (
            <ul className="space-y-3">
              {storage.pools.map((p) => (
                <li key={p.name}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-medium text-slate-100">{p.name}</span>
                    <span className={healthColor(p.health)}>{p.health}</span>
                  </div>
                  <Bar value={pct(p.alloc, p.size)} className="bg-amber-400" />
                  <div className="mt-1 text-[11px] text-slate-400">
                    {bytes(p.alloc)} of {bytes(p.size)} used
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Widget>

        <Widget title="Compute" icon={<Boxes size={14} />}>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Virtual Machines", icon: <Monitor size={16} />, c: o?.vms },
              { label: "Containers", icon: <Container size={16} />, c: o?.containers },
            ].map(({ label, icon, c }) => (
              <button key={label} onClick={() => open("compute")} className="rounded-xl bg-white/5 p-3 text-left hover:bg-white/10">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  {icon}
                  {label}
                </div>
                <div className="mt-1 text-2xl font-semibold text-white tabular-nums">{c?.running ?? "–"}</div>
                <div className="text-[11px] text-slate-400">
                  running · {c?.stopped ?? 0} stopped
                </div>
              </button>
            ))}
          </div>
        </Widget>
      </div>
    </div>
  );
}
