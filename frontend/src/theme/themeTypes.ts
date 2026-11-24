/* Theme file format (also the .solardeck-theme.json export). The backend validates the same shape (backend/app/themes.py). */

export type ColorMode = "dark" | "light";
export type WindowChrome = "standard" | "traffic-dots" | "angular-hud";
export type FontStyle = "sans" | "geometric" | "mono";

/** One color mode of a theme. Hex colors; opacity 0.2–1, blur 0–48 px. */
export interface Palette {
  bg: string;
  surface: string;
  opacity: number;
  blur: number;
  accent: string;
  accent2: string;
  text: string;
}

export interface ThemeStyle {
  radiusWindow: number; // 0–28 px
  radiusCard: number; // 0–24 px
  radiusButton: number; // 0–16 px
  windowChrome: WindowChrome;
  font: FontStyle;
  /** Faint scanline overlay on the wallpaper. */
  scanlines?: boolean;
}

/** A wallpaper is a CSS `background` value per color mode (gradients, SVG data URIs or image URLs). */
export interface Wallpaper {
  name: string;
  dark: string;
  light: string;
}

export interface Theme {
  id: string;
  name: string;
  author: string;
  description: string;
  dark: Palette;
  light: Palette;
  style: ThemeStyle;
  wallpapers: [Wallpaper, Wallpaper, Wallpaper, Wallpaper];
}

/** Per-theme wallpaper choice: a built-in index, or a custom image / gradient that overrides it. */
export interface WallpaperChoice {
  index: number;
  custom: string | null;
}

/** Stored in /api/system/preferences under "theme". */
export interface ThemePrefs {
  activeThemeId: string;
  colorMode: ColorMode;
  selectedWallpaperIndex: number;
  customWallpaperUrl: string | null;
  wallpaperBlurPx: number;
  wallpaperDimPct: number;
  perThemeWallpapers: Record<string, WallpaperChoice>;
}

export const HEX = /^#[0-9a-fA-F]{6}$/;
export const THEME_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** Same rule as the backend's CustomWallpaper: an uploaded file, an https image, or a two-color gradient. */
export const CUSTOM_WALLPAPER = /^(\/api\/system\/themes\/wallpapers\/[0-9a-f]{32}\.(png|jpe?g|webp|svg)|https:\/\/[^\s"'()\\]+|linear-gradient\(\d{1,3}deg, ?#[0-9a-fA-F]{6}, ?#[0-9a-fA-F]{6}\))$/;
const CSS_URL = /url\(\s*['"]?([^'")\s]*)/gi;
/** Quoted data:image URIs; their own internal url(#id) references are not image sources. */
const DATA_URI = /url\(\s*"data:image\/[^"]*"\s*\)|url\(\s*'data:image\/[^']*'\s*\)/gi;
export const CSS_MAX = 120_000;
const SAFE_URL = ["data:image/", "/api/system/themes/wallpapers/", "https://"];

/** CSS background for a custom wallpaper value (URL or gradient). */
export const customBackground = (v: string) => (v.startsWith("linear-gradient(") ? v : `url("${v}") center / cover no-repeat`);

const isNum = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const isStr = (v: unknown, lo: number, hi: number) => typeof v === "string" && v.length >= lo && v.length <= hi;

function paletteError(p: unknown, mode: string): string | null {
  if (!p || typeof p !== "object") return `${mode} palette is missing`;
  const o = p as Record<string, unknown>;
  for (const k of ["bg", "surface", "accent", "accent2", "text"]) if (typeof o[k] !== "string" || !HEX.test(o[k] as string)) return `${mode}.${k} must be a #rrggbb color`;
  if (!isNum(o.opacity, 0.2, 1)) return `${mode}.opacity must be between 0.2 and 1`;
  if (!isNum(o.blur, 0, 48) || !Number.isInteger(o.blur)) return `${mode}.blur must be a whole number from 0 to 48`;
  return null;
}

function cssError(v: unknown, where: string): string | null {
  if (!isStr(v, 1, CSS_MAX)) return `${where} must be a CSS background of up to ${CSS_MAX / 1000} KB`;
  for (const [, url] of (v as string).replace(DATA_URI, "").matchAll(CSS_URL)) if (!SAFE_URL.some((s) => url.toLowerCase().startsWith(s))) return `${where} loads an image from a source that is not allowed`;
  if (/expression\s*\(|javascript:/i.test(v as string)) return `${where} contains script`;
  return null;
}

/** Validate a theme file (import, creator) with the backend's rules; returns the first problem or null. */
export function themeError(t: unknown): string | null {
  if (!t || typeof t !== "object") return "Not a theme file";
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string" || !THEME_ID.test(o.id)) return "id must be 2–63 lowercase letters, digits or dashes";
  if (!isStr(o.name, 1, 60)) return "name is required (up to 60 characters)";
  if (!isStr(o.author, 1, 60)) return "author is required (up to 60 characters)";
  if (!isStr(o.description, 0, 300)) return "description must be up to 300 characters";
  const err = paletteError(o.dark, "dark") ?? paletteError(o.light, "light");
  if (err) return err;
  const s = o.style as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return "style is missing";
  if (!isNum(s.radiusWindow, 0, 28) || !isNum(s.radiusCard, 0, 24) || !isNum(s.radiusButton, 0, 16)) return "style radii are out of range";
  if (!["standard", "traffic-dots", "angular-hud"].includes(s.windowChrome as string)) return "style.windowChrome is not valid";
  if (!["sans", "geometric", "mono"].includes(s.font as string)) return "style.font is not valid";
  if (!Array.isArray(o.wallpapers) || o.wallpapers.length !== 4) return "wallpapers must list exactly 4 wallpapers";
  for (const [i, w] of (o.wallpapers as Record<string, unknown>[]).entries()) {
    if (!w || !isStr(w.name, 1, 60)) return `wallpaper ${i + 1} needs a name`;
    const e = cssError(w.dark, `wallpaper ${i + 1} (dark)`) ?? cssError(w.light, `wallpaper ${i + 1} (light)`);
    if (e) return e;
  }
  return null;
}
