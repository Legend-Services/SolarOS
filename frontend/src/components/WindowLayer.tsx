import { lazy, type ComponentType } from "react";
import { useWindows } from "../lib/stores";
import { useIsMobile } from "../lib/hooks";
import type { AppId } from "../apps/registry";
import ComputeManager from "../apps/ComputeManager";
import FileStation from "../apps/FileStation";
import AppCenter from "../apps/AppCenter";
import HelpCenterApp from "../apps/HelpCenterApp";
import SettingsApp from "../apps/SettingsApp";
import LocalAiApp from "../apps/LocalAiApp";
import WindowFrame from "./WindowFrame";
import type { ConsoleTarget } from "../lib/types";
// noVNC + xterm.js are only downloaded when a console is opened.
const ConsoleApp = lazy(() => import("../apps/ConsoleApp"));
const HostShell = lazy(() => import("../apps/ConsoleApp").then((m) => ({ default: m.HostShell })));

// Retired admin apps never get a window of their own (useWindows.open redirects them to Settings); they map to it for the type.
const COMPONENTS: Record<AppId, ComponentType<{ params?: ConsoleTarget }>> = {
  settings: SettingsApp,
  monitor: SettingsApp,
  compute: ComputeManager,
  storage: SettingsApp,
  files: FileStation,
  appcenter: AppCenter,
  "local-ai": () => <LocalAiApp />,
  backup: SettingsApp,
  shares: SettingsApp,
  controlpanel: SettingsApp,
  system: SettingsApp,
  netservices: SettingsApp,
  datacenter: SettingsApp,
  terminal: HostShell,
  help: HelpCenterApp,
  console: ConsoleApp,
};

export default function WindowLayer() {
  const windows = useWindows((s) => s.windows);
  const mobile = useIsMobile();
  return (
    <>
      {windows.map((w) => (
        <WindowFrame key={w.key} win={w} mobile={mobile} Body={COMPONENTS[w.id]} />
      ))}
    </>
  );
}
