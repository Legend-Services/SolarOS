// Self-check for Settings deep links and the dock / gallery migration. Run: node --experimental-strip-types scripts/settings-routing.check.mjs
import { APP_IDS, DOCK_DEFAULT, RETIRED, liveAppIds } from "../src/apps/registry.ts";
import { MODULE_IDS, settingsModule } from "../src/apps/settings/modules.ts";

const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)}`);

ok(MODULE_IDS.length === 22, "22 sub-modules");
ok(!RETIRED.some((id) => APP_IDS.includes(id)) && APP_IDS.includes("settings"), "retired apps leave the launcher, Settings joins it");
ok(DOCK_DEFAULT.every((id) => APP_IDS.includes(id)), "default dock only holds launchable apps");

// Every retired id opens a Settings module; apps that stay apps are not redirected.
ok(RETIRED.every((id) => settingsModule(id)), "every retired app maps to a module");
eq(settingsModule("monitor"), "resource-monitor", "monitor");
eq(settingsModule("storage", "pools"), "storage-zfs", "storage intent keeps the module");
eq(settingsModule("controlpanel", "power"), "host-power", "control panel power");
eq(settingsModule("controlpanel", "security"), "security-2fa", "control panel security");
eq(settingsModule("netservices", "wg"), "wireguard-vpn", "wireguard");
eq(settingsModule("help", "bios"), "bios-firmware", "bios");
eq(settingsModule("settings", "audit-logs"), "audit-logs", "settings intent");
eq([settingsModule("settings"), settingsModule("settings", "nope"), settingsModule("compute", "iso"), settingsModule("help", "fix"), settingsModule("files")],
  [undefined, undefined, undefined, undefined, undefined], "no redirect");

// Saved lists: legacy admin ids collapse into one Settings entry in place, unknown ids drop out.
eq(liveAppIds(["controlpanel", "compute", "system", "storage", "files", "bogus", "files"]), ["settings", "compute", "files"], "dock migration");
eq(liveAppIds(["compute", "control-panel"]), ["compute", "settings"], "hyphenated legacy id");
eq(liveAppIds(["settings", "monitor"]), ["settings"], "already migrated");
eq(liveAppIds(null), [], "not a list");
console.log("settings routing self-check OK");
