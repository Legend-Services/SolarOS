"""Git-backed SolarDeck updater: update checks, version history, update/rollback to any ref and scheduled auto-updates.

The actual code swap runs in deploy/self-update.sh as a detached systemd unit, because it restarts this backend.
"""
import asyncio
import base64
import hashlib
import json
import logging
import shutil
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .auth import require_user
from .config import settings
from .system import parse_upgrade_status

router = APIRouter(prefix="/api/system/updates", tags=["updater"], dependencies=[Depends(require_user)])
log = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parents[2]
UNIT = "proxmox-os-self-update"
LOG = Path("/var/log/proxmox-os-self-update.log")
REF_RE = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$"
SEP = "\x1f"
DEFAULTS = {"mode": "notify", "schedule_frequency": "daily", "schedule_time": "03:00", "schedule_day": 0,
            "last_checked_at": None, "latest_remote_commit": None, "latest_remote_tag": None, "update_available": False,
            "last_check_error": None}


# ---------------------------------------------------------------- Settings


def load_settings() -> dict:
    try:
        data = json.loads(settings.update_settings_file.read_text())
    except (OSError, ValueError):
        data = {}
    return {**DEFAULTS, **(data if isinstance(data, dict) else {})}


def save_settings(data: dict) -> dict:
    f = settings.update_settings_file
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(f)
    return data


def due(s: dict, now: datetime) -> bool:
    """Whether a scheduled check is due. schedule_day uses 0 = Sunday (JavaScript getDay)."""
    if s["mode"] == "manual":
        return False
    last = datetime.fromisoformat(s["last_checked_at"]) if s.get("last_checked_at") else None
    if s["schedule_frequency"] == "6h":
        return last is None or now - last >= timedelta(hours=6)
    h, m = map(int, s["schedule_time"].split(":"))
    slot = now.replace(hour=h, minute=m, second=0, microsecond=0)
    step = timedelta(days=1)
    if s["schedule_frequency"] == "weekly":
        step = timedelta(days=7)
        slot -= timedelta(days=(now.isoweekday() % 7 - s["schedule_day"]) % 7)
    if slot > now:
        slot -= step
    return last is None or last < slot


# ---------------------------------------------------------------- Git


async def _cmd(*args: str, timeout: float = 30) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, cwd=APP_DIR)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except FileNotFoundError:
        return 127, f"{args[0]} not found"
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timed out"
    return proc.returncode, out.decode(errors="replace").strip()


def git(*args: str, timeout: float = 30):
    # The tree can be owned by another uid (deploy.sh tarball), which git otherwise refuses as "dubious ownership".
    auth = []
    if settings.github_token:
        # Private repositories: GitHub accepts a token as Basic auth with any user name.
        b64 = base64.b64encode(f"x-access-token:{settings.github_token}".encode()).decode()
        auth = ["-c", f"http.https://github.com/.extraheader=Authorization: Basic {b64}"]
    return _cmd("git", "-c", "safe.directory=*", *auth, *args, timeout=timeout)


async def _out(*args: str) -> str | None:
    rc, out = await git(*args)
    return out if rc == 0 and out else None


async def source() -> dict:
    """Current commit, tag and update source.

    .build-commit (written by deploy.sh and self-update.sh) wins over git HEAD: deploy.sh copies files over an existing
    checkout without touching .git, so HEAD can be stale.
    """
    is_git = (APP_DIR / ".git").is_dir()
    commit = branch = remote = tag = None
    if is_git:
        commit = await _out("rev-parse", "HEAD")
        branch = await _out("rev-parse", "--abbrev-ref", "HEAD")
        remote = await _out("remote", "get-url", "origin")
    f = APP_DIR / ".build-commit"
    if f.exists():
        commit = f.read_text().strip() or commit
    if is_git and commit:
        tag = await _out("describe", "--tags", "--abbrev=0", commit)
    try:
        version = json.loads((APP_DIR / "frontend/package.json").read_text()).get("version")
    except (OSError, ValueError):
        version = None
    return {"git": is_git, "commit": commit, "tag": tag, "branch": branch if branch not in (None, "HEAD") else settings.repo_branch,
            "remote": remote or settings.repo_url, "version": version}


async def ensure_repo(branch: str) -> None:
    """Make APP_DIR a full checkout tracking origin/<branch> with tags, without touching the working tree."""
    if not (APP_DIR / ".git").is_dir():
        await git("init", "-q", "-b", branch)
    if not await _out("remote", "get-url", "origin"):
        await git("remote", "add", "origin", settings.repo_url)
    unshallow = ["--unshallow"] if (APP_DIR / ".git/shallow").exists() else []
    rc, out = await git("fetch", "-q", "--tags", "--force", *unshallow, "origin",
                        f"+refs/heads/{branch}:refs/remotes/origin/{branch}", timeout=120)
    if rc and ("could not read Username" in out or "Authentication failed" in out):
        raise HTTPException(502, "GitHub refused access to the update source (private repository or invalid token). "
                                 "Set GITHUB_TOKEN in backend/.env or make the repository public.")
    if rc:
        raise HTTPException(502, f"git fetch failed: {out[-300:]}")
    if not await _out("rev-parse", "--verify", "-q", "HEAD"):
        # Freshly initialised over a copied tree: point HEAD at the deployed commit (index only, files untouched).
        f = APP_DIR / ".build-commit"
        build = f.read_text().strip() if f.exists() else ""
        known = bool(build) and (await git("cat-file", "-e", f"{build}^{{commit}}"))[0] == 0
        await git("reset", "-q", "--mixed", build if known else f"origin/{branch}")


def _parse_log(out: str | None, current: str | None) -> list[dict]:
    rows = []
    for line in (out or "").splitlines():
        h, short, date, subject, refs = (line.split(SEP) + [""] * 5)[:5]
        tags = [r.removeprefix("tag: ") for r in refs.split(", ") if r.startswith("tag: ")]
        rows.append({"hash": h, "short_hash": short, "tag": tags[0] if tags else None, "date": date, "subject": subject,
                     "is_current": bool(current) and h == current})
    return rows


FMT = f"--format=%H{SEP}%h{SEP}%cI{SEP}%s{SEP}%D"


async def check() -> dict:
    src = await source()
    try:
        await ensure_repo(src["branch"])
    except HTTPException as e:
        save_settings({**load_settings(), "last_checked_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                       "last_check_error": e.detail})
        raise
    remote_ref = f"origin/{src['branch']}"
    remote_commit = await _out("rev-parse", remote_ref)
    remote_tag = await _out("describe", "--tags", "--abbrev=0", remote_ref)
    s = load_settings()
    s.update(last_checked_at=datetime.now().astimezone().isoformat(timespec="seconds"), latest_remote_commit=remote_commit,
             latest_remote_tag=remote_tag, update_available=bool(remote_commit) and remote_commit != src["commit"],
             last_check_error=None)
    return save_settings(s)


async def _incoming(src: dict) -> list[dict]:
    if not src["commit"] or not (APP_DIR / ".git").is_dir():
        return []
    return _parse_log(await _out("log", "-50", FMT, f"{src['commit']}..origin/{src['branch']}"), None)


async def job() -> dict:
    _, state = await _cmd("systemctl", "is-active", UNIT)
    try:
        lines = LOG.read_text(errors="replace").splitlines()[-300:]
    except OSError:
        lines = []
    return parse_upgrade_status("\n".join([f"state:{state}", *lines]))


def edition() -> dict:
    """Both editions track the same branch of the same repository; only the driver (backend/.env) differs."""
    native = settings.hypervisor_driver.strip().lower() == "native_ubuntu"
    return {"driver": "native_ubuntu" if native else "proxmox",
            "edition": "SolarDeck Standalone Hypervisor" if native else "Proxmox VE Deck",
            "service": "solardeck-backend" if native else "proxmox-os-backend",
            "supports_system_packages": native}


async def start(target: str, branch: str, system_packages: bool = False) -> None:
    if (await job())["running"]:
        raise HTTPException(409, "An update is already running")
    # Run a copy: git reset rewrites deploy/self-update.sh while bash is still reading it.
    script = Path("/tmp/proxmox-os-self-update.sh")
    shutil.copy(APP_DIR / "deploy/self-update.sh", script)
    await _cmd("systemctl", "reset-failed", UNIT)
    # Detached transient unit: the script restarts this backend, which must not kill the update midway.
    rc, out = await _cmd("systemd-run", "--quiet", f"--unit={UNIT}", "--collect",
                         "-p", f"StandardOutput=truncate:{LOG}", "-p", "StandardError=inherit",
                         "bash", str(script), str(APP_DIR), settings.repo_url, branch, target,
                         "1" if system_packages else "0")
    if rc:
        raise HTTPException(500, f"Could not start the updater: {out[-300:]}")


async def resolve(ref: str) -> str:
    sha = await _out("rev-parse", "--verify", "-q", f"{ref}^{{commit}}")
    if not sha:
        raise HTTPException(404, f"Unknown version: {ref}")
    return sha


# ---------------------------------------------------------------- Routes


@router.get("/status")
async def status(check_remote: bool = Query(False, alias="check")):
    if check_remote:
        await check()
    src = await source()
    s = load_settings()
    # A check stored before the last update/rollback may compare against an older commit.
    available = bool(s["latest_remote_commit"]) and s["latest_remote_commit"] != src["commit"]
    return {**src, **edition(), "remote_commit": s["latest_remote_commit"], "remote_tag": s["latest_remote_tag"],
            "update_available": available, "incoming": await _incoming(src) if available else [], "settings": s,
            **await job()}


class UpdateSettings(BaseModel):
    mode: Literal["manual", "notify", "auto"]
    schedule_frequency: Literal["6h", "daily", "weekly"]
    schedule_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    schedule_day: int = Field(0, ge=0, le=6)


@router.put("/settings")
def put_settings(body: UpdateSettings):
    return save_settings({**load_settings(), **body.model_dump()})


@router.get("/versions")
async def versions():
    src = await source()
    if not await _out("rev-parse", "--verify", "-q", f"origin/{src['branch']}"):
        with suppress(HTTPException):  # offline or no access: show the local history only
            await ensure_repo(src["branch"])
    head = f"origin/{src['branch']}" if await _out("rev-parse", "--verify", "-q", f"origin/{src['branch']}") else "HEAD"
    commits = _parse_log(await _out("log", "-25", FMT, head), src["commit"])
    tagged = _parse_log(await _out("log", "--no-walk=sorted", "--tags", FMT), src["commit"])
    seen = {c["hash"] for c in commits}
    rows = commits + [t for t in tagged if t["hash"] not in seen]
    return {"current": src["commit"], "versions": sorted(rows, key=lambda r: r["date"], reverse=True)}


class ApplyBody(BaseModel):
    target_ref: str | None = Field(None, pattern=REF_RE)
    # Standalone hypervisor only: also run apt-get update && apt-get upgrade -y on the host.
    include_system_packages: bool = False


@router.post("/apply")
async def apply(body: ApplyBody | None = None):
    system_packages = bool(body and body.include_system_packages)
    if system_packages and not edition()["supports_system_packages"]:
        raise HTTPException(400, "System package upgrades run from Proxmox VE itself on this edition")
    src = await source()
    await ensure_repo(src["branch"])
    target = await resolve((body and body.target_ref) or f"origin/{src['branch']}")
    await start(target, src["branch"], system_packages)
    return {"ok": True, "target": target, "include_system_packages": system_packages}


# ---------------------------------------------------------------- Standalone Hypervisor ISO

ISO_BUILD_COMMAND = "sudo bash /opt/proxmox-os/hypervisor/build-iso.sh"
_iso_sums: dict[tuple[str, int, int], str] = {}  # (path, size, mtime) -> sha256: an ISO is hashed once


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def find_isos(dirs: list[Path]) -> list[Path]:
    """SolarDeck Hypervisor ISOs in the given folders (unreadable or missing folders are skipped), newest first."""
    found = {}
    for d in dirs:
        with suppress(OSError):
            for f in d.glob("SolarDeck-Hypervisor-*.iso"):
                if f.is_file():
                    found.setdefault(f.resolve(), f)
    return sorted(found.values(), key=lambda f: f.stat().st_mtime, reverse=True)


@router.get("/iso")
async def hypervisor_iso():
    dirs = [settings.storage_root / "isos", Path("/var/lib/vz/template/iso")]
    out = []
    for f in find_isos(dirs):
        st = f.stat()
        key = (str(f), st.st_size, st.st_mtime_ns)
        if key not in _iso_sums:
            try:
                _iso_sums[key] = await asyncio.to_thread(_sha256, f)
            except OSError as e:
                log.warning("cannot hash %s: %s", f, e)
        out.append({"name": f.name, "path": str(f), "size": st.st_size, "modified": int(st.st_mtime),
                    "sha256": _iso_sums.get(key)})
    return {"build_command": ISO_BUILD_COMMAND, "test_command": "bash /opt/proxmox-os/hypervisor/test-in-proxmox-vm.sh",
            "search_paths": [str(d) for d in dirs], "isos": out}


@router.post("/rollback")
async def rollback(body: ApplyBody):
    if not body.target_ref:
        raise HTTPException(422, "target_ref is required for a rollback")
    src = await source()
    await ensure_repo(src["branch"])
    target = await resolve(body.target_ref)
    await start(target, src["branch"])
    s = load_settings()
    if s["mode"] == "auto":
        # Otherwise the next scheduled run would immediately undo the downgrade.
        save_settings({**s, "mode": "notify"})
    return {"ok": True, "target": target, "mode": load_settings()["mode"]}


# ---------------------------------------------------------------- Scheduler


async def scheduler_loop() -> None:
    # The backend restarts after every update; clear a stale "update available" flag so notify mode stops nagging.
    s = load_settings()
    if s["update_available"] and s["latest_remote_commit"] == (await source())["commit"]:
        save_settings({**s, "update_available": False})
    while True:
        try:
            s = load_settings()
            if due(s, datetime.now().astimezone()):
                s = await check()
                if s["mode"] == "auto" and s["update_available"] and not (await job())["running"]:
                    branch = (await source())["branch"]
                    log.info("Auto-update to %s", s["latest_remote_commit"])
                    await start(s["latest_remote_commit"], branch)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - a failed check must not stop future checks
            # check() already recorded the attempt, so a broken network does not retry every minute.
            log.warning("Update check failed: %s", getattr(e, "detail", e))
        await asyncio.sleep(60)
