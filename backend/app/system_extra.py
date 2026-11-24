"""Spotlight search index."""
import asyncio
import time

from fastapi import APIRouter, Depends, Query

from . import apps, shares
from .auth import require_user
from .pve import _node, _safe
from .storage_admin import datasets

router = APIRouter(tags=["system-extra"], dependencies=[Depends(require_user)])

PER_KIND = 8

# Control Panel sections, matched on title + keywords.
SECTIONS = [
    ("security", "User & Security", "password two-factor 2fa totp authenticator api token login"),
    ("network", "Network & DNS", "interfaces bridge vmbr dns resolver ip gateway"),
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
    qemu, lxc, pools, ds = await asyncio.gather(
        _safe(_node("/qemu"), []), _safe(_node("/lxc"), []), _safe(_node("/disks/zfs"), []), _datasets())
    return {"query": q, "results": build_results(q, qemu or [], lxc or [], pools or [], ds, _shares())}
