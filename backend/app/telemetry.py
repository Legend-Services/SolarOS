"""Hardware telemetry: disk SMART/temperatures from the active provider, GPUs from the host helper (or locally)."""
import asyncio
import glob
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from . import host
from .auth import require_user
from providers.registry import get_provider

router = APIRouter(prefix="/api/v1/telemetry", tags=["telemetry"], dependencies=[Depends(require_user)])

NVIDIA_QUERY = ["nvidia-smi", "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw",
                "--format=csv,noheader,nounits"]
NO_GPU = {"available": False, "name": None, "temp_c": None, "utilization_pct": None, "vram_used_mb": None,
          "vram_total_mb": None, "power_w": None}
CACHE_TTL = 30  # smartctl spins up every disk; don't run it on every poll
_cache: tuple[float, dict] | None = None


def smart_temp(smart: dict) -> int | None:
    """Temperature in °C from a SMART result (NVMe text output or ATA attribute table)."""
    m = re.search(r"^Temperature:\s+(\d+)\s*Celsius", smart.get("text") or "", re.M)
    if m:
        return int(m.group(1))
    for want in ("194", "190"):  # Temperature_Celsius, then Airflow_Temperature_Cel
        for a in smart.get("attributes") or []:
            if str(a.get("id", "")).strip() == want:
                m = re.match(r"\s*(\d+)", str(a.get("raw", "")))
                if m:
                    return int(m.group(1))
    return None


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:
        return None  # "[N/A]", "[Not Supported]"


def parse_gpu_probe(out: str) -> dict:
    """Parse `dri:<node>:<vendor>` and `nvidia:<csv>` lines (from the helper's hw-info or local_probe)."""
    nodes, gpus = [], []
    for line in out.splitlines():
        kind, _, rest = line.partition(":")
        if kind == "dri":
            path, _, vendor = rest.partition(":")
            nodes.append({"path": path, "vendor": vendor, "intel": vendor.lower() == "0x8086"})
        elif kind == "nvidia":
            c = [x.strip() for x in rest.split(",")]
            if len(c) != 6:
                continue
            num = [_num(x) for x in c[1:]]
            gpus.append({"available": True, "name": c[0], "temp_c": num[0], "utilization_pct": num[1],
                         "vram_used_mb": num[2], "vram_total_mb": num[3], "power_w": num[4]})
    return {
        # shortcut: only the first NVIDIA GPU is reported; return the full list when multi-GPU hosts matter.
        "gpu": gpus[0] if gpus else NO_GPU,
        "igpu": {"available": bool(nodes), "quicksync": any(n["intel"] for n in nodes), "render_nodes": nodes},
    }


async def local_probe() -> str:
    """Same output format as the helper's hw-info, for devices visible to this container."""
    lines = []
    for node in sorted(glob.glob("/dev/dri/renderD*")):
        vendor = Path(f"/sys/class/drm/{Path(node).name}/device/vendor")
        lines.append(f"dri:{node}:{vendor.read_text().strip() if vendor.exists() else ''}")
    if shutil.which("nvidia-smi"):
        try:
            proc = await asyncio.create_subprocess_exec(*NVIDIA_QUERY, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(proc.communicate(), 10)
            lines += [f"nvidia:{x}" for x in out.decode(errors="replace").splitlines() if x.strip()]
        except (OSError, asyncio.TimeoutError):
            pass
    return "\n".join(lines)


async def gpu_info() -> dict:
    try:
        out = await host.run(["hw-info"], timeout=20)
    except HTTPException:
        out = ""  # helper missing or old: fall back to what this container sees
    local = parse_gpu_probe(await local_probe())
    hostside = parse_gpu_probe(out)
    return {"gpu": hostside["gpu"] if hostside["gpu"]["available"] else local["gpu"],
            "igpu": hostside["igpu"] if hostside["igpu"]["available"] else local["igpu"]}


async def disk_info() -> list[dict]:
    p = get_provider()
    disks = await p.raw_disks() or []
    smarts = await asyncio.gather(*[p.disk_smart_raw(d["devpath"]) for d in disks])
    out = []
    for d, s in zip(disks, smarts):
        s = s or {}
        wear = d.get("wearout")
        out.append({
            "devpath": d["devpath"], "model": d.get("model"), "serial": d.get("serial"), "type": d.get("type"),
            "size": d.get("size", 0), "health": s.get("health") or d.get("health") or "UNKNOWN",
            # wearout is the remaining rated life in % (100 - NVMe percentage_used), "N/A" for HDDs.
            "life_left_pct": wear if isinstance(wear, (int, float)) else None,
            "temp_c": smart_temp(s),
        })
    return out


async def hardware(force: bool = False) -> dict:
    global _cache
    if not force and _cache and time.monotonic() - _cache[0] < CACHE_TTL:
        return _cache[1]
    disks, gpus = await asyncio.gather(disk_info(), gpu_info())
    data = {"disks": disks, **gpus}
    _cache = (time.monotonic(), data)
    return data


@router.get("/hardware")
async def hardware_route():
    return await hardware()
