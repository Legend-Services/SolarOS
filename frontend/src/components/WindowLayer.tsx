import { lazy, Suspense, useRef, type ComponentType, type PointerEvent as RPointerEvent } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { useWindows, type Win } from "../lib/stores";
import { useIsMobile } from "../lib/hooks";
import { APPS, type AppId } from "../apps/registry";
import ResourceMonitor from "../apps/ResourceMonitor";
import ComputeManager from "../apps/ComputeManager";
import StorageManager from "../apps/StorageManager";
import FileStation from "../apps/FileStation";
import AppCenter from "../apps/AppCenter";
import SharesManager from "../apps/SharesManager";
import SystemApp from "../apps/SystemApp";
// noVNC + xterm.js are only downloaded when a console is opened.
const ConsoleApp = lazy(() => import("../apps/ConsoleApp"));
import type { ConsoleTarget } from "../lib/types";

const COMPONENTS: Record<AppId, ComponentType<{ params?: ConsoleTarget }>> = {
  monitor: ResourceMonitor,
  compute: ComputeManager,
  storage: StorageManager,
  files: FileStation,
  appcenter: AppCenter,
  shares: SharesManager,
  system: SystemApp,
  console: ConsoleApp,
};

const TOP = 36; // top bar height
const MIN_W = 360;
const MIN_H = 240;

function WindowFrame({ win, mobile }: { win: Win; mobile: boolean }) {
  const { focus, close, minimize, toggleMaximize, update } = useWindows();
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const full = mobile || win.maximized;
  const { icon: Icon } = APPS[win.id];
  const p = win.params;
  const title = p ? `${p.mode === "vnc" ? "Console" : "Shell"} — ${p.name} (${p.type === "node" ? "host" : p.vmid})` : APPS[win.id].title;
  const Body = COMPONENTS[win.id];

  const begin = (mode: "move" | "resize") => (e: RPointerEvent) => {
    if (full || e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y, ow: win.w, oh: win.h };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      // Keep at least part of the title bar reachable.
      update(win.key, {
        x: Math.min(Math.max(d.ox + dx, 80 - win.w), window.innerWidth - 80),
        y: Math.min(Math.max(d.oy + dy, TOP), window.innerHeight - 40),
      });
    } else {
      update(win.key, { w: Math.max(MIN_W, d.ow + dx), h: Math.max(MIN_H, d.oh + dy) });
    }
  };
  const end = () => (drag.current = null);

  const style = full
    ? { left: 0, top: TOP, width: "100%", height: `calc(100% - ${TOP}px)`, zIndex: win.z }
    : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z };

  return (
    <section
      role="dialog"
      aria-label={title}
      style={style}
      onPointerDown={() => focus(win.key)}
      className={`glass absolute flex flex-col overflow-hidden shadow-2xl shadow-black/50 ${full ? "rounded-none" : "rounded-xl"} ${
        win.minimized ? "hidden" : ""
      }`}
    >
      <header
        onPointerDown={begin("move")}
        onPointerMove={onMove}
        onPointerUp={end}
        onDoubleClick={() => !mobile && toggleMaximize(win.key)}
        className="flex h-10 shrink-0 cursor-default items-center gap-2 border-b border-white/10 bg-white/5 px-3 select-none"
      >
        <Icon size={15} className="text-slate-300" />
        <span className="flex-1 truncate text-sm font-medium text-slate-100">{title}</span>
        <button onClick={() => minimize(win.key)} className="rounded p-1.5 text-slate-300 hover:bg-white/10" aria-label="Minimize">
          <Minus size={14} />
        </button>
        {!mobile && (
          <button onClick={() => toggleMaximize(win.key)} className="rounded p-1.5 text-slate-300 hover:bg-white/10" aria-label="Maximize">
            {win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
        <button onClick={() => close(win.key)} className="rounded p-1.5 text-slate-300 hover:bg-rose-500/80 hover:text-white" aria-label="Close">
          <X size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<p className="p-4 text-sm text-slate-400">Loading…</p>}>
          <Body params={win.params} />
        </Suspense>
      </div>
      {!full && (
        <div
          onPointerDown={begin("resize")}
          onPointerMove={onMove}
          onPointerUp={end}
          className="absolute right-0 bottom-0 h-4 w-4 cursor-se-resize"
          aria-hidden
        />
      )}
    </section>
  );
}

export default function WindowLayer() {
  const windows = useWindows((s) => s.windows);
  const mobile = useIsMobile();
  return (
    <>
      {windows.map((w) => (
        <WindowFrame key={w.key} win={w} mobile={mobile} />
      ))}
    </>
  );
}
