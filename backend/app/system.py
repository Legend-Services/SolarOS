"""Host administration: APT repositories, package updates, power. Needs the Administrator role (Sys.Modify)."""
import asyncio
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
from .pve import _node, _safe, pve

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_user)])


def repo_handle(uri: str, components: list[str]) -> str | None:
    """Map a configured repository to its PVE standard-repo handle (e.g. "no-subscription"), if it is one."""
    if re.search(r"/debian/pve/?$", uri):
        return next((c[4:] for c in components if c.startswith("pve-")), None)
    m = re.search(r"/debian/(ceph-[a-z]+)/?$", uri)
    return f"{m.group(1)}-{components[0]}" if m and components else None


def flatten(data: dict) -> dict:
    repos = []
    for f in data.get("files") or []:
        for i, r in enumerate(f.get("repositories") or []):
            uris, comps = r.get("URIs") or [], r.get("Components") or []
            repos.append({"path": f["path"], "index": i, "enabled": bool(r.get("Enabled")), "types": r.get("Types") or [],
                          "uris": uris, "suites": r.get("Suites") or [], "components": comps,
                          "handle": repo_handle(uris[0], comps) if uris else None})
    std = data.get("standard-repos") or []
    return {
        "digest": data.get("digest"),
        "repositories": repos,
        "names": {s["handle"]: s["name"] for s in std},
        # Standard repos with no "status" are not configured in any file yet.
        "available": [{"handle": s["handle"], "name": s["name"], "description": s.get("description", "")}
                      for s in std if "status" not in s],
        "errors": [e.get("error", str(e)) for e in data.get("errors") or []],
    }


@router.get("/repositories")
async def repositories():
    return flatten(await pve("GET", _node("/apt/repositories")) or {})


class RepoToggle(BaseModel):
    path: str = Field(pattern=r"^/etc/apt/[A-Za-z0-9_./-]+$", max_length=200)
    index: int = Field(ge=0, le=1000)
    enabled: bool
    digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{1,128}$")


class RepoAdd(BaseModel):
    handle: str = Field(pattern=r"^[a-z0-9-]+$", max_length=64)
    digest: str | None = Field(default=None, pattern=r"^[0-9a-f]{1,128}$")


@router.post("/repositories/toggle")
async def toggle_repository(body: RepoToggle):
    data = {"path": body.path, "index": body.index, "enabled": int(body.enabled)}
    await pve("POST", _node("/apt/repositories"), data={**data, **({"digest": body.digest} if body.digest else {})})
    return {"ok": True}


@router.post("/repositories/add")
async def add_repository(body: RepoAdd):
    await pve("PUT", _node("/apt/repositories"), data={"handle": body.handle, **({"digest": body.digest} if body.digest else {})})
    return {"ok": True}


@router.get("/updates")
async def updates():
    return await pve("GET", _node("/apt/update")) or []


@router.post("/updates/refresh")
async def refresh_updates():
    return {"task": await pve("POST", _node("/apt/update"))}


def parse_upgrade_status(out: str) -> dict:
    lines = out.splitlines()
    state = lines[0].removeprefix("state:") if lines and lines[0].startswith("state:") else "unknown"
    log = lines[1:]
    m = next((re.match(r"proxmox-os: exit (\d+)", x) for x in reversed(log) if x.startswith("proxmox-os: exit")), None)
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


@router.post("/power")
async def power(body: PowerBody):
    await pve("POST", _node("/status"), data={"command": body.command})
    return {"ok": True}


# ---------------------------------------------------------------- Control Panel


@router.get("/info")
async def info():
    version, status, network, dns = await asyncio.gather(
        _safe("/version"), _safe(_node("/status"), {}), _safe(_node("/network"), []), _safe(_node("/dns"), {}),
    )
    status, cpu = status or {}, (status or {}).get("cpuinfo", {})
    return {
        "node": settings.pve_node,
        "version": version or {},
        "pveversion": status.get("pveversion", ""),
        "kernel": status.get("kversion", ""),
        "uptime": status.get("uptime", 0),
        "cpu_model": cpu.get("model", ""),
        "cpus": cpu.get("cpus", 0),
        "boot_mode": (status.get("boot-info") or {}).get("mode", ""),
        "network": sorted(network or [], key=lambda n: (n.get("type") != "bridge", n.get("iface", ""))),
        "dns": dns or {},
        "api": {"host": settings.pve_host, "token_id": settings.pve_token_id, "connected": version is not None,
                "verify_ssl": settings.pve_verify_ssl},
        "admin_username": settings.admin_username,
        "storage_root": str(settings.storage_root),
        "helper": "ssh " + settings.host_ssh if settings.host_ssh else "local",
    }


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
def change_password(body: PasswordBody):
    if not secrets.compare_digest(body.current_password.encode(), settings.admin_password.encode()):
        raise HTTPException(403, "Current password is incorrect")
    write_env(config.ENV_FILE, "ADMIN_PASSWORD", body.new_password)
    settings.admin_password = body.new_password
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
