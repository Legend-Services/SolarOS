import { Activity, Boxes, FolderOpen, HardDrive, Settings, Share2, SlidersHorizontal, Store, SquareTerminal, type LucideIcon } from "lucide-react";

// Metadata only (no components) so stores can import it without a circular dependency.
// `icon` is the small title-bar glyph; launchers and the dock use the bespoke icons in components/icons/AppIcons.
export const APPS = {
  monitor: { title: "Resource Monitor", icon: Activity, size: { w: 900, h: 620 } },
  compute: { title: "Compute Manager", icon: Boxes, size: { w: 1000, h: 620 } },
  storage: { title: "Storage & ZFS", icon: HardDrive, size: { w: 1040, h: 680 } },
  files: { title: "File Station", icon: FolderOpen, size: { w: 960, h: 620 } },
  appcenter: { title: "App Center", icon: Store, size: { w: 1040, h: 660 } },
  shares: { title: "Network Shares", icon: Share2, size: { w: 940, h: 640 } },
  controlpanel: { title: "Control Panel", icon: SlidersHorizontal, size: { w: 940, h: 640 } },
  system: { title: "System", icon: Settings, size: { w: 960, h: 640 } },
  // Opened per guest from Compute Manager, so it is not in the dock or launcher.
  console: { title: "Console", icon: SquareTerminal, size: { w: 900, h: 620 } },
} satisfies Record<string, { title: string; icon: LucideIcon; size: { w: number; h: number } }>;

export type AppId = keyof typeof APPS;
export const APP_IDS = (Object.keys(APPS) as AppId[]).filter((id) => id !== "console");
