// Self-check for the Dock magnification curve. Run: node --experimental-strip-types scripts/dock-math.check.mjs
import { dockSizes } from "../src/lib/dockMath.ts";

const ok = (c, m) => {
  if (!c) throw new Error(m);
};
ok(dockSizes(12, 46, 8, 1.75, null).every((s) => s === 46), "no cursor -> base size");
ok(dockSizes(12, 46, 8, 1, 0).every((s) => s === 46), "magnification off -> base size");
const s = dockSizes(11, 46, 8, 1.75, 0); // cursor over the middle (6th) icon
ok(Math.abs(s[5] - 46 * 1.75) < 1e-9, `peak at cursor: ${s[5]}`);
ok(s[4] === s[6] && s[4] < s[5] && s[3] < s[4], "symmetric, decreasing away from the cursor");
ok(s[0] === 46 && s[10] === 46, "far icons stay at base size");
ok(s.every((x) => x >= 46 && x <= 46 * 1.75), "sizes within [base, base*peak]");
console.log("dock math self-check OK", s.map((x) => x.toFixed(1)).join(" "));
