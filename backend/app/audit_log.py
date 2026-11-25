"""Tamper-evident security audit log: backend/data/audit_log.jsonl, one hash-chained JSON entry per line.

entry_hash = sha256(prev_hash + canonical JSON of the entry without entry_hash). Editing, deleting, inserting or
reordering a line breaks the chain from that line on, which verify() reports (GET /api/security/audit-log/verify).
"""
import hashlib
import json
import logging
import os
import re
import threading
from datetime import datetime, timezone

from .config import settings

GENESIS = "0" * 64
_lock = threading.Lock()
_last: str | None = None
log = logging.getLogger(__name__)

# Mutating requests recorded by the HTTP middleware in main.py: (method, path regex, event). Auth, 2FA, session,
# step-up, hardening and host shell events are recorded where they happen.
HTTP_EVENTS = [
    ("POST", r"^/api/v1/guests/(qemu|lxc)$", "guest.create"),
    ("DELETE", r"^/api/v1/guests/(qemu|lxc)/\d+$", "guest.delete"),
    ("POST", r"^/api/v1/zfs/pools$", "zfs.pool.create"),
    ("DELETE", r"^/api/v1/zfs/pools/[^/]+$", "zfs.pool.destroy"),
    ("POST", r"^/api/v1/zfs/datasets$", "zfs.dataset.create"),
    ("DELETE", r"^/api/v1/zfs/datasets$", "zfs.dataset.destroy"),
    ("POST", r"^/api/v1/zfs/pools/[^/]+/members/(offline|detach|replace)$", "zfs.member.change"),
    ("POST", r"^/api/v1/disks/wipe$", "disk.wipe"),
    ("*", r"^/api/v1/firewall/", "firewall.edit"),
    ("POST", r"^/api/system/updates/(apply|rollback)$", "update.apply"),
    ("POST", r"^/api/hardware/gpu-drivers/", "gpu.driver.change"),
    ("POST", r"^/api/system/password$", "password.change"),
    ("POST", r"^/api/network/switch/(apply|confirm|revert)$", "network.switch.apply"),
    ("PUT", r"^/api/network/switch/vlans/\d+/dhcp$", "network.vlan.dhcp"),
]


def http_event(method: str, path: str) -> str | None:
    if method == "GET":
        return None
    return next((e for m, rx, e in HTTP_EVENTS if m in ("*", method) and re.search(rx, path)), None)


def canonical(data: dict) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def entry_hash(prev_hash: str, payload: dict) -> str:
    return hashlib.sha256((prev_hash + canonical(payload)).encode()).hexdigest()


def _tail_hash() -> str:
    try:
        with open(settings.audit_log_file, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 65536))
            lines = [x for x in f.read().splitlines() if x.strip()]
        return json.loads(lines[-1])["entry_hash"] if lines else GENESIS
    except FileNotFoundError:
        return GENESIS
    except (OSError, ValueError, KeyError):
        return "corrupt"  # the chain is already broken; verify() reports where


def record(event: str, *, user: str | None = None, ip: str | None = None, ok: bool = True, **details) -> None:
    """Append one event. Never raises: a full disk must not block sign-in or the action being audited."""
    global _last
    try:
        with _lock:
            prev = _last if _last is not None else _tail_hash()
            payload = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": event, "user": user,
                       "ip": ip, "ok": ok, "details": details, "prev_hash": prev}
            h = entry_hash(prev, payload)
            path = settings.audit_log_file
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(canonical({**payload, "entry_hash": h}) + "\n")
            _last = h
    except OSError as e:
        log.warning("audit log write failed: %s", e)


def entries() -> list[dict]:
    # shortcut: reads the whole file; rotate (with a signed checkpoint) once logs reach tens of MB.
    try:
        lines = settings.audit_log_file.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            out.append({"event": "corrupt", "raw": line[:200]})
    return out


def verify(items: list[dict] | None = None) -> dict:
    items = entries() if items is None else items
    prev = GENESIS
    for i, e in enumerate(items, 1):
        payload = {k: v for k, v in e.items() if k != "entry_hash"}
        if e.get("prev_hash") != prev:
            return {"ok": False, "entries": len(items), "first_bad_line": i,
                    "reason": "Entry does not link to the previous one (a line was removed, inserted or reordered)"}
        if entry_hash(prev, payload) != e.get("entry_hash"):
            return {"ok": False, "entries": len(items), "first_bad_line": i, "reason": "Entry was modified"}
        prev = e["entry_hash"]
    return {"ok": True, "entries": len(items), "first_bad_line": None, "reason": None}
