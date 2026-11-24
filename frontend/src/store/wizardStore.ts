import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WizardState {
  /** Guide id from data/wizardGuides, or null when no wizard is open. */
  guide: string | null;
  step: number;
  /** Show the Welcome Tour automatically after login. Synced to /api/system/preferences. */
  welcomeAuto: boolean;
  show: (guide: string, step?: number) => void;
  setStep: (step: number) => void;
  close: () => void;
  setWelcomeAuto: (v: boolean) => void;
}

export const useWizard = create<WizardState>()(
  persist(
    (set) => ({
      guide: null,
      step: 0,
      welcomeAuto: true,
      show: (guide, step = 0) => set({ guide, step }),
      setStep: (step) => set({ step }),
      close: () => set({ guide: null, step: 0 }),
      setWelcomeAuto: (welcomeAuto) => set({ welcomeAuto }),
    }),
    { name: "solardeck-wizard", partialize: ({ welcomeAuto }) => ({ welcomeAuto }) },
  ),
);
