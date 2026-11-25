import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Settings > Hypervisor Defaults: the values the New VM / New Container wizard starts with. Synced with /api/system/preferences. */
export interface GuestProfile {
  cores: number;
  memory: number; // MiB
  disk: number; // GB
}

export interface HypervisorDefaults {
  vm: GuestProfile;
  lxc: GuestProfile;
  /** Preferred storage for new disks; "" picks ZFS, then local-lvm, then anything. */
  storage: string;
  /** Nesting on for new containers (Docker inside LXC needs it). */
  nesting: boolean;
}

export const HYPERVISOR_DEFAULTS: HypervisorDefaults = {
  vm: { cores: 2, memory: 2048, disk: 32 },
  lxc: { cores: 1, memory: 1024, disk: 8 },
  storage: "",
  nesting: true,
};

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};
const profile = (v: unknown, d: GuestProfile): GuestProfile => {
  const p = (typeof v === "object" && v ? v : {}) as Partial<GuestProfile>;
  return { cores: num(p.cores, 1, 512, d.cores), memory: num(p.memory, 64, 4_194_304, d.memory), disk: num(p.disk, 1, 65_536, d.disk) };
};

/** Validate saved defaults (localStorage or server JSON). */
export function sanitizeHypervisor(v: unknown): HypervisorDefaults {
  const p = (typeof v === "object" && v ? v : {}) as Partial<HypervisorDefaults>;
  const d = HYPERVISOR_DEFAULTS;
  return {
    vm: profile(p.vm, d.vm),
    lxc: profile(p.lxc, d.lxc),
    storage: typeof p.storage === "string" && /^[A-Za-z0-9._-]{0,64}$/.test(p.storage) ? p.storage : d.storage,
    nesting: typeof p.nesting === "boolean" ? p.nesting : d.nesting,
  };
}

interface HypervisorState extends HypervisorDefaults {
  set: (patch: Partial<HypervisorDefaults>) => void;
  reset: () => void;
}

export const useHypervisorDefaults = create<HypervisorState>()(
  persist(
    (set) => ({ ...HYPERVISOR_DEFAULTS, set: (patch) => set(patch), reset: () => set(HYPERVISOR_DEFAULTS) }),
    {
      name: "solardeck-hypervisor-defaults",
      partialize: ({ vm, lxc, storage, nesting }) => ({ vm, lxc, storage, nesting }),
      merge: (saved, cur) => ({ ...cur, ...sanitizeHypervisor(saved) }),
    },
  ),
);

export const hypervisorPrefs = ({ vm, lxc, storage, nesting }: HypervisorDefaults): HypervisorDefaults => ({ vm, lxc, storage, nesting });
