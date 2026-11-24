import { useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent } from "react";
import { LayoutGrid } from "lucide-react";
import { MAGNIFICATION, activateApp, useDock, useWindows } from "../lib/stores";
import { APPS, type AppId } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";
import { useDismiss } from "../lib/hooks";
import { dockSizes } from "../lib/dockMath";
import Launchpad from "./Launchpad";
import { useLayout } from "../store/layoutStore";


const LAUNCHPAD = "launchpad";
type Slot = AppId | typeof LAUNCHPAD;

export default function Dock() {
  const windows = useWindows((s) => s.windows);
  const { close, setDockIconRect } = useWindows();
  const { pinned, autoHide, baseSize, magnification, launchpad, pin, unpin, move, set } = useDock();
  const gap = useLayout((s) => s.dockGap);
  const [mouseX, setMouseX] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState<AppId | null>(null);
  const [drag, setDrag] = useState<AppId | null>(null);
  const icons = useRef<Partial<Record<AppId, HTMLSpanElement | null>>>({});
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const menuRef = useDismiss(!!menu, () => setMenu(null));

  // Launchpad first, then pinned apps, then running apps that are not pinned (after a divider).
  const running = [...new Set(windows.map((w) => w.id))].filter((id) => id !== "console" && !pinned.includes(id));
  const slots: Slot[] = [LAUNCHPAD, ...pinned, ...running];
  const sizes = dockSizes(slots.length, baseSize, gap, MAGNIFICATION[magnification], mouseX);
  const shown = !autoHide || revealed || launchpad || !!menu;

  // Register unmagnified icon rects as minimize targets; re-measure when the layout changes.
  const layoutKey = slots.join(",") + baseSize + gap + shown;
  useLayoutEffect(() => {
    const measure = () =>
      Object.entries(icons.current).forEach(([id, el]) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        setDockIconRect(id as AppId, { x: r.x, y: r.y, w: r.width, h: r.height });
      });
    const t = setTimeout(measure, 350); // after size / auto-hide transitions
    const settle = setTimeout(measure, 800); // after the unlock zoom-in transition of the desktop
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
    };
  }, [setDockIconRect, layoutKey]);

  const click = activateApp;

  const reveal = () => {
    clearTimeout(hideTimer.current);
    setRevealed(true);
  };
  const leave = () => {
    setMouseX(null);
    hideTimer.current = setTimeout(() => setRevealed(false), 400);
  };
  const onMove = (e: RMouseEvent) => setMouseX(drag ? null : e.clientX - window.innerWidth / 2);
  const onDrop = (e: DragEvent, target: number) => {
    e.preventDefault();
    if (drag) move(drag, target);
    setDrag(null);
  };

  return (
    <>
      {autoHide && <div className="fixed inset-x-0 bottom-0 z-[9000] h-2" onMouseEnter={reveal} aria-hidden />}
      <nav
        className={`pointer-events-none fixed inset-x-0 bottom-3 z-[9000] flex justify-center px-2 transition-transform duration-300 ease-out ${shown ? "" : "translate-y-[calc(100%+1rem)]"}`}
        aria-label="Dock"
      >
        <div
          className="glass pointer-events-auto flex items-end rounded-[22px] px-3 pb-1.5"
          style={{ gap, height: baseSize + 22 }}
          onMouseMove={onMove}
          onMouseEnter={reveal}
          onMouseLeave={leave}
        >
          {slots.map((slot, i) => {
            const size = sizes[i];
            const ease = mouseX === null ? "transition-[width,height] duration-200 ease-out" : "";
            if (slot === LAUNCHPAD)
              return (
                <button key={slot} onClick={() => set({ launchpad: !launchpad })} className="group relative flex flex-col items-center" aria-label="Launchpad — all apps">
                  <Label text="Launchpad" />
                  <span className={`flex items-center justify-center rounded-[28%] bg-gradient-to-br from-slate-200/90 to-slate-500/80 text-slate-900 shadow-lg shadow-black/40 ${ease}`} style={{ width: size, height: size }}>
                    <LayoutGrid size={size * 0.5} />
                  </span>
                  <span className="mt-1 h-1 w-1" />
                </button>
              );
            const id = slot;
            const isPinned = i <= pinned.length;
            const isRunning = windows.some((w) => w.id === id);
            return (
              <div key={id} className="relative flex items-end" style={{ gap }}>
                {i === pinned.length + 1 && <span className="mb-2 h-8 w-px self-end bg-white/20" aria-hidden />}
                <button
                  draggable={isPinned}
                  onDragStart={() => setDrag(id)}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => isPinned && drag && e.preventDefault()}
                  onDrop={(e) => onDrop(e, i - 1)}
                  onClick={() => click(id)}
                  onContextMenu={(e) => (e.preventDefault(), setMenu(id))}
                  className={`group relative flex flex-col items-center ${drag === id ? "opacity-40" : ""}`}
                  aria-label={APPS[id].title}
                >
                  {menu !== id && <Label text={APPS[id].title} />}
                  <span
                    ref={(el) => {
                      icons.current[id] = el;
                    }}
                    className={`block ${ease}`}
                    style={{ width: size, height: size }}
                  >
                    <AppIcon id={id} size={size} />
                  </span>
                  <span className={`mt-1 h-1 w-1 rounded-full transition-colors ${isRunning ? "bg-white shadow-[0_0_6px_#fff]" : "bg-transparent"}`} />
                </button>
                {menu === id && (
                  <div ref={menuRef} className="glass absolute bottom-full left-1/2 mb-2 w-44 -translate-x-1/2 rounded-xl p-1 text-xs text-slate-100" role="menu">
                    <MenuItem onClick={() => (click(id), setMenu(null))}>{isRunning ? "Show" : "Open"}</MenuItem>
                    <MenuItem onClick={() => ((isPinned ? unpin : pin)(id), setMenu(null))}>{isPinned ? "Remove from Dock" : "Keep in Dock"}</MenuItem>
                    {isRunning && (
                      <MenuItem danger onClick={() => (windows.filter((w) => w.id === id).forEach((w) => close(w.key)), setMenu(null))}>
                        Quit
                      </MenuItem>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>
      <Launchpad />
    </>
  );
}

function Label({ text }: { text: string }) {
  return (
    <span className="glass pointer-events-none absolute -top-9 rounded-md px-2 py-0.5 text-[11px] whitespace-nowrap text-slate-100 opacity-0 transition-opacity group-hover:opacity-100">
      {text}
    </span>
  );
}

function MenuItem({ children, onClick, danger }: { children: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={`block w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10 ${danger ? "text-rose-300" : ""}`}>
      {children}
    </button>
  );
}
