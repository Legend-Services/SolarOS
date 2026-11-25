"""Server-name branding: GET /api/system/branding/info (host name, node, product) and
POST /api/system/themes/wallpapers/generate, a branded SVG wallpaper in a theme's colors (4 variants per theme)."""
import socket
from functools import lru_cache
from typing import Annotated, Literal
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from providers.registry import get_provider

from . import system, themes
from .auth import require_user

router = APIRouter(prefix="/api/system", tags=["branding"], dependencies=[Depends(require_user)])

# (bg, surface, accent, accent2, text) per mode; the same values as the palettes in frontend/src/theme/builtInThemes.ts.
BUILT_IN_PALETTES: dict[str, dict[str, tuple[str, str, str, str, str]]] = {
    "solardeck-glass": {"dark": ("#070b16", "#0f172a", "#38bdf8", "#a855f7", "#e2e8f0"), "light": ("#eef2f8", "#ffffff", "#2563eb", "#7c3aed", "#0f172a")},
    "cupertino-frost": {"dark": ("#111318", "#1d1f27", "#3b8cff", "#b866f0", "#f5f5f7"), "light": ("#f2f2f6", "#ffffff", "#0a6cf0", "#9d48d0", "#1c1c22")},
    "redmond-mica": {"dark": ("#1a1c23", "#20242f", "#4cc2ff", "#9a7cff", "#f3f4f8"), "light": ("#eef1f6", "#f9fbfd", "#0067c0", "#6b4fd8", "#1b1b1f")},
    "aubergine-yaru": {"dark": ("#1d0f1a", "#2c1a28", "#ff7a45", "#d4568a", "#f6eef2"), "light": ("#f6f2ee", "#fffdfb", "#c4501c", "#8e2f5c", "#2b1a24")},
    "nordic-slate": {"dark": ("#1f2430", "#2a3140", "#88d8e8", "#9fb6e0", "#eceff4"), "light": ("#eef2f6", "#ffffff", "#2a7593", "#4f6fa8", "#2b3240")},
    "vice-horizon": {"dark": ("#1a0b2e", "#26123f", "#ff4fa3", "#22d3c5", "#fff1f8"), "light": ("#fff4ec", "#ffffff", "#d02a74", "#0b8f88", "#3a1838")},
    "nightcity-2099": {"dark": ("#07090d", "#0e1218", "#f3e600", "#00f0ff", "#e8f4f2"), "light": ("#e9edf1", "#f8fafc", "#8a7600", "#00788c", "#0b1014")},
    "synthwave-84": {"dark": ("#120626", "#1d0b3a", "#ff2bd6", "#2de2ff", "#fbeaff"), "light": ("#fdf0ff", "#ffffff", "#b3128f", "#08799c", "#2a0f3d")},
    "phosphor-terminal": {"dark": ("#020604", "#04110a", "#33ff88", "#20c060", "#b8ffd0"), "light": ("#f3efe2", "#fbf8ef", "#1f6b3a", "#3d7a52", "#16281c")},
    "solarized-amber": {"dark": ("#002b36", "#073642", "#e0a526", "#2aa198", "#eee8d5"), "light": ("#fdf6e3", "#fffbef", "#9a6500", "#1a7d77", "#073642")},
    "obsidian-gold": {"dark": ("#0a0a0b", "#141416", "#d8b46a", "#a58a52", "#f4efe4"), "light": ("#f8f4ea", "#fffcf5", "#86621f", "#6e5428", "#2a2418")},
}
W, H = 1920, 1080


def info() -> dict:
    caps = get_provider().get_capabilities()
    hostname = socket.gethostname().split(".")[0]
    return {"hostname": hostname, "display_host": hostname, "platform_label": caps.platform_label,
            "brand_mode": "solaros" if caps.driver == "native_ubuntu" else "solardeck", **get_provider().branding_extra()}


@router.get("/branding/info")
def branding_info():
    return info()


class WallpaperRequest(BaseModel):
    model_config = ConfigDict(frozen=True)  # hashable: the request is the render cache key
    theme_id: system.ThemeId
    wallpaper_index: Annotated[int, Field(ge=0, le=3)] = 0
    color_mode: Literal["dark", "light"] = "dark"
    show_overlay: Literal["none", "brand_only", "full_personalized"] = "full_personalized"
    position: Literal["center", "bottom-right", "bottom-center"] = "center"
    opacity: Annotated[float, Field(ge=0.1, le=1)] = 0.9
    size: Annotated[float, Field(ge=0.5, le=2)] = 1
    blur: Annotated[int, Field(ge=0, le=24)] = 0


def _palette(theme_id: str, mode: str) -> tuple[str, ...]:
    if theme_id in BUILT_IN_PALETTES:
        return BUILT_IN_PALETTES[theme_id][mode]
    t = next((t for t in themes.load_themes() if t.get("id") == theme_id), None)
    if not t:
        raise HTTPException(404, "Theme not found")
    p = t[mode]
    return p["bg"], p["surface"], p["accent"], p["accent2"], p["text"]


def _art(i: int, a: str, b: str) -> str:
    """Background artwork of variant i in accent colors a and b."""
    if i == 0:  # minimal: one soft glow and a hairline horizon
        return (f'<circle cx="1340" cy="330" r="620" fill="url(#glowA)"/>'
                f'<line x1="0" y1="760" x2="{W}" y2="760" stroke="{a}" stroke-opacity=".25" stroke-width="1.5"/>')
    if i == 1:  # abstract: overlapping blurred orbs
        return (f'<g filter="url(#soft)"><circle cx="520" cy="360" r="420" fill="{a}" fill-opacity=".35"/>'
                f'<circle cx="1360" cy="700" r="460" fill="{b}" fill-opacity=".32"/>'
                f'<circle cx="1100" cy="240" r="240" fill="{a}" fill-opacity=".18"/></g>')
    if i == 2:  # cinematic grid: laser horizon with a perspective floor
        rays = "".join(f'<line x1="960" y1="640" x2="{x}" y2="{H}"/>' for x in range(-1920, 3841, 240))
        rows = "".join(f'<line x1="0" y1="{640 + d}" x2="{W}" y2="{640 + d}"/>' for d in (12, 30, 56, 94, 150, 230, 340, 440))
        return (f'<circle cx="960" cy="640" r="520" fill="url(#glowA)"/>'
                f'<rect y="636" width="{W}" height="8" fill="{a}" fill-opacity=".85" filter="url(#soft)"/>'
                f'<g stroke="{b}" stroke-opacity=".45" stroke-width="2">{rays}{rows}</g>')
    # ambient organic: flowing contour lines
    lines = "".join(
        f'<path d="M-40 {420 + k * 46} C 420 {300 + k * 52}, 900 {620 + k * 30}, 1400 {440 + k * 44} S 1980 {520 + k * 38}, 1980 {520 + k * 38}" '
        f'stroke="{a if k % 2 else b}" stroke-opacity="{0.12 + k * 0.04:.2f}"/>'
        for k in range(10))
    return f'<circle cx="420" cy="820" r="560" fill="url(#glowB)"/><g fill="none" stroke-width="2">{lines}</g>'


# The sundial sun mark (240×240), the same geometry as frontend/public/brand/*-mark.svg.
_RAYS = "".join(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>' for x1, y1, x2, y2 in (
    (180.81, 132.10, 196.50, 135.22), (171.55, 154.45, 184.85, 163.33), (154.45, 171.55, 163.33, 184.85), (132.10, 180.81, 135.22, 196.50),
    (107.90, 180.81, 104.78, 196.50), (85.55, 171.55, 76.67, 184.85), (68.45, 154.45, 55.15, 163.33), (59.19, 132.10, 43.50, 135.22),
    (59.19, 107.90, 43.50, 104.78), (68.45, 85.55, 55.15, 76.67), (85.55, 68.45, 76.67, 55.15), (107.90, 59.19, 104.78, 43.50),
    (132.10, 59.19, 135.22, 43.50), (154.45, 68.45, 163.33, 55.15), (171.55, 85.55, 184.85, 76.67), (180.81, 107.90, 196.50, 104.78)))
_CENTER = {
    "solaros": '<g stroke="#fff" stroke-width="8" stroke-linecap="round" fill="none"><path d="M134.05,104.39 A21,21 0 1 1 105.95,104.39"/><line x1="120" y1="92" x2="120" y2="119"/></g>',
    "solardeck": '<g fill="#fff">' + "".join(f'<rect x="{x}" y="{y}" width="17" height="17" rx="4.5"/>' for x in (100.5, 122.5) for y in (100.5, 122.5)) + "</g>",
}


def _logo(mode: str) -> str:
    return ('<path d="M38.80,188.14 A106,106 0 0 1 143.99,16.75" fill="none" stroke="url(#lgOrange)" stroke-width="12" stroke-linecap="round"/>'
            '<path d="M173.21,23.54 L145.89,-0.26 L138.20,32.86 Z" fill="#FF8A1F"/>'
            '<path d="M203.53,54.74 A106,106 0 0 1 99.63,224.02" fill="none" stroke="url(#lgWhite)" stroke-width="12" stroke-linecap="round"/>'
            '<path d="M70.19,218.26 L98.32,241.09 L104.86,207.73 Z" fill="#E9EEF6"/>'
            f'<g stroke="#FF9A26" stroke-width="7.5" stroke-linecap="round">{_RAYS}</g>'
            '<circle cx="120" cy="120" r="50" fill="url(#lgSun)"/>' + _CENTER[mode])


@lru_cache(maxsize=256)
def render(req: WallpaperRequest, palette: tuple[str, ...], brand: tuple[str, str, str] | None = None) -> str:
    """The SVG; `brand` is (logo mode, title, personalized sub-label) from brand_text()."""
    bg, surface, a, b, text = palette
    light = req.color_mode == "light"
    art = _art(req.wallpaper_index, a, b)
    blur = f' filter="url(#bgBlur)"' if req.blur else ""
    badge = ""
    if req.show_overlay != "none" and brand:
        mode, title, sub = brand
        sub = sub if req.show_overlay == "full_personalized" else ""
        tw = max(len(title) * 26, len(sub) * 12.5)  # shortcut: width estimated per character, no font metrics
        bw, bh = 170 + tw, 150
        cx, cy = {"center": (W / 2, H / 2), "bottom-right": (W - 60 - bw * req.size / 2, H - 60 - bh * req.size / 2),
                  "bottom-center": (W / 2, H - 60 - bh * req.size / 2)}[req.position]
        ty = 88 if sub else 98
        badge = (f'<g transform="translate({cx:.1f} {cy:.1f}) scale({req.size}) translate({-bw / 2:.1f} {-bh / 2})" opacity="{req.opacity}" filter="url(#shadow)">'
                 f'<rect width="{bw:.1f}" height="{bh}" rx="28" fill="{surface}" fill-opacity="{0.55 if light else 0.38}" stroke="{text}" stroke-opacity=".18"/>'
                 f'<circle cx="80" cy="75" r="52" fill="url(#halo)"/>'
                 f'<g transform="translate(35 30) scale(.375)">{_logo(mode)}</g>'
                 f'<text x="150" y="{ty}" fill="{text}" font-size="46" font-weight="600" font-family="Inter, Poppins, system-ui, sans-serif">{escape(title)}</text>'
                 + (f'<text x="152" y="120" fill="{text}" fill-opacity=".7" font-size="18" letter-spacing="4" font-family="Inter, system-ui, sans-serif">{escape(sub.upper())}</text>' if sub else "")
                 + "</g>")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice">'
            '<defs>'
            f'<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{surface if not light else bg}"/><stop offset="1" stop-color="{bg if not light else surface}"/></linearGradient>'
            f'<radialGradient id="glowA"><stop offset="0" stop-color="{a}" stop-opacity=".45"/><stop offset="1" stop-color="{a}" stop-opacity="0"/></radialGradient>'
            f'<radialGradient id="glowB"><stop offset="0" stop-color="{b}" stop-opacity=".4"/><stop offset="1" stop-color="{b}" stop-opacity="0"/></radialGradient>'
            '<radialGradient id="halo"><stop offset="0" stop-color="#FF9A26" stop-opacity=".55"/><stop offset="1" stop-color="#FF9A26" stop-opacity="0"/></radialGradient>'
            '<linearGradient id="lgOrange" x1="0" y1="1" x2="0.6" y2="0"><stop offset="0" stop-color="#FF6A00"/><stop offset="1" stop-color="#FFB23E"/></linearGradient>'
            '<linearGradient id="lgWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9D3E3"/></linearGradient>'
            '<radialGradient id="lgSun" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="#FFD45C"/><stop offset="0.55" stop-color="#FF9A26"/><stop offset="1" stop-color="#FF6A00"/></radialGradient>'
            '<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="60"/></filter>'
            f'<filter id="bgBlur" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="{req.blur}"/></filter>'
            f'<filter id="shadow" x="-20%" y="-30%" width="140%" height="160%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000" flood-opacity="{0.18 if light else 0.45}"/></filter>'
            '</defs>'
            f'<g{blur}><rect width="{W}" height="{H}" fill="url(#bg)"/>{art}</g>{badge}</svg>')


def brand_text(i: dict) -> tuple[str, str, str]:
    """(logo mode, title, personalized sub-label) for /branding/info data."""
    if i["brand_mode"] == "solaros":
        return "solaros", "SolarOS", f'SolarOS [{i["display_host"]}]'
    return "solardeck", "SolarDeck", f'SolarDeck on {i["display_host"]}'


@router.post("/themes/wallpapers/generate")
def generate_wallpaper(req: WallpaperRequest):
    svg = render(req, _palette(req.theme_id, req.color_mode), brand_text(info()))
    return Response(svg, media_type="image/svg+xml", headers={
        "Content-Disposition": f'inline; filename="{req.theme_id}-{req.wallpaper_index + 1}.svg"',
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
