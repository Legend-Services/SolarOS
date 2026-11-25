"""Proxmox Help Center checks and fixes: APT update sources (enterprise vs no-subscription), pending updates, backup jobs."""
import asyncio

from fastapi import HTTPException

from app.backups import ScheduleBody
from app.help_center import check_updates, item

from .api import _node, _safe, pve
from .routes.backups import schedule_params
from .routes.system import flatten


def check_repos(repos: dict, subscription: dict) -> dict:
    flat = flatten(repos or {})["repositories"]
    has_sub = (subscription or {}).get("status") == "active"
    enterprise = [r for r in flat if r["enabled"] and (r["handle"] or "").endswith("enterprise")]
    no_sub = any(r["enabled"] and r["handle"] == "no-subscription" for r in flat)
    manual = ["Open the System app and go to Repositories.",
              "Switch OFF every repository marked 'enterprise' (Proxmox VE and Ceph).",
              "Click 'Add' next to 'No-Subscription' so updates still arrive.",
              "Go to Updates and press 'Refresh' — the 401 errors are gone."]
    if has_sub or not enterprise:
        status = "ok" if no_sub or has_sub else "warning"
        return item("repos", "Update sources (APT repositories)", status,
                    "Your update sources are set up correctly." if status == "ok" else
                    "No Proxmox update source is enabled, so the host never receives updates.",
                    fix=None if status == "ok" else {"label": "Add the free No-Subscription source",
                                                     "changes": ["Adds the Proxmox 'no-subscription' repository"], "reboot": False},
                    manual=[] if status == "ok" else manual, link={"app": "system"})
    return item("repos", "Update sources (APT repositories)", "warning",
                "The paid 'Enterprise' update source is on, but this server has no subscription. Updates fail with "
                "'401 Unauthorized' and you miss security fixes.",
                f"Enabled enterprise sources: {', '.join(sorted({r['path'] for r in enterprise}))}",
                {"label": "Switch to the free No-Subscription updates",
                 "changes": [f"Turns off {len(enterprise)} enterprise source(s)"] +
                            ([] if no_sub else ["Adds the Proxmox 'no-subscription' repository"]), "reboot": False},
                manual, {"app": "system"})


def backup_storage(storages: list) -> str | None:
    return next((s["storage"] for s in storages or [] if s.get("enabled", 1) and s.get("active", 1)
                 and "backup" in (s.get("content") or "")), None)


def check_backups(jobs: list, storages: list) -> dict:
    if any(j.get("enabled", 1) for j in jobs or []):
        return item("backups", "Automatic backups", "ok", "At least one automatic backup job is active.", link={"app": "backup"})
    target = backup_storage(storages)
    return item("backups", "Automatic backups", "warning",
                "No automatic backups are scheduled. If a disk dies or an update goes wrong, your VMs and containers are lost.",
                f"Suggested storage: {target}" if target else "No storage accepts backups yet.",
                {"label": f"Back up every guest each Sunday at 02:00 to '{target}'",
                 "changes": ["Creates a Proxmox backup job for all VMs and containers (snapshot mode, zstd)",
                             "Keeps the last 4 backups of each guest"], "reboot": False} if target else None,
                ["Open Backup Center → Schedules → 'New schedule'.", "Choose 'All guests', a storage and a time (e.g. Sunday 02:00).",
                 "Set 'Keep last' to 4 or more and save.", "Tip: store backups on a different disk than your VMs."],
                {"app": "backup"})


async def diagnostics() -> list[dict]:
    repos, sub, updates, jobs, stores = await asyncio.gather(
        _safe(_node("/apt/repositories")), _safe(_node("/subscription"), {}), _safe(_node("/apt/update")),
        _safe("/cluster/backup"), _safe(_node("/storage"), [], params={"content": "backup"}))
    # A None result means the Proxmox API call failed: skip that check instead of reporting a false problem.
    items = [check_repos(repos, sub)] if repos is not None else []
    items += [check_updates(updates)] if updates is not None else []
    items += [check_backups(jobs, stores)] if jobs is not None else []
    return items


async def fix(fix_id: str) -> dict:
    if fix_id == "repos":
        data = await pve("GET", _node("/apt/repositories")) or {}
        flat = flatten(data)
        for r in flat["repositories"]:
            if r["enabled"] and (r["handle"] or "").endswith("enterprise"):
                await pve("POST", _node("/apt/repositories"), data={"path": r["path"], "index": r["index"], "enabled": 0})
        if not any(r["enabled"] and r["handle"] == "no-subscription" for r in flat["repositories"]):
            await pve("PUT", _node("/apt/repositories"), data={"handle": "no-subscription"})
        await pve("POST", _node("/apt/update"))
        return {"message": "Enterprise sources are off and the free No-Subscription source is on. The update list is refreshing."}
    stores = await _safe(_node("/storage"), [], params={"content": "backup"})
    target = backup_storage(stores)
    if not target:
        raise HTTPException(409, "No storage accepts backups. Add one in Storage & ZFS → Storage backends first.")
    await pve("POST", "/cluster/backup", data=schedule_params(ScheduleBody(
        schedule="sun 02:00", storage=target, keep_last=4, comment="Created by the SolarDeck Help Center")))
    return {"message": f"Every VM and container is now backed up each Sunday at 02:00 to '{target}' (last 4 kept)."}
