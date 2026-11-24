import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Cpu, Database, LayoutDashboard, LayoutGrid, Lock, LogOut, MemoryStick, Search, SlidersHorizontal, SquareTerminal, User } from "lucide-react";
import { activateApp, activeWindow, useAuth, useDock, useSpotlight, useTelemetry, useWindows, zfsHealth } from "../lib/stores";
import { useClock, useDismiss } from "../lib/hooks";
import { pct } from "../lib/format";
import { useLayout } from "../store/layoutStore";
import { APPS, APP_IDS, type AppId } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";
import { ViewOptionsPanel } from "./ViewOptions";
import { HelpMenu, Pill } from "./TopBar";
import TaskCenterPopover from "./TaskCenterPopover";
import NotificationPopover from "./NotificationPopover";

/* One bar along the bottom (the alternative to top bar + Dock): Start, search and app buttons in the middle,
   status, help, tasks, notifications and the clock on the right. Popovers open upwards. */

function BarButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-md text-slate-100 transition hover:bg-white/10 active:scale-95 ${active ? "bg-white/10" : ""}`}
    >
      {children}
    </button>
  );
}

function StartMenu({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const open = useWindows((s) => s.open);
  const { username, lock, logout } = useAuth();
  const q = query.trim().toLowerCase();
  const apps = APP_IDS.filter((id) => !q || `${APPS[id].title} ${APPS[id].desc}`.toLowerCase().includes(q));
  const launch = (id: AppId) => (open(id), onClose());
  return (
    <div className="glass-panel fixed bottom-14 left-1/2 flex max-h-[calc(100vh-5rem)] w-[min(36rem,calc(100vw-1rem))] -translate-x-1/2 flex-col rounded-2xl text-xs" role="dialog" aria-label="Start">
      <div className="p-4 pb-2">
        <label className="relative block">
          <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apps[0] && launch(apps[0])}
            placeholder="Search apps"
            aria-label="Search apps"
            className="glass-field w-full rounded-full py-2 pl-9 text-sm"
          />
        </label>
      </div>
      <p className="px-5 pt-1 pb-2 text-[11px] font-semibold text-slate-300">{q ? "Results" : "All apps"}</p>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-1 overflow-auto px-3 pb-3 sm:grid-cols-6">
        {apps.map((id) => (
          <button key={id} type="button" onClick={() => launch(id)} title={APPS[id].desc} className="flex flex-col items-center gap-1.5 rounded-lg p-2 text-center text-[11px] text-slate-200 transition hover:bg-white/10 active:scale-95">
            <AppIcon id={id} size={36} />
            <span className="line-clamp-2">{APPS[id].title}</span>
          </button>
        ))}
        {apps.length === 0 && <p className="col-span-full py-4 text-center text-slate-400">No apps match “{query}”.</p>}
      </div>
      <div className="flex items-center gap-1 border-t border-white/10 bg-black/20 px-4 py-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-200">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10">
            <User size={14} />
          </span>
          <span className="truncate">{username}</span>
        </span>
        <BarButton label="Control Panel" onClick={() => launch("controlpanel")}>
          <SlidersHorizontal size={15} />
        </BarButton>
        <BarButton label="Lock" onClick={lock}>
          <Lock size={15} />
        </BarButton>
        <BarButton label="Log out" onClick={logout}>
          <LogOut size={15} className="text-rose-300" />
        </BarButton>
      </div>
    </div>
  );
}

export default function Taskbar() {
  const now = useClock();
  const windows = useWindows((s) => s.windows);
  const { open, close, minimize, setDockIconRect } = useWindows();
  const { pinned, pin, unpin } = useDock();
  const overview = useTelemetry((s) => s.overview);
  const storage = useTelemetry((s) => s.storage);
  const openSpotlight = useSpotlight((s) => s.set);
  const viewPanel = useLayout((s) => s.panel);
  const setLayout = useLayout((s) => s.set);
  const [start, setStart] = useState(false);
  const [menu, setMenu] = useState<AppId | null>(null);
  const startRef = useDismiss(start, () => setStart(false));
  const menuRef = useDismiss(!!menu, () => setMenu(null));
  const viewRef = useDismiss(viewPanel, () => setLayout({ panel: false }));
  const icons = useRef<Partial<Record<AppId, HTMLButtonElement | null>>>({});

  // Pinned apps first, then running apps that are not pinned.
  const running = [...new Set(windows.map((w) => w.id))].filter((id) => id !== "console" && !pinned.includes(id));
  const tasks: AppId[] = [...pinned, ...running];
  const active = activeWindow(windows);
  const health = zfsHealth(storage);
  const ram = overview ? pct(overview.memory.used, overview.memory.total) : 0;

  // Taskbar buttons are the minimize targets (the same rects the Dock registers in the other layout).
  const layoutKey = tasks.join(",");
  useLayoutEffect(() => {
    const measure = () =>
      Object.entries(icons.current).forEach(([id, el]) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        setDockIconRect(id as AppId, { x: r.x, y: r.y, w: r.width, h: r.height });
      });
    const t = setTimeout(measure, 350);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [setDockIconRect, layoutKey]);

  const showDesktop = () => windows.filter((w) => !w.minimized).forEach((w) => minimize(w.key));

  return (
    <footer className="glass fixed inset-x-0 bottom-0 z-[9000] flex h-12 items-center gap-1 border-x-0 border-b-0 bg-slate-900/75 pl-2 text-xs" aria-label="Taskbar">
      <div className="flex-1 max-md:hidden" />
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        <div ref={startRef} className="relative">
          <BarButton label="Start" onClick={() => setStart((v) => !v)} active={start}>
            <LayoutGrid size={20} className="text-sky-300" />
          </BarButton>
          {start && <StartMenu onClose={() => setStart(false)} />}
        </div>
        <BarButton label="Search (Ctrl+K)" onClick={() => openSpotlight(true)}>
          <Search size={18} />
        </BarButton>
        {tasks.map((id) => {
          const isRunning = windows.some((w) => w.id === id);
          const focused = active?.id === id;
          const isPinned = pinned.includes(id);
          return (
            <div key={id} className="relative">
              <button
                ref={(el) => {
                  icons.current[id] = el;
                }}
                type="button"
                onClick={() => activateApp(id)}
                onContextMenu={(e) => (e.preventDefault(), setMenu(id))}
                aria-label={APPS[id].title}
                aria-pressed={focused}
                title={APPS[id].title}
                className={`relative flex h-10 w-10 items-center justify-center rounded-md transition hover:bg-white/10 active:scale-95 ${focused ? "bg-white/10" : ""}`}
              >
                <AppIcon id={id} size={26} />
                {isRunning && (
                  <span className={`absolute bottom-0.5 left-1/2 h-[3px] -translate-x-1/2 rounded-full transition-all ${focused ? "w-4 bg-sky-400" : "w-1.5 bg-slate-300"}`} />
                )}
              </button>
              {menu === id && (
                <div ref={menuRef} className="glass absolute bottom-full left-1/2 mb-2 w-48 -translate-x-1/2 rounded-xl p-1 text-slate-100" role="menu">
                  <MenuItem onClick={() => (activateApp(id), setMenu(null))}>{isRunning ? "Show" : "Open"}</MenuItem>
                  {isRunning && <MenuItem onClick={() => (open(id), setMenu(null))}>New window</MenuItem>}
                  <MenuItem onClick={() => ((isPinned ? unpin : pin)(id), setMenu(null))}>{isPinned ? "Unpin from taskbar" : "Pin to taskbar"}</MenuItem>
                  {isRunning && (
                    <MenuItem danger onClick={() => (windows.filter((w) => w.id === id).forEach((w) => close(w.key)), setMenu(null))}>
                      Close window
                    </MenuItem>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-1 items-center justify-end gap-1">
        <Pill icon={<Cpu size={12} />} label={`${overview ? overview.cpu.toFixed(0) : "–"}%`} />
        <Pill icon={<MemoryStick size={12} />} label={`${ram.toFixed(0)}%`} />
        <span className="max-lg:hidden">
          <Pill
            icon={<Database size={12} />}
            label={health}
            tone={health === "ONLINE" ? "text-emerald-300" : health === "N/A" || health === "—" ? "text-slate-400" : "text-rose-300"}
          />
        </span>
        <button onClick={() => open("terminal")} className="rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 max-sm:hidden" aria-label="Host Shell" title="Host Shell (root on the Proxmox host)">
          <SquareTerminal size={14} />
        </button>
        <div ref={viewRef} className="relative max-sm:hidden">
          <button
            onClick={() => setLayout({ panel: !viewPanel })}
            className={`rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 ${viewPanel ? "bg-white/10" : ""}`}
            aria-expanded={viewPanel}
            aria-label="View Settings"
            title="View Settings: layout, icons and spacing"
          >
            <LayoutDashboard size={14} />
          </button>
          {viewPanel && <ViewOptionsPanel up />}
        </div>
        <HelpMenu up />
        <TaskCenterPopover up />
        <NotificationPopover up />
        <span className="flex flex-col items-end px-2 leading-tight tabular-nums text-slate-200">
          <span>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="text-[10px] text-slate-400">{now.toLocaleDateString()}</span>
        </span>
        {/* Thin strip at the far right: minimize every window to show the desktop. */}
        <button onClick={showDesktop} className="h-12 w-2 border-l border-white/15 hover:bg-white/15" aria-label="Show desktop" title="Show desktop" />
      </div>
    </footer>
  );
}

function MenuItem({ children, onClick, danger }: { children: string; onClick: () => void; danger?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={`block w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10 ${danger ? "text-rose-300" : ""}`}>
      {children}
    </button>
  );
}
