import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "../lib/api";
import { useDock } from "../lib/stores";
import { useWizard } from "./wizardStore";

export type ViewMode = "grid" | "list";
/** Apps with a Grid | List switcher. */
export type ViewApp = "compute" | "disks" | "datasets" | "appcenter" | "shares";

/** Slider ranges [min, max]. Dock icon size lives in useDock.baseSize (36–64). */
export const LIMITS = {
  iconSize: [36, 96],
  colGap: [8, 64],
  rowGap: [8, 56],
  dockSize: [36, 64],
  dockGap: [4, 20],
} as const;

export const DEFAULTS = { desktopView: "grid" as ViewMode, iconSize: 56, colGap: 20, rowGap: 16, dockGap: 8, dockSize: 46 };

type Numeric = "iconSize" | "colGap" | "rowGap" | "dockGap";

interface LayoutState {
  desktopView: ViewMode;
  iconSize: number;
  colGap: number;
  rowGap: number;
  dockGap: number;
  appViews: Partial<Record<ViewApp, ViewMode>>;
  /** View Options popover (not persisted). */
  panel: boolean;
  set: (patch: Partial<Pick<LayoutState, "desktopView" | Numeric | "panel">>) => void;
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
    appViews: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, mode(v, "grid")])),
  };
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      desktopView: DEFAULTS.desktopView,
      iconSize: DEFAULTS.iconSize,
      colGap: DEFAULTS.colGap,
      rowGap: DEFAULTS.rowGap,
      dockGap: DEFAULTS.dockGap,
      appViews: {},
      panel: false,
      set: (patch) => set(patch),
      setAppView: (app, m) => set((s) => ({ appViews: { ...s.appViews, [app]: m } })),
      reset: () => {
        set({ desktopView: DEFAULTS.desktopView, iconSize: DEFAULTS.iconSize, colGap: DEFAULTS.colGap, rowGap: DEFAULTS.rowGap, dockGap: DEFAULTS.dockGap });
        useDock.getState().set({ baseSize: DEFAULTS.dockSize });
      },
    }),
    {
      name: "proxmoxos-layout",
      partialize: ({ desktopView, iconSize, colGap, rowGap, dockGap, appViews }) => ({ desktopView, iconSize, colGap, rowGap, dockGap, appViews }),
      merge: (saved, cur) => ({ ...cur, ...sanitize(saved as Partial<LayoutState>, cur) }),
    },
  ),
);

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
  const { desktopView, iconSize, colGap, rowGap, dockGap, appViews } = useLayout.getState();
  return {
    layout: { desktopView, iconSize, colGap, rowGap, dockGap, appViews },
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
