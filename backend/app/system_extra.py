"""Spotlight search index and App Gallery launch counts."""
import asyncio
import json
import threading
import time
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field

from . import apps, shares
from .auth import require_user
from .config import settings
from .storage_admin import datasets
from providers.registry import get_provider

router = APIRouter(tags=["system-extra"], dependencies=[Depends(require_user)])

PER_KIND = 8

# Control Panel sections, matched on title + keywords.
SECTIONS = [
    ("security", "User & Security", "password two-factor 2fa totp authenticator api token login"),
    ("network", "Network & DNS", "interfaces bridge br dns resolver ip gateway"),
    ("appearance", "Appearance & Layout", "wallpaper widgets theme background layout grid list view icon size spacing dock"),
    ("power", "System & Updates", "reboot shutdown version update upgrade downgrade rollback kernel bug report"),
]

# ---------------------------------------------------------------- Search

_ds_cache: tuple[float, list[dict]] = (0.0, [])


async def _datasets() -> list[dict]:
    """ZFS datasets via the host helper; cached briefly so typing in Spotlight doesn't hammer SSH."""
    global _ds_cache
    if time.monotonic() - _ds_cache[0] < 30:
        return _ds_cache[1]
    try:
        items = await asyncio.wait_for(datasets(), 5)
    except Exception:  # noqa: BLE001 - no ZFS / helper: search the rest
        items = []
    _ds_cache = (time.monotonic(), items)
    return items


def _shares() -> list[dict]:
    try:
        return shares.list_shares()
    except OSError:
        return []


def build_results(q: str, qemu: list, lxc: list, pools: list, ds: list, share_list: list) -> list[dict]:
    q = q.lower().strip()
    hit = lambda *fields: any(q in str(f).lower() for f in fields if f)  # noqa: E731
    out: list[dict] = []

    def add(kind: str, items: list[dict]):
        out.extend({"kind": kind, **i} for i in items[:PER_KIND])

    for kind, label, items in (("qemu", "VM", qemu), ("lxc", "Container", lxc)):
        add(kind, [{"title": g.get("name") or f"{kind}-{g['vmid']}", "subtitle": f"{label} {g['vmid']} · {g.get('status', '')}",
                    "target": {"type": kind, "vmid": int(g["vmid"]), "name": g.get("name") or "", "status": g.get("status", "")}}
                   for g in items if hit(g.get("name"), g["vmid"], g.get("tags"))])
    add("pool", [{"title": p["name"], "subtitle": f"ZFS pool · {p.get('health', '')}", "target": {"pool": p["name"]}}
                 for p in pools if hit(p.get("name"))])
    add("dataset", [{"title": d["name"], "subtitle": f"Dataset · {d.get('mountpoint', '')}", "target": {"path": "/" + d["name"]}}
                    for d in ds if d.get("type") == "filesystem" and not d.get("guest_volume") and hit(d["name"])])
    add("share", [{"title": s["name"], "subtitle": f"SMB share · {s['path']}", "target": {"path": s["path"]}}
                  for s in share_list if hit(s["name"], s.get("comment"), s.get("path"))])
    add("app", [{"title": a["name"], "subtitle": f"App Center · {a['category']}", "target": {"app_id": a["id"]}}
                for a in apps.CATALOG if hit(a["name"], a["category"], a["description"])])
    add("section", [{"title": t, "subtitle": "Control Panel", "target": {"section": sid}}
                    for sid, t, kw in SECTIONS if hit(t, kw)])
    return out


@router.get("/api/search")
async def search(q: str = Query(min_length=1, max_length=100)):
    guests, pools, ds = await asyncio.gather(get_provider().guest_rows(), get_provider().zfs_pool_list(), _datasets())
    qemu, lxc = ([g for g in guests if g["type"] == k] for k in ("qemu", "lxc"))
    return {"query": q, "results": build_results(q, qemu, lxc, pools or [], ds, _shares())}


# ---------------------------------------------------------------- App usage

USAGE_MAX_APPS = 64  # caps the file if a client sends made-up ids
_usage_lock = threading.Lock()  # sync routes run in a thread pool: serialize read-modify-write


class UsageRecord(BaseModel):
    app_id: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,31}$")]


def load_usage() -> dict:
    try:
        data = json.loads(settings.app_usage_file.read_text())
    except (FileNotFoundError, ValueError):  # missing or hand-damaged: start from zero
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}


def _save_usage(data: dict) -> None:
    settings.app_usage_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.app_usage_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(settings.app_usage_file)  # atomic: a crash never leaves a half-written file


@router.get("/api/system/app-usage")
def get_app_usage():
    return load_usage()


@router.post("/api/system/app-usage/record")
def record_app_usage(body: UsageRecord = Body(...)):
    with _usage_lock:
        data = load_usage()
        if body.app_id not in data and len(data) >= USAGE_MAX_APPS:
            return {"app_id": body.app_id, "launch_count": 0, "last_opened_at": None}
        prev = data.get(body.app_id, {})
        count = prev.get("launch_count") if isinstance(prev.get("launch_count"), int) else 0
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        data[body.app_id] = {"launch_count": count + 1, "last_opened_at": now}
        _save_usage(data)
    return {"app_id": body.app_id, **data[body.app_id]}


@router.delete("/api/system/app-usage")
def reset_app_usage():
    """Clear every counter. SolarDeck has a single (admin) login, which require_user already enforces."""
    with _usage_lock:
        _save_usage({})
    return {}
