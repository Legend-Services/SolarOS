// Self-check: the Settings sidebar can be dragged wider/narrower, is clamped, remembers its width and never truncates names.
// Run: node scripts/support-docs/check-tree-resize.mjs [out-dir for screenshots]
import assert from "node:assert/strict";
import { launch, openPage, show, startVite } from "./harness.mjs";

const out = process.argv[2];
const vite = await startVite();
const browser = await launch();
try {
  const { page } = await openPage(browser, { deviceScaleFactor: 1 });
  await show(page, { kind: "settings", module: "hardware-gpu" });
  const aside = page.locator("aside").first();
  const handle = page.getByRole("separator");
  const width = async () => Math.round((await aside.boundingBox()).width);
  const drag = async (dx) => {
    const b = await handle.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + 200, { steps: 8 });
    await page.mouse.up();
  };
  assert.equal(await width(), 240);
  await drag(-60);
  assert.equal(await width(), 180, "drag narrower");
  // Narrow: every name is fully visible (wraps instead of an ellipsis or clipping).
  const clipped = await aside.locator("button span.flex-1").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  assert.deepEqual(clipped, [], "clipped names");
  if (out) await page.screenshot({ path: `${out}/narrow.png` });
  await drag(500);
  assert.equal(await width(), 480, "clamped at max");
  if (out) await page.screenshot({ path: `${out}/wide.png` });
  assert.equal(await page.evaluate(() => localStorage.getItem("solardeck-settings-tree-width")), "480", "width remembered");
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await width(), 464, "arrow key");
  await handle.dblclick();
  assert.equal(await width(), 240, "double-click resets");
  console.log("settings sidebar resize: ok");
} finally {
  await browser.close();
  vite.kill();
}
