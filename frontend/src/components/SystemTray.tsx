import { useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpCircle,
  Bell,
  BookOpen,
  Bug,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Cpu,
  Database,
  GripVertical,
  Languages,
  LayoutGrid,
  LifeBuoy,
  MemoryStick,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  SunMoon,
  type LucideIcon,
} from "lucide-react";
import { activeWindow, openLink, useBugReport, useDock, useTelemetry, useWindows, zfsHealth } from "../lib/stores";
import { useDismiss, useFlip } from "../lib/hooks";
import { percent } from "../lib/format";
import { useWizard } from "../store/wizardStore";
import { useCapabilities } from "../store/capabilitiesStore";
import { useUpdatePoll, useUpdateStore } from "../store/updateStore";
import { LIMITS, useLayout, useShell, type ClockSide, type ShellLayout, type TrayItem } from "../store/layoutStore";
import { useTranslation, type TKey } from "../i18n";
import { GlassButton, GlassSlider, GlassSwitch, Segmented } from "./ui/GlassKit";
import LanguagePill from "./LanguagePill";
import { ModeToggle, ThemeSwitcher } from "./ThemeQuickSwitcher";
import NotificationPopover from "./NotificationPopover";

/* The system tray shared by the top bar (floating-dock layout) and the bottom taskbar: the user's order, hidden
   items left out, the first `maxVisibleTrayItems` on the bar and the rest behind an overflow chevron. */

export const TRAY_META: Record<TrayItem, { label: TKey; icon: LucideIcon }> = {
  cpu: { label: "tray.item.cpu", icon: Cpu },
  ram: { label: "tray.item.ram", icon: MemoryStick },
  storage: { label: "tray.item.storage", icon: Database },
  terminal: { label: "tray.item.terminal", icon: SquareTerminal },
  "app-gallery": { label: "tray.item.app-gallery", icon: LayoutGrid },
  language: { label: "tray.item.language", icon: Languages },
  "color-mode": { label: "tray.item.color-mode", icon: SunMoon },
  theme: { label: "tray.item.theme", icon: Palette },
  help: { label: "tray.item.help", icon: CircleHelp },
  updates: { label: "tray.item.updates", icon: ArrowUpCircle },
  notifications: { label: "tray.item.notifications", icon: Bell },
};

/** Settings -> System -> General & Appearance, scrolled to the Top Bar & Taskbar Tray card. */
export const openTraySettings = () => openLink("settings", { module: "general-appearance", anchor: "tray" });

/** Move `from` to the slot `to` holds now. */
export const moveItem = <T,>(order: T[], from: T, to: T): T[] => {
  if (from === to) return order;
  const rest = order.filter((x) => x !== from);
  rest.splice(order.indexOf(to), 0, from);
  return rest;
};

/** Items that can render on this server right now: Host Shell needs a host shell, Updates only shows with an update. */
function useAvailable(): (id: TrayItem) => boolean {
  const shell = useCapabilities((s) => s.capabilities.supports_host_shell);
  const update = useUpdateStore((s) => s.updateAvailable || s.updateRunning);
  return (id) => (id === "terminal" ? shell : id === "updates" ? update : true);
}

/** The visible tray items split into the ones on the bar and the ones behind the overflow chevron. */
export function useTray(): { bar: TrayItem[]; overflow: TrayItem[] } {
  useUpdatePoll();
  const order = useLayout((s) => s.trayItemOrder);
  const hidden = useLayout((s) => s.hiddenTrayItems);
  const max = useLayout((s) => s.maxVisibleTrayItems);
  const ok = useAvailable();
  const shown = order.filter((id) => !hidden.includes(id) && ok(id));
  return { bar: shown.slice(0, max), overflow: shown.slice(max) };
}

export function Pill({ icon, label, tone = "text-slate-200", onClick, title }: { icon: ReactNode; label: string; tone?: string; onClick?: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title ? `${title}: ${label}` : label}
      className={`inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 tabular-nums transition hover:bg-white/15 ${tone}`}
    >
      {icon}
      {label}
    </button>
  );
}

const iconBtn = "flex items-center rounded-md p-1 text-slate-200 hover:bg-white/10";

function TrayItemView({ id, up }: { id: TrayItem; up: boolean }) {
  const { t } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  const overview = useTelemetry((s) => s.overview);
  const storage = useTelemetry((s) => s.storage);
  const { latestVersion, updateRunning, progressPercent } = useUpdateStore();
  const open = useWindows((s) => s.open);
  const gallery = useDock((s) => s.gallery);
  const setDock = useDock((s) => s.set);
  const monitor = () => openLink("settings", "resource-monitor");
  switch (id) {
    case "cpu":
      return <Pill icon={<Cpu size={12} />} label={`${overview ? overview.cpu.toFixed(0) : "–"}%`} onClick={monitor} title={t("set.mod.resource-monitor")} />;
    case "ram": {
      const ram = overview ? percent(overview.memory.used, overview.memory.total) : 0;
      return <Pill icon={<MemoryStick size={12} />} label={`${ram.toFixed(0)}%`} onClick={monitor} title={t("set.mod.resource-monitor")} />;
    }
    case "storage": {
      const health = zfsHealth(storage);
      const tone = health === "ONLINE" ? "text-emerald-300" : health === "N/A" || health === "—" ? "text-slate-400" : "text-rose-300";
      return <Pill icon={<Database size={12} />} label={health} tone={tone} onClick={() => openLink("settings", "storage-zfs")} title={t("set.mod.storage-zfs")} />;
    }
    case "updates":
      return (
        <Pill
          icon={<ArrowUpCircle size={12} className={updateRunning ? "animate-pulse" : ""} />}
          label={updateRunning ? t("upd.badgeRunning", { percent: progressPercent }) : latestVersion ? t("upd.badge", { version: latestVersion }) : t("top.update")}
          tone="text-amber-300"
          onClick={() => openLink("settings", { module: "software-updates", tab: "solardeck" })}
          title={t("set.mod.software-updates")}
        />
      );
    case "terminal": {
      const label = t("top.hostShell", { platform: caps.platform_label });
      return (
        <button onClick={() => open("terminal")} className={iconBtn} aria-label={label} title={label}>
          <SquareTerminal size={14} />
        </button>
      );
    }
    case "app-gallery":
      return (
        <button onClick={() => setDock({ gallery: !gallery })} className={`${iconBtn} ${gallery ? "bg-white/10" : ""}`} aria-expanded={gallery} aria-label={t("dock.appGallery")} title={t("dock.appGallery")}>
          <LayoutGrid size={14} />
        </button>
      );
    case "language":
      return <LanguagePill />;
    case "color-mode":
      return <ModeToggle />;
    case "theme":
      return <ThemeSwitcher up={up} />;
    case "help":
      return <HelpMenu up={up} />;
    case "notifications":
      return <NotificationPopover up={up} />;
  }
}

/** The tray items on the bar. Drag one onto another to reorder (neighbours slide aside); saved with the layout. */
export function TrayItems({ ids, up = false }: { ids: TrayItem[]; up?: boolean }) {
  const set = useLayout((s) => s.set);
  const [drag, setDrag] = useState<TrayItem | null>(null);
  const flipRef = useFlip<HTMLDivElement>(ids.join(","));
  return (
    <div ref={flipRef} className="flex items-center gap-1">
      {ids.map((id) => (
        <div
          key={id}
          data-flip={id}
          draggable
          onDragStart={(e) => (e.dataTransfer.setData("text/plain", id), (e.dataTransfer.effectAllowed = "move"), setDrag(id))}
          onDragEnd={() => setDrag(null)}
          onDragEnter={() => drag && drag !== id && set({ trayItemOrder: moveItem(useLayout.getState().trayItemOrder, drag, id) })}
          onDragOver={(e) => drag && e.preventDefault()}
          onDrop={(e: DragEvent) => (e.preventDefault(), setDrag(null))}
          className={`flex items-center ${drag === id ? "opacity-40" : ""}`}
        >
          <TrayItemView id={id} up={up} />
        </div>
      ))}
    </div>
  );
}

/** Chevron (▾ on the top bar, ▴ on the taskbar) with a count badge; opens the overflow items and a Customize link. */
export function TrayOverflow({ ids, up = false }: { ids: TrayItem[]; up?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  if (!ids.length) return null;
  const label = t("tray.more", { count: ids.length });
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className={`relative ${iconBtn} ${open ? "bg-white/10" : ""}`} aria-expanded={open} aria-label={label} title={label}>
        {up ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        <span className="absolute -top-0.5 -right-1 rounded-full bg-white/20 px-1 text-[9px] leading-tight text-white tabular-nums">{ids.length}</span>
      </button>
      {open && (
        <div
          className={`glass-panel absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-64 rounded-2xl p-2 text-xs shadow-2xl shadow-black/50`}
          style={{ animation: "sd-search-in 160ms ease-out" }}
          role="dialog"
          aria-label={t("tray.overflowTitle")}
        >
          <div className="px-1 pb-1.5 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{t("tray.overflowTitle")}</div>
          <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
            {ids.map((id) => (
              <TrayItemView key={id} id={id} up={up} />
            ))}
          </div>
          <button
            onClick={() => (setOpen(false), openTraySettings())}
            className="flex w-full items-center gap-2 rounded-lg border-t border-white/10 px-2 pt-2 pb-1 text-left text-sky-300 hover:text-sky-200"
          >
            <SlidersHorizontal size={12} /> {t(up ? "tray.customizeTaskbar" : "tray.customizeBar")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Right-click menu for the bars ("Customize Bar & Tray..."). Spread `onContextMenu` on the bar and render `menu`.
 * Right-clicks a child already handled (app buttons call preventDefault) and text fields are left alone.
 */
export function useBarMenu(): [(e: MouseEvent) => void, ReactNode] {
  const { t } = useTranslation();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useDismiss(!!at, () => setAt(null));
  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.target as HTMLElement).closest("input, textarea, select")) return;
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY });
  };
  // Portal: the bars use backdrop-filter, which would make a fixed child position against the bar instead of the screen.
  const menu =
    at &&
    createPortal(
      <div
        ref={ref}
        role="menu"
        className="glass fixed z-[9600] w-56 rounded-xl bg-slate-950/90 p-1 text-xs text-slate-100"
        style={{ left: Math.min(at.x, innerWidth - 232), top: Math.min(at.y, innerHeight - 48) }}
      >
        <button role="menuitem" onClick={() => (setAt(null), openTraySettings())} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-white/10">
          <SlidersHorizontal size={12} /> {t("tray.customize")}
        </button>
      </div>,
      document.body,
    );
  return [onContextMenu, menu];
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
      <button onClick={() => setHelp((v) => !v)} className={iconBtn} aria-expanded={help} aria-label={t("top.help")} title={t("tray.helpTitle")}>
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

/** Settings card body: bar mode, how many icons sit on the bar (live preview), order + visibility, clock side, search tip. */
export function TrayControls() {
  const { t } = useTranslation();
  const { trayItemOrder, hiddenTrayItems, maxVisibleTrayItems, taskbarClockSide, shellLayout, set } = useLayout();
  const shell = useShell();
  const ok = useAvailable();
  const [drag, setDrag] = useState<TrayItem | null>(null);
  const [tipReset, setTipReset] = useState(false);
  const flipRef = useFlip<HTMLUListElement>(trayItemOrder.join(","));
  const shown = trayItemOrder.filter((id) => !hiddenTrayItems.includes(id) && ok(id));
  const chevron = shell === "taskbar" ? "▴" : "▾";
  const toggle = (id: TrayItem, on: boolean) => set({ hiddenTrayItems: on ? hiddenTrayItems.filter((x) => x !== id) : [...hiddenTrayItems, id] });
  const step = (id: TrayItem, by: number) => {
    const to = trayItemOrder[trayItemOrder.indexOf(id) + by];
    if (to) set({ trayItemOrder: moveItem(trayItemOrder, id, to) });
  };
  const shells: { id: ShellLayout; label: ReactNode }[] = [
    { id: "auto", label: t("view.auto") },
    { id: "dock", label: t("view.dock") },
    { id: "taskbar", label: t("view.taskbar") },
  ];
  const sides: { id: ClockSide; label: ReactNode }[] = [
    { id: "right", label: t("tray.clockRight") },
    { id: "left", label: t("tray.clockLeft") },
  ];
  const chip = (id: TrayItem) => {
    const Icon = TRAY_META[id].icon;
    return (
      <span key={id} className="inline-flex items-center gap-1 rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-slate-200" title={t(TRAY_META[id].label)}>
        <Icon size={11} /> {t(TRAY_META[id].label)}
      </span>
    );
  };
  return (
    <div className="space-y-4" data-anchor="tray">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] text-slate-300">{t("tray.barMode")}</span>
        <Segmented value={shellLayout} onChange={(v) => set({ shellLayout: v })} options={shells} />
      </div>
      <GlassSlider
        label={t("tray.maxVisible")}
        value={maxVisibleTrayItems}
        min={LIMITS.trayItems[0]}
        max={LIMITS.trayItems[1]}
        unit=""
        onChange={(v) => set({ maxVisibleTrayItems: v })}
      />
      <div className="glass-soft space-y-1.5 rounded-xl p-2" aria-live="polite">
        <div className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">{t("tray.preview")}</div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[10px] text-slate-500">{t("tray.onBar")}</span>
          {shown.slice(0, maxVisibleTrayItems).map(chip)}
        </div>
        {shown.length > maxVisibleTrayItems && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] text-slate-500">{t("tray.inOverflow", { chevron })}</span>
            {shown.slice(maxVisibleTrayItems).map(chip)}
          </div>
        )}
      </div>
      <div>
        <p className="mb-2 text-[11px] text-slate-400">{t("tray.dragHint")}</p>
        <ul ref={flipRef} className="space-y-1">
          {trayItemOrder.map((id, i) => {
            const Icon = TRAY_META[id].icon;
            const visible = !hiddenTrayItems.includes(id);
            return (
              <li
                key={id}
                data-flip={id}
                draggable
                onDragStart={(e) => (e.dataTransfer.setData("text/plain", id), (e.dataTransfer.effectAllowed = "move"), setDrag(id))}
                onDragEnd={() => setDrag(null)}
                onDragEnter={() => drag && drag !== id && set({ trayItemOrder: moveItem(useLayout.getState().trayItemOrder, drag, id) })}
                onDragOver={(e) => drag && e.preventDefault()}
                onDrop={(e) => (e.preventDefault(), setDrag(null))}
                className={`glass-soft flex items-center gap-2 rounded-xl px-2 py-1.5 text-xs ${drag === id ? "opacity-40" : ""} ${visible ? "text-slate-100" : "text-slate-500"}`}
              >
                <GripVertical size={14} className="shrink-0 cursor-grab text-slate-500" aria-hidden />
                <Icon size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t(TRAY_META[id].label)}
                  {!ok(id) && <span className="ml-2 text-[10px] text-slate-500">{t(id === "updates" ? "tray.whenUpdate" : "tray.unavailable")}</span>}
                </span>
                <GlassButton variant="ghost" size="xs" disabled={i === 0} onClick={() => step(id, -1)} aria-label={`${t("common.moveUp")}: ${t(TRAY_META[id].label)}`}>
                  <ChevronUp size={12} />
                </GlassButton>
                <GlassButton variant="ghost" size="xs" disabled={i === trayItemOrder.length - 1} onClick={() => step(id, 1)} aria-label={`${t("common.moveDown")}: ${t(TRAY_META[id].label)}`}>
                  <ChevronDown size={12} />
                </GlassButton>
                <GlassSwitch checked={visible} onChange={(v) => toggle(id, v)} label={<span className="sr-only">{`${t("common.show")}: ${t(TRAY_META[id].label)}`}</span>} />
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] text-slate-300">{t("tray.clockPos")}</span>
        <Segmented value={taskbarClockSide} onChange={(v) => set({ taskbarClockSide: v })} options={sides} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] text-slate-500">{tipReset ? t("tray.tipReset") : t("view.saved")}</span>
        <GlassButton onClick={() => (set({ hideSearchIntroBalloon: false, searchTipDismissed: false }), setTipReset(true))}>
          <RotateCcw size={12} /> {t("tray.resetTip")}
        </GlassButton>
      </div>
    </div>
  );
}
