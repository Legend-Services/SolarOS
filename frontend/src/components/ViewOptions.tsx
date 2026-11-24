import { ChevronRight, LayoutGrid, List, RotateCcw, X } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { useDock } from "../lib/stores";
import { LIMITS, useAppView, useLayout, type ViewApp, type ViewMode } from "../store/layoutStore";
import { APPS, type AppId } from "../apps/registry";
import { GlassButton, GlassSlider, Segmented } from "./ui/GlassKit";
import { AppIcon } from "./icons/AppIcons";

const MODES = [
  { id: "grid" as ViewMode, label: <span className="flex items-center gap-1"><LayoutGrid size={12} /> Grid</span> },
  { id: "list" as ViewMode, label: <span className="flex items-center gap-1"><List size={12} /> List</span> },
];

/** Desktop + Dock layout form: view mode, icon size and spacing sliders, reset. Used by the popover and Control Panel. */
export function LayoutControls() {
  const { desktopView, iconSize, colGap, rowGap, dockGap, set, reset } = useLayout();
  const dockSize = useDock((s) => s.baseSize);
  const setDock = useDock((s) => s.set);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-300">Desktop &amp; Launchpad view</span>
        <Segmented value={desktopView} onChange={(v) => set({ desktopView: v })} options={MODES} />
      </div>
      <GlassSlider label="Desktop icon size" value={iconSize} min={LIMITS.iconSize[0]} max={LIMITS.iconSize[1]} onChange={(v) => set({ iconSize: v })} />
      <GlassSlider label="Horizontal app distance" value={colGap} min={LIMITS.colGap[0]} max={LIMITS.colGap[1]} onChange={(v) => set({ colGap: v })} />
      <GlassSlider label="Vertical app distance" value={rowGap} min={LIMITS.rowGap[0]} max={LIMITS.rowGap[1]} onChange={(v) => set({ rowGap: v })} />
      <div className="border-t border-white/10 pt-3 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Dock</div>
      <GlassSlider label="Dock icon size" value={dockSize} min={LIMITS.dockSize[0]} max={LIMITS.dockSize[1]} onChange={(v) => setDock({ baseSize: v })} />
      <GlassSlider label="Dock icon spacing" value={dockGap} min={LIMITS.dockGap[0]} max={LIMITS.dockGap[1]} onChange={(v) => set({ dockGap: v })} />
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-slate-500">Saved in this browser and on the server.</span>
        <GlassButton onClick={reset}>
          <RotateCcw size={12} /> Reset to Defaults
        </GlassButton>
      </div>
    </div>
  );
}

/** Floating View Options panel under the TopBar; opened from the TopBar, desktop menu or Control Panel. */
export function ViewOptionsPanel() {
  const set = useLayout((s) => s.set);
  return (
    <div className="glass-panel absolute top-8 right-0 w-80 rounded-2xl p-4 text-xs" role="dialog" aria-label="View options">
      <div className="mb-3 flex items-center">
        <h3 className="flex-1 text-sm font-semibold text-white">View Options</h3>
        <GlassButton variant="ghost" size="xs" onClick={() => set({ panel: false })} aria-label="Close view options">
          <X size={14} />
        </GlassButton>
      </div>
      <LayoutControls />
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
  return (
    <button
      className={`glass-soft group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.1] focus:bg-white/[0.1] focus:outline-none active:scale-[0.99] ${className}`}
      {...rest}
    >
      <AppIcon id={id} size={iconSize} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-slate-100">{APPS[id].title}</span>
        <span className="block truncate text-[11px] text-slate-400">{APPS[id].desc}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-sky-300" />
    </button>
  );
}
