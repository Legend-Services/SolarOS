/**
 * Shared headless-browser harness for scripts/generate-support-docs.mjs and scripts/audit-scaling-and-themes.mjs:
 * starts the Vite dev server, opens it in Chromium with every /api call answered from fixtures.mjs, and drives the UI
 * through its own stores.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixtures.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const FRONTEND = join(ROOT, "frontend");
const PORT = Number(process.env.DOCS_PORT || 5178);
const BASE = `http://127.0.0.1:${PORT}`;

const { chromium } = createRequire(join(FRONTEND, "package.json"))("playwright");

export async function startVite() {
  // The SolarOS edition: neutral SolarDeck branding in every picture.
  const proc = spawn(join(FRONTEND, "node_modules/.bin/vite"), ["--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: FRONTEND,
    env: { ...process.env, VITE_EDITION: process.env.VITE_EDITION || "solaros" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error("vite exited early");
    try {
      if ((await fetch(BASE)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error("vite did not start");
}

export async function launch() {
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? chromium.launch() : chromium.launch({ channel: "chrome" });
}

export const missing = new Set();

export async function openPage(browser, { colorScheme = "dark", deviceScaleFactor = 2, viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, colorScheme, locale: "en-US" });
  await context.addInitScript(() => {
    // English interface (the Welcome Tour is closed after load).
    localStorage.setItem("solardeck-language", JSON.stringify({ state: { language: "en" }, version: 0 }));
  });
  await context.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api(\/api)?/, "") || "/";
    const method = route.request().method();
    const body = fixture(method, path, url.searchParams);
    if (body === undefined) {
      missing.add(`${method} ${path}`);
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Not available in documentation mode" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  // Terminal: a short demo session instead of a real host shell.
  await context.routeWebSocket(/\/api\//, (ws) => {
    ws.send(
      "\x1b[1;32mroot@solardeck\x1b[0m:\x1b[1;34m~\x1b[0m# zpool list\r\n" +
        "NAME   SIZE  ALLOC   FREE  HEALTH\r\ntank  21.7T   8.3T  13.4T  ONLINE\r\nfast   928G   289G   639G  ONLINE\r\n" +
        "\x1b[1;32mroot@solardeck\x1b[0m:\x1b[1;34m~\x1b[0m# uptime\r\n 21:19:04 up 20 days,  load average: 1.42, 1.31, 1.18\r\n" +
        "\x1b[1;32mroot@solardeck\x1b[0m:\x1b[1;34m~\x1b[0m# ",
    );
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("header", { timeout: 20000 });
  // The guided Welcome Tour opens on first sign-in; close any wizard.
  await page.evaluate(async () => {
    const w = await import("/src/store/wizardStore.ts");
    w.useWizard.setState({ guide: null, welcomeAuto: false });
    // Host shells ask for step-up confirmation; documentation mode is already "confirmed".
    (await import("/src/lib/api.ts")).rememberStepUp("docs", 3600);
  });
  return { page, errors };
}

/** Reset the desktop: no windows, no overlays, search closed. */
export async function reset(page) {
  await page.evaluate(async () => {
    const s = await import("/src/lib/stores.ts");
    s.useWindows.setState({ windows: [] });
    s.useDock.setState({ gallery: false });
    s.useSpotlight.setState({ open: false });
    (await import("/src/store/widgetStore.ts")).useWidgets.getState().setEditing(false);
    (await import("/src/store/onboardingStore.ts")).useOnboarding.setState({ wizard: false, tour: false });
  });
  await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height / 2);
}

export const settle = (page, ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));

/** Open a registry target the way the app does, maximize its window, and wait for it to render. */
export async function show(page, target) {
  await reset(page);
  await page.evaluate(async (t) => {
    const s = await import("/src/lib/stores.ts");
    s.navigate(t);
  }, target);
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    const s = await import("/src/lib/stores.ts");
    const w = s.useWindows.getState().windows.at(-1);
    if (w && !w.maximized) s.useWindows.getState().toggleMaximize(w.key);
  });
  await settle(page);
}
