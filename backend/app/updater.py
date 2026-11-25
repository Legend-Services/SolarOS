"""Git-backed SolarDeck updater: background update checks, version history, update/rollback to any ref, live update
progress and scheduled installs.

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
from providers import registry

router = APIRouter(prefix="/api/system/updates", tags=["updater"], dependencies=[Depends(require_user)])
log = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parents[2]
UNIT = settings.name("self-update")
LOG = Path(f"/var/log/{UNIT}.log")
# Written by deploy/self-update.sh at every stage. In /run, not /tmp: the backend's /tmp is private (PrivateTmp=yes),
# so the updater unit and this backend would each see their own copy.
PROGRESS = Path(f"/run/{settings.name('update-progress')}.json")
COMPLETED_TTL = timedelta(minutes=2)  # a finished update is shown this long, then the page is back to idle
REF_RE = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$"
SEP = "\x1f"
DEFAULTS = {"auto_check_enabled": True, "check_interval_hours": 6, "auto_install_enabled": False,
            "schedule_frequency": "weekly", "schedule_day_of_week": 0, "schedule_day_of_month": 1, "schedule_time": "03:00",
            "include_os_packages": False, "last_auto_install_at": None,
            "last_checked_at": None, "latest_remote_commit": None, "latest_remote_tag": None, "update_available": False,
            "last_check_error": None}


# ---------------------------------------------------------------- Settings


def load_settings() -> dict:
    try:
        data = json.loads(settings.update_settings_file.read_text())
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    if "mode" in data:
        # Settings from before the update schedule: manual / notify / auto with a 6h, daily or weekly check.
        mode = data.pop("mode")
        data.setdefault("auto_check_enabled", mode != "manual")
        data.setdefault("auto_install_enabled", mode == "auto")
        if "schedule_day" in data:
            data.setdefault("schedule_day_of_week", data.pop("schedule_day"))
        if data.get("schedule_frequency") == "6h":
            data.update(schedule_frequency="daily", check_interval_hours=6)
    return {**DEFAULTS, **data}


def save_settings(data: dict) -> dict:
    f = settings.update_settings_file
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(f)
    return data


def _ts(v: str | None) -> datetime | None:
    return datetime.fromisoformat(v) if v else None


def check_due(s: dict, now: datetime) -> bool:
    """Whether the background update check is due (every check_interval_hours)."""
    last = _ts(s.get("last_checked_at"))
    return s["auto_check_enabled"] and (last is None or now - last >= timedelta(hours=s["check_interval_hours"]))


def install_slot(s: dict, day: datetime) -> datetime | None:
    """The scheduled install time on `day`, or None when it is not an install day. Day of week: 0 = Sunday."""
    if s["schedule_frequency"] == "weekly" and day.isoweekday() % 7 != s["schedule_day_of_week"]:
        return None
    if s["schedule_frequency"] == "monthly" and day.day != s["schedule_day_of_month"]:
        return None
    h, m = map(int, s["schedule_time"].split(":"))
    return day.replace(hour=h, minute=m, second=0, microsecond=0)


def install_due(s: dict, now: datetime) -> bool:
    """Within an hour after today's slot, once per day: the backend restarted by the update must not start it again."""
    slot = install_slot(s, now) if s["auto_install_enabled"] else None
    last = _ts(s.get("last_auto_install_at"))
    return slot is not None and slot <= now < slot + timedelta(hours=1) and (last is None or last.date() != now.date())


def next_runs(s: dict, now: datetime) -> dict:
    last = _ts(s.get("last_checked_at"))
    check_at = max(now, last + timedelta(hours=s["check_interval_hours"])) if last else now
    install_at = None
    if s["auto_install_enabled"]:
        # Monthly days are 1..28, so every schedule has a slot within 31 days.
        days = (install_slot(s, now + timedelta(days=i)) for i in range(32))
        install_at = next((d for d in days if d and d > now), None)
    iso = lambda d: d and d.isoformat(timespec="seconds")  # noqa: E731
    return {"next_check_at": iso(check_at) if s["auto_check_enabled"] else None, "next_install_at": iso(install_at)}


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
    # The configured release branch, not whatever the checkout happens to be on (a test deploy may leave a feature branch).
    return {"git": is_git, "commit": commit, "tag": tag, "branch": settings.repo_branch or branch,
            "remote": remote or settings.repo_url, "version": version}


async def ensure_repo(branch: str) -> None:
    """Make APP_DIR a full checkout tracking origin/<branch> with tags, without touching the working tree."""
    if not (APP_DIR / ".git").is_dir():
        await git("init", "-q", "-b", branch)
    if not await _out("remote", "get-url", "origin"):
        await git("remote", "add", "origin", settings.repo_url)
    unshallow = ["--unshallow"] if (APP_DIR / ".git/shallow").exists() else []
    # main carries every release tag; an edition release branch only its own <branch>-* tags (nothing else is fetched).
    tags = (["--tags"], []) if branch == "main" else (["--no-tags"], [f"+refs/tags/{branch}-*:refs/tags/{branch}-*"])
    rc, out = await git("fetch", "-q", *tags[0], "--force", *unshallow, "origin",
                        f"+refs/heads/{branch}:refs/remotes/origin/{branch}", *tags[1], timeout=120)
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
        if not known:
            # An ISO records its main-branch commit, which the edition branch does not contain: the edition tag of the
            # same version is the same release, so record that (else every fresh install reports an update).
            version = (await source())["version"]
            build = version and await _out("rev-parse", "--verify", "-q", f"refs/tags/{branch}-v{version}^{{commit}}")
            if build:
                f.write_text(build + "\n")
        await git("reset", "-q", "--mixed", build or f"origin/{branch}")


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


_detached: asyncio.subprocess.Process | None = None  # the runner when systemd-run is missing


async def job() -> dict:
    _, state = await _cmd("systemctl", "is-active", UNIT)
    if _detached and _detached.returncode is None:
        state = "active"
    try:
        lines = LOG.read_text(errors="replace").splitlines()[-300:]
    except OSError:
        lines = []
    return parse_upgrade_status("\n".join([f"state:{state}", *lines]))


def write_progress(**p) -> None:
    tmp = PROGRESS.with_suffix(".tmp")
    tmp.write_text(json.dumps(p))
    tmp.replace(PROGRESS)


def progress(j: dict, now: datetime) -> dict:
    """The update runner's stage, from the file self-update.sh keeps current (it outlives backend restarts)."""
    try:
        p = json.loads(PROGRESS.read_text())
    except (OSError, ValueError):
        p = {}
    p = p if isinstance(p, dict) else {}
    if p.get("status") == "running" and not j["running"]:
        # The unit ended without a final stage: killed, or an updater from a release without progress tracking.
        ok = j["exit_code"] == 0
        p.update(status="completed" if ok else "failed", percent=100 if ok else p.get("percent", 0),
                 error_message=None if ok else "The updater stopped unexpectedly; see the log for details.")
        p.setdefault("finished_at", now.isoformat(timespec="seconds"))
    finished = _ts(p.get("finished_at"))
    if p.get("status") == "completed" and finished and now - finished > COMPLETED_TTL:
        p = {}
    return {"update_status": p.get("status", "idle"), "progress_percent": p.get("percent", 0), "stage": p.get("stage"),
            "current_stage": p.get("stage_label"), "error_message": p.get("error_message"),
            "started_at": p.get("started_at"), "finished_at": p.get("finished_at"),
            "completed_version": p.get("completed_version"), "completed_commit": p.get("completed_commit")}


def edition() -> dict:
    """Both editions track the same branch of the same repository; only the driver (backend/.env) differs."""
    pkg = registry.driver_package()
    return {"driver": registry.driver_id(), "edition": pkg.EDITION, "service": settings.name("backend"),
            "supports_system_packages": pkg.SYSTEM_PACKAGES}


async def start(target: str, branch: str, system_packages: bool = False) -> None:
    if (await job())["running"]:
        raise HTTPException(409, "An update is already running")
    # Run a copy: git reset rewrites deploy/self-update.sh while bash is still reading it.
    # In /run, not /tmp: the backend's /tmp is private (PrivateTmp=yes) and invisible to the transient unit.
    script = Path(f"/run/{UNIT}.sh")
    shutil.copy(APP_DIR / "deploy/self-update.sh", script)
    await _cmd("systemctl", "reset-failed", UNIT)
    # Detached transient unit: the script restarts this backend, which must not kill the update midway.
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    write_progress(status="running", percent=0, stage="starting", stage_label="Starting the updater", target=target,
                   started_at=now, updated_at=now)
    run = ["bash", str(script), str(APP_DIR), settings.repo_url, branch, target, "1" if system_packages else "0"]
    rc, out = await _cmd("systemd-run", "--quiet", f"--unit={UNIT}", "--collect",
                         "-p", f"StandardOutput=truncate:{LOG}", "-p", "StandardError=inherit", *run)
    if rc == 127:
        # No systemd-run: a nohup-style new session survives this backend's restart just the same.
        global _detached
        with LOG.open("w") as f:
            _detached = await asyncio.create_subprocess_exec(*run, stdout=f, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    elif rc:
        write_progress(status="failed", percent=0, stage="starting", stage_label="Starting the updater",
                       error_message=f"Could not start the updater: {out[-300:]}", started_at=now, finished_at=now)
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
    tag = s["latest_remote_tag"]
    j = await job()
    return {**src, **edition(), "remote_commit": s["latest_remote_commit"], "remote_tag": tag,
            "update_available": available, "incoming": await _incoming(src) if available else [], "settings": s,
            "current_version": src["version"], "last_checked": s["last_checked_at"],
            # The branch can be ahead of its newest tag: then the commit names the new version.
            "latest_version": tag if tag and tag != src["tag"] else (s["latest_remote_commit"] or "")[:10] or None,
            "running": j["running"], "exit_code": j["exit_code"], "logs": j["log"],
            **progress(j, datetime.now().astimezone())}


@router.post("/acknowledge")
async def acknowledge():
    """Clear a finished or failed update, so the page shows the idle state again (the log stays on disk)."""
    if (await job())["running"]:
        raise HTTPException(409, "An update is running")
    PROGRESS.unlink(missing_ok=True)
    return {"ok": True}


class UpdateSchedule(BaseModel):
    auto_check_enabled: bool
    check_interval_hours: Literal[1, 6, 12, 24]
    auto_install_enabled: bool
    schedule_frequency: Literal["daily", "weekly", "monthly"]
    schedule_day_of_week: int = Field(0, ge=0, le=6)
    schedule_day_of_month: int = Field(1, ge=1, le=28)
    schedule_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    include_os_packages: bool = False


def _schedule(s: dict) -> dict:
    return {**{k: s[k] for k in UpdateSchedule.model_fields}, **next_runs(s, datetime.now().astimezone()),
            "supports_os_packages": edition()["supports_system_packages"]}


@router.get("/schedule")
def get_schedule():
    return _schedule(load_settings())


@router.put("/schedule")
def put_schedule(body: UpdateSchedule):
    data = body.model_dump()
    if data["include_os_packages"] and not edition()["supports_system_packages"]:
        raise HTTPException(400, "This edition upgrades host packages from the hypervisor host itself")
    return _schedule(save_settings({**load_settings(), **data}))


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
        raise HTTPException(400, "This edition upgrades host packages from the hypervisor host itself")
    src = await source()
    await ensure_repo(src["branch"])
    target = await resolve((body and body.target_ref) or f"origin/{src['branch']}")
    await start(target, src["branch"], system_packages)
    return {"ok": True, "target": target, "include_system_packages": system_packages}


# ---------------------------------------------------------------- SolarOS installer ISO

ISO_BUILD_COMMAND = f"sudo bash {APP_DIR}/hypervisor/build-iso.sh"
_iso_sums: dict[tuple[str, int, int], str] = {}  # (path, size, mtime) -> sha256: an ISO is hashed once


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def find_isos(dirs: list[Path]) -> list[Path]:
    """SolarOS installer ISOs in the given folders (unreadable or missing folders are skipped), newest first."""
    found = {}
    for d in dirs:
        with suppress(OSError):
            # SolarDeck-Hypervisor-*.iso: ISOs built before the SolarOS name (v2.2.0)
            for f in [*d.glob("SolarOS-*.iso"), *d.glob("SolarDeck-Hypervisor-*.iso")]:
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
    # The nested-VM test script ships only where a hypervisor to test on exists.
    test = next(iter(sorted(APP_DIR.glob("hypervisor/test-in-*-vm.sh"))), None)
    return {"build_command": ISO_BUILD_COMMAND, "test_command": f"bash {test}" if test else None,
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
    if s["auto_install_enabled"]:
        # Otherwise the next scheduled run would immediately undo the downgrade.
        save_settings({**s, "auto_install_enabled": False})
    return {"ok": True, "target": target, "auto_install_enabled": False}


# ---------------------------------------------------------------- Scheduler


async def scheduler_loop() -> None:
    # The backend restarts after every update: a check from before it is stale (it may even name an older commit as
    # the update), so clear it when it matches the installed commit and check again when it does not.
    s = load_settings()
    commit = (await source())["commit"]
    if s["update_available"] and s["latest_remote_commit"] == commit:
        save_settings({**s, "update_available": False})
    elif s["latest_remote_commit"] and s["latest_remote_commit"] != commit and s["auto_check_enabled"]:
        with suppress(Exception):  # offline: check() records the error, the loop below retries on its interval
            await check()
    while True:
        try:
            s = load_settings()
            now = datetime.now().astimezone()
            if install_due(s, now):
                # Recorded first: whatever happens next, this slot is used up (no retry loop on a broken update).
                save_settings({**s, "last_auto_install_at": now.isoformat(timespec="seconds")})
                s = await check()
                if s["update_available"] and not (await job())["running"]:
                    branch = (await source())["branch"]
                    log.info("Scheduled update to %s", s["latest_remote_commit"])
                    await start(s["latest_remote_commit"], branch,
                                s["include_os_packages"] and edition()["supports_system_packages"])
            elif check_due(s, now):
                await check()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - a failed check must not stop future checks
            # check() already recorded the attempt, so a broken network does not retry every minute.
            log.warning("Update check failed: %s", getattr(e, "detail", e))
        await asyncio.sleep(60)
