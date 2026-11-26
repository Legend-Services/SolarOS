import {
  Activity, ArchiveRestore, BatteryCharging, BrainCircuit, Boxes, Cable, Container, Cpu, Database, FolderSync, HardDrive, Image, KeyRound, Layers, MonitorCog,
  MonitorSmartphone, Network, Package, Plug, Route, Server, Share2, ShieldAlert, Ship, Users, Waypoints, Workflow, type LucideIcon,
} from "lucide-react";
import type { AppId } from "../apps/registry";
import type { ModuleId } from "../apps/settings/modules";

/*
 * Features & Services: the frontend half of backend/app/features.py (same keys). Pure data and helpers, so the
 * knowledge registry (and the docs generator that imports it) can filter without a store.
 */

export const FEATURE_DOMAINS = ["network", "compute", "storage", "system", "apps"] as const;
export type FeatureDomain = (typeof FEATURE_DOMAINS)[number];

/** `parent`: a feature the child lives inside (hidden with it), or a heading that groups siblings. */
export const FEATURES = {
  virtual_switch: { domain: "network", icon: Network },
  vlan_dhcp: { domain: "network", icon: Cable, parent: "virtual_switch" },
  wireguard_server: { domain: "network", icon: Waypoints, parent: "wireguard" },
  wireguard_client: { domain: "network", icon: Plug, parent: "wireguard" },
  reverse_proxy: { domain: "network", icon: Route },
  vlan_firewall: { domain: "network", icon: ShieldAlert },
  network_architect: { domain: "network", icon: Share2 },
  compute_vms: { domain: "compute", icon: Server },
  compute_containers: { domain: "compute", icon: Container },
  docker_engine: { domain: "compute", icon: Ship },
  virtual_hardware: { domain: "compute", icon: MonitorCog },
  multiseat: { domain: "compute", icon: MonitorSmartphone },
  clustering: { domain: "compute", icon: Boxes },
  image_hub: { domain: "compute", icon: Image },
  zfs_storage: { domain: "storage", icon: HardDrive },
  smb_shares: { domain: "storage", icon: FolderSync },
  nfs_webdav: { domain: "storage", icon: Database },
  backups_snapshots: { domain: "storage", icon: ArchiveRestore },
  offsite_dr: { domain: "storage", icon: Layers },
  live_telemetry: { domain: "system", icon: Activity },
  gpu_management: { domain: "system", icon: Cpu },
  bios_manager: { domain: "system", icon: MonitorCog },
  ups_power: { domain: "system", icon: BatteryCharging },
  oob_bmc: { domain: "system", icon: Server },
  automation: { domain: "system", icon: Workflow },
  rbac_users: { domain: "system", icon: Users },
  api_keys: { domain: "system", icon: KeyRound },
  app_center: { domain: "apps", icon: Package },
  local_ai: { domain: "apps", icon: BrainCircuit },
} satisfies Record<string, { domain: FeatureDomain; icon: LucideIcon; parent?: string }>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];
export type Enabled = Partial<Record<FeatureKey, boolean>>;
export const isFeature = (v: unknown): v is FeatureKey => typeof v === "string" && v in FEATURES;
export const parentOf = (k: FeatureKey): string | undefined => (FEATURES[k] as { parent?: string }).parent;

/** On unless switched off, and inside an enabled parent feature. Unknown flags count as on (older backend). */
export function on(e: Enabled, k: FeatureKey): boolean {
  const p = parentOf(k);
  return e[k] !== false && (!isFeature(p) || on(e, p));
}

/** A Settings module shows while any of its features is on; modules not listed here (the core screens) always show. */
export const MODULE_FEATURES: Partial<Record<ModuleId, FeatureKey[]>> = {
  "hardware-gpu": ["gpu_management", "multiseat"],
  "bios-firmware": ["bios_manager"],
  "resource-monitor": ["live_telemetry"],
  "automation-alerts": ["automation"],
  "power-ups": ["ups_power"],
  "storage-zfs": ["zfs_storage"],
  "backup-restore": ["backups_snapshots", "offsite_dr"],
  "network-topology": ["network_architect"],
  "reverse-proxy": ["reverse_proxy"],
  "firewall-ids": ["vlan_firewall"],
  "wireguard-vpn": ["wireguard_server", "wireguard_client"],
  "installed-apps": ["app_center"],
  "local-ai-runtime": ["local_ai"],
  "cluster-ha": ["clustering", "oob_bmc"],
};

/** Inner tabs (`<module>:<tab>`, the tab ids deep links and knowledgeRegistry controls use) owned by one feature. */
export const TAB_FEATURE: Record<string, FeatureKey> = {
  "hardware-gpu:gpu": "gpu_management",
  "hardware-gpu:multiseat": "multiseat",
  "backup-restore:backups": "backups_snapshots",
  "backup-restore:dr": "offsite_dr",
  "shared-folders:smb": "smb_shares",
  "shared-folders:protocols": "nfs_webdav",
  "shared-folders:snapfiles": "nfs_webdav",
  "iso-templates:images": "image_hub",
  "users-roles:accounts": "rbac_users",
  "users-roles:tokens": "api_keys",
  "cluster-ha:cluster": "clustering",
  "cluster-ha:oob": "oob_bmc",
  "network-switch:vswitch": "virtual_switch",
  "network-switch:labs": "virtual_hardware",
  "wireguard-vpn:wg": "wireguard_server",
  "wireguard-vpn:wgc": "wireguard_client",
};

/** Apps shown while any of their features is on. */
export const APP_FEATURES: Partial<Record<AppId, FeatureKey[]>> = {
  appcenter: ["app_center"],
  architect: ["network_architect"],
  "local-ai": ["local_ai"],
  compute: ["compute_vms", "compute_containers", "docker_engine"],
};

const any = (e: Enabled, ks?: FeatureKey[]) => !ks || ks.some((k) => on(e, k));
export const moduleOn = (e: Enabled, m: ModuleId) => any(e, MODULE_FEATURES[m]);
export const tabOn = (e: Enabled, m: ModuleId, tab?: string) => moduleOn(e, m) && (!tab || !TAB_FEATURE[`${m}:${tab}`] || on(e, TAB_FEATURE[`${m}:${tab}`]));
export const appOn = (e: Enabled, id: AppId) => any(e, APP_FEATURES[id]);

/** Full map: every key true/false, `keep` on. */
export const only = (keep: readonly FeatureKey[]): Record<FeatureKey, boolean> => Object.fromEntries(FEATURE_KEYS.map((k) => [k, keep.includes(k)])) as Record<FeatureKey, boolean>;

export const PRESETS = {
  minimal: ["compute_vms", "compute_containers", "zfs_storage", "backups_snapshots", "live_telemetry"],
  home: ["compute_containers", "zfs_storage", "smb_shares", "nfs_webdav", "backups_snapshots", "live_telemetry", "app_center", "wireguard_server", "reverse_proxy", "ups_power", "automation", "image_hub", "docker_engine"],
  lab: FEATURE_KEYS.filter((k) => k !== "multiseat" && k !== "oob_bmc"),
  all: FEATURE_KEYS,
} satisfies Record<string, readonly FeatureKey[]>;
export type PresetId = keyof typeof PRESETS;

/* ---------------- Server Setup Wizard roles ---------------- */

export type RoleId = "storage" | "virtualization" | "multiseat" | "cluster" | "gateway" | "ai" | "other";
export const ROLES: { id: RoleId; features: FeatureKey[]; apps: string[] }[] = [
  { id: "storage", features: ["zfs_storage", "smb_shares", "nfs_webdav", "backups_snapshots", "offsite_dr", "compute_containers", "app_center", "live_telemetry"], apps: ["jellyfin"] },
  { id: "virtualization", features: ["compute_vms", "compute_containers", "image_hub", "virtual_switch", "vlan_dhcp", "backups_snapshots", "zfs_storage", "live_telemetry", "virtual_hardware", "network_architect", "docker_engine"], apps: [] },
  { id: "multiseat", features: ["compute_vms", "multiseat", "gpu_management", "virtual_hardware", "live_telemetry"], apps: [] },
  { id: "cluster", features: ["clustering", "compute_vms", "compute_containers", "backups_snapshots", "zfs_storage", "oob_bmc", "live_telemetry"], apps: [] },
  { id: "gateway", features: ["virtual_switch", "vlan_dhcp", "wireguard_server", "wireguard_client", "reverse_proxy", "vlan_firewall", "network_architect"], apps: ["adguard-home"] },
  { id: "ai", features: ["local_ai", "gpu_management", "compute_containers", "app_center", "live_telemetry"], apps: ["local-ai"] },
  { id: "other", features: [], apps: [] },
];
/** Apps the wizard offers (App Center catalog ids). */
export const WIZARD_APPS = ["local-ai", "jellyfin", "immich", "adguard-home", "portainer"];
/** Features every role keeps (live status of the host). */
export const BASE_FEATURES: FeatureKey[] = ["live_telemetry", "automation"];

export function roleFeatures(roles: RoleId[]): FeatureKey[] {
  const set = new Set<FeatureKey>(BASE_FEATURES);
  for (const r of ROLES) if (roles.includes(r.id)) r.features.forEach((f) => set.add(f));
  return FEATURE_KEYS.filter((k) => set.has(k));
}
export const roleApps = (roles: RoleId[]) => WIZARD_APPS.filter((a) => ROLES.some((r) => roles.includes(r.id) && r.apps.includes(a)));
