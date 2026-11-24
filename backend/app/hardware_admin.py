"""Host hardware inventory and the multi-vendor GPU driver / mode manager.

Everything is read in one SSH round trip (PROBE, sections split by @@name@@ markers) plus the shared PCI probe.
Temperatures come from /sys/class/hwmon (the kernel data lm-sensors reads), so no extra package is needed.
Driver installs and vfio-pci mode switches run as detached host jobs (host_ssh.start_job) with streamed logs.
"""
import asyncio
import json
import logging
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import host_ssh, pci
from .auth import require_user
from .pve import _node, _safe

router = APIRouter(tags=["hardware_admin"], dependencies=[Depends(require_user)])
log = logging.getLogger(__name__)

PKGS = ("nvidia-container-toolkit", "intel-media-va-driver-non-free", "intel-gpu-tools", "vainfo", "pve-firmware",
        "radeontop", "rocminfo", "rocm-smi", "lm-sensors")
VFIO_CONF = "/etc/modprobe.d/proxmox-os-vfio.conf"
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
                k, v = x.strip().split(": ", 1)
                kv[k] = v.strip()
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
        addrs = [f"{a['local']}/{a['prefixlen']}" for a in link.get("addr_info", []) if a.get("scope") != "link"]
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
        return {VFIO_CONF: None, "/etc/modprobe.d/proxmox-os-blacklist.conf": None,
                "/etc/modules-load.d/proxmox-os-vfio.conf": None}
    mods = {"nvidia": ["nouveau", "nvidia", "nvidiafb", "nvidia_drm"], "amd": ["amdgpu", "radeon"]}
    black = [m for v in sorted(vendors) for m in mods.get(v, [])]
    soft = "".join(f"softdep {m} pre: vfio-pci\n" for m in ["nouveau", "nvidia", "amdgpu", "radeon", "snd_hda_intel", "i915"])
    return {VFIO_CONF: f"# Managed by SolarDeck (GPU passthrough)\noptions vfio-pci ids={','.join(ids)}\n{soft}",
            "/etc/modprobe.d/proxmox-os-blacklist.conf": "# Managed by SolarDeck\n" + "".join(f"blacklist {m}\n" for m in black)
            if black else None,
            "/etc/modules-load.d/proxmox-os-vfio.conf": "vfio\nvfio_iommu_type1\nvfio_pci\n"}


# ---------------------------------------------------------------- Inventory


async def _pci() -> dict:
    """lspci over the bridge, else the Proxmox API PCI list (no drivers or kernel cmdline from that source)."""
    try:
        probe = await pci.probe()
        if probe["devices"]:
            return probe
    except HTTPException:
        pass
    return pci.parse(pci.from_pve(await _safe(_node("/hardware/pci"), []) or []))


async def _collect() -> tuple[dict[str, str], dict, bool, str]:
    """(sections, pci probe, bridge connected, bridge message). Never raises: missing tools leave sections empty."""
    (ok, out, err), probe = await asyncio.gather(host_ssh.run_host_cmd(PROBE + "\ntrue", timeout=40), _pci())
    connected = ok or bool(out.strip())
    return split_sections(out), probe, connected, "Connected" if connected else (err.strip() or "No response from host")


def fill_from_pve(inv: dict, st: dict) -> dict:
    """Fill CPU, memory and kernel gaps (no SSH bridge, no dmidecode/lscpu) from PVE /nodes/{node}/status."""
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


def build_inventory(s: dict[str, str], probe: dict, disks: list[dict]) -> dict:
    dmi = {t: kv for t, kv in parse_dmi(s.get("dmi", ""))}
    sysi, board, bios = dmi.get("System Information", {}), dmi.get("Base Board Information", {}), dmi.get("BIOS Information", {})
    cpu = parse_lscpu(s.get("lscpu", ""))
    mhz = [float(x) for x in re.findall(r"cpu MHz\s*:\s*([\d.]+)", s.get("mhz", ""))]
    temps = parse_hwmon(s.get("hwmon", ""))
    mem = parse_meminfo(s.get("meminfo", ""))
    arc = re.search(r"(\d+)\s*$", s.get("arc", ""))
    nv, amd = parse_nvidia(s.get("nvidia", "")), parse_amd_vram(s.get("amd", ""))
    intel = s.get("intel", "").splitlines()
    vfio = parse_vfio_ids(s.get("vfio", ""))
    kernel = s.get("kernel", "").splitlines()
    nvidia_built = len(kernel) > 1
    smart = parse_kv_lines(s.get("smart", ""))
    devs = probe["devices"]
    gpus = []
    for d in devs:
        if not d["gpu"]:
            continue
        g = {**pci.gpu_view(d), **gpu_mode(d, vfio, nvidia_built), "metrics": nv.get(d["id"]),
             "vram_bytes": int(nv[d["id"]]["vram_total_mib"] * 1024 * 1024) if d["id"] in nv and nv[d["id"]]["vram_total_mib"]
             else amd.get(d["id"])}
        if d["vendor"] == "intel":
            uc = {m.group(1): m.group(2) for m in (re.search(r"/uc/(guc|huc)_info:\s*status:\s*(\S+)", x) for x in intel[1:]) if m}
            g["firmware"] = {"enable_guc": intel[0] if intel else None, "guc": uc.get("guc"), "huc": uc.get("huc")}
        gpus.append(g)
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
                   "dimms": parse_dimms(s.get("dimm", ""))},
        "gpus": gpus,
        "storage": {"controllers": [{"id": d["id"], "name": d["name"], "class_name": d["class_name"], "driver": d["driver"]}
                                    for d in devs if d["class"].startswith("01")],
                    "drives": [{"devpath": x.get("devpath"), "model": x.get("model"), "serial": x.get("serial"),
                                "size": x.get("size"), "type": x.get("type"), "wearout": x.get("wearout"),
                                "health": x.get("health"), "temp_c": int(smart[x["devpath"]]) if
                                smart.get(x.get("devpath", ""), "").isdigit() else None} for x in disks]},
        "network": parse_nics(s.get("ipaddr", ""), s.get("netsys", "")),
        "sensors": temps["other"],
        "packages": parse_pkgs(s.get("pkgs", "")),
    }


def safe_inventory(s: dict[str, str], probe: dict, disks: list[dict]) -> dict:
    try:
        return build_inventory(s, probe, disks)
    except Exception:  # unexpected host output must degrade to API data, never an HTTP 500
        log.exception("hardware inventory parse failed; using Proxmox API data only")
        return build_inventory({}, probe, [])


@router.get("/api/hardware/inventory")
async def inventory():
    (s, probe, connected, message), disks, st = await asyncio.gather(
        _collect(), _safe(_node("/disks/list"), []), _safe(_node("/status"), {}))
    inv = fill_from_pve(safe_inventory(s, probe, disks or []), st or {})
    pub = host_ssh.public_key_or_none()
    return {**inv, "ssh_bridge_connected": connected, "ssh_bridge_message": message,
            "ssh_setup_command": None if connected or not pub else host_ssh.setup_command(pub)}


@router.get("/api/hardware/gpu-metrics")
async def gpu_metrics():
    """Light poll for live GPU numbers (nvidia-smi / amdgpu sysfs) while the panel is open."""
    _, out, _ = await host_ssh.run_host_cmd(f"echo @@nvidia@@; {NVIDIA_CMD}; echo @@amd@@; {AMD_CMD}", timeout=15)
    s = split_sections(out)
    return {"nvidia": parse_nvidia(s.get("nvidia", "")), "amd_vram": parse_amd_vram(s.get("amd", ""))}


@router.get("/api/pve/bios/status")
async def bios_status():
    """Board/BIOS facts: dmidecode, then /sys/devices/virtual/dmi/id, then Proxmox API node info. Never a 500."""
    from . import help_center  # lazy: help_center -> backups -> storage_admin imports this module
    (ok, out, err), st = await asyncio.gather(host_ssh.run_host_cmd(help_center.BIOS_PROBE, timeout=20),
                                              _safe(_node("/status"), {}))
    facts = help_center.parse_bios_facts(out)
    ci = (st or {}).get("cpuinfo") or {}
    if not out.strip():  # bridge down: CPU vendor and VT-x/AMD-V from the API's /proc/cpuinfo flags
        flags = str(ci.get("flags", "")).split()
        facts.update(virtualization="vmx" in flags or "svm" in flags, cpu="amd" if "AMD" in str(ci.get("model")) else "intel")
    return {**facts, "cpu_model": ci.get("model"), "pve_version": (st or {}).get("pveversion"),
            "ssh_bridge_connected": bool(out.strip()), "ssh_bridge_message": "Connected" if out.strip() else
            (err.strip() or "No response from host")}


# ---------------------------------------------------------------- GPU drivers & modes

APT_UPDATE = 'apt-get update || echo "!! apt-get update reported errors (an unlicensed enterprise repo?); continuing"\n'
# `apt-cache show` exits 0 for a package that is only referenced (no candidate); madison prints only real versions.
NONFREE = APT_UPDATE + """if [ -z "$(apt-cache madison __PROBE_PKG__ 2>/dev/null)" ]; then
  CODENAME=$(. /etc/os-release; echo $VERSION_CODENAME)
  echo "==> Enabling the Debian non-free component for $CODENAME"
  cat > /etc/apt/sources.list.d/proxmox-os-nonfree.sources <<EOF
Types: deb
URIs: http://deb.debian.org/debian
Suites: $CODENAME $CODENAME-updates
Components: non-free
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
  apt-get update || true
fi
"""

SCRIPTS = {
    "nvidia-install": "set -e\necho '==> Kernel headers and build tools'\n" + APT_UPDATE + r"""K=$(uname -r)
apt-get install -y "proxmox-headers-$K" || apt-get install -y "pve-headers-$K"
apt-get install -y build-essential dkms pkg-config libglvnd-dev curl gpg
echo '==> Blacklisting nouveau'
printf 'blacklist nouveau\noptions nouveau modeset=0\n' > /etc/modprobe.d/proxmox-os-nouveau.conf
update-initramfs -u
if grep -q '^nouveau ' /proc/modules; then
  rmmod nouveau 2>/dev/null || { echo '!! nouveau is still loaded and in use. Reboot the host, then click Install NVIDIA driver again.'; exit 3; }
fi
VER=$(curl -fsSL https://download.nvidia.com/XFree86/Linux-x86_64/latest.txt | awk '{print $1}')
[[ "$VER" =~ ^[0-9.]+$ ]] || { echo '!! Could not determine the latest NVIDIA driver version'; exit 1; }
RUN=/var/lib/proxmox-os/NVIDIA-Linux-x86_64-$VER.run
echo "==> Downloading NVIDIA driver $VER"
mkdir -p /var/lib/proxmox-os
curl -fsSL -o "$RUN" "https://download.nvidia.com/XFree86/Linux-x86_64/$VER/NVIDIA-Linux-x86_64-$VER.run"
echo "==> Installing NVIDIA driver $VER (DKMS)"
sh "$RUN" --silent --dkms || { echo '!! Installer failed; see /var/log/nvidia-installer.log'; tail -n 30 /var/log/nvidia-installer.log; exit 1; }
nvidia-smi || true
echo '==> nvidia-container-toolkit'
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update || true
apt-get install -y nvidia-container-toolkit
echo '==> Done. Reboot the host if nvidia-smi above did not list the GPU.'
""",
    "intel-install": "set -e\n" + NONFREE.replace("__PROBE_PKG__", "intel-media-va-driver-non-free") + """
apt-get install -y intel-media-va-driver-non-free \\
  || { echo '!! intel-media-va-driver-non-free is unavailable; installing the free intel-media-va-driver (no low-power encode)'; apt-get install -y intel-media-va-driver; }
# GuC/HuC firmware ships in pve-firmware; Debian firmware-* packages conflict with it and would remove proxmox-ve.
apt-get install -y intel-gpu-tools vainfo
echo 'options i915 enable_guc=3' > /etc/modprobe.d/i915.conf
update-initramfs -u
echo '==> Done. Reboot the host to load the GuC/HuC firmware (Quick Sync low-power encoding).'
""",
    # amdgpu firmware ships in pve-firmware (firmware-amd-graphics conflicts with it and would remove proxmox-ve).
    "amd-install": "set -e\n" + APT_UPDATE + """apt-get install -y radeontop
apt-get install -y rocminfo rocm-smi || echo '!! ROCm tools are not available in the configured repositories; skipped.'
update-initramfs -u
echo '==> Done.'
""",
}


def mode_script(files: dict[str, str | None]) -> str:
    lines = ["set -e"]
    for path, content in files.items():
        if content is None:
            lines.append(f"rm -f {path} && echo 'removed {path}'")
        else:
            lines.append(f"cat > {path} <<'SOLARDECK_EOF'\n{content}SOLARDECK_EOF\necho 'wrote {path}'; cat {path}")
    lines += ["echo '==> update-initramfs -u -k all'", "update-initramfs -u -k all",
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


@router.post("/api/hardware/gpu-drivers/{action}")
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
        return {"job": job}
    # Mode switch: recompute the full passthrough id set (other GPUs keep their mode).
    vfio = parse_vfio_ids(await host_ssh.read_file(VFIO_CONF))
    slot = {f"{d['vendor_id']}:{d['device_id']}" for d in probe["devices"] if d["id"] in gpu["functions"]}
    ids = sorted(set(vfio) | slot) if action == "mode-passthrough" else sorted(set(vfio) - slot)
    vendors = {d["vendor"] for d in probe["devices"] if d["gpu"] and f"{d['vendor_id']}:{d['device_id']}" in ids}
    await host_ssh.start_job("gpu-mode", mode_script(vfio_files(ids, vendors)))
    return {"job": "gpu-mode", "vfio_ids": ids}
