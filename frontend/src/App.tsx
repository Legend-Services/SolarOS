import { useEffect } from "react";
import { useAuth, useTelemetry } from "./lib/stores";
import LockScreen from "./components/LockScreen";
import TopBar from "./components/TopBar";
import Desktop from "./components/Desktop";
import Dock from "./components/Dock";
import AppGallery from "./components/AppGallery";
import WindowLayer from "./components/WindowLayer";
import SpotlightSearch from "./components/SpotlightSearch";
import BugReportModal from "./components/BugReportModal";
import GuidedWizardModal from "./components/wizards/GuidedWizardModal";
import StepUpAuthModal from "./components/security/StepUpAuthModal";
import Taskbar from "./components/Taskbar";
import { startPreferencesSync, useShell } from "./store/layoutStore";
import { useWizard } from "./store/wizardStore";
import { useTheme } from "./store/themeStore";
import { useBranding } from "./store/capabilitiesStore";
import { DesktopWallpaperLayer } from "./components/ThemeQuickSwitcher";
import ServerSetupWizard from "./components/onboarding/ServerSetupWizard";
import DesktopGuidedTour from "./components/onboarding/DesktopGuidedTour";
import { useFeatures } from "./store/featureStore";
import { useOnboarding } from "./store/onboardingStore";

// The automatic Welcome Tour shows at most once per page load (not again after a lock / unlock).
let tourShown = false;

export default function App() {
  const status = useAuth((s) => s.status);
  const init = useAuth((s) => s.init);
  const start = useTelemetry((s) => s.start);
  const shell = useShell();

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => (status === "unlocked" ? start() : undefined), [status, start]);
  useEffect(() => {
    if (status !== "unlocked") return;
    useTheme.getState().loadCustom().catch(() => {}); // custom themes; built-ins work offline
    void useBranding.getState().load(); // server name for the wallpaper brand badge
  }, [status]);
  // Server preferences first, so a "don't show again" saved on another browser is respected. The Welcome Tour
  // waits for the onboarding state: it never stacks on the Server Setup Wizard or the Desktop Tour.
  useEffect(() => {
    if (status !== "unlocked") return;
    void useFeatures.getState().load();
    const onboarding = useOnboarding.getState().load();
    return startPreferencesSync(() => {
      void onboarding.then(() => {
        const o = useOnboarding.getState();
        const w = useWizard.getState();
        if (!o.wizard && !o.tour && w.welcomeAuto && !w.guide && !tourShown) (tourShown = true, w.show("welcome"));
      });
    });
  }, [status]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <DesktopWallpaperLayer />
      <div
        className={`absolute inset-0 transition-[transform,scale,opacity,filter] duration-700 ${
          status === "unlocked" ? "scale-100 opacity-100" : "pointer-events-none scale-105 opacity-0 blur-sm"
        }`}
        aria-hidden={status !== "unlocked"}
      >
        {status === "unlocked" && (
          <>
            <Desktop />
            <WindowLayer />
            {shell === "taskbar" ? (
              <Taskbar />
            ) : (
              <>
                <TopBar />
                <Dock />
              </>
            )}
            <AppGallery />
            <SpotlightSearch />
            <BugReportModal />
            <GuidedWizardModal />
            <StepUpAuthModal />
            <DesktopGuidedTour />
            <ServerSetupWizard />
          </>
        )}
      </div>
      <LockScreen visible={status !== "unlocked"} checking={status === "checking"} />
    </div>
  );
}
