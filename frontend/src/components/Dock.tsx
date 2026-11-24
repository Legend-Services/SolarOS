import { useState } from "react";
import { useWindows } from "../lib/stores";
import { APPS, APP_IDS, type AppId } from "../apps/registry";

const SCALE = [1.45, 1.2, 1.05];

export default function Dock() {
  const windows = useWindows((s) => s.windows);
  const { open, focus, minimize } = useWindows();
  const [hover, setHover] = useState<number | null>(null);

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
      <div className="glass flex items-end gap-2 rounded-2xl px-3 py-2 shadow-2xl" onMouseLeave={() => setHover(null)}>
        {APP_IDS.map((id, i) => {
          const { title, icon: Icon, color } = APPS[id];
          const scale = hover === null ? 1 : (SCALE[Math.abs(hover - i)] ?? 1);
          const running = windows.some((w) => w.id === id);
          return (
            <button
              key={id}
              onClick={() => click(id)}
              onMouseEnter={() => setHover(i)}
              className="group relative flex flex-col items-center"
              aria-label={title}
              title={title}
            >
              <span
                style={{ transform: `scale(${scale}) translateY(${(1 - scale) * 12}px)` }}
                className={`flex h-11 w-11 origin-bottom items-center justify-center rounded-xl bg-gradient-to-br shadow-lg transition-transform duration-150 ${color}`}
              >
                <Icon size={22} className="text-white" />
              </span>
              <span className={`mt-1 h-1 w-1 rounded-full ${running ? "bg-white" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
