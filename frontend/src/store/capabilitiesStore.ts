import { create } from "zustand";
import { edition } from "@edition";
import { api } from "../lib/api";
import type { Product } from "../editions/types";

/** Mirrors backend ProviderCapabilities (GET /api/system/capabilities). */
export interface Capabilities {
  driver: string;
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
  default_bridge: string;
}
export type CapabilityFlag = { [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never }[keyof Capabilities];

/** Used until (or if) the endpoint answers, so the edition's own platform behaves exactly as before. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  driver: edition.defaultDriver,
  platform_label: edition.platformLabel,
  supports_clustering: true,
  supports_lxc: true,
  supports_qemu: true,
  supports_zfs: true,
  supports_gpu_passthrough: true,
  supports_bios_manager: true,
  supports_rbac_realms: true,
  supports_apt_repos: true,
  supports_host_shell: true,
  default_bridge: "",
};

interface CapabilitiesState {
  capabilities: Capabilities;
  loaded: boolean;
  load: () => Promise<void>;
}

export const useCapabilities = create<CapabilitiesState>((set) => ({
  capabilities: DEFAULT_CAPABILITIES,
  loaded: false,
  load: async () => {
    const c = await api<Partial<Capabilities>>("/system/capabilities").catch(() => null);
    const capabilities = { ...DEFAULT_CAPABILITIES, ...(c ?? {}) };
    set({ capabilities, loaded: true });
    // Tab title and icon follow the reported driver (index.html starts with the edition's own).
    const product = productOf(capabilities.driver);
    document.title = product.name;
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", `/brand/${product.slug}-mark.svg`);
  },
}));

/** GET /api/system/branding/info (signed in only: it names the host). */
export interface BrandingInfo {
  hostname: string;
  /** The server name to show: the hypervisor node on a cluster platform, otherwise the host name. */
  display_host: string;
  platform_label: string;
  brand_mode: "solardeck" | "solaros";
}

export const useBranding = create<{ info: BrandingInfo | null; load: () => Promise<void> }>((set) => ({
  info: null,
  load: async () => set({ info: await api<BrandingInfo>("/system/branding/info").catch(() => null) }),
}));

export const usePlatformLabel = () => useCapabilities((s) => s.capabilities.platform_label);
export const useSupports = (flag: CapabilityFlag) => useCapabilities((s) => s.capabilities[flag]);
export const useDriver = () => useCapabilities((s) => s.capabilities.driver);

/** Product branding (name, logo slug) for a driver, as the edition defines it. */
export type { Product };
export const productOf = (driver: string): Product => edition.product(driver);
export const useProduct = () => productOf(useDriver());
