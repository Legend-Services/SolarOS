// Self-check for the pointer reorder math. Run: node --experimental-strip-types scripts/reorder.check.mjs
import { arrayMove, mergeVisible, siblingOffsets, targetIndex } from "../src/hooks/useSmoothReorder.ts";

const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const row = [0, 1, 2, 3].map((i) => ({ x: i * 50, y: 0, w: 40, h: 40 })); // 40px icons, 10px gap
ok(arrayMove(["a", "b", "c"], 0, 2).join("") === "bca", "arrayMove forward");
ok(targetIndex(row, 0, { x: 0, y: 0 }, "x") === 0, "no movement keeps the slot");
ok(targetIndex(row, 0, { x: 29, y: 0 }, "x") === 0, "before the neighbour's midpoint: no swap");
ok(targetIndex(row, 0, { x: 51, y: 0 }, "x") === 1, "past the neighbour's midpoint: swap");
ok(targetIndex(row, 3, { x: -200, y: 0 }, "x") === 0, "drag to the front");
const off = siblingOffsets(row, 0, 2, "x");
ok(off[1].x === -50 && off[2].x === -50 && off[3].x === 0, `siblings pack left: ${JSON.stringify(off)}`);
const wide = [{ x: 0, y: 0, w: 80, h: 20 }, { x: 84, y: 0, w: 20, h: 20 }, { x: 108, y: 0, w: 40, h: 20 }]; // 4px gap, mixed widths
ok(siblingOffsets(wide, 0, 2, "x")[1].x === -84 && siblingOffsets(wide, 0, 2, "x")[2].x === -84, "mixed widths pack by size");
const grid = [0, 1, 2, 3].map((i) => ({ x: (i % 2) * 100, y: Math.floor(i / 2) * 100, w: 80, h: 80 }));
ok(targetIndex(grid, 0, { x: 100, y: 100 }, "xy") === 3, "grid: nearest slot");
const g = siblingOffsets(grid, 0, 3, "xy");
ok(g[1].x === -100 && g[1].y === 0 && g[2].x === 100 && g[2].y === -100, `grid: siblings shift one slot back: ${JSON.stringify(g)}`);
ok(mergeVisible(["a", "h", "b", "c"], ["a", "b", "c"], ["c", "a", "b"]).join("") === "chab", "hidden items keep their place");
console.log("reorder self-check OK");
