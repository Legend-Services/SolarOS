/* Procedural wallpaper art. Every generator returns a CSS `background` value: seeded SVG drawn on a 1600×1000 canvas
   (scaled with `cover`, so it stays crisp at any resolution) layered over CSS gradients in percentages. A Kit holds the
   colors of one color mode, so the same scene renders in Dark and Light. */

export interface Kit {
  mode: "dark" | "light";
  bg: [string, string];
  /** Four accent colors used by the scene. */
  a: [string, string, string, string];
  /** Silhouette color (mountains, palms, buildings). */
  ink: string;
  /** Fine detail color (stars, grid lines, glyphs). */
  line: string;
}

const W = 1600;
const H = 1000;
type Pt = [number, number];

const n = (v: number) => Math.round(v * 10) / 10;
/** Hex color with alpha: al("#38bdf8", 0.3) → "#38bdf84d". */
export const al = (c: string, a: number) => c + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");

/** Seeded PRNG (mulberry32): the same seed always draws the same wallpaper. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimal escaping for a double-quoted CSS data URI (the markup only uses single quotes); far smaller than encodeURIComponent. */
const svg = (body: string, defs = "") =>
  `url("data:image/svg+xml,${`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMid slice'><defs>${defs}</defs>${body}</svg>`
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")}") center / cover no-repeat`;
const base = (k: Kit, deg = 160) => `linear-gradient(${deg}deg, ${k.bg[0]}, ${k.bg[1]})`;
const blob = (c: string, x: number, y: number, w: number, h: number, a: number) => `radial-gradient(${w}% ${h}% at ${x}% ${y}%, ${al(c, a)}, transparent 70%)`;
const stack = (...l: (string | false)[]) => l.filter(Boolean).join(", ");
const path = (pts: Pt[], close = true) => "M" + pts.map(([x, y]) => `${n(x)},${n(y)}`).join("L") + (close ? "Z" : "");
const lg = (id: string, stops: [string, number][], vertical = true) =>
  `<linearGradient id='${id}' x1='0' y1='0' x2='${vertical ? 0 : 1}' y2='${vertical ? 1 : 0}'>${stops
    .map(([c, o], i) => `<stop offset='${n(i / (stops.length - 1))}' stop-color='${c}' stop-opacity='${o}'/>`)
    .join("")}</linearGradient>`;
const blurF = (id: string, s: number) => `<filter id='${id}' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='${s}'/></filter>`;
const glowF = (id: string, s: number) =>
  `<filter id='${id}' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='${s}' result='b'/><feMerge><feMergeNode in='b'/><feMergeNode in='SourceGraphic'/></feMerge></filter>`;
const blend = (k: Kit) => (k.mode === "dark" ? "screen" : "multiply");

/** Mountain-like ridge line from x=0 to W, closed to the bottom. */
function ridge(r: () => number, baseY: number, amp: number): Pt[] {
  const [p1, p2, p3] = [r() * 6, r() * 6, r() * 6];
  const [f1, f2, f3] = [0.0018 + r() * 0.002, 0.006 + r() * 0.004, 0.02 + r() * 0.01];
  const pts: Pt[] = [];
  for (let x = 0; x <= W; x += 16)
    pts.push([x, baseY - amp * (0.55 * (1 - Math.abs(Math.sin(x * f1 + p1))) + 0.3 * Math.sin(x * f2 + p2) + 0.15 * Math.sin(x * f3 + p3))]);
  return [[0, H], ...pts, [W, H]];
}

/** Smooth wave line from x=0 to W. */
function waveLine(r: () => number, baseY: number, amp: number): Pt[] {
  const [p, q, f] = [r() * 6, r() * 6, 0.002 + r() * 0.002];
  const pts: Pt[] = [];
  for (let x = 0; x <= W; x += 16) pts.push([x, baseY + amp * Math.sin(x * f + p) + amp * 0.4 * Math.sin(x * f * 2.3 + q)]);
  return pts;
}

function stars(r: () => number, k: Kit, count: number, maxY = H) {
  let s = "";
  for (let i = 0; i < count; i++)
    s += k.mode === "dark"
      ? `<circle cx='${n(r() * W)}' cy='${n(r() * maxY)}' r='${n(0.5 + r() * 1.4)}' fill='${k.line}' opacity='${n(0.25 + r() * 0.7)}'/>`
      : `<circle cx='${n(r() * W)}' cy='${n(r() * maxY)}' r='${n(6 + r() * 26)}' fill='${k.a[i % 4]}' opacity='${n(0.06 + r() * 0.12)}'/>`;
  return s;
}

/* ---------------- Scenes ---------------- */

export type Blob = [x: number, y: number, w: number, h: number, color: number, alpha: number];
const MESH: Blob[] = [
  [10, 10, 60, 55, 0, 0.3],
  [90, 20, 55, 55, 1, 0.3],
  [50, 110, 70, 60, 2, 0.24],
  [70, 55, 40, 35, 3, 0.12],
];

/** Soft mesh of radial light blobs. */
export const mesh = (k: Kit, blobs: Blob[] = MESH, deg = 160) => stack(...blobs.map(([x, y, w, h, c, a]) => blob(k.a[c], x, y, w, h, a)), base(k, deg));

/** Mesh with blurred gas clouds and a star field (bokeh in Light). */
export function nebula(k: Kit, seed: number) {
  const r = rng(seed);
  let clouds = "";
  for (let i = 0; i < 6; i++)
    clouds += `<ellipse cx='${n(200 + r() * 1200)}' cy='${n(150 + r() * 700)}' rx='${n(220 + r() * 260)}' ry='${n(90 + r() * 160)}' fill='${k.a[i % 4]}' opacity='${n(0.18 + r() * 0.2)}' transform='rotate(${n(r() * 60 - 30)} 800 500)' filter='url(#b)' style='mix-blend-mode:${blend(k)}'/>`;
  return stack(svg(clouds + stars(r, k, k.mode === "dark" ? 180 : 40), blurF("b", 60)), mesh(k));
}

/** Layered mountain ridges under a glowing sky; `water` adds a still lake with reflections. */
export function ridges(k: Kit, seed: number, water = false) {
  const r = rng(seed);
  let defs = blurF("b", 4);
  let body = stars(r, k, k.mode === "dark" ? 90 : 0, 500);
  const layers = 4;
  for (let i = 0; i < layers; i++) {
    defs += lg(`r${i}`, [[k.a[i % 4], 0.5 + i * 0.12], [k.ink, 0.45 + i * 0.18]]);
    body += `<path d='${path(ridge(r, 430 + i * 120 - (water ? 40 : 0), 300 - i * 50))}' fill='url(#r${i})'/>`;
  }
  if (water) {
    defs += lg("w", [[k.a[0], 0.35], [k.bg[1], 0.95]]);
    body += `<rect y='760' width='${W}' height='240' fill='url(#w)'/>`;
    for (let i = 0; i < 26; i++) body += `<rect x='${n(r() * W)}' y='${n(770 + r() * 220)}' width='${n(40 + r() * 220)}' height='1.5' fill='${k.line}' opacity='${n(0.1 + r() * 0.25)}'/>`;
  }
  return stack(svg(body, defs), blob(k.a[0], 70, 38, 45, 40, 0.45), blob(k.a[1], 20, 20, 50, 45, 0.3), base(k, 180));
}

/** Flowing translucent wave bands. */
export function waves(k: Kit, seed: number, bands = 6) {
  const r = rng(seed);
  let defs = "";
  let body = "";
  for (let i = 0; i < bands; i++) {
    defs += lg(`w${i}`, [[k.a[i % 4], 0.55], [k.a[(i + 1) % 4], 0.04]]);
    const line = waveLine(r, 300 + i * (600 / bands), 60 + r() * 70);
    body += `<path d='${path([...line, [W, H], [0, H]])}' fill='url(#w${i})' style='mix-blend-mode:${blend(k)}'/><path d='${path(line, false)}' fill='none' stroke='${k.line}' stroke-opacity='0.22' stroke-width='1.5'/>`;
  }
  return stack(svg(body, defs), mesh(k, [[15, 15, 55, 50, 0, 0.25], [85, 80, 55, 50, 2, 0.2]]));
}

/** Folded glowing ribbons sweeping across. */
export function ribbons(k: Kit, seed: number) {
  const r = rng(seed);
  let defs = blurF("b", 40);
  let body = "";
  for (let i = 0; i < 4; i++) {
    defs += lg(`g${i}`, [[k.a[i % 4], 0.9], [k.a[(i + 1) % 4], 0.85], [k.a[(i + 2) % 4], 0.2]], false);
    const y0 = 200 + r() * 600;
    const d = `M-200,${n(y0)} C${n(300 + r() * 300)},${n(r() * H)} ${n(900 + r() * 300)},${n(r() * H)} 1800,${n(200 + r() * 600)}`;
    const w = 90 + r() * 120;
    body += `<path d='${d}' fill='none' stroke='url(#g${i})' stroke-width='${n(w * 1.6)}' opacity='0.5' filter='url(#b)'/>`;
    body += `<path d='${d}' fill='none' stroke='url(#g${i})' stroke-width='${n(w)}' stroke-linecap='round' opacity='0.78' style='mix-blend-mode:${blend(k)}'/>`;
    body += `<path d='${d}' fill='none' stroke='${k.line}' stroke-width='2' opacity='0.35' transform='translate(0 ${n(-w / 2.4)})'/>`;
  }
  return stack(svg(body, defs), base(k));
}

/** Radial bloom of translucent petals. */
export function bloom(k: Kit, seed: number, petals = 14) {
  const r = rng(seed);
  const [cx, cy] = [880 + r() * 200, 480 + r() * 120];
  let defs = blurF("b", 50);
  let body = `<circle cx='${cx}' cy='${cy}' r='260' fill='${k.a[0]}' opacity='0.35' filter='url(#b)'/>`;
  for (let i = 0; i < petals; i++) {
    defs += lg(`p${i}`, [[k.a[i % 4], 0], [k.a[i % 4], 0.6], [k.a[(i + 1) % 4], 0.15]], false);
    body += `<ellipse cx='${n(cx + 300)}' cy='${cy}' rx='${n(300 + r() * 80)}' ry='${n(70 + r() * 40)}' fill='url(#p${i})' transform='rotate(${n((i * 360) / petals + r() * 8)} ${cx} ${cy})' style='mix-blend-mode:${blend(k)}'/>`;
  }
  return stack(svg(body, defs), base(k));
}

/** Low-poly facets lit from one corner (origami, gem cuts). */
export function facets(k: Kit, seed: number, light: Pt = [1300, 150]) {
  const r = rng(seed);
  const [cols, rows] = [10, 7];
  const g: Pt[][] = [];
  for (let y = 0; y <= rows; y++) {
    g.push([]);
    for (let x = 0; x <= cols; x++) {
      const edge = x === 0 || y === 0 || x === cols || y === rows;
      g[y].push([(x / cols) * W + (edge ? 0 : (r() - 0.5) * 120), (y / rows) * H + (edge ? 0 : (r() - 0.5) * 110)]);
    }
  }
  let body = "";
  const tri = (pts: Pt[]) => {
    const [mx, my] = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3];
    const t = Math.min(1, Math.hypot(mx - light[0], my - light[1]) / 1500);
    body += `<path d='${path(pts)}' fill='${k.a[Math.floor(r() * 4)]}' fill-opacity='${n(0.05 + (1 - t) * 0.5 * (0.4 + r() * 0.6))}' stroke='${k.line}' stroke-opacity='0.06'/>`;
  };
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const [a, b, c, d] = [g[y][x], g[y][x + 1], g[y + 1][x], g[y + 1][x + 1]];
      if (r() > 0.5) (tri([a, b, d]), tri([a, d, c]));
      else (tri([a, b, c]), tri([b, d, c]));
    }
  return stack(svg(body), base(k));
}

/** Northern lights curtains; `fjord` adds mountains and a mirrored lake. */
export function aurora(k: Kit, seed: number, fjord = false) {
  const r = rng(seed);
  let defs = blurF("b", 16);
  let body = stars(r, k, k.mode === "dark" ? 160 : 30, 700);
  for (let i = 0; i < 4; i++) {
    // Curtain: a band hanging below a wavy top edge, bright at the top and fading downwards.
    const [y0, amp, len, f, p] = [140 + i * 80 + r() * 50, 60 + r() * 70, 160 + r() * 140, 0.002 + r() * 0.002, r() * 6];
    const top: Pt[] = [];
    for (let x = -100; x <= W + 100; x += 20) top.push([x, y0 + amp * Math.sin(x * f + p)]);
    defs += `<linearGradient id='a${i}' gradientUnits='userSpaceOnUse' x1='0' y1='${n(y0 - amp)}' x2='0' y2='${n(y0 + amp + len)}'><stop offset='0' stop-color='${k.a[i % 4]}' stop-opacity='0'/><stop offset='0.3' stop-color='${k.a[i % 4]}' stop-opacity='0.85'/><stop offset='1' stop-color='${k.a[(i + 1) % 4]}' stop-opacity='0'/></linearGradient>`;
    body += `<path d='${path([...top, ...top.map(([x, y]) => [x, y + len] as Pt).reverse()])}' fill='url(#a${i})' opacity='0.75' filter='url(#b)' style='mix-blend-mode:${blend(k)}'/>`;
  }
  if (fjord) {
    defs += lg("w", [[k.a[0], 0.2], [k.bg[1], 0.95]]);
    body += `<path d='${path(ridge(r, 760, 300))}' fill='${k.ink}' opacity='0.75'/><path d='${path(ridge(r, 820, 200))}' fill='${k.ink}'/><rect y='860' width='${W}' height='140' fill='url(#w)'/>`;
    for (let i = 0; i < 18; i++) body += `<rect x='${n(r() * W)}' y='${n(870 + r() * 120)}' width='${n(60 + r() * 200)}' height='1.5' fill='${k.a[i % 2]}' opacity='${n(0.15 + r() * 0.3)}'/>`;
  }
  return stack(svg(body, defs), base(k, 180));
}

/** A palm tree silhouette rooted at (x, y). */
function palm(x: number, y: number, h: number, lean: number, ink: string, r: () => number) {
  const [tx, ty] = [x + lean, y - h];
  let s = `<path d='M${x - 10},${y} Q${n(x + lean * 0.2 - 8)},${n(y - h * 0.5)} ${n(tx - 4)},${n(ty)} L${n(tx + 4)},${n(ty)} Q${n(x + lean * 0.2 + 8)},${n(y - h * 0.5)} ${x + 10},${y}Z' fill='${ink}'/>`;
  for (let i = 0; i < 9; i++) {
    const a = (-170 + i * 20 + (r() - 0.5) * 10) * (Math.PI / 180);
    const len = 120 + r() * 70;
    const [ex, ey] = [tx + Math.cos(a) * len, ty + Math.sin(a) * len * 0.55 + len * 0.45];
    const [mx, my] = [tx + Math.cos(a) * len * 0.55, ty + Math.sin(a) * len * 0.55 - 10];
    s += `<path d='M${n(tx)},${n(ty)} Q${n(mx)},${n(my - 14)} ${n(ex)},${n(ey)} Q${n(mx)},${n(my + 10)} ${n(tx)},${n(ty + 6)}Z' fill='${ink}'/>`;
  }
  return s;
}

/** City skyline along `y`; `lights` adds lit windows. */
function skyline(r: () => number, y: number, k: Kit, maxH: number, lights: boolean, opacity = 1) {
  let s = "";
  for (let x = -20; x < W; ) {
    const w = 30 + r() * 70;
    const h = 30 + r() * maxH * (0.4 + 0.6 * Math.sin((x / W) * Math.PI));
    s += `<rect x='${n(x)}' y='${n(y - h)}' width='${n(w)}' height='${n(h + 2)}' fill='${k.ink}' opacity='${opacity}'/>`;
    if (lights)
      for (let wy = y - h + 8; wy < y - 6; wy += 12)
        for (let wx = x + 5; wx < x + w - 6; wx += 9) if (r() < 0.16) s += `<rect x='${n(wx)}' y='${n(wy)}' width='4' height='6' fill='${k.a[Math.floor(r() * 3)]}' opacity='${n(0.5 + r() * 0.5)}'/>`;
    x += w + r() * 6;
  }
  return s;
}

export interface SunsetOpts {
  sun?: boolean;
  stripes?: boolean;
  ocean?: boolean;
  grid?: boolean;
  palms?: number;
  skyline?: boolean;
}

/** Horizon scene: sky, sun (optionally striped), then ocean or a perspective laser grid, plus palms or a skyline. */
export function sunset(k: Kit, seed: number, o: SunsetOpts) {
  const r = rng(seed);
  const hy = 640;
  let defs = lg("sky", [[k.bg[0], 1], [k.a[0], 0.85], [k.a[1], 1]]) + lg("sun", [[k.a[2], 1], [k.a[1], 1]]) + blurF("b", 60) + glowF("g", 3);
  let body = `<rect width='${W}' height='${hy}' fill='url(#sky)'/>` + stars(r, k, k.mode === "dark" ? 120 : 0, 380);
  const [cx, cy, sr] = [W / 2, hy - 150, 230];
  if (o.sun !== false) {
    body += `<circle cx='${cx}' cy='${cy}' r='380' fill='${k.a[2]}' opacity='0.3' filter='url(#b)'/>`;
    if (o.stripes) {
      let m = `<rect width='${W}' height='${H}' fill='white'/>`;
      for (let i = 0; i < 7; i++) m += `<rect x='0' y='${n(cy + 10 + i * 30)}' width='${W}' height='${n(4 + i * 3.2)}' fill='black'/>`;
      defs += `<mask id='m'>${m}</mask>`;
    }
    body += `<circle cx='${cx}' cy='${cy}' r='${sr}' fill='url(#sun)' ${o.stripes ? "mask='url(#m)'" : ""}/>`;
  }
  if (o.skyline) body += skyline(r, hy + 2, k, 230, true, o.ocean ? 0.92 : 1);
  if (o.ocean) {
    defs += lg("sea", [[k.a[3], 0.9], [k.bg[1], 1]]);
    body += `<rect y='${hy}' width='${W}' height='${H - hy}' fill='url(#sea)'/>`;
    for (let i = 0; i < 16; i++) {
      const w = (sr * 2 - i * 22) * (0.6 + r() * 0.4);
      body += `<rect x='${n(cx - w / 2)}' y='${n(hy + 8 + i * i * 1.35)}' width='${n(w)}' height='${n(2 + i * 0.4)}' rx='2' fill='${k.a[2]}' opacity='${n(0.6 - i * 0.03)}'/>`;
    }
  }
  if (o.grid) {
    defs += lg("floor", [[k.bg[1], 1], [k.bg[0], 1]]);
    body += `<rect y='${hy}' width='${W}' height='${H - hy}' fill='url(#floor)'/><g stroke='${k.a[0]}' stroke-width='2' opacity='0.85' filter='url(#g)'>`;
    for (let i = -24; i <= 24; i++) body += `<line x1='${cx + i * 22}' y1='${hy}' x2='${cx + i * 240}' y2='${H}'/>`;
    for (let j = 1; j <= 14; j++) body += `<line x1='0' y1='${n(hy + (H - hy) * Math.pow(j / 14, 2.2))}' x2='${W}' y2='${n(hy + (H - hy) * Math.pow(j / 14, 2.2))}'/>`;
    body += `</g><rect y='${hy - 2}' width='${W}' height='3' fill='${k.a[1]}' filter='url(#g)'/>`;
  }
  for (let i = 0; i < (o.palms ?? 0); i++) {
    const left = i % 2 === 0;
    const x = left ? 60 + (i / 2) * 170 + r() * 60 : W - 60 - ((i - 1) / 2) * 170 - r() * 60;
    body += palm(x, H + 10, 420 + r() * 220, (left ? 1 : -1) * (40 + r() * 90), k.ink, r);
  }
  return stack(svg(body, defs), base(k, 180));
}

/** Megacity: three depths of towers with lit windows and neon signs; `rain` adds streaks. */
export function city(k: Kit, seed: number, rain = false) {
  const r = rng(seed);
  let defs = glowF("g", 4) + lg("far", [[k.a[1], 0.3], [k.ink, 0.6]]);
  let body = "";
  for (let x = -20; x < W; ) {
    const w = 60 + r() * 110;
    const h = 350 + r() * 480;
    body += `<rect x='${n(x)}' y='${n(H - h)}' width='${n(w)}' height='${n(h)}' fill='url(#far)'/>`;
    x += w + 4;
  }
  body += `<path d='M700,${H}V220h60V120h80v100h60V${H}Z' fill='${k.ink}' opacity='0.8'/><rect x='796' y='40' width='8' height='80' fill='${k.a[0]}' filter='url(#g)'/>`;
  body += skyline(r, H + 2, k, 620, true, 0.88);
  for (let i = 0; i < 12; i++)
    body += `<rect x='${n(r() * W)}' y='${n(380 + r() * 420)}' width='${n(5 + r() * 5)}' height='${n(50 + r() * 110)}' fill='${k.a[i % 2]}' filter='url(#g)' opacity='0.9'/>`;
  if (rain)
    for (let i = 0; i < 280; i++) {
      const [x, y, len] = [r() * (W + 200), r() * H, 20 + r() * 50];
      body += `<line x1='${n(x)}' y1='${n(y)}' x2='${n(x - len * 0.25)}' y2='${n(y + len)}' stroke='${k.line}' stroke-opacity='${n(0.1 + r() * 0.28)}'/>`;
    }
  return stack(svg(body, defs), blob(k.a[0], 30, 100, 70, 45, 0.35), blob(k.a[1], 85, 20, 50, 45, 0.3), base(k, 180));
}

/** Circuit board traces with glowing pads. */
export function circuit(k: Kit, seed: number) {
  const r = rng(seed);
  const G = 40;
  const defs = glowF("g", 3) + `<pattern id='p' width='${G}' height='${G}' patternUnits='userSpaceOnUse'><path d='M${G} 0H0V${G}' fill='none' stroke='${k.line}' stroke-opacity='0.06'/></pattern>`;
  let body = `<rect width='${W}' height='${H}' fill='url(#p)'/><g filter='url(#g)' fill='none' stroke-width='2.5' stroke-linejoin='round'>`;
  const dirs: Pt[] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1]];
  for (let i = 0; i < 40; i++) {
    let [x, y] = [Math.floor(r() * (W / G)) * G, Math.floor(r() * (H / G)) * G];
    const pts: Pt[] = [[x, y]];
    let d = dirs[Math.floor(r() * 4)];
    for (let s = 0; s < 4 + r() * 6; s++) {
      const len = (2 + Math.floor(r() * 5)) * G;
      [x, y] = [x + d[0] * len, y + d[1] * len];
      pts.push([x, y]);
      d = r() < 0.2 ? dirs[4 + Math.floor(r() * 2)] : d[0] ? [0, r() < 0.5 ? 1 : -1] : [r() < 0.5 ? 1 : -1, 0];
    }
    const c = k.a[i % 2];
    body += `<path d='${path(pts, false)}' stroke='${c}' stroke-opacity='${n(0.35 + r() * 0.45)}'/><circle cx='${pts[0][0]}' cy='${pts[0][1]}' r='5' stroke='${c}' fill='${k.bg[0]}'/><circle cx='${n(x)}' cy='${n(y)}' r='4' fill='${c}'/>`;
  }
  return stack(svg(body + "</g>", defs), blob(k.a[0], 75, 30, 55, 50, 0.22), blob(k.a[1], 15, 85, 50, 45, 0.18), base(k));
}

/** Falling columns of segment glyphs. */
export function digitalRain(k: Kit, seed: number) {
  const r = rng(seed);
  const SEG = ["M0,0h10", "M0,7h10", "M0,14h10", "M0,0v14", "M10,0v14", "M5,0v14", "M0,0l10,14", "M10,0l-10,14"];
  const glyph = (x: number, y: number) => {
    let d = "";
    for (let i = 0; i < 2 + r() * 2; i++) d += SEG[Math.floor(r() * SEG.length)].replace(/^M(\d+),(\d+)/, (_, a, b) => `M${x + +a},${y + +b}`);
    return d;
  };
  let body = `<g fill='none' stroke-width='2' stroke-linecap='round' filter='url(#g)'>`;
  for (let x = 6; x < W; x += 28) {
    const len = 6 + Math.floor(r() * 22);
    const y0 = Math.floor(r() * H * 1.2) - 300;
    const op = 0.25 + r() * 0.5;
    for (let part = 0; part < 3; part++) {
      let d = "";
      for (let i = Math.floor((len * part) / 3); i < Math.floor((len * (part + 1)) / 3); i++) d += glyph(x, y0 + i * 22);
      body += `<path d='${d}' stroke='${k.a[0]}' stroke-opacity='${n(op * (0.35 + part * 0.3))}'/>`;
    }
    body += `<path d='${glyph(x, y0 + len * 22)}' stroke='${k.line}' stroke-opacity='0.95'/>`;
  }
  return stack(svg(body + "</g>", glowF("g", 2.5)), blob(k.a[1], 50, 50, 80, 70, 0.14), base(k, 180));
}

/** Radar scope with sweep and blips, or (`scope`) an oscilloscope with two traces. */
export function radar(k: Kit, scope = false) {
  const defs = glowF("g", 4);
  let body = "";
  if (scope) {
    for (let x = 0; x <= W; x += 160) body += `<line x1='${x}' y1='0' x2='${x}' y2='${H}' stroke='${k.line}' stroke-opacity='${x === 800 ? 0.3 : 0.1}'/>`;
    for (let y = 0; y <= H; y += 125) body += `<line x1='0' y1='${y}' x2='${W}' y2='${y}' stroke='${k.line}' stroke-opacity='${y === 500 ? 0.3 : 0.1}'/>`;
    const sine: Pt[] = [];
    const square: Pt[] = [];
    for (let x = 0; x <= W; x += 4) {
      sine.push([x, 500 + Math.sin(x / 60) * 220 * Math.exp(-x / 2400)]);
      square.push([x, 720 + (Math.sin(x / 110) > 0 ? -70 : 70) + Math.sin(x / 9) * 4]);
    }
    body += `<path d='${path(sine, false)}' fill='none' stroke='${k.a[0]}' stroke-width='3' filter='url(#g)'/><path d='${path(square, false)}' fill='none' stroke='${k.a[1]}' stroke-width='2' opacity='0.8' filter='url(#g)'/>`;
  } else {
    const [cx, cy] = [1080, 520];
    for (let rr = 70; rr <= 490; rr += 70) body += `<circle cx='${cx}' cy='${cy}' r='${rr}' fill='none' stroke='${k.line}' stroke-opacity='0.22'/>`;
    body += `<path d='M${cx - 520},${cy}H${cx + 520}M${cx},${cy - 520}V${cy + 520}' stroke='${k.line}' stroke-opacity='0.2'/>`;
    for (let a = 0; a < 360; a += 10) {
      const t = (a * Math.PI) / 180;
      body += `<line x1='${n(cx + Math.cos(t) * 490)}' y1='${n(cy + Math.sin(t) * 490)}' x2='${n(cx + Math.cos(t) * 505)}' y2='${n(cy + Math.sin(t) * 505)}' stroke='${k.line}' stroke-opacity='0.4'/>`;
    }
    for (let i = 0; i < 10; i++) {
      const [t0, t1] = [(-70 + i * 6) * (Math.PI / 180), (-64 + i * 6) * (Math.PI / 180)];
      body += `<path d='M${cx},${cy}L${n(cx + Math.cos(t0) * 490)},${n(cy + Math.sin(t0) * 490)}A490,490 0 0 1 ${n(cx + Math.cos(t1) * 490)},${n(cy + Math.sin(t1) * 490)}Z' fill='${k.a[0]}' opacity='${n(0.02 + i * 0.03)}'/>`;
    }
    body += `<line x1='${cx}' y1='${cy}' x2='${n(cx + Math.cos(-0.07) * 490)}' y2='${n(cy + Math.sin(-0.07) * 490)}' stroke='${k.a[0]}' stroke-width='3' filter='url(#g)'/>`;
    for (const [bx, by] of [[1260, 420], [930, 700], [1350, 650], [880, 330], [1150, 220]]) body += `<circle cx='${bx}' cy='${by}' r='6' fill='${k.a[1]}' filter='url(#g)'/>`;
  }
  return stack(svg(body, defs), blob(k.a[0], 65, 50, 70, 70, 0.12), base(k, 180));
}

/** Technical drawing on a grid: flange with bolt circle, plate, nut and dimension lines. */
export function blueprint(k: Kit) {
  const defs =
    `<pattern id='m' width='25' height='25' patternUnits='userSpaceOnUse'><path d='M25 0H0V25' fill='none' stroke='${k.line}' stroke-opacity='0.07'/></pattern>` +
    `<pattern id='M' width='125' height='125' patternUnits='userSpaceOnUse'><path d='M125 0H0V125' fill='none' stroke='${k.line}' stroke-opacity='0.16'/></pattern>`;
  let g = `<circle cx='1050' cy='480' r='260'/><circle cx='1050' cy='480' r='180'/><circle cx='1050' cy='480' r='70'/><path d='M760,480H1340M1050,190V770' stroke-dasharray='18 6 4 6'/>`;
  for (let i = 0; i < 12; i++) {
    const t = (i * Math.PI) / 6;
    g += `<circle cx='${n(1050 + Math.cos(t) * 220)}' cy='${n(480 + Math.sin(t) * 220)}' r='12'/>`;
  }
  g += `<path d='M260,300H620L680,360V700H260Z'/><circle cx='360' cy='400' r='26'/><circle cx='580' cy='600' r='26'/>`;
  g += `<path d='${path([0, 1, 2, 3, 4, 5].map((i) => [470 + Math.cos((i * Math.PI) / 3) * 60, 520 + Math.sin((i * Math.PI) / 3) * 60] as Pt))}'/><circle cx='470' cy='520' r='32'/>`;
  g += `<path d='M260,760V800M680,760V800M260,785H680M260,785l14,-6v12zM680,785l-14,-6v12z'/><path d='M790,770V840M1310,770V840M790,825H1310'/><path d='M1340,480L1440,380H1520'/>`;
  g += `<rect x='1180' y='860' width='380' height='110'/><path d='M1180,900H1560M1370,860V970'/>`;
  return stack(svg(`<rect width='${W}' height='${H}' fill='url(#m)'/><rect width='${W}' height='${H}' fill='url(#M)'/><g fill='none' stroke='${k.a[0]}' stroke-opacity='0.6' stroke-width='1.6'>${g}</g>`, defs), blob(k.a[1], 60, 45, 70, 60, 0.12), base(k));
}

/** Topographic contour lines around a few peaks. */
export function contour(k: Kit, seed: number) {
  const r = rng(seed);
  let body = "";
  for (let p = 0; p < 3; p++) {
    const [cx, cy] = [200 + r() * 1200, 150 + r() * 700];
    const [p1, p2, p3] = [r() * 6, r() * 6, r() * 6];
    for (let i = 0; i < 15; i++) {
      const rad = 28 + i * 36;
      const pts: Pt[] = [];
      for (let s = 0; s < 96; s++) {
        const t = (s / 96) * Math.PI * 2;
        const rr = rad * (1 + 0.15 * Math.sin(3 * t + p1 + i * 0.09) + 0.07 * Math.sin(5 * t + p2 - i * 0.05) + 0.03 * Math.sin(9 * t + p3));
        pts.push([cx + Math.cos(t) * rr * 1.25, cy + Math.sin(t) * rr]);
      }
      const major = i % 5 === 4;
      body += `<path d='${path(pts)}' fill='none' stroke='${major ? k.a[0] : k.line}' stroke-opacity='${major ? 0.7 : 0.28}' stroke-width='${major ? 2 : 1.2}'/>`;
    }
  }
  return stack(svg(body), blob(k.a[0], 80, 20, 55, 50, 0.22), blob(k.a[1], 10, 90, 55, 50, 0.2), base(k));
}

/** Glass façade in steep perspective with light beams. */
export function glassFacade(k: Kit, seed: number) {
  const r = rng(seed);
  const [vx, vy] = [800 + (r() - 0.5) * 600, -900];
  const top = (x: number, y: number) => vx + (x - vx) * ((y - vy) / (H - vy));
  const levels = [0, 120, 260, 420, 600, 800, 1000];
  let defs = lg("beam", [[k.line, 0.28], [k.line, 0]], false);
  let body = "";
  for (let x = -400; x < 2000; x += 160)
    for (let j = 0; j < levels.length - 1; j++) {
      const [y0, y1] = [levels[j], levels[j + 1]];
      const quad: Pt[] = [[top(x, y0), y0], [top(x + 160, y0), y0], [top(x + 160, y1), y1], [top(x, y1), y1]];
      body += `<path d='${path(quad)}' fill='${k.a[Math.floor(r() * 4)]}' fill-opacity='${n(0.04 + r() * 0.24)}' stroke='${k.line}' stroke-opacity='0.3' stroke-width='3'/>`;
    }
  defs += lg("sheen", [[k.a[0], 0.4], [k.a[0], 0]]);
  body += `<path d='M200,0H520L1100,1000H700Z' fill='url(#beam)'/><path d='M900,0H1020L1500,1000H1320Z' fill='url(#beam)'/><rect width='${W}' height='${H}' fill='url(#sheen)' opacity='0.5'/>`;
  return stack(svg(body, defs), base(k));
}

/** Retro tape cassette over stripes. */
export function cassette(k: Kit) {
  const defs = glowF("g", 5) + lg("lab", [[k.a[0], 0.9], [k.a[1], 0.9]], false);
  let body = "";
  for (let i = 0; i < 4; i++) body += `<rect x='0' y='${700 + i * 34}' width='${W}' height='22' fill='${k.a[i]}' opacity='0.5'/>`;
  body += `<g filter='url(#g)'><rect x='380' y='230' width='840' height='540' rx='36' fill='${k.bg[0]}' fill-opacity='0.55' stroke='${k.a[0]}' stroke-width='5'/>`;
  body += `<rect x='440' y='290' width='720' height='300' rx='18' fill='url(#lab)' opacity='0.35'/><rect x='560' y='380' width='480' height='140' rx='70' fill='${k.bg[1]}' stroke='${k.a[1]}' stroke-width='4'/>`;
  for (const cx of [640, 960]) {
    body += `<circle cx='${cx}' cy='450' r='56' fill='none' stroke='${k.a[1]}' stroke-width='4'/><circle cx='${cx}' cy='450' r='20' fill='${k.a[1]}' opacity='0.6'/>`;
    for (let s = 0; s < 6; s++) {
      const t = (s * Math.PI) / 3;
      body += `<line x1='${n(cx + Math.cos(t) * 22)}' y1='${n(450 + Math.sin(t) * 22)}' x2='${n(cx + Math.cos(t) * 50)}' y2='${n(450 + Math.sin(t) * 50)}' stroke='${k.a[1]}' stroke-width='3'/>`;
    }
  }
  body += `<path d='M560,770L620,660H980L1040,770' fill='none' stroke='${k.a[0]}' stroke-width='4'/>`;
  for (const [sx, sy] of [[420, 270], [1180, 270], [420, 730], [1180, 730]]) body += `<circle cx='${sx}' cy='${sy}' r='8' fill='none' stroke='${k.a[2]}' stroke-width='3'/>`;
  return stack(svg(body + "</g>", defs), blob(k.a[0], 50, 45, 60, 55, 0.3), `repeating-linear-gradient(135deg, ${al(k.a[3], 0.06)} 0 2px, transparent 2px 28px)`, base(k, 180));
}
