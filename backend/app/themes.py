"""Theme Studio storage: custom themes (data/themes/custom_themes.json) and uploaded wallpapers (data/themes/wallpapers/).
The 11 built-in themes live in the frontend; the active theme is part of /api/system/preferences (ThemePrefs)."""
import json
import re
import secrets
import threading
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError

from . import system
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/system/themes", tags=["themes"], dependencies=[Depends(require_user)])
# Wallpapers are also shown on the lock screen, before sign-in. Their names are 128-bit random tokens, so a file
# can only be fetched by someone who was given its URL.
public = APIRouter(prefix="/api/system/themes", tags=["themes"])

BUILT_IN_IDS = {"solardeck-glass", "cupertino-frost", "redmond-mica", "aubergine-yaru", "nordic-slate", "vice-horizon",
                "nightcity-2099", "synthwave-84", "phosphor-terminal", "solarized-amber", "obsidian-gold"}
MAX_THEMES = 50
WALLPAPER_MAX_BYTES = 15 * 1024 * 1024
WALLPAPER_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"}
WALLPAPER_NAME = re.compile(r"^[0-9a-f]{32}\.(png|jpe?g|webp|svg)$")
_lock = threading.Lock()

Hex = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
CSS_URL = re.compile(r"url\(\s*['\"]?([^'\")\s]*)", re.I)
# Quoted data:image URIs; their own internal url(#id) references are not image sources.
DATA_URI = re.compile(r"url\(\s*\"data:image/[^\"]*\"\s*\)|url\(\s*'data:image/[^']*'\s*\)", re.I)
SAFE_URL = ("data:image/", "/api/system/themes/wallpapers/", "https://")


def _safe_css(v: str) -> str:
    """Wallpaper CSS may only load images from data: URIs, this server's uploads or https."""
    for url in CSS_URL.findall(DATA_URI.sub("", v)):
        if not url.lower().startswith(SAFE_URL):
            raise ValueError(f"wallpaper image source not allowed: {url[:40]}")
    if re.search(r"expression\s*\(|javascript:", v, re.I):
        raise ValueError("wallpaper contains script")
    return v


Css = Annotated[str, Field(min_length=1, max_length=120_000), AfterValidator(_safe_css)]


class Palette(BaseModel):
    bg: Hex
    surface: Hex
    opacity: Annotated[float, Field(ge=0.2, le=1)]
    blur: Annotated[int, Field(ge=0, le=48)]
    accent: Hex
    accent2: Hex
    text: Hex


class Style(BaseModel):
    radiusWindow: Annotated[int, Field(ge=0, le=28)]
    radiusCard: Annotated[int, Field(ge=0, le=24)]
    radiusButton: Annotated[int, Field(ge=0, le=16)]
    windowChrome: Literal["standard", "traffic-dots", "angular-hud"]
    font: Literal["sans", "geometric", "mono"]
    scanlines: bool = False


class Wallpaper(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=60)]
    dark: Css
    light: Css


class Theme(BaseModel):
    """A theme file; unknown keys (an export's "format" marker) are dropped."""

    model_config = ConfigDict(extra="ignore")
    id: system.ThemeId
    name: Annotated[str, Field(min_length=1, max_length=60)]
    author: Annotated[str, Field(min_length=1, max_length=60)]
    description: Annotated[str, Field(max_length=300)]
    dark: Palette
    light: Palette
    style: Style
    wallpapers: Annotated[list[Wallpaper], Field(min_length=4, max_length=4)]


def _file():
    return settings.themes_dir / "custom_themes.json"


def load_themes() -> list[dict]:
    try:
        data = json.loads(_file().read_text())
    except (FileNotFoundError, ValueError):  # missing or hand-damaged: no custom themes
        return []
    return [t for t in data if isinstance(t, dict)] if isinstance(data, list) else []


def _save(themes: list[dict]) -> None:
    settings.themes_dir.mkdir(parents=True, exist_ok=True)
    tmp = _file().with_suffix(".tmp")
    tmp.write_text(json.dumps(themes, indent=2))
    tmp.replace(_file())  # atomic: a crash never leaves a half-written file


@router.get("")
def list_themes():
    try:
        prefs = system.ThemePrefs.model_validate(system.load_preferences().get("theme") or {})
    except ValidationError:  # hand-edited bad value: defaults
        prefs = system.ThemePrefs()
    return {"themes": load_themes(), "preferences": prefs.model_dump()}


@router.post("", status_code=201)
def create_theme(theme: Theme):
    if theme.id in BUILT_IN_IDS:
        raise HTTPException(409, "A built-in theme already uses this id")
    with _lock:
        themes = load_themes()
        if any(t.get("id") == theme.id for t in themes):
            raise HTTPException(409, "A theme with this id already exists")
        if len(themes) >= MAX_THEMES:
            raise HTTPException(409, f"At most {MAX_THEMES} custom themes can be saved")
        themes.append(theme.model_dump())
        _save(themes)
    return theme


@router.put("/{theme_id}")
def update_theme(theme_id: str, theme: Theme):
    if theme.id != theme_id:
        raise HTTPException(422, "The theme id cannot be changed")
    with _lock:
        themes = load_themes()
        i = next((i for i, t in enumerate(themes) if t.get("id") == theme_id), None)
        if i is None:
            raise HTTPException(404, "Theme not found")
        themes[i] = theme.model_dump()
        _save(themes)
    return theme


@router.delete("/{theme_id}")
def delete_theme(theme_id: str):
    with _lock:
        themes = load_themes()
        rest = [t for t in themes if t.get("id") != theme_id]
        if len(rest) == len(themes):
            raise HTTPException(404, "Theme not found")
        _save(rest)
    return {"ok": True}


def _looks_like(ext: str, head: bytes) -> bool:
    """Content check, so a file renamed to .png is refused."""
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return b"<svg" in head[:2048].lower()


@router.post("/wallpapers/upload", status_code=201)
def upload_wallpaper(file: UploadFile = File(...)):
    ext = "." + (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in WALLPAPER_TYPES:
        raise HTTPException(415, "Use a .png, .jpg, .jpeg, .webp or .svg image")
    data = file.file.read(WALLPAPER_MAX_BYTES + 1)
    if len(data) > WALLPAPER_MAX_BYTES:
        raise HTTPException(413, "Wallpapers can be at most 15 MB")
    if not _looks_like(ext, data):
        raise HTTPException(415, f"The file is not a valid {ext[1:].upper()} image")
    folder = settings.themes_dir / "wallpapers"
    folder.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(16) + (".jpg" if ext == ".jpeg" else ext)
    tmp = folder / f".{name}.part"
    tmp.write_bytes(data)
    tmp.replace(folder / name)
    return {"url": f"/api/system/themes/wallpapers/{name}"}


@public.get("/wallpapers/{filename}")
def get_wallpaper(filename: str):
    # The strict name pattern is the path-traversal guard: no slashes, dots only before the extension.
    path = settings.themes_dir / "wallpapers" / filename
    if not WALLPAPER_NAME.match(filename) or not path.is_file():
        raise HTTPException(404, "Wallpaper not found")
    return FileResponse(path, media_type=WALLPAPER_TYPES["." + filename.rsplit(".", 1)[1]], headers={
        "Cache-Control": "private, max-age=31536000, immutable",  # names are random and never reused
        "X-Content-Type-Options": "nosniff",
        # An SVG opened directly must not run scripts on SolarDeck's origin.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
