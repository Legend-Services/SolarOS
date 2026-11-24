import { useEffect } from "react";
import { useAuth, usePrefs, useTelemetry } from "./lib/stores";
import LockScreen from "./components/LockScreen";
import TopBar from "./components/TopBar";
import Desktop from "./components/Desktop";
import Dock from "./components/Dock";
import WindowLayer from "./components/WindowLayer";
import SpotlightSearch from "./components/SpotlightSearch";
import BugReportModal from "./components/BugReportModal";
import GuidedWizardModal from "./components/wizards/GuidedWizardModal";
import { startPreferencesSync } from "./store/layoutStore";
import { useWizard } from "./store/wizardStore";

// The automatic Welcome Tour shows at most once per page load (not again after a lock / unlock).
let tourShown = false;

export default function App() {
  const status = useAuth((s) => s.status);
  const init = useAuth((s) => s.init);
  const start = useTelemetry((s) => s.start);
  const wallpaper = usePrefs((s) => s.wallpaper);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => (status === "unlocked" ? start() : undefined), [status, start]);
  // Server preferences first, so a "don't show again" saved on another browser is respected.
  useEffect(
    () =>
      status === "unlocked"
        ? startPreferencesSync(() => {
            const w = useWizard.getState();
            if (w.welcomeAuto && !w.guide && !tourShown) (tourShown = true, w.show("welcome"));
          })
        : undefined,
    [status],
  );

  return (
    <div className={`wallpaper wp-${wallpaper} relative h-full w-full overflow-hidden`}>
      <div
        className={`absolute inset-0 transition-all duration-700 ${
          status === "unlocked" ? "scale-100 opacity-100" : "pointer-events-none scale-105 opacity-0 blur-sm"
        }`}
        aria-hidden={status !== "unlocked"}
      >
        {status === "unlocked" && (
          <>
            <Desktop />
            <WindowLayer />
            <TopBar />
            <Dock />
            <SpotlightSearch />
            <BugReportModal />
            <GuidedWizardModal />
          </>
        )}
      </div>
      <LockScreen visible={status !== "unlocked"} checking={status === "checking"} />
    </div>
  );
}
