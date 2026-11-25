"""Branding info + generated wallpaper self-check. Run: python -m tests.test_branding"""
import re
import tempfile
import xml.dom.minidom
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

from app import branding, system
from app.config import settings
from providers.registry import get_provider

i = branding.info()
assert {"hostname", "display_host", "platform_label", "brand_mode"} <= i.keys(), i
assert i["brand_mode"] == ("solaros" if get_provider().get_capabilities().driver == "native_ubuntu" else "solardeck")

# The palette table covers exactly the built-in themes.
ts = Path(__file__).parents[2].joinpath("frontend/src/theme/builtInThemes.ts").read_text()
assert set(branding.BUILT_IN_PALETTES) == set(re.findall(r'^\s+id: "([a-z0-9-]+)"', ts, re.M)), "palette table out of date"

brand = ("solaros", "SolarOS", "SolarOS [host<&>1]")
for theme_id in branding.BUILT_IN_PALETTES:
    for idx in range(4):
        for mode in ("dark", "light"):
            req = branding.WallpaperRequest(theme_id=theme_id, wallpaper_index=idx, color_mode=mode, blur=6, position="bottom-right")
            svg = branding.render(req, branding._palette(theme_id, mode), brand)
            xml.dom.minidom.parseString(svg)  # well-formed, host name escaped
assert "SOLAROS [HOST&lt;&amp;&gt;1]" in svg
assert "SOLAROS [" not in branding.render(branding.WallpaperRequest(theme_id="nordic-slate", show_overlay="brand_only"), branding._palette("nordic-slate", "dark"), brand)
assert "<text" not in branding.render(branding.WallpaperRequest(theme_id="nordic-slate", show_overlay="none"), branding._palette("nordic-slate", "dark"), brand)
assert branding.brand_text({"brand_mode": "solardeck", "display_host": "node-1"}) == ("solardeck", "SolarDeck", "SolarDeck on node-1")

for bad in ({"theme_id": "../x"}, {"theme_id": "nordic-slate", "wallpaper_index": 4}, {"theme_id": "nordic-slate", "opacity": 2},
            {"theme_id": "nordic-slate", "show_overlay": "all"}):
    try:
        branding.WallpaperRequest.model_validate(bad)
        raise AssertionError(bad)
    except ValidationError:
        pass

with tempfile.TemporaryDirectory() as d:
    settings.themes_dir = Path(d)
    try:
        branding._palette("no-such-theme", "dark")
        raise AssertionError("expected 404")
    except HTTPException as e:
        assert e.status_code == 404
    r = branding.generate_wallpaper(branding.WallpaperRequest(theme_id="synthwave-84", wallpaper_index=2))
    assert r.media_type == "image/svg+xml" and b"<svg" in r.body and "sandbox" in r.headers["content-security-policy"]

p = system.ThemePrefs()
assert (p.brandOverlay, p.brandPosition, p.brandOpacityPct, p.brandSizePct) == ("none", "bottom-right", 85, 100)
try:
    system.ThemePrefs(brandSizePct=300)
    raise AssertionError("brandSizePct 300 accepted")
except ValidationError:
    pass
print("branding OK")
