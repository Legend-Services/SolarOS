import { useLayoutEffect, useRef, useState } from "react";
import { useWindows } from "../lib/stores";
import { APPS, APP_IDS, type AppId } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";

const SCALE = [1.45, 1.2, 1.05];

export default function Dock() {
  const windows = useWindows((s) => s.windows);
  const { open, focus, minimize, setDockIconRect } = useWindows();
  const [hover, setHover] = useState<number | null>(null);
  const icons = useRef<Partial<Record<AppId, HTMLSpanElement | null>>>({});

  // Register unmagnified icon rects as minimize targets; re-measure when the viewport changes.
  useLayoutEffect(() => {
    const measure = () =>
      APP_IDS.forEach((id) => {
        const el = icons.current[id];
        if (!el) return;
        const r = el.getBoundingClientRect();
        setDockIconRect(id, { x: r.x, y: r.y, w: r.width, h: r.height });
      });
    measure();
    const settle = setTimeout(measure, 800); // after the unlock zoom-in transition of the desktop
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
    };
  }, [setDockIconRect]);

  const click = (id: AppId) => {
    const w = windows.find((x) => x.id === id);
    if (!w) return open(id);
    const top = Math.max(...windows.filter((x) => !x.minimized).map((x) => x.z), 0);
    // Clicking the focused app minimizes it, like macOS / DSM docks.
    if (!w.minimized && w.z === top) minimize(w.key);
    else focus(w.key);
  };

  return (
    <nav className="fixed inset-x-0 bottom-3 z-[9000] flex justify-center px-2" aria-label="Dock">
      <div className="glass flex items-end gap-2 rounded-[22px] px-3 pt-2 pb-1.5" onMouseLeave={() => setHover(null)}>
        {APP_IDS.map((id, i) => {
          const { title } = APPS[id];
          const scale = hover === null ? 1 : (SCALE[Math.abs(hover - i)] ?? 1);
          const running = windows.some((w) => w.id === id);
          return (
            <button
              key={id}
              onClick={() => click(id)}
              onMouseEnter={() => setHover(i)}
              className="group relative flex flex-col items-center"
              aria-label={title}
            >
              <span className="glass pointer-events-none absolute -top-9 rounded-md px-2 py-0.5 text-[11px] whitespace-nowrap text-slate-100 opacity-0 transition-opacity group-hover:opacity-100">
                {title}
              </span>
              <span
                ref={(el) => {
                  icons.current[id] = el;
                }}
                style={{ transform: `scale(${scale}) translateY(${(1 - scale) * 12}px)` }}
                className="block origin-bottom transition-transform duration-200 ease-out"
              >
                <AppIcon id={id} size={46} />
              </span>
              <span className={`mt-1 h-1 w-1 rounded-full transition-colors ${running ? "bg-white shadow-[0_0_6px_#fff]" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
