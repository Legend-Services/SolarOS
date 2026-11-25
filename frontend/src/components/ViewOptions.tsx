import { ChevronRight, LayoutGrid, List, PencilRuler, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { openTraySettings } from "./SystemTray";
import { useTranslation, type TKey } from "../i18n";
import { useWidgets } from "../store/widgetStore";

/** Translated text node, usable in module-level option lists. */
const T = ({ k }: { k: TKey }) => <>{useTranslation().t(k)}</>;
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useDock } from "../lib/stores";
import { LIMITS, useAppView, useLayout, type Align, type IconClick, type ShellLayout, type VAlign, type WindowControls, type ViewApp, type ViewMode } from "../store/layoutStore";
import type { AppId } from "../apps/registry";
import { GlassButton, GlassSlider, GlassSwitch, Segmented } from "./ui/GlassKit";
import { AppIcon } from "./icons/AppIcons";

const MODES = [
  { id: "grid" as ViewMode, label: <span className="flex items-center gap-1"><LayoutGrid size={12} /> <T k="view.grid" /></span> },
  { id: "list" as ViewMode, label: <span className="flex items-center gap-1"><List size={12} /> <T k="view.list" /></span> },
];

const ALIGNS = [
  { id: "left" as Align, label: <T k="view.left" /> },
  { id: "center" as Align, label: <T k="view.center" /> },
];
const VALIGNS = [
  { id: "top" as VAlign, label: <T k="view.top" /> },
  { id: "middle" as VAlign, label: <T k="view.middle" /> },
];
const CLICKS = [
  { id: "single" as IconClick, label: <T k="view.singleClick" /> },
  { id: "double" as IconClick, label: <T k="view.doubleClick" /> },
];
const SHELLS = [
  { id: "auto" as ShellLayout, label: <T k="view.auto" /> },
  { id: "dock" as ShellLayout, label: <T k="view.dock" /> },
  { id: "taskbar" as ShellLayout, label: <T k="view.taskbar" /> },
];
const CONTROLS = [
  { id: "auto" as WindowControls, label: <T k="view.auto" /> },
  { id: "left" as WindowControls, label: <T k="view.circlesLeft" /> },
  { id: "right" as WindowControls, label: <T k="view.buttonsRight" /> },
];
const COLUMNS = ["auto", "4", "5", "6", "8"].map((id) => ({ id, label: id === "auto" ? <T k="view.auto" /> : id }));

/** Desktop + Dock layout form: view mode, icon size and spacing sliders, reset. Used by the popover and Settings. */
export function LayoutControls() {
  const { t } = useTranslation();
  const editWidgets = useWidgets((s) => s.setEditing);
  const { desktopView, iconSize, colGap, rowGap, dockGap, desktopAlignment, desktopVerticalAlign, desktopMaxColumns, iconClick, windowControls, shellLayout, showDesktopIcons, set, reset } = useLayout();
  const row = (label: TKey, control: ReactNode) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] text-slate-300">{t(label)}</span>
      {control}
    </div>
  );
  const dockSize = useDock((s) => s.baseSize);
  const setDock = useDock((s) => s.set);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-300">{t("view.desktopView")}</span>
        <Segmented value={desktopView} onChange={(v) => set({ desktopView: v })} options={MODES} />
      </div>
      {row("view.desktopLayout", <Segmented value={shellLayout} onChange={(v) => set({ shellLayout: v })} options={SHELLS} />)}
      <GlassSwitch checked={showDesktopIcons} onChange={(v) => set({ showDesktopIcons: v })} label={<span className="text-[11px] text-slate-300">{t("view.showShortcuts")}</span>} />
      {row("view.windowButtons", <Segmented value={windowControls} onChange={(v) => set({ windowControls: v })} options={CONTROLS} />)}
      {row("view.openWith", <Segmented value={iconClick} onChange={(v) => set({ iconClick: v })} options={CLICKS} />)}
      {row("view.alignment", <Segmented value={desktopAlignment} onChange={(v) => set({ desktopAlignment: v })} options={ALIGNS} />)}
      {desktopAlignment === "center" && (
        <>
          {row("view.vertical", <Segmented value={desktopVerticalAlign} onChange={(v) => set({ desktopVerticalAlign: v })} options={VALIGNS} />)}
          {row(
            "view.perRow",
            <Segmented
              value={String(desktopMaxColumns)}
              onChange={(v) => set({ desktopMaxColumns: v === "auto" ? "auto" : Number(v) })}
              options={COLUMNS}
            />,
          )}
        </>
      )}
      <GlassSlider label={t("view.iconSize")} value={iconSize} min={LIMITS.iconSize[0]} max={LIMITS.iconSize[1]} onChange={(v) => set({ iconSize: v })} />
      <GlassSlider label={t("view.colGap")} value={colGap} min={LIMITS.colGap[0]} max={LIMITS.colGap[1]} onChange={(v) => set({ colGap: v })} />
      <GlassSlider label={t("view.rowGap")} value={rowGap} min={LIMITS.rowGap[0]} max={LIMITS.rowGap[1]} onChange={(v) => set({ rowGap: v })} />
      <div className="border-t border-white/10 pt-3 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{t("view.dockSection")}</div>
      <GlassSlider label={t("view.dockSize")} value={dockSize} min={LIMITS.dockSize[0]} max={LIMITS.dockSize[1]} onChange={(v) => setDock({ baseSize: v })} />
      <GlassSlider label={t("view.dockGap")} value={dockGap} min={LIMITS.dockGap[0]} max={LIMITS.dockGap[1]} onChange={(v) => set({ dockGap: v })} />
      <GlassButton className="w-full" onClick={() => (editWidgets(true), set({ panel: false }))}>
        <PencilRuler size={12} /> {t("view.customizeWidgets")}
      </GlassButton>
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-slate-500">{t("view.saved")}</span>
        <GlassButton onClick={reset}>
          <RotateCcw size={12} /> {t("view.resetDefaults")}
        </GlassButton>
      </div>
    </div>
  );
}

/** Floating View Options panel under the TopBar; opened from the TopBar, desktop menu or Settings. */
export function ViewOptionsPanel({ up = false }: { up?: boolean }) {
  const { t } = useTranslation();
  const dockSize = useDock((s) => s.baseSize);
  const set = useLayout((s) => s.set);
  return (
    <div className={`glass-panel absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-80 overflow-auto rounded-2xl p-4 text-xs`}
      // Top bar: end above the floating Dock (icon + padding + bottom offset) and scroll inside; taskbar: fit above the bar.
      style={{ maxHeight: up ? "calc(100vh - 5rem)" : `calc(100vh - ${dockSize + 96}px)` }}
      role="dialog" aria-label="View options">
      <div className="mb-3 flex items-center">
        <h3 className="flex-1 text-sm font-semibold text-white">{t("view.title")}</h3>
        <GlassButton variant="ghost" size="xs" onClick={() => set({ panel: false })} aria-label="Close view options">
          <X size={14} />
        </GlassButton>
      </div>
      <LayoutControls />
      <GlassButton className="mt-3 w-full" onClick={() => (set({ panel: false }), openTraySettings())}>
        <SlidersHorizontal size={12} /> {t("tray.customize")}
      </GlassButton>
    </div>
  );
}

/** Grid | List pill for an app view, persisted per app. */
export function ViewToggle({ app }: { app: ViewApp }) {
  const [view, setView] = useAppView(app);
  return <Segmented value={view} onChange={setView} options={MODES} />;
}

/** Frosted-glass row: icon, title, plain-English description and a quick-launch arrow (List View). */
export function AppListRow({ id, iconSize, className = "", ...rest }: { id: AppId; iconSize: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { appTitle, appDesc } = useTranslation();
  return (
    <button
      className={`glass-soft group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.1] focus:bg-white/[0.1] focus:outline-none active:scale-[0.99] ${className}`}
      {...rest}
    >
      <AppIcon id={id} size={iconSize} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-100">{appTitle(id)}</span>
        <span className="block truncate text-[11px] text-slate-400">{appDesc(id)}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-sky-300" />
    </button>
  );
}
