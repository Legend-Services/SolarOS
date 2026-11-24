import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "../lib/api";
import { useDock } from "../lib/stores";
import { useWizard } from "./wizardStore";

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
export type ViewApp = "compute" | "disks" | "datasets" | "appcenter" | "shares";

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
  iconClick: "single" as IconClick, windowControls: "auto" as WindowControls, shellLayout: "auto" as ShellLayout };

type Numeric = "iconSize" | "colGap" | "rowGap" | "dockGap";
type Placement = "desktopAlignment" | "desktopVerticalAlign" | "desktopMaxColumns" | "iconClick" | "windowControls" | "shellLayout";

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
    appViews: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, mode(v, "grid")])),
  };
}

/** The fields saved to localStorage and /api/system/preferences. */
const persisted = ({ desktopView, iconSize, colGap, rowGap, dockGap, desktopAlignment, desktopVerticalAlign, desktopMaxColumns, iconClick, windowControls, shellLayout, appViews }: LayoutState) =>
  ({ desktopView, iconSize, colGap, rowGap, dockGap, desktopAlignment, desktopVerticalAlign, desktopMaxColumns, iconClick, windowControls, shellLayout, appViews });

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
      appViews: {},
      panel: false,
      set: (patch) => set(patch),
      setAppView: (app, m) => set((s) => ({ appViews: { ...s.appViews, [app]: m } })),
      reset: () => {
        set({ desktopView: DEFAULTS.desktopView, iconSize: DEFAULTS.iconSize, colGap: DEFAULTS.colGap, rowGap: DEFAULTS.rowGap, dockGap: DEFAULTS.dockGap,
          desktopAlignment: DEFAULTS.desktopAlignment, desktopVerticalAlign: DEFAULTS.desktopVerticalAlign, desktopMaxColumns: DEFAULTS.desktopMaxColumns, iconClick: DEFAULTS.iconClick,
          windowControls: DEFAULTS.windowControls, shellLayout: DEFAULTS.shellLayout });
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

/** The shell actually shown ("auto" resolved for this device). */
export function useShell(): "dock" | "taskbar" {
  const s = useLayout((st) => st.shellLayout);
  return s === "auto" ? deviceShell() : s;
}

/** Screen space taken by the shell bars, which windows (maximize, snap, drag) and desktop icons stay clear of. */
export function useInsets(): { top: number; bottom: number } {
  return useShell() === "taskbar" ? { top: 0, bottom: TASKBAR } : { top: TOP_BAR, bottom: 0 };
}

/** Default view per app: each keeps the layout it had before the switcher existed. */
export const APP_VIEW_DEFAULTS: Record<ViewApp, ViewMode> = { compute: "list", disks: "grid", datasets: "list", appcenter: "grid", shares: "grid" };

/** Grid | List mode for one app, persisted. */
export function useAppView(app: ViewApp): [ViewMode, (m: ViewMode) => void] {
  const m = useLayout((s) => s.appViews[app] ?? APP_VIEW_DEFAULTS[app]);
  const setAppView = useLayout((s) => s.setAppView);
  return [m, (v) => setAppView(app, v)];
}

/* ---------------- Server sync: /api/system/preferences ---------------- */

interface Preferences {
  layout?: Partial<LayoutState>;
  dock?: { baseSize?: number };
  wizard?: { welcomeAuto?: boolean };
}

const snapshot = (): Preferences => {
  return {
    layout: persisted(useLayout.getState()),
    dock: { baseSize: useDock.getState().baseSize },
    wizard: { welcomeAuto: useWizard.getState().welcomeAuto },
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
  const subs = [useLayout.subscribe(push), useDock.subscribe(push), useWizard.subscribe(push)];

  api<Preferences>("/system/preferences")
    .then((p) => {
      if (p.layout) useLayout.setState(sanitize(p.layout, useLayout.getState()));
      if (p.dock?.baseSize !== undefined) useDock.getState().set({ baseSize: clamp(p.dock.baseSize, LIMITS.dockSize, useDock.getState().baseSize) });
      if (typeof p.wizard?.welcomeAuto === "boolean") useWizard.getState().setWelcomeAuto(p.wizard.welcomeAuto);
      last = p.layout ? JSON.stringify(snapshot()) : ""; // nothing stored yet: upload this browser's settings
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
