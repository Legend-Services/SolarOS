import { Activity, LifeBuoy, ArchiveRestore, Boxes, Waypoints, BrainCircuit, Building2, FolderOpen, Globe, HardDrive, Settings, Share2, SlidersHorizontal, Store, SquareTerminal, Terminal, type LucideIcon } from "lucide-react";

// Metadata only (no components) so stores can import it without a circular dependency.
// `icon` is the small title-bar glyph; launchers and the dock use the bespoke icons in components/icons/AppIcons.
// `desc` is the plain-English one-liner shown in List View.
export const APPS = {
  settings: { title: "Settings", desc: "Every system, storage, security, network and hypervisor setting in one place", icon: Settings, size: { w: 1180, h: 740 } },
  monitor: { title: "Resource Monitor", desc: "Live CPU, memory, network, GPU and drive temperatures", icon: Activity, size: { w: 900, h: 620 } },
  compute: { title: "Compute Manager", desc: "Create and run virtual machines and containers", icon: Boxes, size: { w: 1000, h: 620 } },
  storage: { title: "Storage & ZFS", desc: "Disks, ZFS pools, datasets, snapshots and disk health", icon: HardDrive, size: { w: 1040, h: 680 } },
  files: { title: "File Station", desc: "Browse, upload and organize files on your storage", icon: FolderOpen, size: { w: 960, h: 620 } },
  appcenter: { title: "App Center", desc: "One-click installs: Jellyfin, Immich, AdGuard Home and more", icon: Store, size: { w: 1040, h: 660 } },
  "local-ai": { title: "Solar AI Studio", desc: "Download and run AI models on your GPU, with a test chat", icon: BrainCircuit, size: { w: 1080, h: 700 } },
  architect: { title: "Network Architect", desc: "Live blueprint of hosts, switches, VLANs, labs and every device on your networks", icon: Waypoints, size: { w: 1240, h: 760 } },
  backup: { title: "Backup Center", desc: "Back up, schedule and restore VMs and containers", icon: ArchiveRestore, size: { w: 980, h: 640 } },
  shares: { title: "Network Shares", desc: "Share folders with every computer and phone on your network", icon: Share2, size: { w: 940, h: 640 } },
  netservices: { title: "Network & Services", desc: "DNS, ad blocking, DHCP, WireGuard VPN and certificates", icon: Globe, size: { w: 1060, h: 680 } },
  datacenter: { title: "Datacenter", desc: "Users, roles, permissions, firewall and logs", icon: Building2, size: { w: 1080, h: 680 } },
  terminal: { title: "Terminal", desc: "Instant root command line on the host and its containers", icon: Terminal, size: { w: 900, h: 560 } },
  help: { title: "Help & Support", desc: "Tutorials, FAQ and one-click fixes", icon: LifeBuoy, size: { w: 1000, h: 680 } },
  controlpanel: { title: "Control Panel", desc: "Security, network, appearance, layout and drivers", icon: SlidersHorizontal, size: { w: 940, h: 640 } },
  system: { title: "System", desc: "Package sources, updates and host details", icon: Settings, size: { w: 960, h: 640 } },
  // Opened per guest from Compute Manager, so it is not in the dock or launcher.
  console: { title: "Console", desc: "Screen or shell of a single guest", icon: SquareTerminal, size: { w: 900, h: 620 } },
} satisfies Record<string, { title: string; desc: string; icon: LucideIcon; size: { w: number; h: number } }>;

export type AppId = keyof typeof APPS;
/** Admin apps folded into Settings: they no longer open their own window (useWindows.open redirects them). */
export const RETIRED: AppId[] = ["monitor", "storage", "backup", "shares", "netservices", "datacenter", "controlpanel", "system"];
/** Launchable apps: App Gallery, Spotlight, desktop icons. */
export const APP_IDS = (Object.keys(APPS) as AppId[]).filter((id) => id !== "console" && !RETIRED.includes(id));
/** Default Dock / taskbar. */
export const DOCK_DEFAULT: AppId[] = ["settings", "compute", "files", "appcenter", "terminal"];

/** Saved dock / gallery lists (one-time migration): every retired admin app becomes Settings in its place, unknown ids drop out, each id once. */
export const liveAppIds = (v: unknown): AppId[] =>
  Array.isArray(v)
    ? [...new Set(v.map((id) => (RETIRED.includes(id) || id === "control-panel" ? "settings" : id)))].filter((id): id is AppId => (APP_IDS as unknown[]).includes(id))
    : [];
