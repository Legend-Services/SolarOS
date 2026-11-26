#!/usr/bin/env node
/**
 * Dual-theme audit: opens every app, Settings sub-module, inner tab, drawer, dialog and schematic canvas in headless
 * Chromium, once in Light Mode and once in Dark Mode, and flags surfaces and text that do not fit the active mode.
 *
 *   node scripts/audit-dual-theme.mjs [--mode light|dark|both] [--only <screen-substring>] [--json <file>]
 * Exit code 1 when anything is flagged. Uses the same dev server and API fixtures as generate-support-docs.mjs.
 *
 * A surface is the element's own background (or an SVG node's fill) composited over what lies under it, down to the
 * theme base color. With relative luminance L:
 *   Light Mode  dark     — own alpha > 0.35 and L < 0.65;  gray — own alpha > 0.05 and L < 0.88 (low saturation)
 *   Dark Mode   light    — own alpha > 0.35 and L > 0.35 (low saturation)
 *   Both        contrast — text below WCAG AA against its surface (4.5:1; 3:1 for large text)
 * Saturated fills count as accents (badges, primary buttons, status tints) unless they cover a large area, so a navy
 * blueprint canvas in Light Mode is still caught. Skipped: terminal / VNC / canvas content, images and video,
 * full-screen modal scrims, small elements (< 40×16 px), disabled controls, aria-hidden decoration and anything marked
 * data-audit-ignore (theme previews, wallpaper swatches).
 */
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { launch, openPage, reset, settle, show, startVite } from "./support-docs/harness.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : "");
const only = opt("--only");
const jsonOut = opt("--json");
const MODES = opt("--mode") && opt("--mode") !== "both" ? [opt("--mode")] : ["light", "dark"];
let MODE = MODES[0];

/* ---------------- In-page scanner ---------------- */

function scan(mode) {
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
    const v = { r, g, b, a: /^(none|transparent)$/.test(css) || css.startsWith("url(") ? 0 : a / 255 };
    cache.set(css, v);
    return v;
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const sat = (c) => {
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  const base = rgba(getComputedStyle(document.documentElement).getPropertyValue("--sd-bg-base").trim() || "#fff");
  const SHAPES = /^(rect|circle|ellipse|polygon)$/;
  /** Own fill of an element: background for HTML, fill × fill-opacity for SVG shapes. */
  const fillOf = (el, cs) => {
    if (el instanceof SVGElement) {
      if (!SHAPES.test(el.tagName)) return { r: 0, g: 0, b: 0, a: 0 };
      const f = rgba(cs.fill);
      return { ...f, a: f.a * Number(cs.fillOpacity || 1) };
    }
    return rgba(cs.backgroundColor);
  };
  const eff = new Map();
  const effective = (el) => {
    if (!el || el === document.documentElement) return base;
    if (eff.has(el)) return eff.get(el);
    let under = effective(el.parentElement);
    // In SVG a shape drawn earlier in the same group (a node card behind its label) sits under this element.
    if (el instanceof SVGElement && el.parentElement) {
      const r = el.getBoundingClientRect();
      for (const sib of el.parentElement.children) {
        if (sib === el) break;
        if (!SHAPES.test(sib.tagName)) continue;
        const sr = sib.getBoundingClientRect();
        if (sr.left <= r.left + 1 && sr.right >= r.right - 1 && sr.top <= r.top + 1 && sr.bottom >= r.bottom - 1) {
          const f = fillOf(sib, getComputedStyle(sib));
          if (f.a > 0) under = over(f, under);
        }
      }
    }
    const own = fillOf(el, getComputedStyle(el));
    const v = own.a > 0 ? over(own, under) : under;
    eff.set(el, v);
    return v;
  };
  const SKIP = ".xterm, canvas, video, img, iframe, [data-audit-ignore], .wallpaper, .noVNC_canvas, [aria-hidden=true]";
  const STRUCT = "header, nav, aside, footer, [role=tablist], [role=tab][aria-selected=true], [role=dialog], [role=menu], [role=listbox], thead, th, table, pre, input, select, textarea, .glass, .glass-soft, .glass-panel, .sd-window";
  const name = (el) => {
    const raw = el.getAttribute("class") || "";
    const cls = raw.split(/\s+/).filter((c) => /^(!?)((dark|hover|focus|group|sm|md|lg|xl):)?(bg|from|to|via|glass|border|rounded|text|fill)/.test(c) || c.startsWith("sd-")).slice(0, 8).join(" ");
    const role = el.getAttribute("role");
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    return `<${el.tagName.toLowerCase()}${role ? ` role=${role}` : ""}${cls ? ` class="${cls}"` : ""}> "${label}"`;
  };
  const out = [];
  const seen = new Set();
  const push = (f) => {
    const k = `${f.kind} ${f.el}`;
    if (!seen.has(k)) (seen.add(k), out.push(f));
  };
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(SKIP)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.2) continue;

    // Text contrast, for elements that hold text of their own.
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && !el.closest("[disabled], [aria-disabled=true], option, .sr-only")) {
      // Text over a gradient or picture has no single background to measure against.
      let gradient = false;
      let fade = 1;
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        fade *= Number(pcs.opacity);
        if (pcs.backgroundImage !== "none") gradient = true;
        if (gradient || rgba(pcs.backgroundColor).a >= 0.95) break;
      }
      if (!gradient && fade > 0.5) {
        const bg = effective(el);
        const svg = el instanceof SVGElement;
        const raw = rgba(svg ? cs.fill : cs.color);
        const fg = over({ ...raw, a: raw.a * (svg ? Number(cs.fillOpacity || 1) : 1) * fade }, bg);
        const px = parseFloat(cs.fontSize);
        const need = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66) ? 3 : 4.5;
        const cr = ratio(fg, bg);
        if (raw.a > 0 && cr < need) push({ kind: "contrast", lum: Math.round(cr * 100) / 100, alpha: Math.round(raw.a * 100) / 100, size: `${Math.round(px)}px`, el: name(el) });
      }
    }

    if (r.width < 40 || r.height < 16) continue;
    const own = fillOf(el, cs);
    if (own.a <= 0.05) continue;
    // Modal scrims dim the whole desktop on purpose.
    if ((cs.position === "fixed" || cs.position === "absolute") && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.85 && own.a < 0.75 && !el.matches(STRUCT)) continue;
    const isStruct = el.matches(STRUCT) || el instanceof SVGElement;
    // Plain divs count only when they are bars or panels, not small chips.
    if (!isStruct && !(r.width >= 120 && r.height >= 24)) continue;
    if (sat(own) > 0.25 && r.width * r.height < 60000) continue; // accent, status or badge tint
    const e = effective(el);
    const L = lum(e);
    let kind = null;
    if (mode === "light") kind = own.a > 0.35 && L < 0.65 ? "dark" : L < 0.88 && sat(e) <= 0.25 ? "gray" : null;
    else kind = own.a > 0.35 && L > 0.35 && sat(e) <= 0.25 ? "light" : null;
    if (!kind) continue;
    // A fill that only repeats its parent's tone is not a block of its own.
    if (kind === "gray" && Math.abs(lum(effective(el.parentElement)) - L) < 0.02) continue;
    push({ kind, lum: Math.round(L * 1000) / 1000, alpha: Math.round(own.a * 100) / 100, size: `${Math.round(r.width)}×${Math.round(r.height)}`, el: name(el) });
  }
  return out;
}

/* ---------------- Screens ---------------- */

const findings = [];
let screens = 0;

async function audit(page, screen) {
  if (only && !screen.includes(only)) return;
  screens++;
  // The tab walk may have pressed a Light / Dark / Auto or language switch: put the audited mode and English back, and
  // park the pointer so no hover tint is measured.
  await page.evaluate(async (m) => {
    (await import("/src/store/themeStore.ts")).useTheme.getState().setMode(m);
    (await import("/src/i18n/index.ts")).useLanguage.getState().setLanguage("en");
  }, MODE);
  await page.mouse.move(1439, 899);
  await page.waitForTimeout(150);
  const mode = await page.evaluate(() => document.documentElement.dataset.colorMode);
  assert.equal(mode, MODE, `${screen}: color mode is ${mode}`);
  const hits = await page.evaluate(scan, MODE);
  for (const h of hits) findings.push({ mode: MODE, screen, ...h });
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
      findings.push({ mode: MODE, screen, kind: "error", el: String(e.message).split("\n")[0] });
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
  // A VM and a container, each in Form View and Wireframe Architecture.
  for (const g of ["media-server", "dns-filter"])
    await step(`compute › guest drawer ${g}`, async () => {
      await compute();
      await click(page, page.getByRole("button", { name: g, exact: true }));
      await auditTabs(page, `compute › guest drawer ${g}`);
      await click(page, page.getByRole("tab", { name: "Wireframe Architecture" }));
      await click(page, page.getByRole("button", { name: /^net0 · / }));
      await audit(page, `compute › guest drawer ${g} › wireframe inspector`);
    });
  await step("architect › zoomed in", async () => {
    await show(page, { kind: "app", appId: "architect" });
    await click(page, page.getByRole("button", { name: /zoom in/i }));
    await click(page, page.getByRole("button", { name: /zoom in/i }));
    await audit(page, "architect › zoomed in");
  });
  await step("architect › network", async () => {
    await show(page, { kind: "app", appId: "architect" });
    await click(page, page.getByRole("tab", { name: "Infrastructure Blueprint" }));
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
  const errors = [];
  for (MODE of MODES) {
    const { page, errors: pageErrors } = await openPage(browser, { colorScheme: MODE, deviceScaleFactor: 1 });
    await page.evaluate(async (m) => (await import("/src/store/themeStore.ts")).useTheme.getState().setMode(m), MODE);
    await settle(page, 500);
    console.log(`\n${MODE === "light" ? "Light" : "Dark"} Mode audit:`);
    await run(page);
    errors.push(...pageErrors);
    await page.context().close();
  }
  for (const m of MODES) {
    const real = findings.filter((f) => f.mode === m && f.kind !== "error");
    const byEl = new Map();
    for (const f of real) {
      const k = `${f.kind} ${f.el}`;
      byEl.set(k, [...(byEl.get(k) ?? []), f]);
    }
    console.log(`\n${m === "light" ? "Light" : "Dark"} Mode: ${real.length} findings (${byEl.size} distinct)`);
    for (const [k, fs] of [...byEl].sort())
      console.log(`  ${k}\n      ${fs[0].kind === "contrast" ? "ratio" : "lum"} ${fs[0].lum} · ${fs[0].size} · ${fs.length}× · ${[...new Set(fs.map((f) => f.screen))].slice(0, 3).join(" | ")}`);
    for (const f of findings.filter((x) => x.mode === m && x.kind === "error")) console.log(`  could not open ${f.screen}: ${f.el}`);
  }
  const bad = findings.filter((f) => f.kind !== "error").length;
  console.log(`\n${screens} screens audited (${MODES.join(" + ")}), ${bad} findings, ${findings.length - bad} screens failed to open`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(findings, null, 2));
  if (errors.length) console.error(`Page errors:\n  ${[...new Set(errors)].join("\n  ")}`);
  code = findings.length || errors.length ? 1 : 0;
  await browser.close();
} finally {
  vite.kill();
}
process.exit(code);
