/* Desktop wallpaper rasterizer. Paints the active wallpaper (its CSS background stack or custom image, plus blur and
   dimming) once into an offscreen canvas and returns a PNG Blob, which the desktop shows as one static <img>. Without
   it the desktop keeps live SVG filters and gradients mounted, and the browser re-rasterizes them whenever compositor
   tiles are evicted during telemetry and window updates (visible as flashes on large displays).
   Canvas 2D paints the layers directly: an SVG foreignObject snapshot would be simpler, but Chrome always taints a
   canvas that drew one, so it could never be exported. Unsupported CSS throws; the caller then keeps the CSS layer. */

export interface WallpaperSpec {
  /** CSS `background` value: a theme wallpaper or customBackground(url). */
  background: string;
  blur: number;
  dim: number;
  /** Solid theme base color under everything. */
  base: string;
}

/** Bitmap budget: an 8K ultrawide at 2x would be ~66 MP; past this the image is scaled up by `object-fit`. */
const MAX_PIXELS = 16_000_000;

/** Splits on top-level commas (outside parentheses and quotes). */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

interface Stop {
  color: string;
  /** Explicit positions ("50%", "2px"); CSS allows two for a hard band. */
  at: { v: number; px: boolean }[];
}

export type Layer =
  | { kind: "image"; src: string }
  | { kind: "linear"; angle: number; stops: Stop[]; repeat: boolean }
  | { kind: "radial"; w: number; h: number; x: number; y: number; stops: Stop[] };

// Positions are % or px; a unitless one is only valid as 0.
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([^)]*\))((?:\s+(?:-?[\d.]+(?:%|px)|0))*)$/i;

function parseStop(s: string): Stop {
  const m = COLOR.exec(s.trim());
  if (!m) throw new Error(`unsupported gradient stop: ${s}`);
  const at = m[2].trim().split(/\s+/).filter(Boolean).map((p) => ({ v: parseFloat(p), px: !p.endsWith("%") }));
  return { color: m[1], at };
}

/** One CSS background layer → a paintable layer; throws on syntax the desktop does not use. */
export function parseLayer(s: string): Layer {
  const url = /^url\(\s*(["']?)([\s\S]*?)\1\s*\)\s+center\s*\/\s*cover(\s+no-repeat)?$/.exec(s);
  if (url) return { kind: "image", src: url[2] };
  const lin = /^(repeating-)?linear-gradient\(([\s\S]*)\)$/.exec(s);
  if (lin) {
    const args = splitTop(lin[2]);
    const deg = /^(-?[\d.]+)deg$/.exec(args[0]);
    if (!deg && /^to\s/.test(args[0])) throw new Error("unsupported gradient direction");
    return { kind: "linear", angle: deg ? parseFloat(deg[1]) : 180, stops: (deg ? args.slice(1) : args).map(parseStop), repeat: !!lin[1] };
  }
  const rad = /^radial-gradient\(([\s\S]*)\)$/.exec(s);
  if (rad) {
    const [shape, ...stops] = splitTop(rad[1]);
    const g = /^([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%$/.exec(shape);
    if (!g) throw new Error(`unsupported radial shape: ${shape}`);
    return { kind: "radial", w: +g[1] / 100, h: +g[2] / 100, x: +g[3] / 100, y: +g[4] / 100, stops: stops.map(parseStop) };
  }
  throw new Error(`unsupported background layer: ${s.slice(0, 60)}`);
}

/** Color stops as [offset 0..1 along a gradient line of `len` px, color]; CSS fix-up rules for missing positions. */
export function resolveStops(stops: Stop[], len: number): [number, string][] {
  const flat: { t: number | null; color: string }[] = [];
  for (const s of stops) {
    if (!s.at.length) flat.push({ t: null, color: s.color });
    for (const a of s.at) flat.push({ t: a.px ? a.v / len : a.v / 100, color: s.color });
  }
  if (flat[0].t === null) flat[0].t = 0;
  if (flat[flat.length - 1].t === null) flat[flat.length - 1].t = 1;
  let max = 0;
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i];
    if (s.t === null) {
      const j = flat.findIndex((x, k) => k > i && x.t !== null);
      const prev = flat[i - 1].t!;
      s.t = prev + (flat[j].t! - prev) / (j - i + 1);
    }
    max = s.t = Math.max(s.t, max);
  }
  // Canvas interpolates unpremultiplied: fading to `transparent` (transparent black) would darken the fade.
  return flat.map((s, i) => {
    if (s.color !== "transparent") return [s.t!, s.color];
    const near = flat[i - 1]?.color !== "transparent" ? flat[i - 1]?.color : flat[i + 1]?.color;
    return [s.t!, near && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(near) ? near.slice(0, 7) + "00" : "rgba(0,0,0,0)"];
  });
}

function addStops(g: CanvasGradient, stops: [number, string][], repeat: boolean) {
  if (!repeat) {
    for (const [t, c] of stops) g.addColorStop(Math.min(1, Math.max(0, t)), c);
    return;
  }
  const first = stops[0][0];
  const period = stops[stops.length - 1][0] - first;
  if (period <= 0) throw new Error("empty repeating gradient");
  for (let base = first; base < 1; base += period)
    for (const [t, c] of stops) {
      const at = base + t - first;
      if (at <= 1) g.addColorStop(Math.max(0, at), c);
    }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    if (/^https?:/.test(src)) img.crossOrigin = "anonymous"; // without CORS the canvas would be tainted
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("wallpaper image failed to load"));
    img.src = src;
  });
}

async function paintImage(ctx: CanvasRenderingContext2D, src: string, cw: number, ch: number, w: number, h: number) {
  const inline = /^data:image\/svg\+xml,([\s\S]*)$/.exec(src);
  if (inline) {
    // Scene SVGs have only a viewBox (+ xMidYMid slice): give them the bitmap size so they rasterize 1:1 and cover.
    const markup = decodeURIComponent(inline[1]).replace(/^<svg\s/, `<svg width='${w}' height='${h}' `);
    const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
    try {
      ctx.drawImage(await loadImage(url), 0, 0, cw, ch);
    } finally {
      URL.revokeObjectURL(url);
    }
    return;
  }
  const img = await loadImage(src);
  if (!img.naturalWidth || !img.naturalHeight) return ctx.drawImage(img, 0, 0, cw, ch); // viewBox-only SVG
  const s =Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const [dw, dh] = [img.naturalWidth * s, img.naturalHeight * s];
  ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

/** Paints `spec` at `width`×`height` CSS px (× dpr, capped by MAX_PIXELS) and encodes it as PNG. */
export async function rasterizeWallpaper(spec: WallpaperSpec, width: number, height: number, dpr: number): Promise<Blob> {
  const k = Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
  const [w, h] = [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
  const layers = splitTop(spec.background).map(parseLayer).reverse(); // CSS lists the top layer first
  const canvas = document.createElement("canvas");
  [canvas.width, canvas.height] = [w, h];
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas");
  ctx.scale(w / width, h / height); // paint in CSS px
  ctx.fillStyle = spec.base;
  ctx.fillRect(0, 0, width, height);
  for (const l of layers) {
    if (l.kind === "image") await paintImage(ctx, l.src, width, height, w, h);
    else if (l.kind === "linear") {
      const a = (l.angle * Math.PI) / 180;
      const [dx, dy] = [Math.sin(a), -Math.cos(a)];
      const len = Math.abs(width * dx) + Math.abs(height * dy);
      const g = ctx.createLinearGradient(width / 2 - (dx * len) / 2, height / 2 - (dy * len) / 2, width / 2 + (dx * len) / 2, height / 2 + (dy * len) / 2);
      addStops(g, resolveStops(l.stops, len), l.repeat);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    } else {
      const [rx, ry, cx, cy] = [l.w * width, l.h * height, l.x * width, l.y * height];
      if (!rx || !ry) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry); // unit circle → the CSS ellipse
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      addStops(g, resolveStops(l.stops, rx), false);
      ctx.fillStyle = g;
      ctx.fillRect(-cx / rx, -cy / ry, width / rx, height / ry);
      ctx.restore();
    }
  }
  let out = canvas;
  if (spec.blur > 0) {
    const blurred = document.createElement("canvas");
    [blurred.width, blurred.height] = [w, h];
    const b = blurred.getContext("2d");
    if (!b || !("filter" in b)) throw new Error("canvas blur unsupported");
    // Same as the CSS layer: scaled past the edges so the blur never shows a soft border.
    const bleed = spec.blur * 2 * (w / width);
    b.filter = `blur(${spec.blur * (w / width)}px)`;
    b.drawImage(canvas, -bleed, -bleed, w + 2 * bleed, h + 2 * bleed);
    out = blurred;
  }
  if (spec.dim > 0) {
    const d = out.getContext("2d")!;
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.filter = "none";
    d.fillStyle = `rgba(0, 0, 0, ${spec.dim / 100})`;
    d.fillRect(0, 0, w, h);
  }
  return new Promise((ok, fail) => out.toBlob((b) => (b ? ok(b) : fail(new Error("wallpaper encode failed"))), "image/png"));
}
