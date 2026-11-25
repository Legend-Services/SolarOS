"""Signed-in sessions and the sign-in rate limiter, both kept in memory and persisted in backend/data.

Every session JWT carries a jti that must be listed in sessions.json: revoking a session removes it, and the token stops
working at once. The limiter counts failed sign-ins per client address in a sliding 10-minute window; from the 5th
failure on, the address is locked out for 1, 2, 4, ... minutes (at most an hour).
"""
import json
import math
import re
import secrets
import threading
import time

from .config import settings

WINDOW_S = 600
MAX_FAILURES = 5
MAX_LOCK_S = 3600
TOUCH_FLUSH_S = 60  # last_seen is written to disk at most once a minute per session
_lock = threading.Lock()
_sessions: dict[str, dict] | None = None
_failures: dict[str, list[float]] | None = None
_flushed: dict[str, float] = {}


def _read(path, default):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, type(default)) else default
    except (FileNotFoundError, ValueError):
        return default


def _write(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o600)
    tmp.replace(path)


def device_summary(user_agent: str) -> str:
    """'Firefox on Windows' from a User-Agent header."""
    ua = user_agent or ""
    browser = next((name for rx, name in [(r"Edg/", "Edge"), (r"OPR/|Opera", "Opera"), (r"Firefox/", "Firefox"),
                                          (r"Chrome/|CriOS/", "Chrome"), (r"Safari/", "Safari"), (r"curl/", "curl"),
                                          (r"python", "Script")] if re.search(rx, ua)), "Browser")
    system = next((name for rx, name in [(r"iPhone|iPad", "iOS"), (r"Android", "Android"), (r"Windows", "Windows"),
                                         (r"Mac OS X|Macintosh", "macOS"), (r"CrOS", "ChromeOS"), (r"Linux", "Linux")]
                   if re.search(rx, ua)), "")
    return f"{browser} on {system}" if system else browser


# ---------------------------------------------------------------- sessions


def _all() -> dict[str, dict]:
    global _sessions
    if _sessions is None:
        _sessions = _read(settings.sessions_file, {})
    now = time.time()
    for sid in [s for s, v in _sessions.items() if v.get("expires", 0) < now]:
        del _sessions[sid]
    return _sessions


def create(user: str, ip: str, user_agent: str, ttl_s: int) -> str:
    sid = secrets.token_urlsafe(16)
    now = time.time()
    with _lock:
        _all()[sid] = {"id": sid, "user": user, "ip": ip, "device": device_summary(user_agent),
                       "user_agent": (user_agent or "")[:200], "issued": now, "last_seen": now, "expires": now + ttl_s}
        _write(settings.sessions_file, _sessions)
    return sid


def touch(sid: str | None, ip: str | None = None) -> bool:
    """True when the session is active (and marks it as seen now)."""
    if not sid:
        return False
    with _lock:
        s = _all().get(sid)
        if not s:
            return False
        now = time.time()
        s["last_seen"] = now
        if ip:
            s["ip"] = ip
        if now - _flushed.get(sid, 0) > TOUCH_FLUSH_S:
            _flushed[sid] = now
            _write(settings.sessions_file, _sessions)
    return True


def listing() -> list[dict]:
    with _lock:
        return sorted((dict(v) for v in _all().values()), key=lambda s: -s["last_seen"])


def revoke(sid: str) -> bool:
    with _lock:
        found = _all().pop(sid, None) is not None
        if found:
            _write(settings.sessions_file, _sessions)
    return found


def revoke_all(keep: str | None = None) -> int:
    with _lock:
        gone = [s for s in _all() if s != keep]
        for s in gone:
            del _sessions[s]
        _write(settings.sessions_file, _sessions)
    return len(gone)


# ---------------------------------------------------------------- sign-in rate limiter


def lock_seconds(failures: list[float], now: float) -> int:
    """Seconds this address must still wait (pure: unit tested)."""
    recent = sorted(t for t in failures if now - t < max(WINDOW_S, MAX_LOCK_S))
    in_window = [t for t in recent if now - t < WINDOW_S]
    if len(in_window) < MAX_FAILURES:
        return 0
    lock = min(MAX_LOCK_S, 60 * 2 ** (len(in_window) - MAX_FAILURES))
    return max(0, math.ceil(recent[-1] + lock - now))


def _fails() -> dict[str, list[float]]:
    global _failures
    if _failures is None:
        _failures = _read(settings.login_failures_file, {})
    return _failures


def retry_after(key: str) -> int:
    with _lock:
        return lock_seconds(_fails().get(key, []), time.time())


def failed(key: str) -> int:
    """Record a failed attempt; returns the lockout now in force (0 = none)."""
    now = time.time()
    with _lock:
        f = _fails()
        f[key] = [t for t in f.get(key, []) if now - t < max(WINDOW_S, MAX_LOCK_S)] + [now]
        for k in [k for k, v in f.items() if not v or now - v[-1] > MAX_LOCK_S]:
            del f[k]
        _write(settings.login_failures_file, f)
        return lock_seconds(f.get(key, []), now)


def succeeded(key: str) -> None:
    with _lock:
        if _fails().pop(key, None) is not None:
            _write(settings.login_failures_file, _failures)
