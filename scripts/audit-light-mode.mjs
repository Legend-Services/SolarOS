#!/usr/bin/env node
/**
 * Light Mode audit: opens every app, Settings sub-module, inner tab, drawer and dialog in headless Chromium with the
 * theme switched to Light Mode, and flags structural surfaces (window bars, headers, toolbars, sidebars, tab bars,
 * cards, tables, fields, dialogs) whose rendered background is a dark bar or a heavy gray block.
 *
 *   node scripts/audit-light-mode.mjs [--only <screen-substring>] [--json <file>]
 * Exit code 1 when anything is flagged. Uses the same dev server and API fixtures as generate-support-docs.mjs.
 *
 * A surface is the element's own background composited over its ancestors' (down to the theme base color):
 *   dark bar   — own fill alpha > 0.35 and relative luminance < 0.65
 *   gray block — own fill alpha > 0.05 and relative luminance < 0.85 (low saturation only)
 * Skipped: terminal / VNC / canvas content, images and video, accent-colored fills (badges, primary buttons, status
 * tints), full-screen modal scrims, small elements (< 40×16 px) and anything marked data-audit-ignore (theme previews).
 */
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { launch, openPage, reset, settle, show, startVite } from "./support-docs/harness.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : "";

/* ---------------- In-page scanner ---------------- */

function scan() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  // Canvas parses every CSS color syntax (oklab, oklch, color-mix results, color()) into sRGB.
  const rgba = (css) => {
    if (cache.has(css)) return cache.get(css);
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "#000";
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
    const v = { r, g, b, a: a / 255 };
    cache.set(css, v);
    return v;
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const sat = (c) => {
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  const base = rgba(getComputedStyle(document.documentElement).getPropertyValue("--sd-bg-base").trim() || "#fff");
  const eff = new Map();
  const effective = (el) => {
    if (!el || el === document.documentElement) return base;
    if (eff.has(el)) return eff.get(el);
    const own = rgba(getComputedStyle(el).backgroundColor);
    const v = own.a > 0 ? over(own, effective(el.parentElement)) : effective(el.parentElement);
    eff.set(el, v);
    return v;
  };
  const SKIP = ".xterm, canvas, video, img, svg, iframe, [data-audit-ignore], .wallpaper, .noVNC_canvas";
  const STRUCT = "header, nav, aside, footer, [role=tablist], [role=tab][aria-selected=true], [role=dialog], [role=menu], [role=listbox], thead, th, table, pre, input, select, textarea, .glass, .glass-soft, .glass-panel, .sd-window";
  const name = (el) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter((c) => /^(!?)((dark|hover|focus|group|sm|md|lg|xl):)?(bg|from|to|via|glass|border|rounded)/.test(c) || c.startsWith("sd-")).slice(0, 8).join(" ") : "";
    const role = el.getAttribute("role");
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    return `<${el.tagName.toLowerCase()}${role ? ` role=${role}` : ""}${cls ? ` class="${cls}"` : ""}> "${label}"`;
  };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(SKIP)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 16 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || Number(cs.opacity) < 0.2 || cs.display === "none") continue;
    const own = rgba(cs.backgroundColor);
    if (own.a <= 0.05) continue;
    // Modal scrims dim the whole desktop on purpose.
    if ((cs.position === "fixed" || cs.position === "absolute") && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.85 && own.a < 0.75 && !el.matches(STRUCT)) continue;
    const isStruct = el.matches(STRUCT);
    // Plain divs count only when they are bars or panels, not small chips.
    if (!isStruct && !(r.width >= 120 && r.height >= 24)) continue;
    if (sat(own) > 0.25) continue; // accent, status or badge tint
    const e = effective(el);
    const L = lum(e);
    const kind = own.a > 0.35 && L < 0.65 ? "dark" : L < 0.85 ? "gray" : null;
    if (!kind) continue;
    // A fill that only repeats its parent's tone is not a block of its own.
    if (kind === "gray" && Math.abs(lum(effective(el.parentElement)) - L) < 0.02) continue;
    out.push({ kind, lum: Math.round(L * 1000) / 1000, alpha: Math.round(own.a * 100) / 100, size: `${Math.round(r.width)}×${Math.round(r.height)}`, el: name(el) });
  }
  return out;
}

/* ---------------- Screens ---------------- */

const findings = [];
let screens = 0;

async function audit(page, screen) {
  if (only && !screen.includes(only)) return;
  screens++;
  // The tab walk may have pressed a Dark / Auto or language switch: put Light Mode and English back, and park the
  // pointer so no hover tint is measured.
  await page.evaluate(async () => {
    (await import("/src/store/themeStore.ts")).useTheme.getState().setMode("light");
    (await import("/src/i18n/index.ts")).useLanguage.getState().setLanguage("en");
  });
  await page.mouse.move(1439, 899);
  await page.waitForTimeout(150);
  const mode = await page.evaluate(() => document.documentElement.dataset.colorMode);
  assert.equal(mode, "light", `${screen}: color mode is ${mode}`);
  const hits = await page.evaluate(scan);
  for (const h of hits) findings.push({ screen, ...h });
  process.stdout.write(`  ${hits.length ? "✗" : "✓"} ${screen}${hits.length ? ` (${hits.length})` : ""}\n`);
}

/** Audit the screen, then click through every tab of the front window (one level) and audit each. */
async function auditTabs(page, screen) {
  if (only && !screen.includes(only)) return;
  await audit(page, screen);
  const scope = page.locator(".sd-window").last();
  const root = (await scope.count()) ? scope : page.locator("body");
  const n = Math.min(await root.locator("[role=tab]").count(), 30);
  for (let i = 0; i < n; i++) {
    const tab = root.locator("[role=tab]").nth(i);
    if (!(await tab.isVisible().catch(() => false))) continue;
    const label = ((await tab.getAttribute("aria-label")) || (await tab.innerText()).trim().split("\n")[0] || `#${i}`).slice(0, 40);
    await tab.click({ timeout: 3000 }).catch(() => {});
    await settle(page, 400);
    await audit(page, `${screen} › ${label}`);
  }
}

const click = async (page, locator) => {
  await locator.filter({ visible: true }).first().click({ timeout: 4000 });
  await settle(page, 600);
};

async function run(page) {
  const reg = await page.evaluate(async () => {
    const r = await import("/src/apps/registry.ts");
    const m = await import("/src/apps/settings/modules.ts");
    return { apps: r.APP_IDS, modules: m.MODULE_IDS };
  });
  const step = async (screen, fn) => {
    if (only && !screen.includes(only)) return;
    try {
      await fn();
    } catch (e) {
      findings.push({ screen, kind: "error", el: String(e.message).split("\n")[0] });
      process.stdout.write(`  ! ${screen}: ${String(e.message).split("\n").slice(0, 12).join(" | ")}\n`);
    }
  };

  await step("desktop", async () => (await reset(page), await settle(page, 500), await audit(page, "desktop")));
  await step("desktop › widget studio", async () => {
    await reset(page);
    await click(page, page.getByRole("button", { name: "Edit Widgets" }));
    await audit(page, "desktop › widget studio");
  });
  await step("desktop › app gallery", async () => {
    await reset(page);
    await page.evaluate(async () => (await import("/src/lib/stores.ts")).useDock.setState({ gallery: true }));
    await settle(page, 600);
    await audit(page, "desktop › app gallery");
  });
  await step("global search", async () => {
    await reset(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("dhcp", { delay: 30 });
    await settle(page, 500);
    await audit(page, "global search");
    await page.keyboard.press("Escape");
  });
  await step("notifications", async () => {
    await reset(page);
    // The bell sits behind the tray's overflow chevron by default.
    await page.evaluate(async () => (await import("/src/store/layoutStore.ts")).useLayout.setState({ maxVisibleTrayItems: 20 }));
    await click(page, page.getByRole("button", { name: /notification|background task/i }));
    await auditTabs(page, "notifications");
    await page.keyboard.press("Escape");
  });
  await step("desktop tour", async () => {
    await reset(page);
    await page.evaluate(async () => (await import("/src/store/onboardingStore.ts")).useOnboarding.getState().startTour());
    await settle(page, 700);
    await audit(page, "desktop tour");
    await page.evaluate(async () => (await import("/src/store/onboardingStore.ts")).useOnboarding.setState({ tour: false }));
  });

  for (const id of reg.apps) await step(`app ${id}`, async () => (await show(page, { kind: "app", appId: id }), await auditTabs(page, `app ${id}`)));
  for (const m of reg.modules) await step(`settings ${m}`, async () => (await show(page, { kind: "settings", module: m }), await auditTabs(page, `settings ${m}`)));

  // The tab walk leaves Grid / List on whatever it clicked last; the deep links below expect the grid.
  const grid = () => page.evaluate(async () => (await import("/src/store/layoutStore.ts")).useLayout.setState((s) => ({ appViews: { ...s.appViews, compute: "grid", appcenter: "grid" } })));
  const compute = async () => (await grid(), await show(page, { kind: "app", appId: "compute" }));
  const intent = (v) => page.evaluate(async (x) => (await import("/src/lib/stores.ts")).useIntent.getState().go("compute", x), v).then(() => settle(page, 700));
  for (const v of ["iso", "docker"]) await step(`compute › ${v}`, async () => (await compute(), await intent(v), await auditTabs(page, `compute › ${v}`)));
  for (const v of ["vm", "lxc"]) await step(`compute › create ${v}`, async () => (await compute(), await intent(v), await audit(page, `compute › create ${v}`)));
  await step("compute › zero-touch", async () => (await compute(), await click(page, page.getByRole("button", { name: /zero-touch/i })), await audit(page, "compute › zero-touch")));
  await step("compute › labs", async () => {
    await compute();
    await click(page, page.getByRole("button", { name: /isolated lab/i }));
    await audit(page, "compute › labs");
    await click(page, page.getByRole("button", { name: "New Lab" }));
    await audit(page, "compute › labs › launch an isolated lab");
  });
  await step("compute › guest drawer", async () => {
    await compute();
    await click(page, page.getByRole("button", { name: "media-server", exact: true }));
    await auditTabs(page, "compute › guest drawer");
    await click(page, page.getByRole("tab", { name: "Wireframe Architecture" }));
    await click(page, page.getByRole("button", { name: /^net0 · / }));
    await audit(page, "compute › guest drawer › wireframe inspector");
  });
  await step("architect › network", async () => {
    await show(page, { kind: "app", appId: "architect" });
    await click(page, page.getByRole("button", { name: "Open the network view of br0" }));
    await audit(page, "architect › network");
    await click(page, page.getByRole("button", { name: /^Other Devices/ }));
    await audit(page, "architect › network › other devices");
  });
  await step("appcenter › list", async () => {
    await grid();
    await show(page, { kind: "app", appId: "appcenter" });
    await click(page, page.getByRole("tab", { name: "List", exact: true }));
    await auditTabs(page, "appcenter › list");
  });
}

/* ---------------- Main ---------------- */

const vite = await startVite();
let code = 0;
try {
  const browser = await launch();
  const { page, errors } = await openPage(browser, { colorScheme: "light", deviceScaleFactor: 1 });
  await page.evaluate(async () => (await import("/src/store/themeStore.ts")).useTheme.getState().setMode("light"));
  await settle(page, 500);
  console.log("Light Mode audit:");
  await run(page);
  const real = findings.filter((f) => f.kind !== "error");
  const byEl = new Map();
  for (const f of real) {
    const k = `${f.kind} ${f.el}`;
    byEl.set(k, [...(byEl.get(k) ?? []), f.screen]);
  }
  console.log(`\n${screens} screens audited, ${real.length} findings (${byEl.size} distinct), ${findings.length - real.length} screens failed to open`);
  for (const [k, s] of [...byEl].sort()) console.log(`  ${k}\n      lum ${real.find((f) => `${f.kind} ${f.el}` === k).lum} · ${s.length}× · ${[...new Set(s)].slice(0, 3).join(" | ")}`);
  for (const f of findings.filter((x) => x.kind === "error")) console.log(`  could not open ${f.screen}: ${f.el}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(findings, null, 2));
  if (errors.length) console.error(`Page errors:\n  ${[...new Set(errors)].join("\n  ")}`);
  code = findings.length || errors.length ? 1 : 0;
  await browser.close();
} finally {
  vite.kill();
}
process.exit(code);
