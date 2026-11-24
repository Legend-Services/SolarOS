import { useState, type ReactNode } from "react";
import { Cpu, Database, LayoutGrid, Lock, LogOut, MemoryStick, User } from "lucide-react";
import { activeWindow, useAuth, useTelemetry, useWindows, zfsHealth } from "../lib/stores";
import { useClock, useDismiss } from "../lib/hooks";
import TaskCenterPopover from "./TaskCenterPopover";
import NotificationPopover from "./NotificationPopover";
import { pct } from "../lib/format";
import { APPS, APP_IDS } from "../apps/registry";

function Pill({ icon, label, tone = "text-slate-200" }: { icon: ReactNode; label: string; tone?: string }) {
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
  const [launcher, setLauncher] = useState(false);
  const [menu, setMenu] = useState(false);
  const launcherRef = useDismiss(launcher, () => setLauncher(false));
  const menuRef = useDismiss(menu, () => setMenu(false));

  const active = activeWindow(windows);
  const health = zfsHealth(storage);
  const ram = overview ? pct(overview.memory.used, overview.memory.total) : 0;

  return (
    <header className="glass fixed inset-x-0 top-0 z-[9000] flex h-9 items-center gap-3 border-x-0 border-t-0 px-2 text-xs">
      <div ref={launcherRef} className="relative">
        <button
          onClick={() => setLauncher((v) => !v)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-white hover:bg-white/10"
          aria-expanded={launcher}
          aria-label="Open launcher"
        >
          <LayoutGrid size={15} /> <span className="hidden sm:inline">ProxmoxOS</span>
        </button>
        {launcher && (
          <div className="glass absolute top-8 left-0 grid w-72 grid-cols-2 gap-2 rounded-xl p-3 shadow-2xl">
            {APP_IDS.map((id) => {
              const { title, icon: Icon, color } = APPS[id];
              return (
                <button
                  key={id}
                  onClick={() => {
                    open(id);
                    setLauncher(false);
                  }}
                  className="flex flex-col items-center gap-2 rounded-lg p-3 text-slate-200 hover:bg-white/10"
                >
                  <span className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${color}`}>
                    <Icon size={20} className="text-white" />
                  </span>
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
          <div className="glass absolute top-8 right-0 w-40 rounded-xl p-1 shadow-2xl">
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
