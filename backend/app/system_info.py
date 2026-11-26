"""Settings › System › Info: OS, update and hardware summary added to GET /api/system/info by both drivers."""
import asyncio
import logging
import os
import platform
import re
import time

from providers.base import NodeMetrics
from providers.registry import get_provider

from . import cluster, hardware_admin, updater
from .config import settings

log = logging.getLogger(__name__)
CACHE_TTL = 30  # seconds: the guest wizard and Control Panel call /system/info too, the host probe is not free
_cache: tuple[float, dict] | None = None


def invalidate() -> None:
    global _cache
    _cache = None


def rows(v) -> list[dict]:
    """Only the dict rows of a list: unexpected host or API output must never fail the Info page."""
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def gpu_type(g: dict) -> str:
    # shortcut: Intel non-Arc or a bus-00 device counts as integrated; upgrade if a probe reports it directly.
    name = (g.get("name") or "").lower()
    on_die = (g.get("id") or "").startswith("00:")
    return "integrated" if on_die or (g.get("vendor") == "intel" and "arc" not in name) else "discrete"


def gpu_row(g: dict) -> dict:
    m = g.get("metrics") or {}
    vram = g.get("vram_bytes")
    return {"slot": g.get("id"), "name": m.get("name") or g.get("name"), "vendor": g.get("vendor"), "gpu_type": gpu_type(g),
            "vram_total_mb": m.get("vram_total_mib") or (round(vram / 1048576) if vram else None),
            "vram_used_mb": m.get("vram_used_mib"), "driver": g.get("driver"), "temperature_c": m.get("temp_c"),
            "passthrough_bound": g.get("driver") == "vfio-pci"}


def memory_type_speed(dimms: list[dict]) -> str | None:
    d = next((x for x in dimms if x.get("size")), None)
    if not d:
        return None
    speed = d.get("configured_speed") or d.get("speed")
    return " ".join(x for x in (d.get("type"), speed) if x and x != "Unknown") or None


def storage_summary(drives: list[dict], pools: list[dict]) -> dict:
    drives, pools = rows(drives), rows(pools)
    ok = sum(1 for d in drives if str(d.get("health") or "").upper() in ("PASSED", "OK"))
    bad = sum(1 for d in drives if str(d.get("health") or "").upper() in ("FAILED", "FAILING", "WARNING"))
    return {"physical_disk_count": len(drives), "total_raw_bytes": sum(int(d.get("size") or 0) for d in drives),
            "healthy_disks": ok, "degraded_disks": bad, "pool_count": len(pools),
            "pools_summary": [{"name": p.get("name"), "health": p.get("health"), "used_bytes": int(p.get("alloc") or 0),
                               "total_bytes": int(p.get("size") or 0)} for p in pools]}


def hardware(inv: dict, metrics, pools: list[dict]) -> dict:
    cpu, mem = inv.get("cpu") or {}, inv.get("memory") or {}
    mhz = cpu.get("mhz") or {}
    return {
        "cpu": {"model": cpu.get("model") or metrics.cpuinfo.get("model"), "sockets": cpu.get("sockets") or metrics.cpuinfo.get("sockets"),
                "physical_cores": cpu.get("cores") or metrics.cpuinfo.get("cores"),
                "logical_threads": cpu.get("threads") or metrics.cpuinfo.get("cpus"),
                "current_freq_mhz": mhz.get("avg") or cpu.get("max_mhz"), "temperature_c": cpu.get("package_c"),
                "load_avg": [float(x) for x in metrics.loadavg][:3]},
        "memory": {"total_bytes": mem.get("total") or metrics.memory.get("total", 0),
                   "used_bytes": mem.get("used") or metrics.memory.get("used", 0),
                   "available_bytes": mem.get("available") or metrics.memory.get("free", 0),
                   "zfs_arc_bytes": mem.get("arc", 0), "swap_total_bytes": mem.get("swap_total") or metrics.swap.get("total", 0),
                   "swap_used_bytes": mem.get("swap_used") or metrics.swap.get("used", 0),
                   "memory_type_speed": memory_type_speed(mem.get("dimms") or [])},
        "gpus": [gpu_row(g) for g in rows(inv.get("gpus"))],
        "storage": storage_summary((inv.get("storage") or {}).get("drives") or [], pools),
    }


def updates(st: dict) -> dict:
    notes = "; ".join(r["subject"] for r in (st.get("incoming") or [])[:3]) or None
    return {"current_version": st.get("current_version"), "latest_version": st.get("latest_version"),
            "update_available": bool(st.get("update_available")), "last_checked": st.get("last_checked"),
            "release_notes_summary": notes, "channel": st.get("branch")}


async def _safe(coro, default):
    try:
        return await coro
    except Exception:  # noqa: BLE001 - one missing source must not fail the whole Info page
        log.exception("system info: a source failed")
        return default


async def _extra() -> dict:
    global _cache
    if _cache and time.monotonic() - _cache[0] < CACHE_TTL:
        return _cache[1]
    p = get_provider()
    inv, metrics, pools, st = await asyncio.gather(
        _safe(hardware_admin.inventory(), {}), _safe(p.get_node_metrics(), NodeMetrics()), _safe(p.zfs_pool_list(), []),
        _safe(updater.status(check_remote=False), {}))
    data = {"metrics": metrics, "hardware": hardware(inv, metrics, pools or []), "updates": updates(st or {})}
    _cache = (time.monotonic(), data)
    return data


def os_pretty_name() -> str:
    try:
        text = open("/etc/os-release").read()
    except OSError:
        return platform.system()
    m = re.search(r'^PRETTY_NAME="?([^"\n]*)"?$', text, re.M)
    return m.group(1) if m else platform.system()


async def enrich(base: dict, *, hostname_editable: bool = False) -> dict:
    """Add the `os`, `updates` and `hardware` blocks to a driver's /system/info answer (its own keys stay)."""
    x = await _extra()
    caps = get_provider().get_capabilities()
    st = cluster.load()
    clustered = cluster.in_cluster(st)
    return {**base, "updates": x["updates"], "hardware": x["hardware"], "os": {
        "product_name": updater.edition()["edition"],
        "release_version": x["updates"]["current_version"], "os_pretty_name": base.get("platform_version") or os_pretty_name(),  # the host, not this container
        "kernel_version": base.get("kernel") or x["metrics"].kernel or platform.release(),
        "architecture": platform.machine() or os.uname().machine, "hypervisor_driver": caps.driver,
        "hostname": base.get("node") or settings.node_name, "uptime_seconds": base.get("uptime") or x["metrics"].uptime,
        "cluster_mode": st.get("mode", "standalone"), "cluster_name": st["shared"].get("name") or None if clustered else None,
        # Renaming a hypervisor node moves its guest configs; only the native driver renames, and never while clustered.
        "hostname_editable": hostname_editable and not clustered,
    }}
