"""Host hardware inventory and the multi-vendor GPU driver / mode manager.

Everything is read in one SSH round trip (PROBE, sections split by @@name@@ markers) plus the shared PCI probe.
Temperatures come from /sys/class/hwmon (the kernel data lm-sensors reads), so no extra package is needed.
Driver installs and vfio-pci mode switches run as detached host jobs (host_ssh.start_job) with streamed logs.
"""
import asyncio
import json
import logging
import re
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import host_ssh, pci, task_progress
from .config import settings
from .auth import require_step_up_auth, require_user
from providers.registry import driver_package, get_provider

router = APIRouter(tags=["hardware_admin"], dependencies=[Depends(require_user)])
log = logging.getLogger(__name__)

PLATFORM = driver_package()
PKGS = ("nvidia-container-toolkit", "intel-media-va-driver-non-free", "intel-gpu-tools", "vainfo", *PLATFORM.HOST_PACKAGES,
        "radeontop", "rocminfo", "rocm-smi", "lm-sensors")
VFIO_CONF = f"/etc/modprobe.d/{settings.name('vfio')}.conf"
BLACKLIST_CONF = f"/etc/modprobe.d/{settings.name('blacklist')}.conf"
VFIO_MODULES = f"/etc/modules-load.d/{settings.name('vfio')}.conf"
NVIDIA_Q = "pci.bus_id,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw"
NVIDIA_CMD = f"command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu={NVIDIA_Q} --format=csv,noheader,nounits 2>/dev/null"
AMD_CMD = "for f in /sys/bus/pci/devices/*/mem_info_vram_total; do [ -e \"$f\" ] && echo \"$f $(cat $f)\"; done"

PROBE = f"""
echo @@dmi@@; dmidecode -t 0,1,2 2>/dev/null
echo @@dimm@@; dmidecode -t 17 2>/dev/null
echo @@lscpu@@; lscpu -J 2>/dev/null
echo @@mhz@@; grep '^cpu MHz' /proc/cpuinfo
echo @@hwmon@@
for h in /sys/class/hwmon/hwmon*; do n=$(cat $h/name 2>/dev/null)
  for t in $h/temp*_input; do [ -e "$t" ] || continue
    echo "$n|$(cat ${{t%_input}}_label 2>/dev/null || echo temp)|$(cat $t 2>/dev/null)"; done; done
echo @@meminfo@@; cat /proc/meminfo
echo @@arc@@; grep '^size ' /proc/spl/kstat/zfs/arcstats 2>/dev/null
echo @@nvidia@@; {NVIDIA_CMD}
echo @@amd@@; {AMD_CMD}
echo @@intel@@; cat /sys/module/i915/parameters/enable_guc 2>/dev/null
grep -iH -m1 'status' /sys/kernel/debug/dri/*/gt*/uc/guc_info /sys/kernel/debug/dri/*/gt*/uc/huc_info 2>/dev/null
echo @@ipaddr@@; ip -j addr
echo @@netsys@@
for n in /sys/class/net/*; do b=$(basename $n); [ "$b" = bonding_masters ] && continue
  d=$(readlink $n/device/driver 2>/dev/null); echo "$b|$(cat $n/speed 2>/dev/null)|${{d##*/}}|$([ -e $n/device ] && echo phys || echo virt)"; done
echo @@smart@@
for d in /dev/nvme?n1 /dev/sd?; do [ -e "$d" ] || continue
  echo "$d|$(smartctl -A -j $d 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("temperature",{{}}).get("current",""))' 2>/dev/null)"; done
echo @@pkgs@@; dpkg-query -W -f='${{Package}}|${{Version}}|${{db:Status-Status}}\\n' {' '.join(PKGS)} 2>/dev/null
echo @@vfio@@; cat {VFIO_CONF} 2>/dev/null
echo @@kernel@@; uname -r; ls /lib/modules/$(uname -r)/updates/dkms 2>/dev/null | grep -m1 '^nvidia'
"""


# ---------------------------------------------------------------- Pure parsers


def split_sections(out: str) -> dict[str, str]:
    parts = re.split(r"^@@(\w+)@@$", out, flags=re.M)
    return {parts[i]: parts[i + 1].strip("\n") for i in range(1, len(parts) - 1, 2)}


def parse_dmi(text: str) -> list[tuple[str, dict]]:
    """dmidecode text → [(block title, {key: value})]; list-valued keys (Characteristics, Features) are skipped."""
    blocks = []
    for chunk in re.split(r"\n\s*\n", text):
        lines = [x for x in chunk.splitlines() if x.strip()]
        i = next((n for n, x in enumerate(lines) if x.startswith("Handle ")), None)
        if i is None or i + 1 >= len(lines):
            continue
        kv = {}
        for x in lines[i + 2:]:
            if x.startswith("\t") and not x.startswith("\t\t") and ": " in x:
                k, _, v = x.partition(": ")  # not strip() first: "\tAsset Tag:  " (empty value) loses its ": "
                kv[k.strip()] = v.strip()
        blocks.append((lines[i + 1].strip(), kv))
    return blocks


def parse_dimms(text: str) -> list[dict]:
    out = []
    for title, kv in parse_dmi(text):
        if title != "Memory Device":
            continue
        empty = kv.get("Size", "").startswith("No Module")
        out.append({"locator": kv.get("Locator", ""), "bank": kv.get("Bank Locator", ""),
                    "size": None if empty else kv.get("Size"), "type": None if empty else kv.get("Type"),
                    "speed": None if empty else kv.get("Speed"), "configured_speed": None if empty else
                    kv.get("Configured Memory Speed"), "manufacturer": None if empty else kv.get("Manufacturer"),
                    "part_number": None if empty else kv.get("Part Number")})
    return out


def parse_meminfo(text: str) -> dict[str, int]:
    """/proc/meminfo → bytes."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^(\w+):\s+(\d+)(?: kB)?$", line)
        if m:
            out[m.group(1)] = int(m.group(2)) * (1024 if line.endswith("kB") else 1)
    return out


def parse_hwmon(text: str) -> dict:
    """"chip|label|millidegrees" lines → CPU package/core temps and other sensors in °C."""
    cpu, cores, other = None, [], []
    for line in text.splitlines():
        chip, label, raw = (line.split("|") + ["", ""])[:3]
        if not raw.strip().lstrip("-").isdigit():
            continue
        c = round(int(raw) / 1000, 1)
        if chip in ("coretemp", "k10temp") and (label.startswith("Package") or label == "Tctl"):
            cpu = c if cpu is None else max(cpu, c)
        elif chip == "coretemp" and label.startswith("Core"):
            cores.append({"label": label, "c": c})
        else:
            other.append({"chip": chip, "label": label, "c": c})
    cores.sort(key=lambda x: int(re.sub(r"\D", "", x["label"]) or 0))
    return {"package_c": cpu, "cores": cores, "other": other}


def parse_nvidia(text: str) -> dict[str, dict]:
    """nvidia-smi csv (NVIDIA_Q order) → {"01:00.0": metrics}; MiB and W values as numbers."""
    num = lambda v: float(v) if re.fullmatch(r"[\d.]+", v) else None  # noqa: E731
    out = {}
    for line in text.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) != 8:
            continue
        bus = cols[0].lower()[-12:]  # "00000000:01:00.0" → "0000:01:00.0"
        out[bus[5:]] = {"name": cols[1], "driver_version": cols[2], "vram_total_mib": num(cols[3]),
                        "vram_used_mib": num(cols[4]), "util_pct": num(cols[5]), "temp_c": num(cols[6]),
                        "power_w": num(cols[7])}
    return out


def parse_amd_vram(text: str) -> dict[str, int]:
    out = {}
    for line in text.splitlines():
        m = re.match(r"^/sys/bus/pci/devices/[0-9a-f]{4}:([0-9a-f:.]+)/mem_info_vram_total (\d+)$", line)
        if m:
            out[m.group(1)] = int(m.group(2))
    return out


def parse_vfio_ids(text: str) -> list[str]:
    m = re.search(r"^options vfio-pci ids=([0-9a-f:,]+)", text, flags=re.M)
    return [x for x in m.group(1).split(",") if x] if m else []


def parse_pkgs(text: str) -> dict[str, str | None]:
    out: dict[str, str | None] = {p: None for p in PKGS}
    for line in text.splitlines():
        name, ver, status = (line.split("|") + ["", ""])[:3]
        if name in out and status == "installed":
            out[name] = ver
    return out


def parse_lscpu(text: str) -> dict[str, str]:
    try:
        return {f["field"].rstrip(":"): f.get("data") or "" for f in json.loads(text)["lscpu"]}
    except (ValueError, KeyError, TypeError, AttributeError):
        return {}


def num(v, cast=int):
    """Lenient number: '-', '' or '5800,0000' (comma locale) never raise; 0 and junk become None."""
    try:
        return cast(str(v).replace(",", ".")) or None
    except (TypeError, ValueError):
        return None


def parse_nics(ipaddr: str, netsys: str) -> list[dict]:
    sysinfo = {}
    for line in netsys.splitlines():
        name, speed, driver, kind = (line.split("|") + ["", "", ""])[:4]
        sysinfo[name] = {"speed_mbps": int(speed) if speed.isdigit() and int(speed) > 0 else None,
                         "driver": driver or None, "physical": kind == "phys"}
    try:
        links = json.loads(ipaddr or "[]")
    except ValueError:
        links = []
    out = []
    for link in links:
        name = link.get("ifname", "")
        if name == "lo":
            continue
        addrs = [f"{a['local']}/{a.get('prefixlen', '')}" for a in link.get("addr_info") or []
                 if a.get("local") and a.get("scope") != "link"]
        out.append({"name": name, "mac": link.get("address"), "state": link.get("operstate"), "mtu": link.get("mtu"),
                    "master": link.get("master"), "addresses": addrs,
                    **sysinfo.get(name, {"speed_mbps": None, "driver": None, "physical": False})})
    return sorted(out, key=lambda n: (not n["physical"], n["name"]))


def parse_kv_lines(text: str) -> dict[str, str]:
    return {a: b for a, _, b in (line.partition("|") for line in text.splitlines()) if a}


def gpu_mode(gpu: dict, vfio_ids: list[str], nvidia_built: bool) -> dict:
    ids = {f"{d['vendor_id']}:{d['device_id']}" for d in [gpu]}
    passthrough = bool(ids & set(vfio_ids))
    drv = gpu["driver"]
    reboot = (passthrough and drv != "vfio-pci") or (not passthrough and drv == "vfio-pci") or \
             (gpu["vendor"] == "nvidia" and nvidia_built and not passthrough and drv != "nvidia")
    return {"mode": "passthrough" if passthrough else "host", "reboot_required": reboot}


def vfio_files(ids: list[str], vendors: set[str]) -> dict[str, str | None]:
    """Contents of the managed modprobe/modules files for a set of passthrough ids (None = delete the file)."""
    if not ids:
        return {VFIO_CONF: None, BLACKLIST_CONF: None,
                VFIO_MODULES: None}
    mods = {"nvidia": ["nouveau", "nvidia", "nvidiafb", "nvidia_drm"], "amd": ["amdgpu", "radeon"]}
    black = [m for v in sorted(vendors) for m in mods.get(v, [])]
    soft = "".join(f"softdep {m} pre: vfio-pci\n" for m in ["nouveau", "nvidia", "amdgpu", "radeon", "snd_hda_intel", "i915"])
    return {VFIO_CONF: f"# Managed by SolarDeck (GPU passthrough)\noptions vfio-pci ids={','.join(ids)}\n{soft}",
            BLACKLIST_CONF: "# Managed by SolarDeck\n" + "".join(f"blacklist {m}\n" for m in black)
            if black else None,
            VFIO_MODULES: "vfio\nvfio_iommu_type1\nvfio_pci\n"}


# ---------------------------------------------------------------- Inventory


async def _pci() -> dict:
    """lspci over the bridge, else the provider's PCI list (no drivers or kernel cmdline from that source)."""
    try:
        probe = await pci.probe()
        if probe["devices"]:
            return probe
    except HTTPException:
        pass
    return pci.parse(pci.from_api(await get_provider().pci_devices_raw() or []))


async def _collect() -> tuple[dict[str, str], dict, bool, str]:
    """(sections, pci probe, bridge connected, bridge message). Never raises: missing tools leave sections empty."""
    (ok, out, err), probe = await asyncio.gather(host_ssh.run_host_cmd(PROBE + "\ntrue", timeout=40), _pci())
    connected = ok or bool(out.strip())
    return split_sections(out), probe, connected, "Connected" if connected else (err.strip() or "No response from host")


def fill_from_status(inv: dict, st: dict) -> dict:
    """Fill CPU, memory and kernel gaps (no SSH bridge, no dmidecode/lscpu) from the provider's host status."""
    ci, mem, swap = st.get("cpuinfo") or {}, st.get("memory") or {}, st.get("swap") or {}
    c, m, flags = inv["cpu"], inv["memory"], str(ci.get("flags", "")).split()
    c["model"] = c["model"] or ci.get("model")
    c["sockets"] = c["sockets"] or num(ci.get("sockets"))
    c["cores"] = c["cores"] or ((num(ci.get("cores")) or 0) * (num(ci.get("sockets")) or 1)) or None
    c["threads"] = c["threads"] or num(ci.get("cpus"))
    c["max_mhz"] = c["max_mhz"] or num(ci.get("mhz"), float)
    if not m["total"] and mem.get("total"):
        m.update(total=mem["total"], used=mem.get("used", 0), available=mem["total"] - mem.get("used", 0),
                 swap_total=swap.get("total", 0), swap_used=swap.get("used", 0))
    inv["system"]["kernel"] = inv["system"]["kernel"] or (st.get("current-kernel") or {}).get("release") or st.get("kversion")
    inv["virtualization"]["cpu"] = inv["virtualization"]["cpu"] or ("VT-x" if "vmx" in flags else "AMD-V" if "svm" in flags else None)
    return inv


def guard(section: str, fn, default):
    """Run one section parser; unexpected host output empties that section only (logged), never the whole inventory."""
    try:
        return fn()
    except Exception:
        log.exception("hardware inventory: could not parse the %s section", section)
        return default


def _gpu(d: dict, vfio: list[str], nvidia_built: bool, nv: dict, amd: dict, intel: list[str]) -> dict:
    g = {**pci.gpu_view(d), **gpu_mode(d, vfio, nvidia_built), "metrics": nv.get(d["id"]),
         "vram_bytes": int(nv[d["id"]]["vram_total_mib"] * 1024 * 1024) if d["id"] in nv and nv[d["id"]]["vram_total_mib"]
         else amd.get(d["id"])}
    if d["vendor"] == "intel":
        uc = {m.group(1): m.group(2) for m in (re.search(r"/uc/(guc|huc)_info:\s*status:\s*(\S+)", x) for x in intel[1:]) if m}
        g["firmware"] = {"enable_guc": intel[0] if intel else None, "guc": uc.get("guc"), "huc": uc.get("huc")}
    return g


def _drive(x: dict, smart: dict[str, str]) -> dict:
    t = smart.get(x.get("devpath") or "", "")
    return {"devpath": x.get("devpath"), "model": x.get("model"), "serial": x.get("serial"), "size": x.get("size"),
            "type": x.get("type"), "wearout": x.get("wearout"), "health": x.get("health"),
            "temp_c": int(t) if t.isdigit() else None}


def build_inventory(s: dict[str, str], probe: dict, disks: list[dict]) -> dict:
    dmi = guard("dmi", lambda: {t: kv for t, kv in parse_dmi(s.get("dmi", ""))}, {})
    sysi, board, bios = dmi.get("System Information", {}), dmi.get("Base Board Information", {}), dmi.get("BIOS Information", {})
    cpu = guard("lscpu", lambda: parse_lscpu(s.get("lscpu", "")), {})
    mhz = guard("mhz", lambda: [float(x) for x in re.findall(r"cpu MHz\s*:\s*([\d.]+)", s.get("mhz", ""))], [])
    temps = guard("hwmon", lambda: parse_hwmon(s.get("hwmon", "")), {"package_c": None, "cores": [], "other": []})
    mem = guard("meminfo", lambda: parse_meminfo(s.get("meminfo", "")), {})
    arc = re.search(r"(\d+)\s*$", s.get("arc", ""))
    nv = guard("nvidia", lambda: parse_nvidia(s.get("nvidia", "")), {})
    amd = guard("amd", lambda: parse_amd_vram(s.get("amd", "")), {})
    intel = s.get("intel", "").splitlines()
    vfio = guard("vfio", lambda: parse_vfio_ids(s.get("vfio", "")), [])
    kernel = s.get("kernel", "").splitlines()
    nvidia_built = len(kernel) > 1
    smart = guard("smart", lambda: parse_kv_lines(s.get("smart", "")), {})
    devs = probe["devices"]
    gpus = [g for g in (guard(f"gpu {d.get('id')}", lambda d=d: _gpu(d, vfio, nvidia_built, nv, amd, intel), None)
                        for d in devs if d.get("gpu")) if g]
    return {
        "system": {"manufacturer": sysi.get("Manufacturer"), "product": sysi.get("Product Name"),
                   "board_manufacturer": board.get("Manufacturer"), "board": board.get("Product Name"),
                   "board_version": board.get("Version"), "bios_vendor": bios.get("Vendor"),
                   "bios_version": bios.get("Version"), "bios_date": bios.get("Release Date"),
                   "kernel": kernel[0] if kernel else None},
        "virtualization": {"cpu": cpu.get("Virtualization") or None, "iommu": probe["iommu_enabled"],
                           "cmdline": probe["cmdline"]},
        "cpu": {"model": cpu.get("Model name"), "sockets": num(cpu.get("Socket(s)")),
                "cores": ((num(cpu.get("Core(s) per socket")) or 0) * (num(cpu.get("Socket(s)")) or 1)) or None,
                "threads": num(cpu.get("CPU(s)")), "max_mhz": num(cpu.get("CPU max MHz"), float),
                "mhz": {"min": min(mhz), "avg": round(sum(mhz) / len(mhz)), "max": max(mhz)} if mhz else None,
                "package_c": temps["package_c"], "cores_c": temps["cores"]},
        "memory": {"total": mem.get("MemTotal", 0), "available": mem.get("MemAvailable", 0),
                   "used": mem.get("MemTotal", 0) - mem.get("MemAvailable", 0),
                   "cached": mem.get("Cached", 0) + mem.get("Buffers", 0), "arc": int(arc.group(1)) if arc else 0,
                   "swap_total": mem.get("SwapTotal", 0), "swap_used": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0),
                   "dimms": guard("dimm", lambda: parse_dimms(s.get("dimm", "")), [])},
        "gpus": gpus,
        "storage": {"controllers": [{"id": d["id"], "name": d["name"], "class_name": d["class_name"], "driver": d["driver"]}
                                    for d in devs if d["class"].startswith("01")],
                    "drives": [d for d in (guard("drive", lambda x=x: _drive(x, smart), None) for x in disks) if d]},
        "network": guard("network", lambda: parse_nics(s.get("ipaddr", ""), s.get("netsys", "")), []),
        "sensors": temps["other"],
        "packages": guard("pkgs", lambda: parse_pkgs(s.get("pkgs", "")), {p: None for p in PKGS}),
    }


def safe_inventory(s: dict[str, str], probe: dict, disks: list[dict]) -> dict:
    try:
        return build_inventory(s, probe, disks)
    except Exception:  # unexpected host output must degrade to API data, never an HTTP 500
        log.exception("hardware inventory parse failed; using the hypervisor API data only")
        return build_inventory({}, probe, [])


@router.get("/api/hardware/inventory")
async def inventory():
    (s, probe, connected, message), disks, st = await asyncio.gather(
        _collect(), get_provider().raw_disks(), get_provider().host_status())
    inv = fill_from_status(safe_inventory(s, probe, disks or []), st or {})
    pub = host_ssh.public_key_or_none()
    return {**inv, "ssh_bridge_connected": connected, "ssh_bridge_message": message,
            "ssh_setup_command": None if connected or not pub else host_ssh.setup_command(pub)}


@router.get("/api/hardware/gpu-metrics")
async def gpu_metrics():
    """Light poll for live GPU numbers (nvidia-smi / amdgpu sysfs) while the panel is open."""
    _, out, _ = await host_ssh.run_host_cmd(f"echo @@nvidia@@; {NVIDIA_CMD}; echo @@amd@@; {AMD_CMD}", timeout=15)
    s = split_sections(out)
    return {"nvidia": parse_nvidia(s.get("nvidia", "")), "amd_vram": parse_amd_vram(s.get("amd", ""))}


# ---------------------------------------------------------------- Live thermals (2 s poll)

# Only sysfs/procfs reads and nvidia-smi: no lspci/dmidecode/smartctl, so one call stays well under a second.
THERMAL_NV_Q = "pci.bus_id,name,temperature.gpu,fan.speed,power.draw,memory.used,memory.total,utilization.gpu"
THERMAL_PROBE = f"""
echo @@hwmon@@
for h in /sys/class/hwmon/hwmon*; do n=$(cat $h/name 2>/dev/null); d=$(readlink -f $h/device 2>/dev/null)
  b=$(ls $d/block 2>/dev/null | head -n1)
  for t in $h/temp*_input $h/fan*_input $h/power1_average $h/power1_input; do [ -e "$t" ] || continue
    echo "$n|${{d##*/}}|$b|${{t##*/}}|$(cat ${{t%_input}}_label 2>/dev/null)|$(cat $t 2>/dev/null)"; done; done
echo @@freq@@
for c in /sys/devices/system/cpu/cpu[0-9]*; do echo "${{c##*cpu}}|$(cat $c/topology/core_id 2>/dev/null)|$(cat $c/cpufreq/scaling_cur_freq 2>/dev/null)"; done
echo @@mhz@@; grep '^cpu MHz' /proc/cpuinfo
echo @@stat@@; grep '^cpu[0-9]' /proc/stat
echo @@nvidia@@; command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu={THERMAL_NV_Q} --format=csv,noheader,nounits 2>/dev/null
true
"""
THERMAL_TTL = 1.5  # several open views (Hardware, Info, Resource & Thermal Monitor) share one host read per poll
GPU_HWMON = ("amdgpu", "radeon", "i915", "xe", "nouveau")
_thermals: tuple[float, dict] | None = None
_thermal_lock = asyncio.Lock()
_prev_stat: dict[str, tuple[int, int]] = {}


def parse_stat(text: str) -> dict[str, tuple[int, int]]:
    """/proc/stat cpuN lines → {"N": (busy jiffies, total jiffies)}."""
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) > 5 and f[0][3:].isdigit():
            v = [int(x) for x in f[1:] if x.isdigit()]
            idle = v[3] + (v[4] if len(v) > 4 else 0)  # idle + iowait
            out[f[0][3:]] = (sum(v) - idle, sum(v))
    return out


def load_pct(prev: dict[str, tuple[int, int]], cur: dict[str, tuple[int, int]]) -> dict[str, float]:
    out = {}
    for cpu, (busy, total) in cur.items():
        if cpu in prev and total > prev[cpu][1]:
            out[cpu] = round(100 * max(0, busy - prev[cpu][0]) / (total - prev[cpu][1]), 1)
    return out


def parse_thermals(s: dict[str, str], prev_stat: dict, drives_meta: list[dict]) -> dict:
    """THERMAL_PROBE sections → the GET /api/hardware/thermals body (timestamp added by the caller)."""
    rows = [(line.split("|") + [""] * 6)[:6] for line in s.get("hwmon", "").splitlines()]
    val = lambda r: int(r[5]) if r[5].strip().lstrip("-").isdigit() else None  # noqa: E731
    # CPU package and per-core temperatures: same rules as the inventory parser.
    temps = parse_hwmon("\n".join(f"{r[0]}|{r[4] or 'temp'}|{r[5]}" for r in rows if r[3].startswith("temp")))
    core_temp = {int(re.sub(r"\D", "", c["label"]) or 0): c["c"] for c in temps["cores"]}
    # Per-thread clock and load, folded into physical cores (core_id).
    # shortcut: core_id repeats per socket, so multi-socket hosts merge same-numbered cores; key on (package, core) if that matters.
    loads = load_pct(prev_stat, parse_stat(s.get("stat", "")))
    per_core: dict[int, dict] = {}
    for line in s.get("freq", "").splitlines():
        cpu, core, khz = (line.split("|") + ["", ""])[:3]
        if not cpu.isdigit():
            continue  # unmatched glob on a host without sysfs
        cid = int(core) if core.isdigit() else int(cpu)
        c = per_core.setdefault(cid, {"freq": [], "load": []})
        if khz.isdigit():
            c["freq"].append(int(khz) / 1000)
        if cpu in loads:
            c["load"].append(loads[cpu])
    mhz = [f for c in per_core.values() for f in c["freq"]] or \
        [float(x) for x in re.findall(r"cpu MHz\s*:\s*([\d.]+)", s.get("mhz", ""))]
    ids = sorted(set(per_core) | set(core_temp))
    cores = [{"core_id": i, "temp_c": core_temp.get(i),
              "freq_mhz": round(max(per_core[i]["freq"])) if per_core.get(i, {}).get("freq") else None,
              "load_pct": round(sum(per_core[i]["load"]) / len(per_core[i]["load"]), 1) if per_core.get(i, {}).get("load") else None}
             for i in ids]
    # GPUs: nvidia-smi rows, then amdgpu/i915/xe hwmon chips keyed by their PCI address.
    gpus: dict[str, dict] = {}
    for line in s.get("nvidia", "").splitlines():
        c = [x.strip() for x in line.split(",")]
        if len(c) != 8:
            continue
        n = [_num(x) for x in c[2:]]
        gpus[c[0].lower()[-7:]] = {"slot": c[0].lower()[-7:], "name": c[1], "temp_c": n[0], "hotspot_temp_c": None,
                                   "fan_rpm_or_pct": n[1], "fan_unit": "%", "power_w": n[2], "vram_used_mb": n[3],
                                   "vram_total_mb": n[4], "utilization_pct": n[5]}
    fans, drives = [], {}
    for r in rows:
        chip, dev, block, attr, label, v = r[0], r[1], r[2], r[3], r[4], val(r)
        if v is None:
            continue
        if chip in GPU_HWMON and re.fullmatch(r"[0-9a-f]{4}:[0-9a-f:.]+", dev):
            g = gpus.setdefault(dev[5:], {"slot": dev[5:], "name": chip, "temp_c": None, "hotspot_temp_c": None,
                                          "fan_rpm_or_pct": None, "fan_unit": "rpm", "power_w": None, "vram_used_mb": None,
                                          "vram_total_mb": None, "utilization_pct": None})
            if attr.startswith("temp"):
                key = "hotspot_temp_c" if label.lower() in ("junction", "hotspot") else "temp_c"
                if g[key] is None:  # first edge/GPU sensor wins; memory and VR sensors come later
                    g[key] = round(v / 1000, 1)
            elif attr.startswith("fan"):
                g["fan_rpm_or_pct"] = v
            elif attr.startswith("power"):
                g["power_w"] = round(v / 1e6, 1)  # microwatts
        elif chip in ("nvme", "drivetemp") and attr.startswith("temp"):
            name = block or dev
            if chip == "nvme" and re.fullmatch(r"nvme\d+", dev):
                name = f"{dev}n1"
            # First sensor is the composite / drive temperature; extra NVMe sensors are per-die.
            drives.setdefault(f"/dev/{name}", round(v / 1000, 1))
        elif attr.startswith("fan") and v > 0:
            fans.append({"label": label or f"{chip} {attr.split('_')[0]}", "rpm": v})
    drive_rows = [{"device": d.get("devpath"), "model": d.get("model"),
                   "temp_c": drives.pop(d.get("devpath"), d.get("temp_c")), "wear_pct": d.get("life_left_pct")}
                  for d in drives_meta]
    drive_rows += [{"device": k, "model": None, "temp_c": v, "wear_pct": None} for k, v in drives.items()]
    return {"cpu": {"package_temp_c": temps["package_c"], "cores": cores,
                    "avg_freq_mhz": round(sum(mhz) / len(mhz)) if mhz else None,
                    "min_freq_mhz": round(min(mhz)) if mhz else None, "max_freq_mhz": round(max(mhz)) if mhz else None},
            "gpus": sorted(gpus.values(), key=lambda g: g["slot"]), "drives": drive_rows, "chassis_fans": fans}


def _num(v: str) -> float | None:
    try:
        return float(v)
    except ValueError:
        return None  # "[N/A]", "[Not Supported]"


async def _thermal_read() -> str:
    ok, out, _ = await host_ssh.run_host_cmd(THERMAL_PROBE, timeout=8)
    if ok or out.strip():
        return out
    # No bridge: the same reads against this machine (native install, or what the container can see).
    try:
        proc = await asyncio.create_subprocess_exec("sh", "-c", THERMAL_PROBE, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        stdout, _ = await asyncio.wait_for(proc.communicate(), 8)
        return stdout.decode(errors="replace")
    except (OSError, asyncio.TimeoutError):
        return ""


def _drive_meta() -> list[dict]:
    """Model and wear from the 30 s SMART cache; refreshed in the background so a poll never waits on smartctl."""
    from . import telemetry  # local: telemetry is an optional router module
    cached = telemetry._cache
    if not cached or time.monotonic() - cached[0] > telemetry.CACHE_TTL:
        global _smart_task
        if _smart_task is None or _smart_task.done():
            _smart_task = asyncio.create_task(telemetry.hardware())
    return cached[1]["disks"] if cached else []


_smart_task: asyncio.Task | None = None


@router.get("/api/hardware/thermals")
async def thermals():
    """Live CPU/GPU/drive temperatures, clocks, loads and fan speeds; static board/BIOS data stays in /inventory."""
    global _thermals, _prev_stat
    async with _thermal_lock:
        if _thermals and time.monotonic() - _thermals[0] < THERMAL_TTL:
            return _thermals[1]
        s = split_sections(await _thermal_read())
        data = guard("thermals", lambda: parse_thermals(s, _prev_stat, _drive_meta()),
                     {"cpu": {"package_temp_c": None, "cores": [], "avg_freq_mhz": None, "min_freq_mhz": None,
                              "max_freq_mhz": None}, "gpus": [], "drives": [], "chassis_fans": []})
        _prev_stat = parse_stat(s.get("stat", "")) or _prev_stat
        data["timestamp"] = time.time()
        _thermals = (time.monotonic(), data)
        return data


@router.get("/api/v1/bios/status")
async def bios_status():
    """Board/BIOS facts: dmidecode, then /sys/devices/virtual/dmi/id, then the provider's host status. Never a 500."""
    from . import help_center  # lazy: help_center -> backups -> storage_admin imports this module
    (ok, out, err), st = await asyncio.gather(host_ssh.run_host_cmd(help_center.BIOS_PROBE, timeout=20),
                                              get_provider().host_status())
    facts = help_center.parse_bios_facts(out)
    ci = (st or {}).get("cpuinfo") or {}
    if not out.strip():  # bridge down: CPU vendor and VT-x/AMD-V from the API's /proc/cpuinfo flags
        flags = str(ci.get("flags", "")).split()
        facts.update(virtualization="vmx" in flags or "svm" in flags, cpu="amd" if "AMD" in str(ci.get("model")) else "intel")
    return {**facts, "cpu_model": ci.get("model"), "platform_version": (st or {}).get("platform_version"),
            "ssh_bridge_connected": bool(out.strip()), "ssh_bridge_message": "Connected" if out.strip() else
            (err.strip() or "No response from host")}


# ---------------------------------------------------------------- GPU drivers & modes

APT_UPDATE = 'apt-get update || echo "!! apt-get update reported errors (an unlicensed enterprise repo?); continuing"\n'
# `apt-cache show` exits 0 for a package that is only referenced (no candidate); madison prints only real versions.
NONFREE = APT_UPDATE + """if [ -z "$(apt-cache madison __PROBE_PKG__ 2>/dev/null)" ]; then
  CODENAME=$(. /etc/os-release; echo $VERSION_CODENAME)
  echo "==> Enabling the Debian non-free component for $CODENAME"
  cat > /etc/apt/sources.list.d/{P}-nonfree.sources <<EOF
Types: deb
URIs: http://deb.debian.org/debian
Suites: $CODENAME $CODENAME-updates
Components: non-free
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
  apt-get update || true
fi
"""

def _stage(i: int) -> str:
    return task_progress.marker("gpu", i) + "\n"


CHECK = _stage(0) + """echo "==> Checking PCI hardware, kernel $(uname -r) & active driver bindings"
lspci -nnk | grep -A3 -iE 'vga|3d controller|display controller' || true
"""

# Runs after the drivers are installed: a failing update-initramfs or a warning from lsinitramfs must not fail the
# whole install. The check reads the initramfs of the running kernel (uname -r) and only reports what it found.
INITRAMFS = _stage(3) + """K=$(uname -r)
echo "==> Updating the initramfs for kernel $K"
update-initramfs -u -k "$K" || echo "!! update-initramfs reported a problem; the drivers are installed, reboot and check again"
if command -v lsinitramfs >/dev/null && [ -e "/boot/initrd.img-$K" ]; then
  echo "==> /boot/initrd.img-$K: $( { lsinitramfs "/boot/initrd.img-$K" 2>/dev/null || true; } | grep -cE '__MODS__' || true) matching file(s) for __MODS__"
fi
"""

RENDER_CHECK = """ls -l /dev/dri/renderD* 2>/dev/null || echo '!! No /dev/dri render node yet; reboot the host to load the driver.'
"""

SCRIPTS = {
    "nvidia-install": "set -e\n" + CHECK + _stage(1) + "echo '==> Kernel headers and build tools'\n" + APT_UPDATE + r"""K=$(uname -r)
__KERNEL_HEADERS__
apt-get install -y build-essential dkms pkg-config libglvnd-dev curl gpg
""" + _stage(2) + r"""echo '==> Blacklisting nouveau'
printf 'blacklist nouveau\noptions nouveau modeset=0\n' > /etc/modprobe.d/{P}-nouveau.conf
update-initramfs -u -k "$K" || echo '!! update-initramfs reported a problem; continuing'
if grep -q '^nouveau ' /proc/modules; then
  rmmod nouveau 2>/dev/null || { echo '!! nouveau is still loaded and in use. Reboot the host, then click Install NVIDIA driver again.'; exit 3; }
fi
VER=$(curl -fsSL https://download.nvidia.com/XFree86/Linux-x86_64/latest.txt | awk '{print $1}')
[[ "$VER" =~ ^[0-9.]+$ ]] || { echo '!! Could not determine the latest NVIDIA driver version'; exit 1; }
CUR=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 || true)
if [ "$CUR" = "$VER" ]; then
  echo "==> NVIDIA driver $VER is already installed and running; skipping the driver installer"
else
  # The installer aborts (silently answering "abort") while an older nvidia module is loaded, so unload it first.
  if grep -q '^nvidia ' /proc/modules; then
    echo "==> Unloading the running NVIDIA driver ${CUR:-} before installing $VER"
    systemctl stop nvidia-persistenced 2>/dev/null || true
    for m in nvidia_uvm nvidia_drm nvidia_modeset nvidia; do
      if grep -q "^$m " /proc/modules; then rmmod "$m" 2>/dev/null || true; fi
    done
    if grep -q '^nvidia ' /proc/modules; then
      echo "!! The running NVIDIA driver ${CUR:-} is in use by a container, VM or service, so it cannot be replaced. Stop the guests that use the GPU (for example Solar AI Studio), then click Install again."
      exit 4
    fi
  fi
  RUN=/var/lib/{P}/NVIDIA-Linux-x86_64-$VER.run
  echo "==> Downloading NVIDIA driver $VER"
  mkdir -p /var/lib/{P}
  curl -fsSL -o "$RUN" "https://download.nvidia.com/XFree86/Linux-x86_64/$VER/NVIDIA-Linux-x86_64-$VER.run"
  echo "==> Installing NVIDIA driver $VER (DKMS)"
  sh "$RUN" --silent --dkms || { echo '!! Installer failed; see /var/log/nvidia-installer.log'; tail -n 30 /var/log/nvidia-installer.log; exit 1; }
fi
echo '==> nvidia-container-toolkit'
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update || true
apt-get install -y nvidia-container-toolkit
""" + INITRAMFS.replace("__MODS__", "nouveau|nvidia") + _stage(4) + """echo '==> Verifying the GPU'
nvidia-smi || echo '!! nvidia-smi does not list the GPU yet; reboot the host.'
echo '==> Done.'
""",
    "intel-install": "set -e\n" + CHECK + _stage(1) + NONFREE.replace("__PROBE_PKG__", "intel-media-va-driver-non-free")
    + _stage(2) + """apt-get install -y intel-media-va-driver-non-free \\
  || { echo '!! intel-media-va-driver-non-free is unavailable; installing the free intel-media-va-driver (no low-power encode)'; apt-get install -y intel-media-va-driver; }
# GuC/HuC firmware comes with the host's firmware package; Debian firmware-* packages may conflict with it.
apt-get install -y intel-gpu-tools vainfo
echo 'options i915 enable_guc=3' > /etc/modprobe.d/i915.conf
""" + INITRAMFS.replace("__MODS__", "i915") + _stage(4) + "echo '==> Verifying the GPU'\n" + RENDER_CHECK + """
echo '==> Done. Reboot the host to load the GuC/HuC firmware (Quick Sync low-power encoding).'
""",
    # amdgpu firmware comes with the host's firmware package (firmware-amd-graphics may conflict with it).
    "amd-install": "set -e\n" + CHECK + _stage(1) + APT_UPDATE + _stage(2) + """apt-get install -y radeontop
apt-get install -y rocminfo rocm-smi || echo '!! ROCm tools are not available in the configured repositories; skipped.'
""" + INITRAMFS.replace("__MODS__", "amdgpu") + _stage(4) + "echo '==> Verifying the GPU'\n" + RENDER_CHECK + """
echo '==> Done.'
""",
}
# Host-side file names carry the system prefix (solardeck-nouveau.conf, /var/lib/solardeck, ...).
SCRIPTS = {k: v.replace("{P}", settings.system_prefix).replace("__KERNEL_HEADERS__", PLATFORM.KERNEL_HEADERS)
           for k, v in SCRIPTS.items()}


def mode_script(files: dict[str, str | None]) -> str:
    lines = ["set -e", CHECK.rstrip()]
    for path, content in files.items():
        if content is None:
            lines.append(f"rm -f {path} && echo 'removed {path}'")
        else:
            lines.append(f"cat > {path} <<'SOLARDECK_EOF'\n{content}SOLARDECK_EOF\necho 'wrote {path}'; cat {path}")
    # Unlike a driver install, the initramfs is the change itself here, so a failing update-initramfs fails the job.
    lines += [_stage(3).rstrip(), "echo '==> update-initramfs -u -k all'", "update-initramfs -u -k all",
              _stage(4).rstrip(), 'K=$(uname -r)',
              'if command -v lsinitramfs >/dev/null && [ -e "/boot/initrd.img-$K" ]; then',
              '  echo "==> /boot/initrd.img-$K: $( { lsinitramfs "/boot/initrd.img-$K" 2>/dev/null || true; } '
              '| grep -c vfio || true) vfio file(s)"', 'fi',
              "echo '==> Done. Reboot the host to apply the new GPU driver binding.'"]
    return "\n".join(lines) + "\n"


class GpuBody(BaseModel):
    gpu: str = Field(pattern=r"^[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$")


Action = Literal["nvidia-install", "intel-install", "amd-install", "mode-passthrough", "mode-host"]


@router.get("/api/hardware/gpu-drivers")
async def gpu_drivers():
    s, probe, _, _ = await _collect()
    inv = safe_inventory(s, probe, [])
    return {"gpus": [{k: g[k] for k in ("id", "name", "vendor", "driver", "iommu_group", "audio_function", "functions",
                                        "warnings", "mode", "reboot_required", "metrics")} for g in inv["gpus"]],
            "packages": inv["packages"], "nvidia_driver": next((g["metrics"]["driver_version"] for g in inv["gpus"]
                                                                if g["metrics"]), None),
            "vfio_ids": parse_vfio_ids(s.get("vfio", "")), "iommu": probe["iommu_enabled"]}


@router.post("/api/hardware/gpu-drivers/{action}", dependencies=[Depends(require_step_up_auth)])
async def gpu_driver_action(action: Action, body: GpuBody):
    probe = await pci.probe()
    gpu = next((d for d in probe["devices"] if d["gpu"] and d["id"] == body.gpu), None)
    if not gpu:
        raise HTTPException(404, f"No GPU at {body.gpu}")
    if action in SCRIPTS:
        if not action.startswith(gpu["vendor"]):
            raise HTTPException(400, f"{action} does not apply to a {gpu['vendor']} GPU")
        job = f"gpu-{action}"
        await host_ssh.start_job(job, SCRIPTS[action])
        task_progress.watch(job, gpu["name"])
        return {"job": job}
    # Mode switch: recompute the full passthrough id set (other GPUs keep their mode).
    vfio = parse_vfio_ids(await host_ssh.read_file(VFIO_CONF))
    slot = {f"{d['vendor_id']}:{d['device_id']}" for d in probe["devices"] if d["id"] in gpu["functions"]}
    ids = sorted(set(vfio) | slot) if action == "mode-passthrough" else sorted(set(vfio) - slot)
    vendors = {d["vendor"] for d in probe["devices"] if d["gpu"] and f"{d['vendor_id']}:{d['device_id']}" in ids}
    await host_ssh.start_job("gpu-mode", mode_script(vfio_files(ids, vendors)))
    task_progress.watch("gpu-mode", gpu["name"])
    return {"job": "gpu-mode", "vfio_ids": ids}


@router.get("/api/hardware/gpu-drivers/jobs/{job}")
async def gpu_job(job: Literal["gpu-nvidia-install", "gpu-intel-install", "gpu-amd-install", "gpu-mode"]):
    """Stage progress of a GPU job (null if it never ran on this host)."""
    return task_progress.from_host_job(job, "gpu", await host_ssh.job_status(job), task_progress._watch.get(job, {}).get("subject", ""))
