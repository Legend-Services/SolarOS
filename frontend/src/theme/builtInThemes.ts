import type { Theme, Wallpaper } from "./themeTypes";
import { aurora, blueprint, bloom, cassette, circuit, city, contour, digitalRain, facets, glassFacade, mesh, nebula, radar, ribbons, ridges, sunset, waves, type Kit } from "./wallpaperArt";

/* The 11 built-in themes: Dark and Light palettes plus 4 procedural wallpapers each (44 in all). */

const wp = (name: string, draw: (k: Kit) => string, dark: Kit, light: Kit): Wallpaper => ({ name, dark: draw(dark), light: draw(light) });
const kit = (mode: Kit["mode"], bg: Kit["bg"], a: Kit["a"], ink: string, line: string): Kit => ({ mode, bg, a, ink, line });
/** Same kit with the accents in another order, for variety inside one theme. */
const spin = (k: Kit, by = 1): Kit => ({ ...k, a: [...k.a.slice(by), ...k.a.slice(0, by)] as Kit["a"] });

const SANS = { font: "sans" } as const;

function solardeckGlass(): Theme {
  const D = kit("dark", ["#0b1020", "#070b16"], ["#38bdf8", "#a855f7", "#10b981", "#6366f1"], "#05070e", "#e2e8f0");
  const L = kit("light", ["#f5f8fd", "#e4eaf6"], ["#38bdf8", "#a855f7", "#34d399", "#818cf8"], "#9aa8c4", "#334155");
  const ember = (k: Kit): Kit => ({ ...k, bg: k.mode === "dark" ? ["#1a0c14", "#0b0710"] : ["#fff6f1", "#fbe6e6"], a: ["#ea580c", "#be185d", "#facc15", "#f472b6"] });
  const current = (k: Kit): Kit => ({ ...k, bg: k.mode === "dark" ? ["#06142a", "#030a16"] : ["#f1f8fd", "#dfeefa"], a: ["#2563eb", "#06b6d4", "#2dd4bf", "#38bdf8"] });
  return {
    id: "solardeck-glass",
    name: "SolarDeck Liquid Glass",
    author: "SolarDeck",
    description: "Deep cosmic indigo glass by night, crisp alabaster glass by day, with electric blue and violet accents.",
    dark: { bg: "#070b16", surface: "#0f172a", opacity: 0.7, blur: 40, accent: "#38bdf8", accent2: "#a855f7", text: "#e2e8f0" },
    light: { bg: "#eef2f8", surface: "#ffffff", opacity: 0.66, blur: 40, accent: "#2563eb", accent2: "#7c3aed", text: "#0f172a" },
    style: { radiusWindow: 16, radiusCard: 12, radiusButton: 8, windowChrome: "standard", ...SANS },
    wallpapers: [
      wp("Aurora", (k) => mesh(k), D, L),
      wp("Nebula", (k) => nebula(k, 11), spin(D, 3), spin(L, 3)),
      wp("Deep Current", (k) => mesh(k, [[80, 90, 60, 55, 0, 0.3], [10, 20, 55, 50, 1, 0.32], [50, 40, 35, 30, 2, 0.14]], 170), current(D), current(L)),
      wp("Ember Veil", (k) => mesh(k, [[15, 85, 55, 50, 0, 0.32], [85, 15, 50, 48, 1, 0.3], [55, 50, 40, 35, 2, 0.12]]), ember(D), ember(L)),
    ],
  };
}

function cupertinoFrost(): Theme {
  const D = kit("dark", ["#1b1f3a", "#0d0f1a"], ["#5e8bff", "#c07af2", "#ff9f6b", "#59c7f0"], "#0a0c16", "#f5f5f7");
  const L = kit("light", ["#e8eefb", "#fbf6f2"], ["#7aa2ff", "#d6a2f5", "#ffc59e", "#9adcf5"], "#7d8db3", "#4b5068");
  return {
    id: "cupertino-frost",
    name: "Cupertino Frost",
    author: "SolarDeck",
    description: "Ultra-clean frosted acrylic with soft vibrancy and circular traffic-dot window controls.",
    dark: { bg: "#111318", surface: "#1d1f27", opacity: 0.62, blur: 48, accent: "#3b8cff", accent2: "#b866f0", text: "#f5f5f7" },
    light: { bg: "#f2f2f6", surface: "#ffffff", opacity: 0.6, blur: 48, accent: "#0a6cf0", accent2: "#9d48d0", text: "#1c1c22" },
    style: { radiusWindow: 14, radiusCard: 12, radiusButton: 8, windowChrome: "traffic-dots", ...SANS },
    wallpapers: [
      wp("Alpine Ridge", (k) => ridges(k, 21), D, L),
      wp("Glacier Waves", (k) => waves(k, 22), spin(D, 3), spin(L, 3)),
      wp("Summit Dawn", (k) => ridges(k, 23), spin(D, 2), spin(L, 2)),
      wp("Soft Swell", (k) => waves(k, 24, 4), spin(D, 1), spin(L, 1)),
    ],
  };
}

function redmondMica(): Theme {
  const D = kit("dark", ["#14223a", "#0b0f1a"], ["#4cc2ff", "#3a7bff", "#9a7cff", "#7fe0ff"], "#0a0f1c", "#e8f1ff");
  const L = kit("light", ["#e9f1fb", "#f7f9fc"], ["#5ab8ff", "#5a8cff", "#a993ff", "#8fdcff"], "#93a7c6", "#2b3a55");
  return {
    id: "redmond-mica",
    name: "Redmond Mica",
    author: "SolarDeck",
    description: "Layered mica-tinted surfaces with crisp 1px specular borders and azure-sky accents.",
    dark: { bg: "#1a1c23", surface: "#20242f", opacity: 0.84, blur: 30, accent: "#4cc2ff", accent2: "#9a7cff", text: "#f3f4f8" },
    light: { bg: "#eef1f6", surface: "#f9fbfd", opacity: 0.84, blur: 30, accent: "#0067c0", accent2: "#6b4fd8", text: "#1b1b1f" },
    style: { radiusWindow: 8, radiusCard: 8, radiusButton: 4, windowChrome: "standard", ...SANS },
    wallpapers: [
      wp("Folded Ribbon", (k) => ribbons(k, 31), D, L),
      wp("Azure Bloom", (k) => bloom(k, 32), D, L),
      wp("Sky Ribbon", (k) => ribbons(k, 33), spin(D, 2), spin(L, 2)),
      wp("Petal Light", (k) => bloom(k, 34, 10), spin(D, 2), spin(L, 2)),
    ],
  };
}

function aubergineYaru(): Theme {
  const D = kit("dark", ["#2a1027", "#140a14"], ["#ff7a45", "#c5487a", "#ffb347", "#7a2f6b"], "#12070f", "#fbe9e0");
  const L = kit("light", ["#f8f1ea", "#efe5df"], ["#ff8a5c", "#d1658f", "#ffc178", "#a65d92"], "#b99aa8", "#5a3346");
  return {
    id: "aubergine-yaru",
    name: "Aubergine Yaru",
    author: "SolarDeck",
    description: "Warm aubergine and volcanic slate by night, warm stone-white by day, with vibrant coral-orange accents.",
    dark: { bg: "#1d0f1a", surface: "#2c1a28", opacity: 0.8, blur: 28, accent: "#ff7a45", accent2: "#d4568a", text: "#f6eef2" },
    light: { bg: "#f6f2ee", surface: "#fffdfb", opacity: 0.82, blur: 24, accent: "#c4501c", accent2: "#8e2f5c", text: "#2b1a24" },
    style: { radiusWindow: 12, radiusCard: 10, radiusButton: 6, windowChrome: "standard", font: "geometric" },
    wallpapers: [
      wp("Origami", (k) => facets(k, 41), D, L),
      wp("Warm Nebula", (k) => nebula(k, 42), D, L),
      wp("Paper Folds", (k) => facets(k, 43, [200, 900]), spin(D, 1), spin(L, 1)),
      wp("Ember Mesh", (k) => mesh(k, [[20, 80, 60, 55, 0, 0.35], [80, 20, 55, 50, 1, 0.32], [60, 60, 35, 30, 2, 0.15]]), D, L),
    ],
  };
}

function nordicSlate(): Theme {
  const D = kit("dark", ["#232a3a", "#141924"], ["#88d8e8", "#7fd1a8", "#9fb6e0", "#b48ead"], "#0e121b", "#eceff4");
  const L = kit("light", ["#eef3f8", "#dfe7ef"], ["#7cc6d8", "#8ccfae", "#a6bde3", "#c3a4be"], "#8796ad", "#3b4252");
  return {
    id: "nordic-slate",
    name: "Nordic Slate",
    author: "SolarDeck",
    description: "Arctic polar-night blues or snow-drift frost, with glacier-cyan accents.",
    dark: { bg: "#1f2430", surface: "#2a3140", opacity: 0.76, blur: 32, accent: "#88d8e8", accent2: "#9fb6e0", text: "#eceff4" },
    light: { bg: "#eef2f6", surface: "#ffffff", opacity: 0.72, blur: 32, accent: "#2a7593", accent2: "#4f6fa8", text: "#2b3240" },
    style: { radiusWindow: 14, radiusCard: 10, radiusButton: 6, windowChrome: "standard", ...SANS },
    wallpapers: [
      wp("Fjord", (k) => ridges(k, 51, true), D, L),
      wp("Northern Lights", (k) => aurora(k, 52), spin(D, 1), spin(L, 1)),
      wp("Polar Night", (k) => aurora(k, 53, true), D, L),
      wp("Snow Drift", (k) => waves(k, 54, 5), spin(D, 2), spin(L, 2)),
    ],
  };
}

function viceHorizon(): Theme {
  const D = kit("dark", ["#1a0b3a", "#0d0620"], ["#ff4fa3", "#ff8a3d", "#ffd166", "#22d3c5"], "#0b0418", "#fff1f8");
  const L = kit("light", ["#ffe9f3", "#fff3e6"], ["#ff8fc4", "#ffb27a", "#ffe08a", "#5fe0d6"], "#c49ac8", "#6b3a66");
  return {
    id: "vice-horizon",
    name: "Vice Horizon",
    author: "SolarDeck",
    description: "Tropical neon sunset: palm-night violet with flamingo magenta, sunset orange and turquoise ocean, or pastel beach daylight.",
    dark: { bg: "#1a0b2e", surface: "#26123f", opacity: 0.68, blur: 30, accent: "#ff4fa3", accent2: "#22d3c5", text: "#fff1f8" },
    light: { bg: "#fff4ec", surface: "#ffffff", opacity: 0.64, blur: 28, accent: "#d02a74", accent2: "#0b8f88", text: "#3a1838" },
    style: { radiusWindow: 18, radiusCard: 14, radiusButton: 10, windowChrome: "standard", font: "geometric" },
    wallpapers: [
      wp("Ocean Sunset", (k) => sunset(k, 61, { ocean: true }), D, L),
      wp("Palm Night", (k) => sunset(k, 62, { ocean: true, palms: 4 }), D, L),
      wp("Neon Skyline", (k) => sunset(k, 63, { skyline: true, ocean: true }), D, L),
      wp("Tropic Coast", (k) => sunset(k, 64, { stripes: true, ocean: true, palms: 2 }), D, L),
    ],
  };
}

function nightcity2099(): Theme {
  const D = kit("dark", ["#0c1118", "#05070a"], ["#f3e600", "#00f0ff", "#ff2a6d", "#7b61ff"], "#06080c", "#9fe8ff");
  const L = kit("light", ["#eef1f4", "#d9dee5"], ["#e0c800", "#00b8cc", "#ff4f86", "#8c7bff"], "#9aa5b4", "#2d3a48");
  return {
    id: "nightcity-2099",
    name: "Nightcity 2099",
    author: "SolarDeck",
    description: "Cyberpunk megacity steel with acid-yellow and neon-cyan accents, chamfered HUD windows and a scanline grid; bright corporate chrome by day.",
    dark: { bg: "#07090d", surface: "#0e1218", opacity: 0.86, blur: 16, accent: "#f3e600", accent2: "#00f0ff", text: "#e8f4f2" },
    light: { bg: "#e9edf1", surface: "#f8fafc", opacity: 0.88, blur: 16, accent: "#8a7600", accent2: "#00788c", text: "#0b1014" },
    style: { radiusWindow: 2, radiusCard: 2, radiusButton: 0, windowChrome: "angular-hud", font: "geometric", scanlines: true },
    wallpapers: [
      wp("Megastructure", (k) => city(k, 71), D, L),
      wp("Neon Rain", (k) => city(k, 72, true), spin(D, 1), spin(L, 1)),
      wp("Circuit Grid", (k) => circuit(k, 73), D, L),
      wp("District Glow", (k) => city(k, 74), spin(D, 2), spin(L, 2)),
    ],
  };
}

function synthwave84(): Theme {
  const D = kit("dark", ["#12062e", "#2a0a4a"], ["#ff2bd6", "#ff7b3a", "#ffd23f", "#2de2ff"], "#0a0318", "#fbeaff");
  const L = kit("light", ["#fde8ff", "#e6f6ff"], ["#ff7be6", "#ffa477", "#ffe27a", "#6fe8ff"], "#b48fd0", "#5a2a7a");
  const grid = (k: Kit): Kit => ({ ...k, a: [k.a[0], k.a[3], k.a[2], k.a[1]] });
  return {
    id: "synthwave-84",
    name: "Synthwave '84",
    author: "SolarDeck",
    description: "Outrun arcade nights in deep ultraviolet with laser magenta and chrome cyan, or retro vapor-pastel daylight.",
    dark: { bg: "#120626", surface: "#1d0b3a", opacity: 0.72, blur: 24, accent: "#ff2bd6", accent2: "#2de2ff", text: "#fbeaff" },
    light: { bg: "#fdf0ff", surface: "#ffffff", opacity: 0.66, blur: 24, accent: "#b3128f", accent2: "#08799c", text: "#2a0f3d" },
    style: { radiusWindow: 10, radiusCard: 8, radiusButton: 6, windowChrome: "standard", font: "geometric" },
    wallpapers: [
      wp("Laser Grid", (k) => sunset(k, 81, { sun: false, grid: true }), grid(D), grid(L)),
      wp("Retro Sun", (k) => sunset(k, 82, { stripes: true, grid: true }), D, L),
      wp("Cassette", (k) => cassette(k), D, L),
      wp("Outrun Coast", (k) => sunset(k, 84, { stripes: true, grid: true, palms: 2 }), D, L),
    ],
  };
}

function phosphorTerminal(): Theme {
  const D = kit("dark", ["#03100a", "#000302"], ["#33ff88", "#1fae5c", "#a8ffc8", "#0e6b38"], "#000000", "#d4ffe2");
  const L = kit("light", ["#f4f0e2", "#e7e1cc"], ["#1f6b3a", "#3d7a52", "#6e8f5c", "#2c4a36"], "#8a8770", "#163020");
  return {
    id: "phosphor-terminal",
    name: "Phosphor Terminal",
    author: "SolarDeck",
    description: "Mainframe console: pitch-black obsidian with glowing emerald phosphor, or warm e-ink paper with deep forest ink. Monospace UI.",
    dark: { bg: "#020604", surface: "#04110a", opacity: 0.88, blur: 10, accent: "#33ff88", accent2: "#20c060", text: "#b8ffd0" },
    light: { bg: "#f3efe2", surface: "#fbf8ef", opacity: 0.92, blur: 8, accent: "#1f6b3a", accent2: "#3d7a52", text: "#16281c" },
    style: { radiusWindow: 4, radiusCard: 2, radiusButton: 2, windowChrome: "standard", font: "mono", scanlines: true },
    wallpapers: [
      wp("Digital Rain", (k) => digitalRain(k, 91), D, L),
      wp("Radar Sweep", (k) => radar(k), D, L),
      wp("Oscilloscope", (k) => radar(k, true), D, L),
      wp("Blueprint", (k) => blueprint(k), D, L),
    ],
  };
}

function solarizedAmber(): Theme {
  const D = kit("dark", ["#063845", "#00212b"], ["#e0a526", "#2aa198", "#cb4b16", "#268bd2"], "#001a22", "#eee8d5");
  const L = kit("light", ["#fdf6e3", "#f1e7c9"], ["#d39a1c", "#2aa198", "#d2683b", "#3a8fcf"], "#b8aa86", "#586e75");
  return {
    id: "solarized-amber",
    name: "Solarized Amber",
    author: "SolarDeck",
    description: "Low-glare precision studio: deep ocean teal or warm parchment cream, with warm amber-gold accents.",
    dark: { bg: "#002b36", surface: "#073642", opacity: 0.84, blur: 24, accent: "#e0a526", accent2: "#2aa198", text: "#eee8d5" },
    light: { bg: "#fdf6e3", surface: "#fffbef", opacity: 0.86, blur: 24, accent: "#9a6500", accent2: "#1a7d77", text: "#073642" },
    style: { radiusWindow: 12, radiusCard: 10, radiusButton: 6, windowChrome: "standard", ...SANS },
    wallpapers: [
      wp("Contour", (k) => contour(k, 101), D, L),
      wp("Glass Atrium", (k) => glassFacade(k, 102), D, L),
      wp("Terrain", (k) => contour(k, 103), spin(D, 1), spin(L, 1)),
      wp("Facade", (k) => glassFacade(k, 104), spin(D, 3), spin(L, 3)),
    ],
  };
}

function obsidianGold(): Theme {
  const D = kit("dark", ["#151413", "#050505"], ["#d8b46a", "#a58a52", "#f3dfa8", "#6b5a3a"], "#030303", "#f4e6c4");
  const L = kit("light", ["#fbf7ee", "#efe6d3"], ["#c49a4f", "#a3824a", "#e6cf98", "#8c7448"], "#c8b48a", "#5a4628");
  return {
    id: "obsidian-gold",
    name: "Obsidian Gold",
    author: "SolarDeck",
    description: "Luxury carbon-black glass with brushed champagne-gold borders, or warm ivory silk with bronze accents.",
    dark: { bg: "#0a0a0b", surface: "#141416", opacity: 0.82, blur: 36, accent: "#d8b46a", accent2: "#a58a52", text: "#f4efe4" },
    light: { bg: "#f8f4ea", surface: "#fffcf5", opacity: 0.8, blur: 32, accent: "#86621f", accent2: "#6e5428", text: "#2a2418" },
    style: { radiusWindow: 14, radiusCard: 10, radiusButton: 6, windowChrome: "standard", font: "geometric" },
    wallpapers: [
      wp("Gold Facet", (k) => facets(k, 111), D, L),
      wp("Silk Wave", (k) => waves(k, 112, 5), D, L),
      wp("Gilded Prism", (k) => facets(k, 113, [300, 200]), spin(D, 2), spin(L, 2)),
      wp("Champagne Ribbon", (k) => ribbons(k, 114), D, L),
    ],
  };
}

export const BUILT_IN_THEMES: Theme[] = [
  solardeckGlass(),
  cupertinoFrost(),
  redmondMica(),
  aubergineYaru(),
  nordicSlate(),
  viceHorizon(),
  nightcity2099(),
  synthwave84(),
  phosphorTerminal(),
  solarizedAmber(),
  obsidianGold(),
];

export const DEFAULT_THEME_ID = "solardeck-glass";
export const BUILT_IN_IDS = new Set(BUILT_IN_THEMES.map((t) => t.id));
/** Every built-in wallpaper, for the Theme Creator's wallpaper presets. */
export const WALLPAPER_LIBRARY = BUILT_IN_THEMES.flatMap((t) => t.wallpapers.map((w, i) => ({ key: `${t.id}:${i}`, theme: t.name, ...w })));
