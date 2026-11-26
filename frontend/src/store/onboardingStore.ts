import { create } from "zustand";
import { api } from "../lib/api";

export interface OnboardingState {
  onboarding_completed: boolean;
  tour_completed: boolean;
  selected_roles: string[];
  cluster_intent: "standalone" | "create_cluster" | "join_cluster";
}

/** Server Setup Wizard + Desktop Tour: what the backend remembers, and what is open right now. */
interface Store {
  state: OnboardingState | null;
  wizard: boolean;
  tour: boolean;
  load: () => Promise<void>;
  openWizard: () => void;
  closeWizard: () => void;
  startTour: () => void;
  /** Finish or skip: never shown automatically again. */
  endTour: () => void;
}

export const useOnboarding = create<Store>((set, get) => ({
  state: null,
  wizard: false,
  tour: false,
  load: async () => {
    const state = await api<OnboardingState>("/onboarding/state").catch(() => null);
    set({ state, wizard: !!state && !state.onboarding_completed, tour: !!state?.onboarding_completed && !state.tour_completed });
  },
  openWizard: () => set({ wizard: true, tour: false }),
  closeWizard: () => {
    const s = get().state;
    set({ wizard: false, tour: !!s?.onboarding_completed && !s.tour_completed });
  },
  startTour: () => set({ tour: true }),
  endTour: () => {
    set((p) => ({ tour: false, state: p.state && { ...p.state, tour_completed: true } }));
    api("/onboarding/tour-complete", { method: "POST" }).catch(() => {});
  },
}));
