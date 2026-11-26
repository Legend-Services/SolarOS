import {
  Activity, ArchiveRestore, Award, BatteryCharging, BellRing, Boxes, BrainCircuit, Cog, Cpu, Database, Disc3, FileClock, Flame, Globe, HardDrive, Info, KeyRound, Layers, LayoutGrid,
  Network, Package, Palette, Route, Server, Share2, ShieldAlert, ShieldCheck, ToggleRight, Users, Waypoints, Workflow, type LucideIcon,
} from "lucide-react";
import type { AppId } from "../registry";

// Metadata only (no components) so lib/stores can import it without a circular dependency.

export const CATEGORIES = ["system", "storage", "security", "network", "hypervisor"] as const;
export type CategoryId = (typeof CATEGORIES)[number];

export const CATEGORY_META: Record<CategoryId, { icon: LucideIcon; tint: string }> = {
  system: { icon: Cog, tint: "from-slate-300 to-slate-600" },
  storage: { icon: Database, tint: "from-amber-300 to-orange-600" },
  security: { icon: ShieldCheck, tint: "from-indigo-400 to-violet-600" },
  network: { icon: Network, tint: "from-sky-400 to-cyan-600" },
  hypervisor: { icon: Layers, tint: "from-emerald-400 to-teal-600" },
};

/** `guide`: the App Guide shown by the breadcrumb "? Guide" button. */
export const MODULES = {
  "system-info": { cat: "system", icon: Info, tint: "from-sky-300 to-blue-600", guide: "controlpanel" },
  "general-appearance": { cat: "system", icon: Palette, tint: "from-pink-400 to-rose-600", guide: "controlpanel" },
  "features-services": { cat: "system", icon: ToggleRight, tint: "from-cyan-300 to-violet-600", guide: "settings" },
  "installed-apps": { cat: "system", icon: Package, tint: "from-sky-400 to-blue-600", guide: "appcenter" },
  "hardware-gpu": { cat: "system", icon: Cpu, tint: "from-emerald-400 to-teal-600", guide: "controlpanel" },
  "resource-monitor": { cat: "system", icon: Activity, tint: "from-cyan-300 to-blue-600", guide: "monitor" },
  "system-services": { cat: "system", icon: Workflow, tint: "from-slate-300 to-zinc-600", guide: "system" },
  "automation-alerts": { cat: "system", icon: BellRing, tint: "from-fuchsia-400 to-purple-600", guide: "controlpanel" },
  "power-ups": { cat: "system", icon: BatteryCharging, tint: "from-lime-300 to-emerald-600", guide: "controlpanel" },
  "storage-zfs": { cat: "storage", icon: HardDrive, tint: "from-amber-300 to-orange-600", guide: "storage" },
  "backup-restore": { cat: "storage", icon: ArchiveRestore, tint: "from-violet-400 to-fuchsia-600", guide: "backup" },
  "shared-folders": { cat: "storage", icon: Share2, tint: "from-sky-400 to-indigo-600", guide: "shares" },
  "iso-templates": { cat: "storage", icon: Disc3, tint: "from-teal-300 to-cyan-600", guide: "compute" },
  "users-roles": { cat: "security", icon: Users, tint: "from-blue-400 to-indigo-600", guide: "datacenter" },
  "security-2fa": { cat: "security", icon: KeyRound, tint: "from-indigo-400 to-violet-600", guide: "controlpanel" },
  "security-posture": { cat: "security", icon: ShieldCheck, tint: "from-emerald-400 to-green-700", guide: "controlpanel" },
  "audit-logs": { cat: "security", icon: FileClock, tint: "from-slate-300 to-slate-600", guide: "datacenter" },
  "platform-modules": { cat: "security", icon: LayoutGrid, tint: "from-violet-400 to-indigo-700", guide: "controlpanel" },
  "network-switch": { cat: "network", icon: Network, tint: "from-sky-400 to-cyan-600", guide: "controlpanel" },
  "network-topology": { cat: "network", icon: Share2, tint: "from-cyan-300 to-sky-600", guide: "netservices" },
  "dns-dhcp": { cat: "network", icon: Globe, tint: "from-blue-400 to-sky-600", guide: "netservices" },
  "domains-certs": { cat: "network", icon: Award, tint: "from-yellow-300 to-amber-600", guide: "netservices" },
  "reverse-proxy": { cat: "network", icon: Route, tint: "from-teal-300 to-sky-600", guide: "netservices" },
  "firewall-forwarding": { cat: "network", icon: Flame, tint: "from-orange-400 to-red-600", guide: "netservices" },
  "firewall-ids": { cat: "network", icon: ShieldAlert, tint: "from-rose-400 to-red-700", guide: "netservices" },
  "wireguard-vpn": { cat: "network", icon: Waypoints, tint: "from-green-400 to-emerald-700", guide: "netservices" },
  "hypervisor-defaults": { cat: "hypervisor", icon: Server, tint: "from-emerald-400 to-teal-600", guide: "compute" },
  "local-ai-runtime": { cat: "hypervisor", icon: BrainCircuit, tint: "from-purple-400 to-indigo-600", guide: "local-ai" },
  "cluster-ha": { cat: "hypervisor", icon: Boxes, tint: "from-sky-400 to-indigo-600", guide: "compute" },
} satisfies Record<string, { cat: CategoryId; icon: LucideIcon; tint: string; guide: AppId }>;

export type ModuleId = keyof typeof MODULES;
export const MODULE_IDS = Object.keys(MODULES) as ModuleId[];
export const isModule = (v: unknown): v is ModuleId => typeof v === "string" && v in MODULES;

/** Where a retired app id (optionally with its old deep-link intent) now lives in Settings. */
const LEGACY: Partial<Record<AppId, ModuleId>> = {
  monitor: "resource-monitor",
  storage: "storage-zfs",
  backup: "backup-restore",
  shares: "shared-folders",
  netservices: "network-topology",
  datacenter: "users-roles",
  controlpanel: "general-appearance",
  system: "system-info",
};
const LEGACY_INTENT: Record<string, ModuleId> = {
  "controlpanel:security": "security-2fa",
  "controlpanel:network": "network-switch",
  "controlpanel:appearance": "general-appearance",
  "controlpanel:automation": "automation-alerts",
  "controlpanel:hardware": "hardware-gpu",
  "controlpanel:power": "system-info",
  "netservices:wg": "wireguard-vpn",
  "netservices:wgc": "wireguard-vpn",
  "netservices:router": "firewall-forwarding",
  "netservices:topology": "network-topology",
  "netservices:dns": "dns-dhcp",
  "netservices:dhcp": "dns-dhcp",
  "netservices:domains": "domains-certs",
  "netservices:certs": "domains-certs",
  "help:bios": "hardware-gpu",
};

/** Retired sub-module ids (saved deep links, bookmarks) and the module plus inner tab that replaced them. */
const RENAMED: Record<string, { module: ModuleId; tab?: string }> = {
  "host-power": { module: "system-info" },
  "bios-firmware": { module: "hardware-gpu", tab: "bios" },
  "software-updates": { module: "system-services", tab: "solardeck" },
};
const LEGACY_TAB: Record<string, string> = { "help:bios": "bios" };

/** The Settings module an app id (plus intent) opens, or undefined when it is still an app of its own. */
export function settingsModule(app: AppId, intent?: unknown): ModuleId | undefined {
  if (app === "settings") {
    const m = typeof intent === "string" ? intent : (intent as { module?: unknown } | undefined)?.module;
    return isModule(m) ? m : typeof m === "string" ? RENAMED[m]?.module : undefined;
  }
  return LEGACY_INTENT[`${app}:${intent}`] ?? LEGACY[app];
}

/** The inner tab a legacy app link or a retired module id points at, if any. */
export function settingsTab(app: AppId, intent?: unknown): string | undefined {
  if (app !== "settings") return LEGACY_TAB[`${app}:${intent}`];
  const m = typeof intent === "string" ? intent : (intent as { module?: unknown } | undefined)?.module;
  return typeof m === "string" && !isModule(m) ? RENAMED[m]?.tab : undefined;
}
