"""Health alerts evaluated from live hypervisor state on every request."""
import asyncio
import time

from fastapi import APIRouter, Depends

from . import automation, telemetry, updater
from .auth import require_user
from providers.registry import get_provider

router = APIRouter(prefix="/api/notifications", tags=["notifications"], dependencies=[Depends(require_user)])

DISK_TEMP_C = 55
CAPACITY_PERCENT = 85
CAPACITY_CRITICAL_PERCENT = 95
FRAG_PERCENT = 80
TASK_WINDOW_S = 24 * 3600
RANK = {"critical": 0, "warning": 1, "info": 2}


def _alert(id_: str, severity: str, category: str, title: str, message: str) -> dict:
    return {"id": id_, "severity": severity, "category": category, "title": title, "message": message}


def _capacity(id_: str, label: str, used: float, total: float) -> list[dict]:
    if not total:
        return []
    p = used / total * 100
    if p < CAPACITY_PERCENT:
        return []
    sev = "critical" if p >= CAPACITY_CRITICAL_PERCENT else "warning"
    return [_alert(id_, sev, "capacity", f"{label} is {p:.0f}% full", f"{label} has crossed the {CAPACITY_PERCENT}% threshold.")]


def evaluate(pools: list[dict], details: list[dict], targets: list[dict], status: dict, disks: list[dict],
             tasks: list[dict]) -> list[dict]:
    alerts: list[dict] = []
    for p, d in zip(pools, details):
        name, health = p.get("name", "?"), (p.get("health") or "UNKNOWN").upper()
        scan = (d or {}).get("scan") or ""
        if health != "ONLINE":
            sev = "warning" if health == "DEGRADED" and "resilver" in scan else "critical"
            alerts.append(_alert(f"zfs-health:{name}", sev, "zfs", f"ZFS pool {name} is {health}",
                                 (d or {}).get("status") or "Check the pool topology in Storage & ZFS."))
        if "resilver in progress" in scan:
            alerts.append(_alert(f"zfs-resilver:{name}", "warning", "zfs", f"ZFS pool {name} is resilvering", scan))
        elif "scrub in progress" in scan:
            alerts.append(_alert(f"zfs-scrub:{name}", "info", "zfs", f"Scrub running on {name}", scan))
        if (p.get("frag") or 0) > FRAG_PERCENT:
            alerts.append(_alert(f"zfs-frag:{name}", "warning", "zfs", f"ZFS pool {name} is {p['frag']}% fragmented",
                                 f"Fragmentation above {FRAG_PERCENT}% slows writes; free up space."))
        alerts += _capacity(f"zfs-cap:{name}", f"ZFS pool {name}", p.get("alloc") or 0, p.get("size") or 0)

    for t in targets:
        if t.get("active"):
            alerts += _capacity(f"storage-cap:{t['storage']}", f"Storage {t['storage']}", t.get("used") or 0,
                                t.get("total") or 0)
    rootfs = status.get("rootfs") or {}
    alerts += _capacity("rootfs-cap", "Host root filesystem", rootfs.get("used") or 0, rootfs.get("total") or 0)

    for d in disks:
        dev = d["devpath"]
        if d["health"].upper() not in ("PASSED", "OK", "UNKNOWN"):
            alerts.append(_alert(f"smart:{dev}", "critical", "disk", f"SMART failure on {dev}",
                                 f"{d.get('model') or 'Disk'} reports SMART status {d['health']}. Back up and replace it."))
        if d["temp_c"] is not None and d["temp_c"] > DISK_TEMP_C:
            alerts.append(_alert(f"disk-temp:{dev}", "warning", "disk", f"{dev} is at {d['temp_c']}°C",
                                 f"{d.get('model') or 'Disk'} is above {DISK_TEMP_C}°C. Check cooling and airflow."))

    for t in tasks:
        if t["state"] == "error":
            alerts.append(_alert(f"task:{t['upid']}", "warning", "task", f"Task {t['type']} {t['id']}".strip() + " failed",
                                 f"{t['status']} ({time.strftime('%Y-%m-%d %H:%M', time.localtime(t['starttime']))})"))

    return sorted(alerts, key=lambda a: RANK[a["severity"]])


@router.get("")
async def notifications():
    since = int(time.time()) - TASK_WINDOW_S
    p = get_provider()
    pools, targets, status, hw, tasks = await asyncio.gather(
        p.zfs_pool_list(), p.storage_list(), p.host_status(), telemetry.hardware(), p.failed_tasks(since))
    pools = pools or []
    details = await asyncio.gather(*[p.zfs_pool_detail(x["name"]) for x in pools])
    alerts = evaluate(pools, details, targets or [], status or {}, hw["disks"], tasks or [])
    u = updater.load_settings()
    if u["mode"] != "manual" and u["update_available"]:
        alerts.append(_alert("solardeck-update", "info", "update", "SolarDeck update available",
                             f"Version {u['latest_remote_tag'] or (u['latest_remote_commit'] or '')[:10]} is ready. "
                             "Install it in Control Panel → System & Updates."))
    alerts += automation.recent_alerts()
    alerts.sort(key=lambda a: RANK[a["severity"]])
    counts = {s: sum(a["severity"] == s for a in alerts) for s in RANK}
    return {"alerts": alerts, "counts": counts, "generated_at": int(time.time())}
