import { Activity, Boxes, FolderOpen, HardDrive, Share2, Store, SquareTerminal, type LucideIcon } from "lucide-react";

// Metadata only (no components) so stores can import it without a circular dependency.
export const APPS = {
  monitor: { title: "Resource Monitor", icon: Activity, color: "from-sky-400 to-blue-600", size: { w: 900, h: 620 } },
  compute: { title: "Compute Manager", icon: Boxes, color: "from-violet-400 to-fuchsia-600", size: { w: 1000, h: 620 } },
  storage: { title: "Storage & ZFS", icon: HardDrive, color: "from-amber-300 to-orange-600", size: { w: 960, h: 620 } },
  files: { title: "File Station", icon: FolderOpen, color: "from-emerald-300 to-teal-600", size: { w: 960, h: 620 } },
  appcenter: { title: "App Center", icon: Store, color: "from-pink-400 to-rose-600", size: { w: 1040, h: 660 } },
  shares: { title: "Network Shares", icon: Share2, color: "from-cyan-300 to-sky-600", size: { w: 920, h: 600 } },
  // Opened per guest from Compute Manager, so it is not in the dock or launcher.
  console: { title: "Console", icon: SquareTerminal, color: "from-slate-400 to-slate-700", size: { w: 900, h: 620 } },
} satisfies Record<string, { title: string; icon: LucideIcon; color: string; size: { w: number; h: number } }>;

export type AppId = keyof typeof APPS;
export const APP_IDS = (Object.keys(APPS) as AppId[]).filter((id) => id !== "console");
