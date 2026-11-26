import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { PencilRuler } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSmoothReorder } from "../hooks/useSmoothReorder";
import { useDock, usePrefs, useTelemetry, useWindows } from "../lib/stores";
import { useInsets, useLayout, useShell } from "../store/layoutStore";
import { APP_IDS, type AppId } from "../apps/registry";
import { AppListRow } from "./ViewOptions";
import { WidgetSlotArea } from "./DesktopWidgets";
import WidgetStudioDrawer from "./WidgetStudioDrawer";
import { useWidgets } from "../store/widgetStore";
import { useVisibility } from "../store/featureStore";
import { useTranslation } from "../i18n";
import { AppIcon } from "./icons/AppIcons";
import DesktopContextMenu from "./DesktopContextMenu";

export default function Desktop() {
  const open = useWindows((s) => s.open);
  const error = useTelemetry((s) => s.error);
  const widgets = usePrefs((s) => s.widgets);
  const editing = useWidgets((s) => s.editing);
  const { t, appTitle } = useTranslation();
  const showWidgets = widgets || editing;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Shallow-picked fields only: tray, panel or gallery changes in the layout store never re-render the desktop.
  const { desktopView, iconSize, colGap, rowGap, desktopAlignment, desktopVerticalAlign, desktopMaxColumns, iconClick, showDesktopIcons, desktopIconOrder, setLayout } = useLayout(
    useShallow((s) => ({
      desktopView: s.desktopView, iconSize: s.iconSize, colGap: s.colGap, rowGap: s.rowGap, desktopAlignment: s.desktopAlignment, desktopVerticalAlign: s.desktopVerticalAlign,
      desktopMaxColumns: s.desktopMaxColumns, iconClick: s.iconClick, showDesktopIcons: s.showDesktopIcons, desktopIconOrder: s.desktopIconOrder, setLayout: s.set,
    })),
  );
  const appOn = useVisibility().app;
  const shortcuts = [...desktopIconOrder, ...APP_IDS.filter((id) => !desktopIconOrder.includes(id))].filter(appOn);
  // 2D pointer reorder of the shortcuts (grid and list view); saved once, on release. Hidden apps keep their place.
  const reorder = useSmoothReorder(shortcuts, (next) => setLayout({ desktopIconOrder: [...next, ...desktopIconOrder.filter((id) => !appOn(id))] }), { axis: "xy" });
  const dockSize = useDock((s) => s.baseSize);
  const { top, bottom } = useInsets();
  // Dock layout: clear the floating Dock; taskbar layout: clear the taskbar.
  const padBottom = useShell() === "taskbar" ? bottom + 20 : dockSize + 52;

  // Shortcuts fill columns top to bottom and wrap into a new column when the next one would pass the Dock.
  // Row height is fixed per mode so `repeat(auto-fill, …)` can count how many rows fit.
  const font = Math.round(Math.min(14, Math.max(10, iconSize * 0.2)));
  const list = desktopView === "list";
  const listIcon = Math.round(Math.min(56, Math.max(28, iconSize * 0.6)));
  const cellW = list ? 300 : Math.max(84, iconSize + 32);
  const cellH = list ? Math.max(listIcon, 38) + 18 : iconSize + 22 + Math.ceil(font * 1.25 * 2); // list: two text lines need ~38px
  // Safe zone = this flex item: the outer padding clears the TopBar and Dock, and the widget column is its flex sibling,
  // so the shortcut box can never extend under either; extra columns scroll inside it instead.
  // Left: column-first, wraps into a new column before the Dock. Center: row-first, auto-fit columns capped by
  // "Icons per row" through max-width, centered horizontally and (Middle) vertically. List mode stacks one column unless capped.
  const center = desktopAlignment === "center";
  const maxCols = desktopMaxColumns === "auto" ? (list ? 1 : Infinity) : desktopMaxColumns;
  const gridStyle: CSSProperties = center
    ? {
        gridAutoFlow: "row",
        gridTemplateColumns: `repeat(auto-fit, ${cellW}px)`,
        gridAutoRows: cellH,
        justifyContent: "center",
        justifyItems: "center",
        alignContent: desktopVerticalAlign === "middle" ? "safe center" : "start",
        maxWidth: Number.isFinite(maxCols) ? maxCols * cellW + (maxCols - 1) * colGap : undefined,
        marginInline: "auto",
        width: "100%",
        columnGap: colGap,
        rowGap,
      }
    : { gridAutoFlow: "column", gridTemplateRows: `repeat(auto-fill, ${cellH}px)`, gridAutoColumns: cellW, alignContent: "start", columnGap: colGap, rowGap };
  // Single click (default): the button's own click, which also covers Enter/Space and touch taps.
  const launch = (id: AppId) =>
    iconClick === "single"
      ? { onClick: () => open(id) }
      : {
          onDoubleClick: () => open(id),
          onKeyDown: (e: KeyboardEvent) => e.key === "Enter" && open(id),
          // Single tap opens on touch devices, which have no double-click.
          onPointerUp: (e: PointerEvent) => e.pointerType === "touch" && open(id),
        };
  const hint = (id: AppId) => `${iconClick === "single" ? "Click" : "Double-click"} to open ${appTitle(id)}`;

  return (
    <div
      className="absolute inset-0 flex gap-6 overflow-auto px-4"
      style={{ paddingTop: top + 20, paddingBottom: padBottom }}
      onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY }))}
    >
      <DesktopContextMenu at={menu} onClose={() => setMenu(null)} />
      {/* Shortcuts: off by default (clean desktop); every app is in the App Gallery. The empty flex item keeps widgets on the right. */}
      {showWidgets && <WidgetSlotArea slot="left" />}
      <div className="flex h-full min-w-0 flex-1 flex-col gap-4 overflow-auto">
        {showWidgets && <WidgetSlotArea slot="grid" />}
        {showDesktopIcons && (
        <div className="grid min-h-0 flex-1 transition-[column-gap,row-gap] duration-200 ease-out" style={gridStyle}>
          {reorder.order.map((id) => (
            <div key={id} {...reorder.bind(id)} className={`w-full ${reorder.dragging === id ? "cursor-grabbing" : ""}`}>
            {list ? (
              <AppListRow id={id} iconSize={listIcon} title={hint(id)} {...launch(id)} />
            ) : (
              <button
                {...launch(id)}
                title={hint(id)}
                className={`group flex w-full flex-col items-center gap-1.5 rounded-xl p-2 text-center text-slate-100 hover:bg-white/10 focus:bg-white/10 focus:outline-none ${iconClick === "single" ? "cursor-pointer" : ""}`}
                // text-shadow, not a CSS drop-shadow filter (see AppIcon: filters bleed through window glass in Chrome).
                style={{ fontSize: font, lineHeight: 1.25, textShadow: "0 1px 2px var(--sd-label-shadow)" }}
              >
                <AppIcon id={id} size={iconSize} className="shrink-0 transition-transform group-hover:scale-105 group-active:scale-95" />
                <span className="line-clamp-2">{appTitle(id)}</span>
              </button>
            )}
            </div>
          ))}
        </div>
        )}
      </div>

      {/* Widgets: right column, with optional left column and middle grid (Widget Studio). */}
      {showWidgets && (
        <div className="ml-auto hidden shrink-0 flex-col gap-4 md:flex" data-tour="widgets">
          {error && <div className="glass w-80 rounded-xl px-3 py-2 text-xs text-rose-300">{error}</div>}
          <WidgetSlotArea slot="right" className="!flex" />
          {!editing && (
            <button
              onClick={() => useWidgets.getState().setEditing(true)}
              className="glass-soft self-end rounded-full px-3 py-1 text-[11px] text-slate-300 opacity-90 transition-[background-color,border-color,box-shadow,transform,scale,opacity] hover:opacity-100"
            >
              <PencilRuler size={11} className="mr-1 inline" />
              {t("widget.editPill")}
            </button>
          )}
        </div>
      )}
      <WidgetStudioDrawer />
    </div>
  );
}
