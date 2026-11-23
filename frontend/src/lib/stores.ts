import { create } from "zustand";
import { api, setUnauthorizedHandler } from "./api";
import type { Overview, StorageInfo } from "./types";
import type { AppId } from "../apps/registry";
import { APPS } from "../apps/registry";

/* ---------------- Auth ---------------- */

type AuthStatus = "checking" | "locked" | "unlocked";

interface AuthState {
  status: AuthStatus;
  username: string | null;
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
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
    const res = await api<{ username: string }>("/auth/login", { method: "POST", json: { username, password } });
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
  id: AppId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
}

interface WindowState {
  windows: Win[];
  topZ: number;
  open: (id: AppId) => void;
  close: (id: AppId) => void;
  focus: (id: AppId) => void;
  minimize: (id: AppId) => void;
  toggleMaximize: (id: AppId) => void;
  update: (id: AppId, patch: Partial<Win>) => void;
}

export const useWindows = create<WindowState>((set, get) => ({
  windows: [],
  topZ: 10,
  open: (id) => {
    const existing = get().windows.find((w) => w.id === id);
    if (existing) return get().focus(id);
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
          id,
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
  close: (id) => set((s) => ({ windows: s.windows.filter((w) => w.id !== id) })),
  focus: (id) => {
    const z = get().topZ + 1;
    set((s) => ({ topZ: z, windows: s.windows.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)) }));
  },
  minimize: (id) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)) })),
  toggleMaximize: (id) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)) })),
  update: (id, patch) => set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) })),
}));

export const activeWindow = (windows: Win[]) =>
  windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0] ?? null;

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
  history: Sample[];
  error: string | null;
  start: () => () => void;
  refreshStorage: () => Promise<void>;
}

export const useTelemetry = create<TelemetryState>((set, get) => ({
  overview: null,
  storage: null,
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
    poll();
    get().refreshStorage();
    const a = setInterval(poll, 2000);
    const b = setInterval(() => get().refreshStorage(), 30000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  },
}));

export const zfsHealth = (s: StorageInfo | null) => {
  if (!s) return "—";
  if (!s.pools.length) return "N/A";
  return s.pools.every((p) => p.health === "ONLINE") ? "ONLINE" : s.pools.find((p) => p.health !== "ONLINE")!.health;
};
