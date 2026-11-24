import { Suspense, useEffect, useRef, useState, type ComponentType, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, Maximize2, Minimize2, Minus, X } from "lucide-react";
import { useWindows, type Rect, type Win } from "../lib/stores";
import { useWizard } from "../store/wizardStore";
import { APPS } from "../apps/registry";
import WindowErrorBoundary from "./WindowErrorBoundary";
import type { ConsoleTarget } from "../lib/types";

export const TOP = 36; // top bar height
const MIN_W = 360;
const MIN_H = 240;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DUR = 280;
const CLOSE_MS = 200;
const EDGE = 6; // px from a screen edge that triggers snapping

type Snap = "left" | "right" | "top" | null;
type Phase = "enter" | "open" | "exit";

const snapRect = (s: Exclude<Snap, null>): Rect => {
  const vw = window.innerWidth;
  const h = window.innerHeight - TOP;
  return s === "left" ? { x: 0, y: TOP, w: vw / 2, h } : s === "right" ? { x: vw / 2, y: TOP, w: vw / 2, h } : { x: 0, y: TOP, w: vw, h };
};

/** Transform that shrinks the frame `r` onto the centre of `target` (genie-style scale-to-dock). */
function towards(r: Rect, target: Rect | undefined) {
  const t = target ?? { x: window.innerWidth / 2 - 23, y: window.innerHeight - 60, w: 46, h: 46 };
  const dx = t.x + t.w / 2 - (r.x + r.w / 2);
  const dy = t.y + t.h / 2 - (r.y + r.h / 2);
  return `translate(${dx}px, ${dy}px) scale(${Math.max(0.04, t.w / r.w)})`;
}

export default function WindowFrame({ win, mobile, Body }: { win: Win; mobile: boolean; Body: ComponentType<{ params?: ConsoleTarget }> }) {
  const { focus, close, minimize, toggleMaximize, update } = useWindows();
  const dockRect = useWindows((s) => s.dockIconRects[win.id]);
  const showGuide = useWizard((s) => s.show); // guide ids match app ids (APP_GUIDES)
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [snap, setSnap] = useState<Snap>(null);
  const [phase, setPhase] = useState<Phase>("enter");
  const full = mobile || win.maximized;
  const { icon: Icon } = APPS[win.id];
  const p = win.params;
  const title = p ? `${p.mode === "vnc" ? "Console" : "Shell"} — ${p.name} (${p.type === "node" ? "host" : p.vmid})` : APPS[win.id].title;

  useEffect(() => {
    const r = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(r);
  }, []);

  const doClose = () => {
    setPhase("exit");
    setTimeout(() => close(win.key), CLOSE_MS);
  };

  const begin = (mode: "move" | "resize") => (e: RPointerEvent) => {
    if (full || e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y, ow: win.w, oh: win.h };
    setDragging(true);
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
      const next: Snap =
        e.clientX <= EDGE ? "left" : e.clientX >= window.innerWidth - EDGE ? "right" : e.clientY <= TOP + EDGE ? "top" : null;
      if (next !== snap) setSnap(next);
    } else {
      update(win.key, { w: Math.max(MIN_W, d.ow + dx), h: Math.max(MIN_H, d.oh + dy) });
    }
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (snap === "top") update(win.key, { maximized: true });
    // shortcut: half-screen snapping overwrites the free geometry instead of remembering it; add a restore rect if users ask.
    else if (snap) update(win.key, snapRect(snap));
    setSnap(null);
  };

  const rect: Rect = full ? { x: 0, y: TOP, w: window.innerWidth, h: window.innerHeight - TOP } : win;
  // Geometry transitions (maximize / snap) are disabled while the pointer drives the frame.
  const geo = dragging ? "" : `, left ${DUR}ms ${EASE}, top ${DUR}ms ${EASE}, width ${DUR}ms ${EASE}, height ${DUR}ms ${EASE}`;
  const transform =
    win.minimized ? towards(rect, dockRect) : phase === "enter" ? "scale(0.94)" : phase === "exit" ? "scale(0.95)" : "translate(0px, 0px) scale(1)";
  const style: CSSProperties = {
    ...(full ? { left: 0, top: TOP, width: "100%", height: `calc(100% - ${TOP}px)` } : { left: win.x, top: win.y, width: win.w, height: win.h }),
    zIndex: win.z,
    transform,
    transformOrigin: "center",
    opacity: win.minimized || phase !== "open" ? 0 : 1,
    visibility: win.minimized ? "hidden" : "visible",
    pointerEvents: win.minimized || phase === "exit" ? "none" : undefined,
    transition: `transform ${DUR}ms ${EASE}, opacity ${phase === "exit" ? CLOSE_MS : DUR}ms ${EASE}, visibility ${DUR}ms${geo}`,
  };

  return (
    <>
      <section
        role="dialog"
        aria-label={title}
        aria-hidden={win.minimized}
        style={style}
        onPointerDown={() => focus(win.key)}
        className={`glass absolute flex flex-col overflow-hidden shadow-2xl shadow-black/50 ${full ? "rounded-none" : "rounded-2xl"}`}
      >
        <header
          onPointerDown={begin("move")}
          onPointerMove={onMove}
          onPointerUp={end}
          onPointerCancel={end}
          onDoubleClick={() => !mobile && toggleMaximize(win.key)}
          className="flex h-10 shrink-0 cursor-default items-center gap-2 border-b border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.02] px-3 select-none"
        >
          <Icon size={15} className="text-slate-300" />
          <span className="flex-1 truncate text-sm font-medium text-slate-100">{title}</span>
          <button
            onClick={() => showGuide(win.id)}
            className="flex items-center gap-1 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-slate-200 ring-1 ring-white/10 transition ring-inset hover:bg-sky-400/25 hover:text-white active:scale-95"
            aria-label={`Step-by-step guide for ${APPS[win.id].title}`}
            title="Step-by-step guide for this app"
          >
            <CircleHelp size={12} /> Guide
          </button>
          <button onClick={() => minimize(win.key)} className="rounded-md p-1.5 text-slate-300 transition hover:bg-white/10 active:scale-90" aria-label="Minimize">
            <Minus size={14} />
          </button>
          {!mobile && (
            <button onClick={() => toggleMaximize(win.key)} className="rounded-md p-1.5 text-slate-300 transition hover:bg-white/10 active:scale-90" aria-label={win.maximized ? "Restore" : "Maximize"}>
              {win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button onClick={doClose} className="rounded-md p-1.5 text-slate-300 transition hover:bg-rose-500/80 hover:text-white active:scale-90" aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <WindowErrorBoundary app={APPS[win.id].title}>
            <Suspense fallback={<p className="p-4 text-sm text-slate-400">Loading…</p>}>
              <Body params={win.params} />
            </Suspense>
          </WindowErrorBoundary>
        </div>
        {!full && (
          <div
            onPointerDown={begin("resize")}
            onPointerMove={onMove}
            onPointerUp={end}
            onPointerCancel={end}
            className="absolute right-0 bottom-0 h-4 w-4 cursor-se-resize"
            aria-hidden
          />
        )}
      </section>
      {/* Portal: inside the frame, `fixed` would resolve against the frame's transform instead of the screen. */}
      {snap &&
        createPortal(
          (() => {
            const r = snapRect(snap);
            return <div className="snap-preview" style={{ left: r.x + 8, top: r.y + 8, width: r.w - 16, height: r.h - 16 }} />;
          })(),
          document.body,
        )}
    </>
  );
}
