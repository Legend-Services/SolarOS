import { create } from "zustand";
import { api } from "../lib/api";
import type { TKey } from "../i18n";

/** Mirrors backend ProviderCapabilities (GET /api/system/capabilities). */
export interface Capabilities {
  driver: "proxmox" | "native_ubuntu" | (string & {});
  platform_label: string;
  supports_clustering: boolean;
  supports_lxc: boolean;
  supports_qemu: boolean;
  supports_zfs: boolean;
  supports_gpu_passthrough: boolean;
  supports_bios_manager: boolean;
  supports_rbac_realms: boolean;
  supports_apt_repos: boolean;
  supports_host_shell: boolean;
}
export type CapabilityFlag = { [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never }[keyof Capabilities];

/** Used until (or if) the endpoint answers, so a Proxmox install behaves exactly as before. */
export const PROXMOX_DEFAULTS: Capabilities = {
  driver: "proxmox",
  platform_label: "Proxmox VE",
  supports_clustering: true,
  supports_lxc: true,
  supports_qemu: true,
  supports_zfs: true,
  supports_gpu_passthrough: true,
  supports_bios_manager: true,
  supports_rbac_realms: true,
  supports_apt_repos: true,
  supports_host_shell: true,
};

interface CapabilitiesState {
  capabilities: Capabilities;
  loaded: boolean;
  load: () => Promise<void>;
}

export const useCapabilities = create<CapabilitiesState>((set) => ({
  capabilities: PROXMOX_DEFAULTS,
  loaded: false,
  load: async () => {
    const c = await api<Partial<Capabilities>>("/system/capabilities").catch(() => null);
    const capabilities = { ...PROXMOX_DEFAULTS, ...(c ?? {}) };
    set({ capabilities, loaded: true });
    // Tab title and icon follow the edition (index.html starts with the Proxmox VE edition's).
    const product = productOf(capabilities.driver);
    document.title = product.name;
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", `/brand/${product.slug}-mark.svg`);
  },
}));

export const usePlatformLabel = () => useCapabilities((s) => s.capabilities.platform_label);
export const useSupports = (flag: CapabilityFlag) => useCapabilities((s) => s.capabilities[flag]);
export const useDriver = () => useCapabilities((s) => s.capabilities.driver);

/** Product branding: the standalone edition is SolarOS, the Proxmox VE edition is SolarDeck for Proxmox VE. */
export interface Product {
  name: string;
  short: string;
  slug: "solaros" | "solardeck-proxmox";
}
export const productOf = (driver: string): Product =>
  driver === "native_ubuntu"
    ? { name: "SolarOS", short: "SolarOS", slug: "solaros" }
    : { name: "SolarDeck for Proxmox VE", short: "SolarDeck", slug: "solardeck-proxmox" };
export const useProduct = () => productOf(useDriver());
/** i18n key of the driver badge: "Proxmox VE" or "SolarOS". */
export const driverBadgeKey = (driver: string): TKey => (driver === "proxmox" ? "driver.proxmox" : "driver.standalone");
