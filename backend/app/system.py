"""Host administration shared by the drivers: package upgrades through the host helper, power request model,
SolarDeck password and desktop preferences. Needs the Administrator role (Sys.Modify)."""
import json
import re
import secrets
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import config, host
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_user)])


def parse_upgrade_status(out: str) -> dict:
    lines = out.splitlines()
    state = lines[0].removeprefix("state:") if lines and lines[0].startswith("state:") else "unknown"
    log = lines[1:]
    m = next((re.fullmatch(r"[\w-]+: exit (\d+)", x.strip()) for x in reversed(log) if re.fullmatch(r"[\w-]+: exit (\d+)", x.strip())), None)
    return {"running": state in ("active", "activating"), "exit_code": int(m.group(1)) if m else None, "log": log}


@router.get("/upgrade")
async def upgrade_status():
    return parse_upgrade_status(await host.run(["apt-upgrade-status"]))


@router.post("/upgrade")
async def start_upgrade():
    # The helper starts apt in a transient systemd unit on the host, so a dropped SSH session can't interrupt dpkg.
    await host.run(["apt-upgrade"])
    return {"ok": True}


class PowerBody(BaseModel):
    command: Literal["reboot", "shutdown"]


class PasswordBody(BaseModel):
    current_password: str = Field(max_length=128)
    # No quotes, backslashes or newlines: the value is stored single-quoted in .env.
    new_password: str = Field(min_length=8, max_length=128, pattern=r"^[^'\\\r\n]+$")


def write_env(path: Path, key: str, value: str) -> None:
    lines = path.read_text().splitlines() if path.exists() else []
    entry = f"{key}='{value}'"
    lines = [entry if line.startswith(f"{key}=") else line for line in lines]
    if entry not in lines:
        lines.append(entry)
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    tmp.chmod(0o600)
    tmp.replace(path)


@router.post("/password")
async def change_password(body: PasswordBody):
    from . import accounts
    from providers.registry import get_provider

    if not accounts.verify_admin(settings.admin_username, body.current_password):
        raise HTTPException(403, "Current password is incorrect")
    accounts.check_new_credentials(settings.admin_username, body.new_password)
    # The host account of the same name (if the platform has one) gets the same password; first, so a failure changes nothing.
    await get_provider().set_host_admin(settings.admin_username, body.new_password)
    accounts.set_admin(settings.admin_username, body.new_password)
    return {"ok": True}


PREFS_MAX_BYTES = 64 * 1024
AppIdStr = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,31}$")]


class LayoutPrefs(BaseModel):
    """Desktop layout block. Only the placement fields are typed; the other keys (icon size, gaps, views) pass through."""

    model_config = ConfigDict(extra="allow")
    desktopAlignment: Literal["left", "center"] = "left"
    desktopVerticalAlign: Literal["top", "middle"] = "top"
    desktopMaxColumns: Literal["auto"] | Annotated[int, Field(ge=3, le=8, strict=True)] = "auto"
    # Phase 16: clean desktop (shortcuts off) and the App Gallery / Dock order.
    showDesktopIcons: bool = False
    gallerySortMode: Literal["custom", "most-used", "alpha-asc", "alpha-desc", "recent"] = "custom"
    galleryAppOrder: Annotated[list[AppIdStr], Field(max_length=64)] = []


ThemeId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")]


# An uploaded wallpaper, an https image, or a two-color gradient made in the Theme Studio.
CustomWallpaper = Annotated[str, Field(max_length=2048, pattern=r"^(/api/system/themes/wallpapers/[0-9a-f]{32}\.(png|jpe?g|webp|svg)"
                                       r"|https://[^\s\"'()\\]+|linear-gradient\(\d{1,3}deg, ?#[0-9a-fA-F]{6}, ?#[0-9a-fA-F]{6}\))$")]


class WallpaperChoice(BaseModel):
    index: Annotated[int, Field(ge=0, le=3)] = 0
    custom: CustomWallpaper | None = None


class ThemePrefs(BaseModel):
    """Active theme block. perThemeWallpapers lets every theme keep its own wallpaper choice."""

    model_config = ConfigDict(extra="ignore")
    activeThemeId: ThemeId = "solardeck-glass"
    colorMode: Literal["dark", "light"] = "dark"
    selectedWallpaperIndex: Annotated[int, Field(ge=0, le=3)] = 0
    customWallpaperUrl: CustomWallpaper | None = None
    wallpaperBlurPx: Annotated[int, Field(ge=0, le=24)] = 0
    wallpaperDimPct: Annotated[int, Field(ge=0, le=60)] = 0
    perThemeWallpapers: Annotated[dict[ThemeId, WallpaperChoice], Field(max_length=200)] = {}


def with_layout_defaults(data: dict) -> dict:
    """Fill placement and theme defaults into stored preferences. No layout yet stays absent: the frontend then uploads its own."""
    if isinstance(data.get("layout"), dict):
        data = {**data, "layout": LayoutPrefs.model_validate(data["layout"]).model_dump()}
    if "theme" in data:
        data = {**data, "theme": ThemePrefs.model_validate(data["theme"]).model_dump()}
    return data


def load_preferences() -> dict:
    try:
        data = json.loads(settings.preferences_file.read_text())
    except (FileNotFoundError, ValueError):  # missing or hand-damaged file: start from defaults
        return {}
    return data if isinstance(data, dict) else {}


@router.get("/preferences")
def get_preferences():
    data = load_preferences()
    try:
        return with_layout_defaults(data)
    except ValidationError:  # hand-edited bad value: return as stored, the frontend sanitizes it
        return data


@router.put("/preferences")
def put_preferences(body: dict = Body(...)):
    """Replace the stored preferences. The frontend owns the schema (layout, dock, wizard, theme); placement and theme are validated."""
    try:
        body = with_layout_defaults(body)
    except ValidationError as e:
        raise HTTPException(422, f"Invalid preference: {'.'.join(map(str, e.errors()[0]['loc']))}")
    raw = json.dumps(body, indent=2)
    if len(raw) > PREFS_MAX_BYTES:
        raise HTTPException(413, "Preferences are too large")
    settings.preferences_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.preferences_file.with_suffix(".tmp")
    tmp.write_text(raw)
    tmp.replace(settings.preferences_file)  # atomic: a crash never leaves a half-written file
    return body
