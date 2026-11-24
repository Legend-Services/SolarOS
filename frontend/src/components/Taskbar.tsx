import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Cpu, Database, Expand, LayoutDashboard, LayoutGrid, MemoryStick, Search, Shrink, SquareTerminal } from "lucide-react";
import { activateApp, activeWindow, useDock, useSpotlight, useTelemetry, useWindows, zfsHealth } from "../lib/stores";
import { useClock, useDismiss, useFlip } from "../lib/hooks";
import { pct } from "../lib/format";
import { useLayout } from "../store/layoutStore";
import type { AppId } from "../apps/registry";
import { useTranslation } from "../i18n";
import { useCapabilities } from "../store/capabilitiesStore";
import LanguagePill from "./LanguagePill";
import { AppIcon } from "./icons/AppIcons";
import { ViewOptionsPanel } from "./ViewOptions";
import { HelpMenu, Pill } from "./TopBar";
import TaskCenterPopover from "./TaskCenterPopover";
import NotificationPopover from "./NotificationPopover";
import { ModeToggle, ThemeSwitcher } from "./ThemeQuickSwitcher";

/* One edge-to-edge bar along the bottom (the alternative to top bar + floating Dock): the App Gallery button in the
   far left corner, a divider, search and the ordered app buttons; status, help, tasks, notifications and the clock
   on the right. Popovers open upwards. */

const START_KEYS = new Set(["Meta", "OS"]); // the Start / logo key as browsers report it

/**
 * Tapping the Start key on its own (no other key or click in between, released within 800 ms) calls `toggle`.
 * Shortcuts such as Start+E stay with the computer. Outside full screen the computer may also open its own menu:
 * a web page cannot stop that, which is what useFullscreenKeys is for.
 */
function useStartKey(toggle: () => void) {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    let since: number | null = null;
    const down = (e: KeyboardEvent) => {
      since = START_KEYS.has(e.key) && !e.repeat ? e.timeStamp : START_KEYS.has(e.key) ? since : null;
    };
    const up = (e: KeyboardEvent) => {
      if (START_KEYS.has(e.key) && since !== null && e.timeStamp - since < 800) {
        e.preventDefault();
        toggleRef.current();
      }
      since = null;
    };
    const cancel = () => (since = null);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);
}

type KeyboardLock = { lock?: (codes: string[]) => Promise<void> };

/**
 * Full screen toggle. In full screen the page asks the browser to keep the Start key (Keyboard Lock, Chromium
 * browsers over https only), so it opens SolarDeck's App Gallery instead of the computer's menu.
 */
function useFullscreenKeys(): [boolean, () => void] {
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => {
      setFull(!!document.fullscreenElement);
      if (document.fullscreenElement) (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard?.lock?.(["MetaLeft", "MetaRight"]).catch(() => {});
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggle = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  return [full, toggle];
}

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

export default function Taskbar() {
  const { t, appTitle } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  const now = useClock();
  const windows = useWindows((s) => s.windows);
  const { open, close, minimize, setDockIconRect } = useWindows();
  const { pinned, pin, unpin, move, gallery, set: setDock } = useDock();
  const overview = useTelemetry((s) => s.overview);
  const storage = useTelemetry((s) => s.storage);
  const openSpotlight = useSpotlight((s) => s.set);
  const viewPanel = useLayout((s) => s.panel);
  const setLayout = useLayout((s) => s.set);
  const [menu, setMenu] = useState<AppId | null>(null);
  const [drag, setDrag] = useState<AppId | null>(null);
  const toggleGallery = () => setDock({ gallery: !useDock.getState().gallery });
  useStartKey(toggleGallery);
  const [fullscreen, toggleFullscreen] = useFullscreenKeys();
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
  // Live drag-and-drop reorder of pinned buttons; neighbours slide aside (FLIP). Saved via useDock (+ preferences sync).
  const flipRef = useFlip<HTMLDivElement>(pinned.join(","));
  const onDrop = (e: DragEvent) => (e.preventDefault(), setDrag(null));

  return (
    <footer className="glass fixed inset-x-0 bottom-0 z-[9000] flex h-12 items-center gap-1 border-x-0 border-b-0 bg-slate-900/75 pl-2 text-xs" aria-label={t("taskbar.label")}>
      <div ref={flipRef} className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        <BarButton label={t("taskbar.start")} onClick={toggleGallery} active={gallery}>
          <LayoutGrid size={20} className="text-sky-300" />
        </BarButton>
        <span className="mx-1 h-6 w-px shrink-0 bg-white/20" aria-hidden />
        <BarButton label={t("top.search")} onClick={() => openSpotlight(true)}>
          <Search size={18} />
        </BarButton>
        {tasks.map((id) => {
          const isRunning = windows.some((w) => w.id === id);
          const focused = active?.id === id;
          const isPinned = pinned.includes(id);
          return (
            <div key={id} data-flip={id} className={`relative ${drag === id ? "opacity-40" : ""}`}>
              <button
                ref={(el) => {
                  icons.current[id] = el;
                }}
                type="button"
                draggable={isPinned}
                onDragStart={(e) => (e.dataTransfer.setData("text/plain", id), (e.dataTransfer.effectAllowed = "move"), setDrag(id))}
                onDragEnd={() => setDrag(null)}
                onDragEnter={() => isPinned && drag && drag !== id && move(drag, pinned.indexOf(id))}
                onDragOver={(e) => isPinned && drag && e.preventDefault()}
                onDrop={onDrop}
                onClick={() => activateApp(id)}
                onContextMenu={(e) => (e.preventDefault(), setMenu(id))}
                aria-label={appTitle(id)}
                aria-pressed={focused}
                title={appTitle(id)}
                className={`relative flex h-10 w-10 items-center justify-center rounded-md transition hover:bg-white/10 active:scale-95 ${focused ? "bg-white/10" : ""}`}
              >
                <AppIcon id={id} size={26} />
                {isRunning && (
                  <span className={`absolute bottom-0.5 left-1/2 h-[3px] -translate-x-1/2 rounded-full transition-all ${focused ? "w-4 bg-sky-400" : "w-1.5 bg-slate-300"}`} />
                )}
              </button>
              {menu === id && (
                <div ref={menuRef} className="glass absolute bottom-full left-1/2 mb-2 w-48 -translate-x-1/2 rounded-xl p-1 text-slate-100" role="menu">
                  <MenuItem onClick={() => (activateApp(id), setMenu(null))}>{isRunning ? t("dock.show") : t("dock.open")}</MenuItem>
                  {isRunning && <MenuItem onClick={() => (open(id), setMenu(null))}>{t("taskbar.newWindow")}</MenuItem>}
                  <MenuItem onClick={() => ((isPinned ? unpin : pin)(id), setMenu(null))}>{isPinned ? t("taskbar.unpin") : t("taskbar.pin")}</MenuItem>
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
        {caps.supports_host_shell && (
          <button onClick={() => open("terminal")} className="rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 max-sm:hidden" aria-label={t("top.hostShell", { platform: caps.platform_label })} title={t("top.hostShell", { platform: caps.platform_label })}>
            <SquareTerminal size={14} />
          </button>
        )}
        <div ref={viewRef} className="relative max-sm:hidden">
          <button
            onClick={() => setLayout({ panel: !viewPanel })}
            className={`rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 ${viewPanel ? "bg-white/10" : ""}`}
            aria-expanded={viewPanel}
            aria-label={t("top.viewSettings")}
            title={t("top.viewSettings")}
          >
            <LayoutDashboard size={14} />
          </button>
          {viewPanel && <ViewOptionsPanel up />}
        </div>
        <button
          onClick={toggleFullscreen}
          className="rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 max-sm:hidden"
          aria-label={fullscreen ? t("taskbar.exitFullScreen") : t("taskbar.fullScreen")}
          title={
            fullscreen
              ? "Exit full screen"
              : window.isSecureContext
                ? "Full screen: the Start key then opens only SolarDeck's App Gallery (Chrome or Edge)"
                : `Full screen. To keep the Start key inside SolarDeck, open https://${location.host} (Chrome or Edge)`
          }
        >
          {fullscreen ? <Shrink size={14} /> : <Expand size={14} />}
        </button>
        <LanguagePill className="max-sm:hidden" />
        <ModeToggle />
        <ThemeSwitcher up />
        <HelpMenu up />
        <TaskCenterPopover up />
        <NotificationPopover up />
        <span className="flex flex-col items-end px-2 leading-tight tabular-nums text-slate-200">
          <span>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="text-[10px] text-slate-400">{now.toLocaleDateString()}</span>
        </span>
        {/* Thin strip at the far right: minimize every window to show the desktop. */}
        <button onClick={showDesktop} className="h-12 w-2 border-l border-white/15 hover:bg-white/15" aria-label={t("taskbar.showDesktop")} title={t("taskbar.showDesktop")} />
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
