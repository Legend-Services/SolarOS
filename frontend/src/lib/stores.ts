import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, forgetStepUp, setUnauthorizedHandler } from "./api";
import type { ConsoleTarget, HardwareInfo, Overview, StorageInfo } from "./types";
import type { AppId } from "../apps/registry";
import { APPS, APP_IDS, DOCK_DEFAULT, liveAppIds } from "../apps/registry";
import { settingsModule, type ModuleId } from "../apps/settings/modules";
import type { NavTarget } from "../data/knowledgeRegistry";

/* ---------------- Auth ---------------- */

type AuthStatus = "checking" | "locked" | "unlocked";

interface AuthState {
  status: AuthStatus;
  username: string | null;
  init: () => Promise<void>;
  /** Resolves with a challenge token when the account has 2FA: finish with `login2fa`. */
  login: (username: string, password: string) => Promise<string | null>;
  login2fa: (challenge: string, code: string) => Promise<void>;
  lock: () => void;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  status: "checking",
  username: null,
  init: async () => {
    try {
      const me = await api<{ username: string }>("/auth/me");
      set({ status: "unlocked", username: me.username });
    } catch {
      set({ status: "locked" });
    }
  },
  login: async (username, password) => {
    const res = await api<{ username?: string; requires_2fa?: boolean; challenge_token?: string }>("/auth/login", { method: "POST", json: { username, password } });
    if (res.requires_2fa) return res.challenge_token ?? null;
    set({ status: "unlocked", username: res.username ?? username });
    return null;
  },
  login2fa: async (challenge, code) => {
    const res = await api<{ username: string }>("/auth/login/2fa", { method: "POST", json: { challenge_token: challenge, code } });
    set({ status: "unlocked", username: res.username });
  },
  // Lock keeps the username but hides the desktop until the password is re-entered.
  lock: () => (forgetStepUp(), set({ status: "locked" })),
  logout: async () => {
    forgetStepUp();
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    useWindows.setState({ windows: [] });
    set({ status: "locked", username: null });
  },
}));

setUnauthorizedHandler(() => useAuth.setState({ status: "locked" }));

/* ---------------- Windows ---------------- */

export interface Win {
  key: string; // app id, or one key per console target (multi-instance)
  id: AppId;
  params?: ConsoleTarget;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WindowState {
  windows: Win[];
  topZ: number;
  /** Screen rect of each Dock icon: the target of the minimize (genie) animation. */
  dockIconRects: Partial<Record<AppId, Rect>>;
  setDockIconRect: (id: AppId, r: Rect) => void;
  open: (id: AppId, params?: ConsoleTarget) => void;
  close: (key: string) => void;
  focus: (key: string) => void;
  minimize: (key: string) => void;
  toggleMaximize: (key: string) => void;
  update: (key: string, patch: Partial<Win>) => void;
}

export const useWindows = create<WindowState>((set, get) => ({
  windows: [],
  topZ: 10,
  dockIconRects: {},
  setDockIconRect: (id, r) => set((s) => ({ dockIconRects: { ...s.dockIconRects, [id]: r } })),
  open: (id, params) => {
    const module = settingsModule(id);
    if (module) return useIntent.getState().go("settings", module); // retired admin apps live in Settings now
    if (id !== "console") useUsage.getState().record(id); // every launcher ends here, so "Most Used" counts them all
    const key = params ? `${id}:${params.type}:${params.vmid}:${params.mode}` : id;
    if (get().windows.some((w) => w.key === key)) return get().focus(key);
    const { w, h } = APPS[id].size;
    const n = get().windows.length;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(w, vw - 40);
    const height = Math.min(h, vh - 140);
    const z = get().topZ + 1;
    set((s) => ({
      topZ: z,
      windows: [
        ...s.windows,
        {
          key,
          id,
          params,
          w: width,
          h: height,
          x: Math.max(20, (vw - width) / 2 + n * 28),
          y: Math.max(48, (vh - height) / 2 - 40 + n * 28),
          z,
          minimized: false,
          maximized: false,
        },
      ],
    }));
  },
  close: (key) => set((s) => ({ windows: s.windows.filter((w) => w.key !== key) })),
  focus: (key) => {
    const z = get().topZ + 1;
    set((s) => ({ topZ: z, windows: s.windows.map((w) => (w.key === key ? { ...w, z, minimized: false } : w)) }));
  },
  minimize: (key) => set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, minimized: true } : w)) })),
  toggleMaximize: (key) =>
    set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, maximized: !w.maximized } : w)) })),
  update: (key, patch) => set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, ...patch } : w)) })),
}));

export const activeWindow = (windows: Win[]) =>
  windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0] ?? null;

/** Dock / taskbar click: open the app, bring its window forward, or minimize it when it is already in front. */
export function activateApp(id: AppId) {
  const { windows, open, focus, minimize } = useWindows.getState();
  const w = windows.find((x) => x.id === id);
  if (!w) return open(id);
  if (!w.minimized && activeWindow(windows)?.key === w.key) minimize(w.key);
  else focus(w.key);
}

/* ---------------- Cross-app navigation (Spotlight, desktop menu) ---------------- */

/** One-shot deep links: the target app reads its entry on mount / change and clears it with `take`. */
export interface Intents {
  files?: string; // File Station path
  compute?: "vm" | "lxc" | "iso"; // open a wizard or the ISO tab
  storage?: "pool" | "dataset" | "pools" | "disks" | "benchmark" | "snapshots"; // a dialog or a tab
  controlpanel?: "security" | "network" | "appearance" | "automation" | "hardware" | "power";
  help?: "ask" | "fix" | "bios" | "tutorials" | "faq" | "manual" | Omit<Extract<NavTarget, { kind: "help" }>, "kind">;
  netservices?: "dns" | "dhcp" | "wg" | "wgc" | "router" | "domains" | "certs" | "topology";
  backup?: "backups" | "schedules" | "now"; // a tab, or the Back Up Now dialog
  shares?: "create" | "users";
  settings?: ModuleId | SettingsTarget;
}

/** A Settings deep link: a category on the hub, or a sub-module with an inner tab and a card to highlight. */
export type SettingsTarget = Omit<Extract<NavTarget, { kind: "settings" }>, "kind">;

/** Go to a search result / Help article target (data/knowledgeRegistry.ts). */
export function navigate(t: NavTarget) {
  if (t.kind === "app") return useWindows.getState().open(t.appId);
  const { kind, ...rest } = t;
  useIntent.getState().go(kind, rest);
}

/** Apps that read an intent; the others are just opened. */
export const INTENT_APPS: AppId[] = ["files", "compute", "storage", "controlpanel", "help", "netservices", "backup", "shares", "settings"];

/** Open an app, deep-linking into a tab or dialog when it supports one. */
export function openLink(app: AppId, intent?: Intents[keyof Intents]) {
  if (intent !== undefined && INTENT_APPS.includes(app)) useIntent.getState().go(app as keyof Intents & AppId, intent as never);
  else useWindows.getState().open(app);
}

/** Apply this app's pending intent once (on mount or when a new one arrives), then clear it. */
export function useIntentFor<K extends keyof Intents>(app: K, apply: (v: NonNullable<Intents[K]>) => void) {
  const v = useIntent((s) => s[app]);
  const take = useIntent((s) => s.take);
  useEffect(() => {
    if (v === undefined) return;
    apply(v as NonNullable<Intents[K]>);
    take(app);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
}

const EMBEDDED_INTENTS: (keyof Intents)[] = ["storage", "backup", "shares", "netservices"];

interface IntentState extends Intents {
  go: <K extends keyof Intents>(app: K & AppId, value: Intents[K]) => void;
  take: (app: keyof Intents) => void;
}

export const useIntent = create<IntentState>((set) => ({
  go: (app, value) => {
    // Retired apps open their Settings module. Only apps embedded there that read their own intent keep it (a tab or dialog).
    const module = settingsModule(app, value);
    if (app === "settings" || !module || EMBEDDED_INTENTS.includes(app)) set({ [app]: value });
    if (module && app !== "settings") set({ settings: module });
    useWindows.getState().open(module ? "settings" : app);
  },
  take: (app) => set({ [app]: undefined }),
}));

export const useSpotlight = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));
export const useBugReport = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/* ---------------- Desktop preferences (per browser) ---------------- */

/* Themes and wallpapers live in store/themeStore.ts. */
interface PrefsState {
  widgets: boolean;
  set: (patch: Partial<Pick<PrefsState, "widgets">>) => void;
}

export const usePrefs = create<PrefsState>()(
  persist((set) => ({ widgets: true, set: (patch) => set(patch) }), {
    name: "solardeck-prefs",
    partialize: ({ widgets }) => ({ widgets }),
  }),
);

/* ---------------- Dock (per browser) ---------------- */

/** Peak icon scale under the cursor for each Magnification Strength setting. */
export const MAGNIFICATION = { off: 1, subtle: 1.35, strong: 1.75, large: 2.2 } as const;
export type Magnification = keyof typeof MAGNIFICATION;

interface DockState {
  pinned: AppId[];
  autoHide: boolean;
  baseSize: number; // px, 36–64
  magnification: Magnification;
  gallery: boolean; // App Gallery overlay open (not persisted)
  pin: (id: AppId) => void;
  unpin: (id: AppId) => void;
  move: (id: AppId, to: number) => void;
  set: (patch: Partial<Pick<DockState, "autoHide" | "baseSize" | "magnification" | "gallery">>) => void;
}

export const useDock = create<DockState>()(
  persist(
    (set) => ({
      pinned: [...DOCK_DEFAULT],
      autoHide: false,
      baseSize: 46,
      magnification: "strong",
      gallery: false,
      pin: (id) => set((s) => (s.pinned.includes(id) ? s : { pinned: [...s.pinned, id] })),
      unpin: (id) => set((s) => ({ pinned: s.pinned.filter((x) => x !== id) })),
      move: (id, to) =>
        set((s) => {
          const rest = s.pinned.filter((x) => x !== id);
          rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
          return { pinned: rest };
        }),
      set: (patch) => set(patch),
    }),
    {
      name: "solardeck-dock",
      partialize: ({ pinned, autoHide, baseSize, magnification }) => ({ pinned, autoHide, baseSize, magnification }),
      // Drop apps that no longer exist and clamp values edited by hand in localStorage.
      merge: (saved, cur) => {
        const p = (saved ?? {}) as Partial<DockState>;
        return {
          ...cur,
          ...p,
          pinned: Array.isArray(p.pinned) ? liveAppIds(p.pinned) : cur.pinned,
          baseSize: Math.max(36, Math.min(64, Number(p.baseSize) || cur.baseSize)),
          magnification: p.magnification && p.magnification in MAGNIFICATION ? p.magnification : cur.magnification,
        };
      },
    },
  ),
);

/* ---------------- App usage (App Gallery "Most Used" / "Recently Used") ---------------- */

export interface AppUsage {
  launch_count: number;
  last_opened_at: string; // ISO 8601 UTC
}

interface UsageState {
  usage: Partial<Record<AppId, AppUsage>>;
  /** Count a launch here at once and on the server in the background. */
  record: (id: AppId) => void;
  /** Replace the local copy with the server's counts (which survive browser clears). */
  load: () => Promise<void>;
}

export const useUsage = create<UsageState>()(
  persist(
    (set) => ({
      usage: {},
      record: (id) => {
        set((s) => ({ usage: { ...s.usage, [id]: { launch_count: (s.usage[id]?.launch_count ?? 0) + 1, last_opened_at: new Date().toISOString() } } }));
        api("/system/app-usage/record", { method: "POST", json: { app_id: id } }).catch(() => {});
      },
      load: async () => {
        const u = await api<Record<string, AppUsage>>("/system/app-usage").catch(() => null);
        if (u) set({ usage: Object.fromEntries(Object.entries(u).filter(([k]) => (APP_IDS as string[]).includes(k))) });
      },
    }),
    { name: "solardeck-usage", partialize: ({ usage }) => ({ usage }) },
  ),
);

/* ---------------- Telemetry ---------------- */

export const HISTORY = 60;

export interface Sample {
  cpu: number;
  memApp: number;
  memArc: number;
  memFree: number;
  netIn: number;
  netOut: number;
}

interface TelemetryState {
  overview: Overview | null;
  storage: StorageInfo | null;
  hardware: HardwareInfo | null;
  history: Sample[];
  error: string | null;
  start: () => () => void;
  refreshStorage: () => Promise<void>;
}

export const useTelemetry = create<TelemetryState>((set, get) => ({
  overview: null,
  storage: null,
  hardware: null,
  history: [],
  error: null,
  refreshStorage: async () => {
    try {
      set({ storage: await api<StorageInfo>("/v1/storage") });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  start: () => {
    const poll = async () => {
      try {
        const o = await api<Overview>("/v1/overview");
        const arc = Math.min(o.memory.arc, o.memory.used);
        const sample: Sample = {
          cpu: o.cpu,
          memApp: o.memory.used - arc,
          memArc: arc,
          memFree: Math.max(0, o.memory.total - o.memory.used),
          netIn: o.net.in,
          netOut: o.net.out,
        };
        set({ overview: o, error: null, history: [...get().history, sample].slice(-HISTORY) });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    };
    // Hardware is optional telemetry (no GPU, no helper): failures keep the last value and show no error.
    const pollHardware = () => api<HardwareInfo>("/v1/telemetry/hardware").then((hardware) => set({ hardware }), () => {});
    poll();
    get().refreshStorage();
    pollHardware();
    const a = setInterval(poll, 2000);
    const b = setInterval(() => get().refreshStorage(), 30000);
    const c = setInterval(pollHardware, 15000);
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  },
}));

export const zfsHealth = (s: StorageInfo | null) => {
  if (!s) return "—";
  if (!s.pools.length) return "N/A";
  return s.pools.every((p) => p.health === "ONLINE") ? "ONLINE" : s.pools.find((p) => p.health !== "ONLINE")!.health;
};

/* ---------------- SolarDeck release (Settings header, update badge) ---------------- */

interface ReleaseState {
  version: string | null;
  update: boolean;
  load: () => void;
}

export const useRelease = create<ReleaseState>((set) => ({
  version: null,
  update: false,
  load: () =>
    void api<{ version?: string | null; update_available?: boolean }>("/system/updates/status").then(
      (s) => set({ version: s.version ?? null, update: !!s.update_available }),
      () => {},
    ),
}));

/** Refresh the release state now and every 30 minutes (the backend's own schedule does the remote check). */
export function useReleasePoll() {
  const load = useRelease((s) => s.load);
  useEffect(() => {
    load();
    const i = setInterval(load, 30 * 60_000);
    return () => clearInterval(i);
  }, [load]);
}
