import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "../lib/api";
import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from "../theme/builtInThemes";
import { CUSTOM_WALLPAPER, THEME_ID, type ColorMode, type FontStyle, type Theme, type ThemePrefs, type WallpaperChoice } from "../theme/themeTypes";
import { al } from "../theme/wallpaperArt";

const FONTS: Record<FontStyle, string> = {
  sans: 'Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif',
  geometric: '"Poppins", "Montserrat", "Avenir Next", "Century Gothic", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace',
};

interface ThemeState extends ThemePrefs {
  /** The user's own themes (server copy; only the active one is kept in this browser for the lock screen). */
  customThemes: Theme[];
  setTheme: (id: string) => void;
  setMode: (m: ColorMode) => void;
  toggleMode: () => void;
  /** Pick a built-in wallpaper of the active theme (clears a custom one). */
  setWallpaper: (index: number) => void;
  /** Use an uploaded / https image or a gradient for the active theme; null goes back to the built-in pick. */
  setCustomWallpaper: (v: string | null) => void;
  set: (patch: Partial<Pick<ThemePrefs, "wallpaperBlurPx" | "wallpaperDimPct">>) => void;
  loadCustom: () => Promise<void>;
  saveTheme: (t: Theme, isNew: boolean) => Promise<void>;
  deleteTheme: (id: string) => Promise<void>;
}

const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
const choice = (c: unknown): WallpaperChoice => {
  const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  return { index: int(o.index, 0, 3, 0), custom: typeof o.custom === "string" && CUSTOM_WALLPAPER.test(o.custom) ? o.custom : null };
};

/** Validate saved theme preferences (localStorage or server JSON). */
export function sanitizePrefs(p: unknown): ThemePrefs {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const per = o.perThemeWallpapers && typeof o.perThemeWallpapers === "object" ? Object.entries(o.perThemeWallpapers) : [];
  return {
    activeThemeId: typeof o.activeThemeId === "string" && THEME_ID.test(o.activeThemeId) ? o.activeThemeId : DEFAULT_THEME_ID,
    colorMode: o.colorMode === "light" ? "light" : "dark",
    selectedWallpaperIndex: int(o.selectedWallpaperIndex, 0, 3, 0),
    customWallpaperUrl: choice({ custom: o.customWallpaperUrl }).custom,
    wallpaperBlurPx: int(o.wallpaperBlurPx, 0, 24, 0),
    wallpaperDimPct: int(o.wallpaperDimPct, 0, 60, 0),
    perThemeWallpapers: Object.fromEntries(per.filter(([k]) => THEME_ID.test(k)).slice(0, 200).map(([k, v]) => [k, choice(v)])),
  };
}

/** The fields saved to localStorage and /api/system/preferences ("theme"). */
export const themePrefs = (s: ThemePrefs): ThemePrefs => ({
  activeThemeId: s.activeThemeId,
  colorMode: s.colorMode,
  selectedWallpaperIndex: s.selectedWallpaperIndex,
  customWallpaperUrl: s.customWallpaperUrl,
  wallpaperBlurPx: s.wallpaperBlurPx,
  wallpaperDimPct: s.wallpaperDimPct,
  perThemeWallpapers: s.perThemeWallpapers,
});

const withChoice = (s: ThemeState, c: WallpaperChoice) => ({
  selectedWallpaperIndex: c.index,
  customWallpaperUrl: c.custom,
  perThemeWallpapers: { ...s.perThemeWallpapers, [s.activeThemeId]: c },
});

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      ...sanitizePrefs({}),
      customThemes: [],
      setTheme: (id) =>
        set((s) => {
          const c = s.perThemeWallpapers[id] ?? { index: 0, custom: null };
          return { activeThemeId: id, selectedWallpaperIndex: c.index, customWallpaperUrl: c.custom };
        }),
      setMode: (colorMode) => set({ colorMode }),
      toggleMode: () => set((s) => ({ colorMode: s.colorMode === "dark" ? "light" : "dark" })),
      setWallpaper: (index) => set((s) => withChoice(s, { index, custom: null })),
      setCustomWallpaper: (custom) => set((s) => withChoice(s, { index: s.selectedWallpaperIndex, custom })),
      set: (patch) => set(patch),
      loadCustom: async () => {
        const r = await api<{ themes: Theme[] }>("/system/themes");
        set({ customThemes: r.themes });
      },
      saveTheme: async (t, isNew) => {
        const saved = await api<Theme>(isNew ? "/system/themes" : `/system/themes/${t.id}`, { method: isNew ? "POST" : "PUT", json: t });
        set((s) => ({ customThemes: isNew ? [...s.customThemes, saved] : s.customThemes.map((x) => (x.id === t.id ? saved : x)) }));
      },
      deleteTheme: async (id) => {
        await api(`/system/themes/${id}`, { method: "DELETE" });
        set((s) => {
          const { [id]: _, ...per } = s.perThemeWallpapers;
          return { customThemes: s.customThemes.filter((t) => t.id !== id), perThemeWallpapers: per };
        });
        if (get().activeThemeId === id) get().setTheme(DEFAULT_THEME_ID);
      },
    }),
    {
      name: "solardeck-theme",
      partialize: (s) => ({ ...themePrefs(s), customThemes: s.customThemes.filter((t) => t.id === s.activeThemeId) }),
      merge: (saved, cur) => {
        const o = (saved ?? {}) as Partial<ThemeState>;
        return { ...cur, ...sanitizePrefs(o), customThemes: Array.isArray(o.customThemes) ? o.customThemes : [] };
      },
    },
  ),
);

export const allThemes = (custom: Theme[]) => [...BUILT_IN_THEMES, ...custom];
const findTheme = (id: string, custom: Theme[]) => allThemes(custom).find((t) => t.id === id) ?? BUILT_IN_THEMES[0];

/** The active theme (falls back to the default when a custom theme is gone). */
export function useActiveTheme(): Theme {
  const id = useTheme((s) => s.activeThemeId);
  const custom = useTheme((s) => s.customThemes);
  return findTheme(id, custom);
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const mixHex = (a: string, b: string, t: number) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, "0")).join("");
/** Black or white text, whichever contrasts more with `bg`. */
export const onColor = (bg: string) => {
  const l = luminance(bg);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#0b0d12" : "#ffffff";
};

/** CSS variables for one theme + mode. */
export function themeVars(t: Theme, mode: ColorMode): Record<string, string> {
  const p = t[mode];
  return {
    // Primary buttons are a translucent accent over glass in Dark Mode and solid accent in Light Mode.
    "--sd-on-accent": onColor(mode === "dark" ? mixHex(p.accent, p.surface, 0.55) : p.accent),
    "--sd-bg-base": p.bg,
    "--sd-surface-glass": al(p.surface, p.opacity),
    "--sd-surface-elevated": al(p.surface, Math.min(0.96, p.opacity + 0.15)),
    "--sd-glass-blur": `${p.blur}px`,
    "--sd-glass-opacity": String(p.opacity),
    "--sd-text-primary": p.text,
    "--sd-accent-primary": p.accent,
    "--sd-accent-secondary": p.accent2,
    "--sd-radius-window": `${t.style.radiusWindow}px`,
    "--sd-radius-card": `${t.style.radiusCard}px`,
    "--sd-radius-button": `${t.style.radiusButton}px`,
    "--sd-font-ui": FONTS[t.style.font],
    "--sd-font-mono": FONTS.mono,
  };
}

/** Write the active theme onto <html>: CSS variables, data-color-mode and data-window-chrome. */
function apply(s: ThemeState) {
  const t = findTheme(s.activeThemeId, s.customThemes);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(t, s.colorMode))) root.style.setProperty(k, v);
  root.dataset.colorMode = s.colorMode;
  root.dataset.windowChrome = t.style.windowChrome;
  root.style.colorScheme = s.colorMode; // native scrollbars, date pickers and form controls follow the mode
}
apply(useTheme.getState());
useTheme.subscribe(apply);
