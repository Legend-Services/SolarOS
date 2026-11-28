// Self-check: the Hardware & Thermal Monitor widget shows CPU, GPU, RAM and Storage with temperatures, and its gear
// panel hides parts and temperatures (saved in the widget layout).
// Run: node scripts/support-docs/check-hardware-widget.mjs [out-dir for screenshots]
import assert from "node:assert/strict";
import { launch, openPage, reset, settle, startVite } from "./harness.mjs";

const out = process.argv[2];
const vite = await startVite();
const browser = await launch();
try {
  const { page } = await openPage(browser, { deviceScaleFactor: 2 });
  await reset(page);
  await settle(page, 2500);
  const card = page.locator('section[aria-label="Hardware & Thermal Monitor"]');
  await card.waitFor();
  const text = () => card.innerText();
  for (const s of ["CPU", "GPU", "RAM", "STORAGE"]) assert.match(await text(), new RegExp(s), `section ${s}`);
  assert.match(await text(), /53°C/, "CPU package temperature");
  assert.match(await text(), /Hottest core/, "hottest core");
  if (out) await card.screenshot({ path: `${out}/widget-all.png` });

  await card.getByRole("button", { name: "Choose what to show" }).click();
  const opts = card.getByRole("group", { name: "Choose what to show" });

  // Thermal sliders in the gear panel: averaging window and per-sensor limits (generic CPU profile: red from 90 °C).
  const pkg = card.locator("span", { hasText: /^53°C$/ }).first();
  assert.match(await pkg.getAttribute("class"), /text-emerald-400/, "53 °C is green on the generic profile");
  const slider = (label) => card.locator("label", { hasText: label }).locator('input[type="range"]');
  await slider("Average temperatures over").fill("30");
  await slider("Red from").first().fill("50");
  await page.waitForTimeout(200);
  assert.match(await pkg.getAttribute("class"), /text-rose-400/, "53 °C turns red with red from 50 °C");
  if (out) await card.screenshot({ path: `${out}/widget-sliders.png` });
  const th = await page.evaluate(() => JSON.parse(localStorage.getItem("solardeck-thermal")).state);
  assert.equal(th.smoothSec, 30, "averaging window saved");
  assert.equal(th.overrides.cpu.hot, 50, "CPU red limit saved");
  assert.ok(th.overrides.cpu.warn < 50, "orange stays below red");

  await opts.getByText("GPU", { exact: true }).click();
  await opts.getByText("Temperatures", { exact: true }).click();
  await page.waitForTimeout(300);
  assert.doesNotMatch(await text(), /Discrete GPU 16 GB/, "GPU hidden");
  assert.doesNotMatch(await text(), /°C/, "temperatures hidden");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("solardeck-widgets")).state.items.find((w) => w.id === "gpu").show);
  assert.deepEqual(saved, ["cpu", "ram", "storage"], "choice saved");
  if (out) await card.screenshot({ path: `${out}/widget-some.png` });
  console.log("hardware widget: ok");
} finally {
  await browser.close();
  vite.kill();
}
