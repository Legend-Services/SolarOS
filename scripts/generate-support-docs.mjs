#!/usr/bin/env node
/**
 * Builds the illustrated manual from frontend/src/data/knowledgeRegistry.ts:
 *   - PNG screenshots of the desktop, App Gallery, Global Search, every app, the Settings hub, every Settings category,
 *     sub-module and major sub-sub-module → frontend/public/docs/screenshots/ (served to Help & Support) and docs/screenshots/
 *   - Markdown pages → docs/README.md, docs/apps.md, docs/settings-<category>.md
 *
 * It starts the Vite dev server, opens it in headless Chromium (1440×900, dark mode, 2× scale), answers every /api call
 * from scripts/support-docs/fixtures.mjs and drives the UI through its own navigation store, so each picture shows the
 * same screen a search result or "Open This Setting / App" button opens.
 *
 *   node scripts/generate-support-docs.mjs [--docs-only] [--only <slug-substring>]
 * Needs `npm ci` in frontend/ (Playwright is a dev dependency). Uses the Playwright Chromium when downloaded
 * (`npx playwright install chromium`), else the installed Google Chrome.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { fixture } from "./support-docs/fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const PUBLIC_SHOTS = join(FRONTEND, "public/docs/screenshots");
const DOC_SHOTS = join(ROOT, "docs/screenshots");
const PORT = Number(process.env.DOCS_PORT || 5178);
const BASE = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const docsOnly = args.includes("--docs-only");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";

const { chromium } = createRequire(join(FRONTEND, "package.json"))("playwright");

/* ---------------- Dev server ---------------- */

async function startVite() {
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

/* ---------------- Browser ---------------- */

async function launch() {
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? chromium.launch() : chromium.launch({ channel: "chrome" });
}

const missing = new Set();

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", locale: "en-US" });
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
async function reset(page) {
  await page.evaluate(async () => {
    const s = await import("/src/lib/stores.ts");
    s.useWindows.setState({ windows: [] });
    s.useDock.setState({ gallery: false });
    s.useSpotlight.setState({ open: false });
  });
  await page.mouse.move(720, 450);
}

const settle = (page, ms = 900) => page.waitForLoadState("networkidle").then(() => page.waitForTimeout(ms));

/** Open a registry target the way the app does, maximize its window, and wait for it to render. */
async function show(page, target) {
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

/* ---------------- Registry ---------------- */

async function loadRegistry(page) {
  return page.evaluate(async () => {
    const k = await import("/src/data/knowledgeRegistry.ts");
    const r = await import("/src/apps/registry.ts");
    const m = await import("/src/apps/settings/modules.ts");
    const { en } = await import("/src/i18n/en.ts");
    const tr = (key) => en[key];
    // Self-check: tier order is fixed and the deepest hits land in their own tiers.
    const groups = k.searchKnowledge("dhcp", tr).map((g) => g.tier);
    const order = groups.map((g) => k.TIERS.indexOf(g));
    const checks = {
      sorted: order.every((v, i) => i === 0 || v > order[i - 1]),
      dhcpTiers: groups,
      vlanControl: k.searchKnowledge("per-vlan dhcp", tr).find((g) => g.tier === "controls")?.hits[0]?.key ?? null,
      appFirst: k.searchKnowledge("terminal", tr)[0]?.tier,
    };
    return {
      checks,
      apps: r.APP_IDS,
      categories: [...m.CATEGORIES],
      modules: m.MODULE_IDS,
      moduleCat: Object.fromEntries(m.MODULE_IDS.map((id) => [id, m.MODULES[id].cat])),
      catTitle: Object.fromEntries(m.CATEGORIES.map((c) => [c, en[`set.cat.${c}`]])),
      catDesc: Object.fromEntries(m.CATEGORIES.map((c) => [c, en[`set.catDesc.${c}`]])),
      controls: k.CONTROLS.map((c) => ({ ...c, slug: k.slug.control(c) })),
      articles: k.buildArticles(tr),
    };
  });
}

/* ---------------- Screenshots ---------------- */

async function capture(page, reg) {
  mkdirSync(PUBLIC_SHOTS, { recursive: true });
  const shots = [];
  const snap = async (slug, prepare) => {
    if (only && !slug.includes(only)) return;
    await prepare();
    const file = join(PUBLIC_SHOTS, `${slug}.png`);
    await page.screenshot({ path: file });
    shots.push(slug);
    process.stdout.write(`  ${slug}.png\n`);
  };

  await snap("desktop", async () => (await reset(page), settle(page, 600)));
  await snap("app-gallery", async () => {
    await reset(page);
    await page.evaluate(async () => (await import("/src/lib/stores.ts")).useDock.setState({ gallery: true }));
    await settle(page, 700);
  });
  await snap("global-search", async () => {
    await reset(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("dhcp", { delay: 40 });
    await settle(page, 600);
  });
  await snap("settings-hub", () => show(page, { kind: "app", appId: "settings" }));
  for (const id of reg.apps) await snap(`app-${id}`, () => show(page, { kind: "app", appId: id }));
  // Screens a few clicks deep: the guest drawer's wireframe (NIC inspector open) and a network drill-down with its device explorer.
  await snap("compute-wireframe", async () => {
    await show(page, { kind: "app", appId: "compute" });
    await page.getByRole("button", { name: "media-server", exact: true }).first().click();
    await page.getByRole("tab", { name: "Wireframe Architecture" }).click();
    await settle(page, 600);
    await page.getByRole("button", { name: /^net0 · / }).first().click();
    await settle(page, 500);
  });
  await snap("architect-network", async () => {
    await show(page, { kind: "app", appId: "architect" });
    await page.getByRole("button", { name: "Open the network view of br0" }).click();
    await settle(page, 600);
    await page.getByRole("button", { name: /^Other Devices/ }).click();
    await settle(page, 500);
  });
  for (const c of reg.categories) await snap(`settings-${c}`, () => show(page, { kind: "settings", category: c }).then(() => page.waitForTimeout(400)));
  for (const m of reg.modules) await snap(`settings-${m}`, () => show(page, { kind: "settings", module: m }));
  for (const c of reg.controls.filter((x) => x.shot))
    await snap(c.slug, () => show(page, { kind: "settings", module: c.moduleId, tab: c.tabId, anchor: c.anchorId }).then(() => page.waitForTimeout(300)));
  await snap("help-manual", () => show(page, { kind: "help", article: "settings-network-switch", section: "per-vlan-dhcp", term: "dhcp" }));
  return shots;
}

/* ---------------- Markdown ---------------- */

const exists = (slug) => existsSync(join(PUBLIC_SHOTS, `${slug}.png`));
const img = (path, alt) => {
  const slug = path?.split("/").pop()?.replace(/\.png$/, "");
  return slug && exists(slug) ? `\n![${alt}](screenshots/${slug}.png)\n` : "";
};

function sectionMd(s, level, skipShot) {
  let out = `${"#".repeat(level)} ${s.subTitle}\n\n${s.bodyText}\n`;
  if (s.steps.length) out += `\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n`;
  for (const tip of s.tips) out += `\n> **Tip:** ${tip}\n`;
  if (s.screenshotPath && s.screenshotPath !== skipShot) out += img(s.screenshotPath, s.subTitle);
  return `${out}\n`;
}

function articleMd(a, level) {
  let out = `${"#".repeat(level)} ${a.mainTitle}\n${img(a.screenshotPath, a.mainTitle)}\n`;
  for (const s of a.sections) out += sectionMd(s.sectionId === "overview" ? { ...s, subTitle: "Overview" } : s, level + 1, a.screenshotPath);
  return out;
}

const PAGES = { system: "settings-system.md", storage: "settings-storage.md", security: "settings-security.md", network: "settings-network.md", hypervisor: "settings-hypervisor.md" };
const HEADER = "<!-- Generated by scripts/generate-support-docs.mjs from frontend/src/data/knowledgeRegistry.ts. Do not edit by hand. -->\n\n";
const anchor = (title) => title.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");

function writeDocs(reg) {
  const byId = Object.fromEntries(reg.articles.map((a) => [a.articleId, a]));
  const docs = join(ROOT, "docs");

  let apps = `${HEADER}# Apps\n\nEvery app on the SolarDeck desktop. Open them from the Dock, the App Gallery or the TopBar search (⌘K / Ctrl+K).\n\n[← Manual](README.md)\n\n`;
  for (const id of reg.apps) apps += articleMd(byId[`app-${id}`], 2);
  writeFileSync(join(docs, "apps.md"), apps);

  for (const c of reg.categories) {
    const cat = byId[`settings-${c}`];
    let md = `${HEADER}# Settings › ${cat.mainTitle}\n\n${reg.catDesc[c]}\n\n[← Manual](README.md)\n${img(cat.screenshotPath, cat.mainTitle)}\n`;
    const mods = reg.modules.filter((m) => reg.moduleCat[m] === c);
    md += `**Sub-modules:** ${mods.map((m) => `[${byId[`settings-${m}`].mainTitle}](#${anchor(byId[`settings-${m}`].mainTitle)})`).join(" · ")}\n\n`;
    for (const m of mods) md += articleMd(byId[`settings-${m}`], 2);
    writeFileSync(join(docs, PAGES[c]), md);
  }

  const shot = (slug, alt) => (exists(slug) ? `![${alt}](screenshots/${slug}.png)\n\n` : "");
  let index = `${HEADER}# SolarDeck Manual\n\nThe illustrated guide to every app and setting. The same articles are built into the desktop: open **Help & Support › Manual**, or search for anything from the TopBar.\n\n`;
  index += `${shot("desktop", "SolarDeck desktop")}`;
  index += `## Global Search\n\nThe search bar in the center of the TopBar finds apps, settings and help in one place. Click it or press **⌘K / Ctrl+K** (or **/** when you are not typing in a field). Use ↑ ↓ to move, Enter to open and Esc to close. Results always come in this order:\n\n`;
  index += ["Apps", "Settings — Main Categories", "Settings — Sub-Modules", "Settings — Sub-Sub-Modules & Controls", "Support — Main Titles", "Support — Subtitles", "Support — Help Content"].map((g, i) => `${i + 1}. **${g}**`).join("\n");
  index += `\n\nOpening a setting jumps straight to its tab and briefly highlights the card; opening a help result shows the article with the matched words highlighted. Live virtual machines, containers, pools and shares are listed after the seven groups.\n\n${shot("global-search", "Global Search results")}`;
  index += `## Contents\n\n- [Apps](apps.md): ${reg.apps.map((id) => byId[`app-${id}`].mainTitle).join(", ")}\n`;
  for (const c of reg.categories) index += `- [Settings › ${reg.catTitle[c]}](${PAGES[c]}): ${reg.modules.filter((m) => reg.moduleCat[m] === c).map((m) => byId[`settings-${m}`].mainTitle).join(", ")}\n`;
  index += `\n## The App Gallery\n\n${shot("app-gallery", "App Gallery")}## Settings\n\n${shot("settings-hub", "Settings hub")}## Help & Support\n\n${shot("help-manual", "Help & Support manual")}`;
  index += `For installation, architecture and development notes see [TECHNICAL.md](TECHNICAL.md).\n`;
  writeFileSync(join(docs, "README.md"), index);
}

/* ---------------- Main ---------------- */

const vite = await startVite();
let failed = false;
try {
  const browser = await launch();
  const { page, errors } = await openPage(browser);
  const reg = await loadRegistry(page);
  assert.ok(reg.checks.sorted, `search tiers out of order: ${reg.checks.dhcpTiers}`);
  assert.equal(reg.checks.appFirst, "apps", "an app name must rank in the Apps tier first");
  assert.equal(reg.checks.vlanControl, "ctl:network-switch:per-vlan-dhcp");
  assert.equal(reg.articles.length, reg.apps.length + reg.categories.length + reg.modules.length + reg.controls.length, "one article per app, category, sub-module and control");
  console.log(`Registry: ${reg.apps.length} apps, ${reg.categories.length} categories, ${reg.modules.length} sub-modules, ${reg.controls.length} sub-sub-modules, ${reg.articles.length} articles`);

  if (!docsOnly) {
    console.log("Screenshots:");
    const shots = await capture(page, reg);
    mkdirSync(DOC_SHOTS, { recursive: true });
    for (const slug of shots) {
      const src = join(PUBLIC_SHOTS, `${slug}.png`);
      assert.ok(statSync(src).size > 10_000, `${slug}.png is empty`);
      copyFileSync(src, join(DOC_SHOTS, `${slug}.png`));
    }
    // Drop pictures of screens that no longer exist (the hand-picked README shots are numbered and kept).
    if (!only) {
      const keep = new Set(shots.map((s) => `${s}.png`));
      for (const dir of [PUBLIC_SHOTS, DOC_SHOTS]) for (const f of readdirSync(dir)) if (!/^\d\d-/.test(f) && !keep.has(f)) rmSync(join(dir, f));
    }
  }
  writeDocs(reg);
  console.log("Markdown: docs/README.md, docs/apps.md, " + Object.values(PAGES).map((p) => `docs/${p}`).join(", "));
  if (missing.size) console.log(`API calls without a fixture (answered 404):\n  ${[...missing].sort().join("\n  ")}`);
  if (errors.length) {
    failed = true;
    console.error(`Page errors:\n  ${[...new Set(errors)].join("\n  ")}`);
  }
  await browser.close();
} finally {
  vite.kill();
}
process.exit(failed ? 1 : 0);
