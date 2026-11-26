import { create } from "zustand";
import { api } from "../lib/api";
import { appOn, moduleOn, on, tabOn, type Enabled, type FeatureKey } from "../data/features";
import type { AppId } from "../apps/registry";
import type { ModuleId } from "../apps/settings/modules";

/** GET/PUT /api/system/features. Until it answers (or for a role that may not read it) everything counts as on. */
interface FeatureState {
  enabled: Enabled;
  loaded: boolean;
  load: () => Promise<void>;
  /** Saves the changed flags; returns the backend's warnings (a service that could not be paused or resumed). */
  save: (changes: Enabled) => Promise<string[]>;
}

export const useFeatures = create<FeatureState>((set) => ({
  enabled: {},
  loaded: false,
  load: async () => {
    const r = await api<{ enabled: Enabled }>("/system/features").catch(() => null);
    set({ enabled: r?.enabled ?? {}, loaded: true });
  },
  save: async (changes) => {
    const r = await api<{ enabled: Enabled; warnings: string[] }>("/system/features", { method: "PUT", json: { enabled: changes } });
    set({ enabled: r.enabled });
    return r.warnings;
  },
}));

export const isFeatureEnabled = (k: FeatureKey) => on(useFeatures.getState().enabled, k);
export const useFeatureEnabled = (k: FeatureKey) => useFeatures((s) => on(s.enabled, k));
/** Visibility checks bound to the current flags (re-render when they change). */
export function useVisibility() {
  const e = useFeatures((s) => s.enabled);
  return { enabled: e, module: (m: ModuleId) => moduleOn(e, m), tab: (m: ModuleId, tab?: string) => tabOn(e, m, tab), app: (id: AppId) => appOn(e, id) };
}
