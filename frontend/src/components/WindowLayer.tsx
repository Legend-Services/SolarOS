import { lazy, type ComponentType } from "react";
import { useWindows } from "../lib/stores";
import { useIsMobile } from "../lib/hooks";
import type { AppId } from "../apps/registry";
import ResourceMonitor from "../apps/ResourceMonitor";
import ComputeManager from "../apps/ComputeManager";
import StorageManager from "../apps/StorageManager";
import FileStation from "../apps/FileStation";
import AppCenter from "../apps/AppCenter";
import SharesManager from "../apps/SharesManager";
import ControlPanelApp from "../apps/ControlPanelApp";
import SystemApp from "../apps/SystemApp";
import WindowFrame from "./WindowFrame";
import type { ConsoleTarget } from "../lib/types";
// noVNC + xterm.js are only downloaded when a console is opened.
const ConsoleApp = lazy(() => import("../apps/ConsoleApp"));

const COMPONENTS: Record<AppId, ComponentType<{ params?: ConsoleTarget }>> = {
  monitor: ResourceMonitor,
  compute: ComputeManager,
  storage: StorageManager,
  files: FileStation,
  appcenter: AppCenter,
  shares: SharesManager,
  controlpanel: ControlPanelApp,
  system: SystemApp,
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
