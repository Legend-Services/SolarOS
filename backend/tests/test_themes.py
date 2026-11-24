"""Theme Studio self-check. Run: python -m tests.test_themes"""
import io
import tempfile
from pathlib import Path

from fastapi import HTTPException, UploadFile
from pydantic import ValidationError

from app import system, themes
from app.config import settings


def expect(status: int, fn, *args):
    try:
        fn(*args)
    except HTTPException as e:
        assert e.status_code == status, (e.status_code, e.detail)
        return
    raise AssertionError(f"expected HTTP {status}")


palette = {"bg": "#0b1020", "surface": "#141a2e", "opacity": 0.7, "blur": 24, "accent": "#38bdf8", "accent2": "#a855f7", "text": "#f1f5f9"}
wp = {"name": "Mesh", "dark": "radial-gradient(60% 50% at 10% 10%, #38bdf8, transparent)", "light": "linear-gradient(#fff, #eee)"}
theme = {"id": "my-theme", "name": "Mine", "author": "Me", "description": "", "dark": palette, "light": {**palette, "bg": "#f8fafc"},
         "style": {"radiusWindow": 16, "radiusCard": 12, "radiusButton": 8, "windowChrome": "standard", "font": "sans"},
         "wallpapers": [wp] * 4, "format": "solardeck-theme"}

with tempfile.TemporaryDirectory() as d:
    settings.themes_dir = Path(d) / "themes"
    settings.preferences_file = Path(d) / "user_preferences.json"
    assert themes.list_themes() == {"themes": [], "preferences": system.ThemePrefs().model_dump()}

    t = themes.Theme.model_validate(theme)
    themes.create_theme(t)
    assert themes.load_themes()[0]["id"] == "my-theme" and "format" not in themes.load_themes()[0]
    expect(409, themes.create_theme, t)
    expect(409, themes.create_theme, themes.Theme.model_validate({**theme, "id": "solardeck-glass"}))
    themes.update_theme("my-theme", themes.Theme.model_validate({**theme, "name": "Renamed"}))
    assert themes.load_themes()[0]["name"] == "Renamed"
    expect(422, themes.update_theme, "other", t)
    expect(404, themes.update_theme, "missing", themes.Theme.model_validate({**theme, "id": "missing"}))
    themes.delete_theme("my-theme")
    expect(404, themes.delete_theme, "my-theme")

    for bad in ({"wallpapers": [wp] * 3}, {"id": "../x"}, {"dark": {**palette, "accent": "red"}},
                {"wallpapers": [{**wp, "dark": "url(http://tracker.example/x.png)"}] * 4},
                {"wallpapers": [{**wp, "dark": "url(javascript:alert(1))"}] * 4}, {"author": ""}):
        try:
            themes.Theme.model_validate({**theme, **bad})
            raise AssertionError(f"invalid theme accepted: {bad}")
        except ValidationError:
            pass
    # A data URI's own url(#filter) references are fine; an external image smuggled next to one is not.
    svg = "url(\"data:image/svg+xml,%3Csvg filter='url(%23b)'/%3E\") center/cover"
    themes.Theme.model_validate({**theme, "wallpapers": [{**wp, "dark": svg}] * 4})
    try:
        themes.Theme.model_validate({**theme, "wallpapers": [{**wp, "dark": svg + ", url(http://tracker.example/p.png)"}] * 4})
        raise AssertionError("external image next to a data URI accepted")
    except ValidationError:
        pass

    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    url = themes.upload_wallpaper(UploadFile(io.BytesIO(png), filename="Sky.PNG"))["url"]
    name = url.rsplit("/", 1)[1]
    assert url.startswith("/api/system/themes/wallpapers/") and name.endswith(".png")
    r = themes.get_wallpaper(name)
    assert r.media_type == "image/png" and "sandbox" in r.headers["content-security-policy"]
    expect(415, themes.upload_wallpaper, UploadFile(io.BytesIO(b"not an image"), filename="x.png"))
    expect(415, themes.upload_wallpaper, UploadFile(io.BytesIO(png), filename="x.gif"))
    expect(413, themes.upload_wallpaper, UploadFile(io.BytesIO(png + b"\0" * themes.WALLPAPER_MAX_BYTES), filename="x.png"))
    for evil in ("../custom_themes.json", "..%2Fx.png", name.upper(), "0" * 32 + ".png"):
        expect(404, themes.get_wallpaper, evil)

    prefs = {"theme": {"activeThemeId": "nordic-slate", "colorMode": "light", "customWallpaperUrl": url, "wallpaperBlurPx": 8,
                       "perThemeWallpapers": {"nordic-slate": {"index": 2, "custom": "linear-gradient(135deg, #112233, #445566)"}}}}
    stored = system.put_preferences(prefs)["theme"]
    assert stored["colorMode"] == "light" and stored["wallpaperDimPct"] == 0 and stored["perThemeWallpapers"]["nordic-slate"]["index"] == 2
    assert themes.list_themes()["preferences"]["activeThemeId"] == "nordic-slate"
    for bad in ({"colorMode": "sepia"}, {"selectedWallpaperIndex": 4}, {"wallpaperDimPct": 61},
                {"customWallpaperUrl": "http://plain.example/x.png"}, {"customWallpaperUrl": "/api/system/themes/wallpapers/../../x"}):
        expect(422, system.put_preferences, {"theme": bad})
print("themes OK")
