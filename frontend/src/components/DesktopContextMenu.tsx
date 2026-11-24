import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Container, Database, Image, Monitor, RefreshCw, SquareTerminal } from "lucide-react";
import { useDismiss } from "../lib/hooks";
import { useIntent, useTelemetry, useWindows } from "../lib/stores";

/** Frosted context menu for right-clicks on the desktop background. */
export default function DesktopContextMenu({ at, onClose }: { at: { x: number; y: number } | null; onClose: () => void }) {
  const ref = useDismiss(!!at, onClose);
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(at);
  const go = useIntent((s) => s.go);
  const open = useWindows((s) => s.open);
  const refreshStorage = useTelemetry((s) => s.refreshStorage);
  const node = useTelemetry((s) => s.overview?.node ?? "host");

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!at || !box.current) return setPos(at);
    const { width, height } = box.current.getBoundingClientRect();
    setPos({ x: Math.min(at.x, window.innerWidth - width - 8), y: Math.min(at.y, window.innerHeight - height - 8) });
  }, [at]);

  if (!at) return null;
  const item = (icon: ReactNode, label: string, fn: () => void) => (
    <button
      role="menuitem"
      onClick={() => (onClose(), fn())}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-xs text-slate-100 transition-colors hover:bg-sky-400/25 focus:bg-sky-400/25 focus:outline-none"
    >
      <span className="text-slate-300">{icon}</span>
      {label}
    </button>
  );
  const sep = <div className="my-1 h-px bg-white/10" />;

  return (
    <div
      ref={(el) => {
        ref.current = el;
        box.current = el;
      }}
      role="menu"
      aria-label="Desktop"
      onContextMenu={(e) => e.preventDefault()}
      className="glass-panel fixed z-[9400] w-56 rounded-xl p-1 shadow-2xl shadow-black/40"
      style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y }}
    >
      {item(<Monitor size={14} />, "New Virtual Machine", () => go("compute", "vm"))}
      {item(<Container size={14} />, "New Container", () => go("compute", "lxc"))}
      {item(<Database size={14} />, "Create ZFS Pool", () => go("storage", "pool"))}
      {sep}
      {item(<SquareTerminal size={14} />, "Open Terminal", () => open("console", { type: "node", vmid: 0, name: node, mode: "shell" }))}
      {item(<Image size={14} />, "Change Wallpaper", () => go("controlpanel", "appearance"))}
      {sep}
      {item(<RefreshCw size={14} />, "Refresh Telemetry", () => refreshStorage())}
    </div>
  );
}
