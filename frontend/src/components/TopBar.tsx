import { useState, type ReactNode } from "react";
import { BookOpen, Bug, CircleHelp, Cpu, Database, LayoutDashboard, LayoutGrid, LifeBuoy, Lock, LogOut, MemoryStick, Search, SlidersHorizontal, Sparkles, SquareTerminal, User } from "lucide-react";
import { useLayout } from "../store/layoutStore";
import { useWizard } from "../store/wizardStore";
import { ViewOptionsPanel } from "./ViewOptions";
import { activeWindow, useAuth, useBugReport, useSpotlight, useTelemetry, useWindows, zfsHealth } from "../lib/stores";
import { useClock, useDismiss } from "../lib/hooks";
import TaskCenterPopover from "./TaskCenterPopover";
import NotificationPopover from "./NotificationPopover";
import { ModeToggle, ThemeSwitcher } from "./ThemeQuickSwitcher";
import { pct } from "../lib/format";
import { APPS, APP_IDS } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";

export function Pill({ icon, label, tone = "text-slate-200" }: { icon: ReactNode; label: string; tone?: string }) {
  return (
    <span className={`hidden items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 tabular-nums sm:inline-flex ${tone}`}>
      {icon}
      {label}
    </span>
  );
}

export default function TopBar() {
  const now = useClock();
  const windows = useWindows((s) => s.windows);
  const open = useWindows((s) => s.open);
  const overview = useTelemetry((s) => s.overview);
  const storage = useTelemetry((s) => s.storage);
  const { username, lock, logout } = useAuth();
  const openSpotlight = useSpotlight((s) => s.set);
  const openBugReport = useBugReport((s) => s.set);
  const [launcher, setLauncher] = useState(false);
  const [menu, setMenu] = useState(false);
  const launcherRef = useDismiss(launcher, () => setLauncher(false));
  const menuRef = useDismiss(menu, () => setMenu(false));
  const viewPanel = useLayout((s) => s.panel);
  const setLayout = useLayout((s) => s.set);
  const viewRef = useDismiss(viewPanel, () => setLayout({ panel: false }));

  const active = activeWindow(windows);
  const health = zfsHealth(storage);
  const ram = overview ? pct(overview.memory.used, overview.memory.total) : 0;

  return (
    <header className="glass fixed inset-x-0 top-0 z-[9000] flex h-9 items-center gap-3 border-x-0 border-t-0 bg-slate-900/55 px-2 text-xs">
      <div ref={launcherRef} className="relative">
        <button
          onClick={() => setLauncher((v) => !v)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-white hover:bg-white/10"
          aria-expanded={launcher}
          aria-label="Open launcher"
        >
          <LayoutGrid size={15} /> <span className="hidden sm:inline">SolarDeck</span>
        </button>
        {launcher && (
          <div className="glass absolute top-8 left-0 grid w-80 grid-cols-3 gap-1 rounded-2xl p-3">
            {APP_IDS.map((id) => {
              const { title } = APPS[id];
              return (
                <button
                  key={id}
                  onClick={() => {
                    open(id);
                    setLauncher(false);
                  }}
                  className="flex flex-col items-center gap-2 rounded-xl p-3 text-center text-slate-200 transition hover:bg-white/10 active:scale-95"
                >
                  <AppIcon id={id} size={44} />
                  {title}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 truncate font-medium text-slate-300">{active ? APPS[active.id].title : "Desktop"}</div>

      <Pill icon={<Cpu size={12} />} label={`${overview ? overview.cpu.toFixed(0) : "–"}%`} />
      <Pill icon={<MemoryStick size={12} />} label={`${ram.toFixed(0)}%`} />
      <Pill
        icon={<Database size={12} />}
        label={health}
        tone={health === "ONLINE" ? "text-emerald-300" : health === "N/A" || health === "—" ? "text-slate-400" : "text-rose-300"}
      />
      <button
        onClick={() => openSpotlight(true)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
        aria-label="Search (Ctrl+K)"
        title="Search (⌘K / Ctrl+K)"
      >
        <Search size={14} />
      </button>
      <button
        onClick={() => open("terminal")}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
        aria-label="Host Shell"
        title="Host Shell (root on the Proxmox host)"
      >
        <SquareTerminal size={14} />
      </button>
      <div ref={viewRef} className="relative">
        <button
          onClick={() => setLayout({ panel: !viewPanel })}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 ${viewPanel ? "bg-white/10" : ""}`}
          aria-expanded={viewPanel}
          aria-label="View Settings"
          title="View Settings: Grid or List, icon size and spacing"
        >
          <LayoutDashboard size={14} />
        </button>
        {viewPanel && <ViewOptionsPanel />}
      </div>
      <ModeToggle />
      <ThemeSwitcher />
      <HelpMenu />
      <TaskCenterPopover />
      <NotificationPopover />
      <span className="tabular-nums text-slate-200">
        {now.toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>

      <div ref={menuRef} className="relative">
        <button
          onClick={() => setMenu((v) => !v)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
          aria-expanded={menu}
          aria-label="User menu"
        >
          <User size={14} /> <span className="hidden sm:inline">{username}</span>
        </button>
        {menu && (
          <div className="glass absolute top-8 right-0 w-44 rounded-xl p-1">
            <button
              onClick={() => (open("controlpanel"), setMenu(false))}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10"
            >
              <SlidersHorizontal size={14} /> Control Panel
            </button>
            <button onClick={() => (openBugReport(true), setMenu(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
              <Bug size={14} /> Report a Bug
            </button>
            <button onClick={lock} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
              <Lock size={14} /> Lock
            </button>
            <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-rose-300 hover:bg-white/10">
              <LogOut size={14} /> Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/** Help: guide for the focused app, Welcome Tour, Help & Support and the bug reporter. `up` opens it above (taskbar). */
export function HelpMenu({ up = false }: { up?: boolean }) {
  const [help, setHelp] = useState(false);
  const helpRef = useDismiss(help, () => setHelp(false));
  const showGuide = useWizard((s) => s.show);
  const open = useWindows((s) => s.open);
  const active = activeWindow(useWindows((s) => s.windows));
  const openBugReport = useBugReport((s) => s.set);
  return (
    <div ref={helpRef} className="relative">
      <button
        onClick={() => setHelp((v) => !v)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
        aria-expanded={help}
        aria-label="Help menu"
        title="Help: guides, Welcome Tour, tutorials and automatic fixes"
      >
        <CircleHelp size={14} />
      </button>
      {help && (
        <div className={`glass absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-56 rounded-xl p-1 text-xs`}>
          {active && (
            <button onClick={() => (showGuide(active.id), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
              <BookOpen size={14} /> Guide: {APPS[active.id].title}
            </button>
          )}
          <button onClick={() => (showGuide("welcome"), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
            <Sparkles size={14} /> Welcome Tour
          </button>
          <button onClick={() => (open("help"), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
            <LifeBuoy size={14} /> Help &amp; Support
          </button>
          <button onClick={() => (openBugReport(true), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
            <Bug size={14} /> Report a Bug
          </button>
        </div>
      )}
    </div>
  );
}
