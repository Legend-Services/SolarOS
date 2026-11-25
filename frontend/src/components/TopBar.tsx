import { useState, type ReactNode } from "react";
import { ArrowUpCircle, BookOpen, Bug, CircleHelp, Cpu, Database, LayoutDashboard, LayoutGrid, LifeBuoy, Lock, LogOut, MemoryStick, Search, SlidersHorizontal, Sparkles, SquareTerminal, User } from "lucide-react";
import { useLayout } from "../store/layoutStore";
import { useWizard } from "../store/wizardStore";
import { ViewOptionsPanel } from "./ViewOptions";
import { activeWindow, openLink, useAuth, useBugReport, useRelease, useReleasePoll, useSpotlight, useTelemetry, useWindows, zfsHealth } from "../lib/stores";
import { useClock, useDismiss } from "../lib/hooks";
import TaskCenterPopover from "./TaskCenterPopover";
import NotificationPopover from "./NotificationPopover";
import { ModeToggle, ThemeSwitcher } from "./ThemeQuickSwitcher";
import { percent } from "../lib/format";
import { APP_IDS } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";
import LanguagePill from "./LanguagePill";
import { useTranslation } from "../i18n";
import { productOf, useCapabilities } from "../store/capabilitiesStore";

export function Pill({ icon, label, tone = "text-slate-200", onClick, title }: { icon: ReactNode; label: string; tone?: string; onClick?: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title ? `${title}: ${label}` : label}
      className={`hidden items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 tabular-nums transition hover:bg-white/15 sm:inline-flex ${tone}`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Telemetry pills + update badge shared by the top bar and the taskbar; each opens its Settings sub-module. */
export function StatusPills() {
  const { t } = useTranslation();
  const overview = useTelemetry((s) => s.overview);
  const storage = useTelemetry((s) => s.storage);
  const update = useRelease((s) => s.update);
  useReleasePoll();
  const health = zfsHealth(storage);
  const ram = overview ? percent(overview.memory.used, overview.memory.total) : 0;
  const monitor = () => openLink("settings", "resource-monitor");
  return (
    <>
      {update && (
        <Pill icon={<ArrowUpCircle size={12} />} label={t("top.update")} tone="text-amber-300" onClick={() => openLink("settings", "software-updates")} title={t("set.mod.software-updates")} />
      )}
      <Pill icon={<Cpu size={12} />} label={`${overview ? overview.cpu.toFixed(0) : "–"}%`} onClick={monitor} title={t("set.mod.resource-monitor")} />
      <Pill icon={<MemoryStick size={12} />} label={`${ram.toFixed(0)}%`} onClick={monitor} title={t("set.mod.resource-monitor")} />
      <span className="max-lg:hidden">
        <Pill
          icon={<Database size={12} />}
          label={health}
          tone={health === "ONLINE" ? "text-emerald-300" : health === "N/A" || health === "—" ? "text-slate-400" : "text-rose-300"}
          onClick={() => openLink("settings", "storage-zfs")}
          title={t("set.mod.storage-zfs")}
        />
      </span>
    </>
  );
}

export default function TopBar() {
  const caps = useCapabilities((s) => s.capabilities);
  const product = productOf(caps.driver);
  const { t, appTitle } = useTranslation();
  const now = useClock();
  const windows = useWindows((s) => s.windows);
  const open = useWindows((s) => s.open);
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

  // z above the Dock (9000): the top bar popovers (View Options, Help, notifications) must open over the Dock.
  return (
    <header className="glass fixed inset-x-0 top-0 z-[9100] flex h-9 items-center gap-3 border-x-0 border-t-0 bg-slate-900/55 px-2 text-xs">
      <div ref={launcherRef} className="relative">
        <button
          onClick={() => setLauncher((v) => !v)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold text-white hover:bg-white/10"
          aria-expanded={launcher}
          aria-label={t("top.openLauncher")}
        >
          <LayoutGrid size={15} /> <span className="hidden sm:inline">{product.short}</span>
        </button>
        {launcher && (
          <div className="glass absolute top-8 left-0 grid w-80 grid-cols-3 gap-1 rounded-2xl p-3">
            {APP_IDS.map((id) => {
              const title = appTitle(id);
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

      <div className="min-w-0 flex-1 truncate font-medium text-slate-300">{active ? appTitle(active.id) : t("top.desktop")}</div>

      <StatusPills />
      <button
        onClick={() => openSpotlight(true)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
        aria-label={t("top.search")}
        title={t("top.search")}
      >
        <Search size={14} />
      </button>
      {caps.supports_host_shell && (
        <button
          onClick={() => open("terminal")}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10"
          aria-label={t("top.hostShell", { platform: caps.platform_label })}
          title={t("top.hostShell", { platform: caps.platform_label })}
        >
          <SquareTerminal size={14} />
        </button>
      )}
      <div ref={viewRef} className="relative">
        <button
          onClick={() => setLayout({ panel: !viewPanel })}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 ${viewPanel ? "bg-white/10" : ""}`}
          aria-expanded={viewPanel}
          aria-label={t("top.viewSettings")}
          title={t("top.viewSettings")}
        >
          <LayoutDashboard size={14} />
        </button>
        {viewPanel && <ViewOptionsPanel />}
      </div>
      <LanguagePill className="hidden sm:inline-flex" />
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
          aria-label={t("top.userMenu")}
        >
          <User size={14} /> <span className="hidden sm:inline">{username}</span>
        </button>
        {menu && (
          <div className="glass absolute top-8 right-0 w-44 rounded-xl p-1">
            <button
              onClick={() => (open("settings"), setMenu(false))}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10"
            >
              <SlidersHorizontal size={14} /> {t("top.controlPanel")}
            </button>
            <button onClick={() => (openBugReport(true), setMenu(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
              <Bug size={14} /> {t("top.reportBug")}
            </button>
            <button onClick={lock} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
              <Lock size={14} /> {t("top.lock")}
            </button>
            <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-rose-300 hover:bg-white/10">
              <LogOut size={14} /> {t("top.logout")}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/** Help: guide for the focused app, Welcome Tour, Help & Support and the bug reporter. `up` opens it above (taskbar). */
export function HelpMenu({ up = false }: { up?: boolean }) {
  const { t, appTitle } = useTranslation();
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
        aria-label={t("top.help")}
        title="Help: guides, Welcome Tour, tutorials and automatic fixes"
      >
        <CircleHelp size={14} />
      </button>
      {help && (
        <div className={`glass absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-56 rounded-xl p-1 text-xs`}>
          {active && (
            <button onClick={() => (showGuide(active.id), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
              <BookOpen size={14} /> {t("top.guide", { app: appTitle(active.id) })}
            </button>
          )}
          <button onClick={() => (showGuide("welcome"), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
            <Sparkles size={14} /> {t("top.welcomeTour")}
          </button>
          <button onClick={() => (open("help"), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
            <LifeBuoy size={14} /> {t("top.helpSupport")}
          </button>
          <button onClick={() => (openBugReport(true), setHelp(false))} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10">
            <Bug size={14} /> {t("top.reportBug")}
          </button>
        </div>
      )}
    </div>
  );
}
