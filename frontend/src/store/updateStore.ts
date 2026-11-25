import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import type { UpdateStatus } from "../lib/types";

/** SolarDeck release state for the Settings header and the update badge in the top bar or taskbar tray. */
interface UpdateState {
  version: string | null;
  updateAvailable: boolean;
  latestVersion: string | null;
  updateRunning: boolean;
  progressPercent: number;
  /** Take a status the caller already fetched (the Updates page polls it while an update runs). */
  apply: (s: UpdateStatus) => void;
  load: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  version: null,
  updateAvailable: false,
  latestVersion: null,
  updateRunning: false,
  progressPercent: 0,
  apply: (s) =>
    set({
      version: s.version ?? null,
      updateAvailable: !!s.update_available,
      latestVersion: s.latest_version ?? null,
      updateRunning: s.update_status === "running",
      progressPercent: s.progress_percent ?? 0,
    }),
  load: () => void api<UpdateStatus>("/system/updates/status").then(get().apply, () => {}),
}));

/** Refresh now and every 5 minutes; the backend's background check keeps update_available current. */
export function useUpdatePoll() {
  const load = useUpdateStore((s) => s.load);
  useEffect(() => {
    load();
    const i = setInterval(load, 5 * 60_000);
    return () => clearInterval(i);
  }, [load]);
}
