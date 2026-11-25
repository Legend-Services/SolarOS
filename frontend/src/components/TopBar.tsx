import { useState } from "react";
import { Bug, LayoutDashboard, LayoutGrid, Lock, LogOut, SlidersHorizontal, User } from "lucide-react";
import { useLayout } from "../store/layoutStore";
import { ViewOptionsPanel } from "./ViewOptions";
import { activeWindow, useAuth, useBugReport, useWindows } from "../lib/stores";
import GlobalSearchBar from "./search/GlobalSearchBar";
import { useClock, useDismiss } from "../lib/hooks";
import { APP_IDS } from "../apps/registry";
import { AppIcon } from "./icons/AppIcons";
import { useTranslation } from "../i18n";
import { productOf, useCapabilities } from "../store/capabilitiesStore";
import { TrayItems, TrayOverflow, useBarMenu, useTray } from "./SystemTray";

export default function TopBar() {
  const caps = useCapabilities((s) => s.capabilities);
  const product = productOf(caps.driver);
  const { t, appTitle } = useTranslation();
  const now = useClock();
  const windows = useWindows((s) => s.windows);
  const open = useWindows((s) => s.open);
  const { username, lock, logout } = useAuth();
  const openBugReport = useBugReport((s) => s.set);
  const [launcher, setLauncher] = useState(false);
  const [menu, setMenu] = useState(false);
  const launcherRef = useDismiss(launcher, () => setLauncher(false));
  const menuRef = useDismiss(menu, () => setMenu(false));
  const viewPanel = useLayout((s) => s.panel);
  const setLayout = useLayout((s) => s.set);
  const viewRef = useDismiss(viewPanel, () => setLayout({ panel: false }));

  const active = activeWindow(windows);
  const tray = useTray();
  const [onContextMenu, barMenu] = useBarMenu();

  // z above the Dock (9000): the top bar popovers (View Options, Help, notifications) must open over the Dock.
  return (
    <header onContextMenu={onContextMenu} className="glass fixed inset-x-0 top-0 z-[9100] flex h-9 items-center gap-1 border-x-0 border-t-0 bg-slate-900/55 px-2 text-xs">
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

      <div className="w-32 min-w-0 shrink truncate px-1 font-medium text-slate-300 max-lg:hidden">{active ? appTitle(active.id) : t("top.desktop")}</div>
      <div className="flex min-w-0 flex-1 justify-center px-2">
        <GlobalSearchBar />
      </div>

      <TrayItems ids={tray.bar} />
      <TrayOverflow ids={tray.overflow} />
      <div ref={viewRef} className="relative">
        <button
          onClick={() => setLayout({ panel: !viewPanel })}
          className={`flex items-center rounded-md p-1 text-slate-200 hover:bg-white/10 ${viewPanel ? "bg-white/10" : ""}`}
          aria-expanded={viewPanel}
          aria-label={t("top.viewSettings")}
          title={t("top.viewSettings")}
        >
          <LayoutDashboard size={14} />
        </button>
        {viewPanel && <ViewOptionsPanel />}
      </div>
      <span className="px-1 whitespace-nowrap tabular-nums text-slate-200">
        {now.toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>

      <div ref={menuRef} className="relative">
        <button
          onClick={() => setMenu((v) => !v)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-slate-200 hover:bg-white/10"
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
      {barMenu}
    </header>
  );
}
