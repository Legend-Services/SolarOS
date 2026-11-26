import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Moon, Palette, SlidersHorizontal, Sun } from "lucide-react";
import { useDismiss } from "../lib/hooks";
import { useAuth, useIntent } from "../lib/stores";
import { useTranslation } from "../i18n";
import { useBranding, useProduct } from "../store/capabilitiesStore";
import { allThemes, useActiveTheme, useTheme } from "../store/themeStore";
import { customBackground, type BrandOverlay, type BrandPosition, type ColorMode, type Theme } from "../theme/themeTypes";
import { al } from "../theme/wallpaperArt";
import { rasterizeWallpaper } from "../theme/wallpaperBitmap";
import { Segmented } from "./ui/GlassKit";

// Own fixed compositor layer under everything; strict containment keeps its paint isolated from the desktop above.
const STABLE_LAYER: CSSProperties = { position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", transform: "translate3d(0, 0, 0)", backfaceVisibility: "hidden", contain: "strict" };

/** Viewport size, updated 250 ms after the last resize (the bitmap is re-rendered for the new size). */
function useViewport() {
  const [size, setSize] = useState(() => [window.innerWidth, window.innerHeight]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSize([window.innerWidth, window.innerHeight]), 250);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return size;
}

/**
 * The active wallpaper (theme art or custom image, blur and dimming) as one cached bitmap object URL, rendered
 * off-screen only when a wallpaper setting or the viewport size changes. `null` = not ready yet, or not rasterizable
 * in this browser (the caller shows the live CSS layer). The previous bitmap stays visible until the next one is ready.
 */
function useWallpaperBitmap(background: string, blur: number, dim: number, base: string): string | null {
  const [width, height] = useViewport();
  const [url, setUrl] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    // Debounced, so dragging the blur / dim sliders renders once when they settle.
    const timer = setTimeout(() => {
      rasterizeWallpaper({ background, blur, dim, base }, width, height, window.devicePixelRatio || 1)
        .then((blob) => URL.createObjectURL(blob))
        .catch(() => null)
        .then((next) => {
          if (!live) return void (next && URL.revokeObjectURL(next));
          if (current.current) URL.revokeObjectURL(current.current);
          current.current = next;
          setUrl(next);
        });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [background, blur, dim, base, width, height]);
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  return url;
}

/**
 * The desktop background: the active theme's wallpaper (or the custom one) as a cached bitmap, plus scanlines and the
 * brand badge. Memoized with one selector per wallpaper field, so telemetry, clock and window updates never re-render it.
 */
export const DesktopWallpaperLayer = memo(function DesktopWallpaperLayer() {
  const colorMode = useTheme((s) => s.colorMode);
  const selectedWallpaperIndex = useTheme((s) => s.selectedWallpaperIndex);
  const customWallpaperUrl = useTheme((s) => s.customWallpaperUrl);
  const blur = useTheme((s) => s.wallpaperBlurPx);
  const dim = useTheme((s) => s.wallpaperDimPct);
  const theme = useActiveTheme(); // activeThemeId (+ the custom theme list it resolves against)
  const overlay = useTheme((s) => s.brandOverlay);
  const position = useTheme((s) => s.brandPosition);
  const opacity = useTheme((s) => s.brandOpacityPct);
  const size = useTheme((s) => s.brandSizePct);
  const unlocked = useAuth((s) => s.status === "unlocked"); // the lock screen keeps its own centered logo
  const background = customWallpaperUrl ? customBackground(customWallpaperUrl) : theme.wallpapers[selectedWallpaperIndex][colorMode];
  const bitmap = useWallpaperBitmap(background, blur, dim, theme[colorMode].bg);
  return (
    <div className="wallpaper overflow-hidden" style={STABLE_LAYER} aria-hidden>
      {bitmap ? (
        <img src={bitmap} alt="" draggable={false} decoding="async" className="absolute inset-0 h-full w-full object-cover select-none" />
      ) : (
        <>
          {/* Live CSS fallback until the first bitmap is ready. Bleeds past the edges so the blur never shows a soft border. */}
          <div className="absolute" style={{ inset: -blur * 2, background, filter: blur ? `blur(${blur}px)` : undefined }} />
          {dim > 0 && <div className="absolute inset-0 bg-black" style={{ opacity: dim / 100 }} />}
        </>
      )}
      {theme.style.scanlines && <div className="sd-scanlines absolute inset-0" />}
      {unlocked && <BrandBadge overlay={overlay} position={position} opacityPct={opacity} sizePct={size} />}
    </div>
  );
});

const BADGE_PLACE: Record<BrandPosition, string> = {
  center: "inset-0 items-center justify-center",
  // Bottom placements stay above the Dock / taskbar.
  "bottom-right": "right-[4%] bottom-[14%] justify-end",
  "bottom-center": "inset-x-0 bottom-[14%] justify-center",
};

/**
 * Glass brand watermark: glowing sun mark, product name and (personalized) the server name from /system/branding/info.
 * `scale` shrinks it for the Wallpaper Studio preview.
 */
export function BrandBadge({ overlay, position, opacityPct, sizePct, scale = 1 }: { overlay: BrandOverlay; position: BrandPosition; opacityPct: number; sizePct: number; scale?: number }) {
  const product = useProduct();
  const info = useBranding((s) => s.info);
  const { t } = useTranslation();
  if (overlay === "none") return null;
  const k = (sizePct / 100) * scale;
  const host = overlay === "full_personalized" && info?.display_host;
  const sub = host && (info.brand_mode === "solaros" ? `${product.short} [${host}]` : t("brand.runningOn", { host }));
  return (
    <div className={`pointer-events-none absolute flex ${BADGE_PLACE[position]}`} style={{ opacity: opacityPct / 100 }}>
      <div
        className="flex items-center border border-white/15 bg-gradient-to-br from-white/15 to-white/[0.04] shadow-[0_12px_40px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-md"
        style={{ gap: 14 * k, padding: `${12 * k}px ${22 * k}px ${12 * k}px ${14 * k}px`, borderRadius: 22 * k }}
      >
        <span className="relative shrink-0" style={{ width: 56 * k, height: 56 * k }}>
          <span className="absolute -inset-1/3 rounded-full" style={{ background: "radial-gradient(circle, rgba(255,154,38,0.55), transparent 65%)" }} />
          <img src={`/brand/${product.slug}-mark.svg`} alt="" className="relative h-full w-full" draggable={false} />
        </span>
        <span className="flex flex-col" style={{ color: "var(--sd-text-primary)", textShadow: "0 1px 8px rgba(0,0,0,0.35)" }}>
          <span className="font-semibold tracking-tight" style={{ fontSize: 30 * k, lineHeight: 1.1 }}>{product.short}</span>
          {sub && (
            <span className="font-medium uppercase" style={{ fontSize: Math.max(7, 11 * k), letterSpacing: "0.22em", marginTop: 3 * k, opacity: 0.8 }}>
              {sub}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** Miniature window on the theme's first wallpaper, drawn with the palette of one color mode. */
export function ThemePreview({ theme, mode, className = "" }: { theme: Theme; mode: ColorMode; className?: string }) {
  const p = theme[mode];
  return (
    <span className={`relative block overflow-hidden ${className}`} style={{ background: theme.wallpapers[0][mode] }} data-audit-ignore>
      <span
        className="absolute inset-x-[14%] top-[18%] bottom-[12%] flex flex-col overflow-hidden border"
        style={{ background: al(p.surface, Math.max(p.opacity, 0.78)), borderColor: al(p.text, 0.16), borderRadius: Math.min(theme.style.radiusWindow, 12) / 2 }}
      >
        <span className="flex items-center gap-[3px] px-1.5 py-1" style={{ borderBottom: `1px solid ${al(p.text, 0.12)}` }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.accent }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.accent2 }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: al(p.text, 0.35) }} />
        </span>
        <span className="flex flex-1 flex-col gap-1 p-1.5">
          <span className="h-1 w-3/4 rounded-full" style={{ background: al(p.text, 0.75) }} />
          <span className="h-1 w-1/2 rounded-full" style={{ background: al(p.text, 0.35) }} />
          <span className="mt-auto h-1.5 w-1/3 rounded-full" style={{ background: p.accent }} />
        </span>
      </span>
    </span>
  );
}

export function WallpaperThumb({ background, label, active, onClick, className = "h-12" }: { background: string; label: string; active: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Wallpaper: ${label}`}
      title={label}
      className={`relative block w-full overflow-hidden rounded-lg ring-2 transition active:scale-[0.97] ${active ? "ring-sky-400" : "ring-white/10 hover:ring-white/30"} ${className}`}
      style={{ background }}
    >
      {active && (
        <span className="absolute top-1 right-1 rounded-full bg-sky-500 p-0.5 text-white" style={{ "--color-white": "#fff" } as CSSProperties}>
          <Check size={10} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/** One-click Light / Dark switch; the sun and moon swap with a rotation. */
export function ModeToggle() {
  const light = useTheme((s) => s.colorMode === "light");
  const toggle = useTheme((s) => s.toggleMode);
  const label = light ? "Switch to Dark Mode" : "Switch to Light Mode";
  return (
    <button onClick={toggle} className="relative flex h-6 w-7 items-center justify-center rounded-md text-slate-200 hover:bg-white/10" aria-label={label} title={label}>
      <Sun size={14} className={`absolute transition-all duration-500 ${light ? "scale-100 rotate-0 opacity-100" : "scale-50 -rotate-90 opacity-0"}`} />
      <Moon size={14} className={`absolute transition-all duration-500 ${light ? "scale-50 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100"}`} />
    </button>
  );
}

/** Quick Theme Switcher: theme, color mode and wallpaper on the fly. `up` opens it above (taskbar). */
export function ThemeSwitcher({ up = false }: { up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const s = useTheme();
  const active = useActiveTheme();
  const go = useIntent((st) => st.go);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-slate-200 hover:bg-white/10 ${open ? "bg-white/10" : ""}`}
        aria-expanded={open}
        aria-label="Quick Theme Switcher"
        title="Theme, Light / Dark and wallpaper"
      >
        <Palette size={14} />
      </button>
      {open && (
        <div className={`glass absolute right-0 z-10 w-80 rounded-2xl p-3 text-xs ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"}`}>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-100">Theme</span>
            <Segmented
              value={s.colorMode}
              onChange={s.setMode}
              options={[
                { id: "dark", label: <span className="flex items-center gap-1"><Moon size={11} /> Dark</span> },
                { id: "light", label: <span className="flex items-center gap-1"><Sun size={11} /> Light</span> },
              ]}
            />
          </div>
          <div className="grid max-h-60 grid-cols-2 gap-1.5 overflow-auto pr-0.5">
            {allThemes(s.customThemes).map((t) => (
              <button
                key={t.id}
                onClick={() => s.setTheme(t.id)}
                aria-pressed={t.id === active.id}
                className={`flex items-center gap-2 rounded-lg p-1 text-left ring-1 transition ring-inset ${t.id === active.id ? "bg-sky-400/15 ring-sky-400/50" : "ring-transparent hover:bg-white/10"}`}
              >
                <ThemePreview theme={t} mode={s.colorMode} className="h-8 w-11 shrink-0 rounded-md" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200">{t.name}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 mb-1.5 font-semibold text-slate-100">Wallpaper</p>
          <div className="grid grid-cols-4 gap-1.5">
            {active.wallpapers.map((w, i) => (
              <WallpaperThumb key={i} background={w[s.colorMode]} label={w.name} active={!s.customWallpaperUrl && s.selectedWallpaperIndex === i} onClick={() => s.setWallpaper(i)} />
            ))}
          </div>
          <button
            onClick={() => (go("controlpanel", "appearance"), setOpen(false))}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-200 hover:bg-white/10"
          >
            <SlidersHorizontal size={13} /> Theme Studio…
          </button>
        </div>
      )}
    </div>
  );
}
