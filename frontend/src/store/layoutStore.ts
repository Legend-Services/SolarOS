import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "../lib/api";
import { useDock, usePrefs, useUsage } from "../lib/stores";
import { liveAppIds, type AppId } from "../apps/registry";
import { hypervisorPrefs, sanitizeHypervisor, useHypervisorDefaults, type HypervisorDefaults } from "./hypervisorStore";
import { useWizard } from "./wizardStore";
import { sanitizePrefs, themePrefs, useTheme } from "./themeStore";
import type { ThemePrefs } from "../theme/themeTypes";
import { NOTES_MAX, sanitizeWidgets, useWidgets, type WidgetCfg } from "./widgetStore";
import { isLang, useLanguage, type Lang } from "../i18n";

export type ViewMode = "grid" | "list";
export type Align = "left" | "center";
export type VAlign = "top" | "middle";
/** How desktop icons open their app: one click (like a website, default) or a double click. */
export type IconClick = "single" | "double";
/** Window button layout: follow the device ("auto"), traffic-light circles on the left, or flat buttons on the right. */
export type WindowControls = "auto" | "left" | "right";

/** Desktop shell: follow the device ("auto"), top bar + Dock, or one taskbar along the bottom. */
export type ShellLayout = "auto" | "dock" | "taskbar";

/** The browser's platform name; only used to pick the "auto" defaults below. */
const platformName = () => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || "";
};
/** The side "auto" window buttons resolve to. */
export const deviceControls = (): "left" | "right" => (/mac|iphone|ipad/i.test(platformName()) ? "left" : "right");
/** The shell "auto" resolves to. */
export const deviceShell = (): "dock" | "taskbar" => (/^win/i.test(platformName()) ? "taskbar" : "dock");

export const TOP_BAR = 36; // px, top bar height in the Dock layout
export const TASKBAR = 48; // px, taskbar height in the taskbar layout
/** "auto" fits as many columns as the safe width allows; a number caps it (3–8). */
export type MaxColumns = "auto" | number;
/** Apps with a Grid | List switcher. */
export type ViewApp = "compute" | "disks" | "datasets" | "appcenter" | "shares" | "gallery";
/** App Gallery order: the user's drag-and-drop order, launch counts, name, or last opened. */
export type GallerySort = "custom" | "most-used" | "alpha-asc" | "alpha-desc" | "recent";
const SORTS: GallerySort[] = ["custom", "most-used", "alpha-asc", "alpha-desc", "recent"];

/** Slider ranges [min, max]. Dock icon size lives in useDock.baseSize (36–64). */
export const LIMITS = {
  iconSize: [36, 96],
  colGap: [8, 64],
  rowGap: [8, 56],
  dockSize: [36, 64],
  dockGap: [4, 20],
  maxColumns: [3, 8],
} as const;

export const DEFAULTS = { desktopView: "grid" as ViewMode, iconSize: 56, colGap: 20, rowGap: 16, dockGap: 8, dockSize: 46,
  desktopAlignment: "left" as Align, desktopVerticalAlign: "top" as VAlign, desktopMaxColumns: "auto" as MaxColumns,
  iconClick: "single" as IconClick, windowControls: "auto" as WindowControls, shellLayout: "auto" as ShellLayout, showDesktopIcons: false };

type Numeric = "iconSize" | "colGap" | "rowGap" | "dockGap";
type Placement = "desktopAlignment" | "desktopVerticalAlign" | "desktopMaxColumns" | "iconClick" | "windowControls" | "shellLayout"
  | "showDesktopIcons" | "gallerySortMode" | "galleryAppOrder";

interface LayoutState {
  desktopView: ViewMode;
  iconSize: number;
  colGap: number;
  rowGap: number;
  dockGap: number;
  desktopAlignment: Align;
  desktopVerticalAlign: VAlign;
  desktopMaxColumns: MaxColumns;
  iconClick: IconClick;
  windowControls: WindowControls;
  shellLayout: ShellLayout;
  /** App shortcuts on the wallpaper; off by default (clean desktop, every app is in the App Gallery). */
  showDesktopIcons: boolean;
  gallerySortMode: GallerySort;
  /** Drag-and-drop order of the App Gallery; apps missing from it follow in registry order. */
  galleryAppOrder: AppId[];
  appViews: Partial<Record<ViewApp, ViewMode>>;
  /** View Options popover (not persisted). */
  panel: boolean;
  set: (patch: Partial<Pick<LayoutState, "desktopView" | Numeric | Placement | "panel">>) => void;
  setAppView: (app: ViewApp, mode: ViewMode) => void;
  reset: () => void;
}

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};
/** Keep known app ids once each; retired admin ids (Control Panel, System, …) migrate to Settings. */
export const appOrder = liveAppIds;
const mode = (v: unknown, fallback: ViewMode): ViewMode => (v === "grid" || v === "list" ? v : fallback);

/** Validate a saved layout (localStorage or server JSON) against the current one. */
function sanitize(saved: Partial<LayoutState> | undefined, cur: LayoutState): Partial<LayoutState> {
  const p = saved ?? {};
  const views = typeof p.appViews === "object" && p.appViews ? p.appViews : {};
  return {
    desktopView: mode(p.desktopView, cur.desktopView),
    iconSize: clamp(p.iconSize, LIMITS.iconSize, cur.iconSize),
    colGap: clamp(p.colGap, LIMITS.colGap, cur.colGap),
    rowGap: clamp(p.rowGap, LIMITS.rowGap, cur.rowGap),
    dockGap: clamp(p.dockGap, LIMITS.dockGap, cur.dockGap),
    desktopAlignment: p.desktopAlignment === "left" || p.desktopAlignment === "center" ? p.desktopAlignment : cur.desktopAlignment,
    desktopVerticalAlign: p.desktopVerticalAlign === "top" || p.desktopVerticalAlign === "middle" ? p.desktopVerticalAlign : cur.desktopVerticalAlign,
    desktopMaxColumns: p.desktopMaxColumns === "auto" ? "auto" : typeof p.desktopMaxColumns === "number" ? clamp(p.desktopMaxColumns, LIMITS.maxColumns, 3) : cur.desktopMaxColumns,
    iconClick: p.iconClick === "single" || p.iconClick === "double" ? p.iconClick : cur.iconClick,
    windowControls: p.windowControls === "auto" || p.windowControls === "left" || p.windowControls === "right" ? p.windowControls : cur.windowControls,
    shellLayout: p.shellLayout === "auto" || p.shellLayout === "dock" || p.shellLayout === "taskbar" ? p.shellLayout : cur.shellLayout,
    showDesktopIcons: typeof p.showDesktopIcons === "boolean" ? p.showDesktopIcons : cur.showDesktopIcons,
    gallerySortMode: SORTS.includes(p.gallerySortMode as GallerySort) ? (p.gallerySortMode as GallerySort) : cur.gallerySortMode,
    galleryAppOrder: p.galleryAppOrder === undefined ? cur.galleryAppOrder : appOrder(p.galleryAppOrder),
    appViews: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, mode(v, "grid")])),
  };
}

/** The fields saved to localStorage and /api/system/preferences. */
const persisted = ({ desktopView, iconSize, colGap, rowGap, dockGap, desktopAlignment, desktopVerticalAlign, desktopMaxColumns, iconClick, windowControls, shellLayout,
  showDesktopIcons, gallerySortMode, galleryAppOrder, appViews }: LayoutState) =>
  ({ desktopView, iconSize, colGap, rowGap, dockGap, desktopAlignment, desktopVerticalAlign, desktopMaxColumns, iconClick, windowControls, shellLayout,
    showDesktopIcons, gallerySortMode, galleryAppOrder, appViews });

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      desktopView: DEFAULTS.desktopView,
      iconSize: DEFAULTS.iconSize,
      colGap: DEFAULTS.colGap,
      rowGap: DEFAULTS.rowGap,
      dockGap: DEFAULTS.dockGap,
      desktopAlignment: DEFAULTS.desktopAlignment,
      desktopVerticalAlign: DEFAULTS.desktopVerticalAlign,
      desktopMaxColumns: DEFAULTS.desktopMaxColumns,
      iconClick: DEFAULTS.iconClick,
      windowControls: DEFAULTS.windowControls,
      shellLayout: DEFAULTS.shellLayout,
      showDesktopIcons: DEFAULTS.showDesktopIcons,
      gallerySortMode: "custom",
      galleryAppOrder: [],
      appViews: {},
      panel: false,
      set: (patch) => set(patch),
      setAppView: (app, m) => set((s) => ({ appViews: { ...s.appViews, [app]: m } })),
      reset: () => {
        set({ desktopView: DEFAULTS.desktopView, iconSize: DEFAULTS.iconSize, colGap: DEFAULTS.colGap, rowGap: DEFAULTS.rowGap, dockGap: DEFAULTS.dockGap,
          desktopAlignment: DEFAULTS.desktopAlignment, desktopVerticalAlign: DEFAULTS.desktopVerticalAlign, desktopMaxColumns: DEFAULTS.desktopMaxColumns, iconClick: DEFAULTS.iconClick,
          windowControls: DEFAULTS.windowControls, shellLayout: DEFAULTS.shellLayout, showDesktopIcons: DEFAULTS.showDesktopIcons });
        useDock.getState().set({ baseSize: DEFAULTS.dockSize });
      },
    }),
    {
      name: "solardeck-layout",
      partialize: (s) => persisted(s),
      merge: (saved, cur) => ({ ...cur, ...sanitize(saved as Partial<LayoutState>, cur) }),
    },
  ),
);

/** Themes whose "auto" shell is the bottom taskbar on every device. */
const TASKBAR_THEMES = new Set(["redmond-mica"]);

/** The shell actually shown ("auto" resolved for the active theme and this device). */
export function useShell(): "dock" | "taskbar" {
  const s = useLayout((st) => st.shellLayout);
  const taskbarTheme = useTheme((t) => TASKBAR_THEMES.has(t.activeThemeId));
  return s !== "auto" ? s : taskbarTheme ? "taskbar" : deviceShell();
}

/** Screen space taken by the shell bars, which windows (maximize, snap, drag) and desktop icons stay clear of. */
export function useInsets(): { top: number; bottom: number } {
  return useShell() === "taskbar" ? { top: 0, bottom: TASKBAR } : { top: TOP_BAR, bottom: 0 };
}

/** Default view per app: each keeps the layout it had before the switcher existed. */
export const APP_VIEW_DEFAULTS: Record<ViewApp, ViewMode> = { compute: "list", disks: "grid", datasets: "list", appcenter: "grid", shares: "grid", gallery: "grid" };

/** Grid | List mode for one app, persisted. */
export function useAppView(app: ViewApp): [ViewMode, (m: ViewMode) => void] {
  const m = useLayout((s) => s.appViews[app] ?? APP_VIEW_DEFAULTS[app]);
  const setAppView = useLayout((s) => s.setAppView);
  return [m, (v) => setAppView(app, v)];
}

/* ---------------- Server sync: /api/system/preferences ---------------- */

interface Preferences {
  layout?: Partial<LayoutState>;
  dock?: { baseSize?: number; dockAppOrder?: AppId[] };
  wizard?: { welcomeAuto?: boolean };
  theme?: Partial<ThemePrefs>;
  widgets?: { items?: WidgetCfg[]; notes?: string; visible?: boolean };
  i18n?: { language?: Lang };
  hypervisor?: Partial<HypervisorDefaults>;
}

const snapshot = (): Preferences => {
  return {
    layout: persisted(useLayout.getState()),
    dock: { baseSize: useDock.getState().baseSize, dockAppOrder: useDock.getState().pinned },
    wizard: { welcomeAuto: useWizard.getState().welcomeAuto },
    theme: themePrefs(useTheme.getState()),
    widgets: { items: useWidgets.getState().items, notes: useWidgets.getState().notes, visible: usePrefs.getState().widgets },
    i18n: { language: useLanguage.getState().language },
    hypervisor: hypervisorPrefs(useHypervisorDefaults.getState()),
  };
};

/**
 * Load preferences from the server (they win over this browser's copy), then push every later change, debounced.
 * `onReady` runs once the server answered or failed, so callers can act on synced values (Welcome Tour).
 * Returns an unsubscribe function.
 */
export function startPreferencesSync(onReady: () => void): () => void {
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  const push = () => {
    if (!ready) return;
    const body = snapshot();
    const json = JSON.stringify(body);
    clearTimeout(timer);
    if (json === last) return;
    timer = setTimeout(() => {
      last = json;
      api("/system/preferences", { method: "PUT", json: body }).catch(() => (last = "")); // retry on the next change
    }, 600);
  };
  const subs = [useLayout.subscribe(push), useDock.subscribe(push), useWizard.subscribe(push), useTheme.subscribe(push), useWidgets.subscribe(push),
    usePrefs.subscribe(push), useLanguage.subscribe(push), useHypervisorDefaults.subscribe(push)];

  useUsage.getState().load();
  api<Preferences>("/system/preferences")
    .then((p) => {
      if (p.layout) useLayout.setState(sanitize(p.layout, useLayout.getState()));
      if (Array.isArray(p.dock?.dockAppOrder)) useDock.setState({ pinned: appOrder(p.dock.dockAppOrder) });
      if (p.dock?.baseSize !== undefined) useDock.getState().set({ baseSize: clamp(p.dock.baseSize, LIMITS.dockSize, useDock.getState().baseSize) });
      if (typeof p.wizard?.welcomeAuto === "boolean") useWizard.getState().setWelcomeAuto(p.wizard.welcomeAuto);
      if (p.theme) useTheme.setState(sanitizePrefs(p.theme));
      if (p.widgets?.items) useWidgets.setState({ items: sanitizeWidgets(p.widgets.items) });
      if (typeof p.widgets?.notes === "string") useWidgets.setState({ notes: p.widgets.notes.slice(0, NOTES_MAX) });
      if (typeof p.widgets?.visible === "boolean") usePrefs.getState().set({ widgets: p.widgets.visible });
      if (isLang(p.i18n?.language)) useLanguage.getState().setLanguage(p.i18n.language);
      if (p.hypervisor) useHypervisorDefaults.setState(sanitizeHypervisor(p.hypervisor));
      last = p.layout && p.theme ? JSON.stringify(snapshot()) : ""; // nothing stored yet: upload this browser's settings
    })
    .catch(() => {})
    .finally(() => {
      ready = true;
      push();
      onReady();
    });

  return () => {
    clearTimeout(timer);
    subs.forEach((u) => u());
  };
}
