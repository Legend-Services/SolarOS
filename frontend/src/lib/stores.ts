import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, setUnauthorizedHandler } from "./api";
import type { ConsoleTarget, HardwareInfo, Overview, StorageInfo } from "./types";
import type { AppId } from "../apps/registry";
import { APPS } from "../apps/registry";

/* ---------------- Auth ---------------- */

type AuthStatus = "checking" | "locked" | "unlocked";

interface AuthState {
  status: AuthStatus;
  username: string | null;
  init: () => Promise<void>;
  login: (username: string, password: string, otp?: string) => Promise<void>;
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
  login: async (username, password, otp) => {
    const res = await api<{ username: string }>("/auth/login", { method: "POST", json: { username, password, otp: otp || undefined } });
    set({ status: "unlocked", username: res.username });
  },
  // Lock keeps the username but hides the desktop until the password is re-entered.
  lock: () => set({ status: "locked" }),
  logout: async () => {
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

/* ---------------- Cross-app navigation (Spotlight, desktop menu) ---------------- */

/** One-shot deep links: the target app reads its entry on mount / change and clears it with `take`. */
export interface Intents {
  files?: string; // File Station path
  compute?: "vm" | "lxc" | "iso"; // open a wizard or the ISO tab
  storage?: "pool"; // open the Create Pool dialog
  controlpanel?: "security" | "network" | "appearance" | "hardware" | "power";
}

interface IntentState extends Intents {
  go: <K extends keyof Intents>(app: K & AppId, value: Intents[K]) => void;
  take: (app: keyof Intents) => void;
}

export const useIntent = create<IntentState>((set) => ({
  go: (app, value) => {
    set({ [app]: value });
    useWindows.getState().open(app);
  },
  take: (app) => set({ [app]: undefined }),
}));

export const useSpotlight = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/* ---------------- Desktop preferences (per browser) ---------------- */

export const WALLPAPERS = [
  { id: "aurora", name: "Aurora", swatch: "linear-gradient(135deg,#38bdf8,#a855f7 60%,#10b981)" },
  { id: "sequoia", name: "Sequoia", swatch: "linear-gradient(135deg,#ea580c,#be185d 60%,#facc15)" },
  { id: "ocean", name: "Ocean", swatch: "linear-gradient(135deg,#2563eb,#06b6d4 60%,#2dd4bf)" },
  { id: "emerald", name: "Emerald", swatch: "linear-gradient(135deg,#10b981,#14b8a6 60%,#84cc16)" },
  { id: "graphite", name: "Graphite", swatch: "linear-gradient(135deg,#94a3b8,#475569 60%,#1e293b)" },
] as const;
export type WallpaperId = (typeof WALLPAPERS)[number]["id"];

interface PrefsState {
  wallpaper: WallpaperId;
  widgets: boolean;
  set: (patch: Partial<Pick<PrefsState, "wallpaper" | "widgets">>) => void;
}

export const usePrefs = create<PrefsState>()(
  persist((set) => ({ wallpaper: "aurora", widgets: true, set: (patch) => set(patch) }), {
    name: "proxmoxos-prefs",
    partialize: ({ wallpaper, widgets }) => ({ wallpaper, widgets }),
  }),
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
      set({ storage: await api<StorageInfo>("/pve/storage") });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  start: () => {
    const poll = async () => {
      try {
        const o = await api<Overview>("/pve/overview");
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
    const pollHardware = () => api<HardwareInfo>("/pve/telemetry/hardware").then((hardware) => set({ hardware }), () => {});
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
