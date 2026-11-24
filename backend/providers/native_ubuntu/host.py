"""Local host plumbing for the standalone driver: command runner, job registry, guest id registry and libvirt XML.

The backend runs as root on the hypervisor itself (solardeck-backend.service), so commands are plain argv lists run
with asyncio subprocesses: no shell, no SSH. Every value that reaches an argv has been validated by a request model.
"""
import asyncio
import json
import re
import secrets
import time
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import HTTPException

from app.config import settings

DATA = Path(__file__).resolve().parents[2] / "data"
GUESTS_FILE = DATA / "native_guests.json"
IMAGES = Path("/var/lib/libvirt/images")
NVRAM = Path("/var/lib/libvirt/qemu/nvram")
OVMF = {"code": "/usr/share/OVMF/OVMF_CODE_4M.fd", "vars": "/usr/share/OVMF/OVMF_VARS_4M.fd",
        "code_sb": "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd", "vars_sb": "/usr/share/OVMF/OVMF_VARS_4M.ms.fd"}
GUEST_TAG = "proxmox-os-guest"
Log = Callable[[str], None]


def node() -> str:
    return settings.pve_node


# ---------------------------------------------------------------- Commands


async def run(*argv: str, input: str | bytes | None = None, stdin_path: str | None = None, stdout_path: str | None = None,
              timeout: float = 120, check: bool = True, log: Log | None = None) -> str:
    """Run argv locally; return stdout+stderr (or only stderr when stdout_path is set). Raises 502/503/504."""
    stdin = open(stdin_path, "rb") if stdin_path else asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL
    stdout = open(stdout_path, "wb") if stdout_path else asyncio.subprocess.PIPE
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=stdin, stdout=stdout,
            stderr=asyncio.subprocess.PIPE if stdout_path else asyncio.subprocess.STDOUT)
    except FileNotFoundError:
        raise HTTPException(503, f"{argv[0]} is not installed on this host (re-run hypervisor/install-hypervisor.sh)")
    finally:
        for f in (stdin, stdout):
            if hasattr(f, "close"):
                f.close()
    out: list[str] = []

    async def pump():
        if input is not None:
            proc.stdin.write(input.encode() if isinstance(input, str) else input)
            await proc.stdin.drain()
            proc.stdin.close()
        stream = proc.stderr if stdout_path else proc.stdout
        async for raw in stream:
            out.append(raw.decode(errors="replace").rstrip("\n"))
            if log:
                log(out[-1])
        await proc.wait()

    try:
        await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, f"Host command timed out: {argv[0]}")
    if check and proc.returncode:
        tail = next((x for x in reversed(out) if x.strip()), "")
        raise HTTPException(502, f"{argv[0]} {argv[1] if len(argv) > 1 else ''} failed (exit {proc.returncode}): {tail[:300]}")
    return "\n".join(out)


async def ok(*argv: str, timeout: float = 30) -> str | None:
    """stdout of a command, or None when it fails or the tool is missing (optional probes)."""
    try:
        return await run(*argv, timeout=timeout)
    except HTTPException:
        return None


async def run_json(*argv: str, timeout: float = 60):
    return json.loads(await run(*argv, timeout=timeout) or "null")


# ---------------------------------------------------------------- Job registry (Task Center)

# shortcut: jobs live in memory (last 200) and vanish on backend restart; upgrade to systemd transient units if needed.
JOBS: dict[str, dict] = {}
_bg: set[asyncio.Task] = set()


def start_job(kind: str, target: str | int, fn: Callable[[Log], Awaitable[None]]) -> str:
    upid = f"SDJOB:{node()}:{secrets.token_hex(6)}:{kind}:{target}:root@solardeck:"
    job = {"upid": upid, "type": kind, "id": str(target), "user": "root@solardeck", "status": None,
           "starttime": int(time.time()), "endtime": None, "log": []}
    JOBS[upid] = job
    for old in sorted(JOBS, key=lambda k: JOBS[k]["starttime"])[:-200]:
        JOBS.pop(old, None)

    async def wrap():
        try:
            await fn(job["log"].append)
            job["status"] = "OK"
        except Exception as e:  # noqa: BLE001 - surfaced in the Task Center
            job["status"] = str(e.detail if isinstance(e, HTTPException) else e)[:300] or "error"
            job["log"].append(f"TASK ERROR: {job['status']}")
        job["endtime"] = int(time.time())

    t = asyncio.create_task(wrap())
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return upid


def job_view(j: dict) -> dict:
    state = "running" if j["endtime"] is None else "ok" if j["status"] == "OK" else "error"
    return {"upid": j["upid"], "type": j["type"], "id": j["id"], "user": j["user"], "status": j["status"] or "running",
            "state": state, "starttime": j["starttime"], "endtime": j["endtime"]}


async def wait_job(upid: str, timeout: float = 3600) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        j = JOBS[upid]
        if j["endtime"] is not None:
            if j["status"] != "OK":
                raise HTTPException(502, f"Task failed: {j['status']}")
            return
        await asyncio.sleep(1)
    raise HTTPException(504, "Task timed out")


# ---------------------------------------------------------------- Guest registry (numeric VMIDs over named guests)


def load_guests() -> dict[int, dict]:
    """vmid -> {"type": "qemu"|"lxc", "name": libvirt domain / Incus instance, "tags": str}."""
    try:
        return {int(k): v for k, v in json.loads(GUESTS_FILE.read_text()).items()}
    except (OSError, ValueError):
        return {}


def save_guests(reg: dict[int, dict]) -> None:
    GUESTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = GUESTS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({str(k): v for k, v in sorted(reg.items())}, indent=2))
    tmp.replace(GUESTS_FILE)


def next_vmid(reg: dict[int, dict]) -> int:
    return next(i for i in range(100, 1_000_000) if i not in reg)


def reconcile(reg: dict[int, dict], live: list[tuple[str, str]]) -> dict[int, dict]:
    """Give every live (kind, name) a stable vmid; forget guests that no longer exist. Pure (unit tested)."""
    known = {(v["type"], v["name"]): k for k, v in reg.items()}
    out = {k: reg[k] for key, k in known.items() if key in set(live)}
    for kind, name in live:
        if (kind, name) not in known:
            out[next_vmid(out | reg)] = {"type": kind, "name": name, "tags": ""}
    return out


def register(vmid: int, kind: str, name: str, tags: str = GUEST_TAG) -> None:
    reg = load_guests()
    reg[vmid] = {"type": kind, "name": name, "tags": tags}
    save_guests(reg)


def guest(vmid: int, kind: str | None = None) -> dict:
    g = load_guests().get(int(vmid))
    if not g or (kind and g["type"] != kind):
        raise HTTPException(404, f"{'VM' if kind == 'qemu' else 'Container' if kind == 'lxc' else 'Guest'} {vmid} not found")
    return g


def name_of(vmid: int, kind: str | None = None) -> str:
    return guest(vmid, kind)["name"]


# ---------------------------------------------------------------- Sizes & parsing helpers

UNITS = {"": 1, "K": 2**10, "M": 2**20, "G": 2**30, "T": 2**40, "P": 2**50}


def size_bytes(v: str) -> int:
    """"64G" / "512M" / "1.5T" / "2048MiB" / "2GB" -> bytes (binary units)."""
    m = re.fullmatch(r"\+?([0-9.]+)\s*([KMGTP]?)(i?B)?", str(v).strip(), re.I)
    if not m:
        return 0
    return int(float(m.group(1)) * UNITS[m.group(2).upper()])


def parse_kv_blocks(text: str, header: str) -> dict[str, dict[str, str]]:
    """`virsh domstats --raw` -> {domain: {key: value}}."""
    out: dict[str, dict[str, str]] = {}
    cur = None
    for line in text.splitlines():
        if line.startswith(header):
            cur = out.setdefault(line.split("'")[1] if "'" in line else line.split(":", 1)[1].strip(), {})
        elif cur is not None and "=" in line:
            k, _, v = line.strip().partition("=")
            cur[k] = v
    return out


# ---------------------------------------------------------------- libvirt domain XML

BUS_PREFIX = {"virtio": "vd", "scsi": "sd", "sata": "sd"}


def disk_key(target: str, bus: str) -> str:
    """libvirt target dev (vda, sdb) -> SolarDeck disk key (virtio0, scsi1) used by the resource editor."""
    return f"{'virtio' if bus == 'virtio' else bus}{ord(target[-1]) - 97}"


def domain_xml(*, name: str, vmid: int, cores: int, sockets: int, memory_mb: int, uefi: bool, secure_boot: bool,
               disks: list[dict], cdroms: list[str], bridge: str, ostype: str, hostpci: list[str],
               usb: list[str], tpm: bool) -> str:
    """Build a KVM domain. disks: [{"path", "type": "file"|"block", "format": "qcow2"|"raw"}] on virtio-scsi."""
    d = ET.Element("domain", type="kvm")
    ET.SubElement(d, "name").text = name
    ET.SubElement(d, "title").text = name
    ET.SubElement(d, "description").text = f"Created by SolarDeck (vmid {vmid})"
    ET.SubElement(d, "memory", unit="MiB").text = str(memory_mb)
    ET.SubElement(d, "currentMemory", unit="MiB").text = str(memory_mb)
    ET.SubElement(d, "vcpu", placement="static").text = str(cores * sockets)
    os_ = ET.SubElement(d, "os")
    ET.SubElement(os_, "type", arch="x86_64", machine="q35").text = "hvm"
    if uefi:
        ET.SubElement(os_, "loader", readonly="yes", type="pflash", **({"secure": "yes"} if secure_boot else {})).text = \
            OVMF["code_sb" if secure_boot else "code"]
        ET.SubElement(os_, "nvram", template=OVMF["vars_sb" if secure_boot else "vars"]).text = \
            str(NVRAM / f"{name}_VARS.fd")
    ET.SubElement(os_, "boot", dev="hd")
    ET.SubElement(os_, "boot", dev="cdrom")
    feat = ET.SubElement(d, "features")
    ET.SubElement(feat, "acpi")
    ET.SubElement(feat, "apic")
    if secure_boot:
        ET.SubElement(feat, "smm", state="on")
    if ostype.startswith("win"):
        hv = ET.SubElement(feat, "hyperv", mode="custom")
        for tag in ("relaxed", "vapic"):
            ET.SubElement(hv, tag, state="on")
        ET.SubElement(hv, "spinlocks", state="on", retries="8191")
    cpu = ET.SubElement(d, "cpu", mode="host-passthrough", check="none", migratable="on")
    ET.SubElement(cpu, "topology", sockets=str(sockets), dies="1", cores=str(cores), threads="1")
    ET.SubElement(d, "clock", offset="localtime" if ostype.startswith("win") else "utc")
    ET.SubElement(d, "on_poweroff").text = "destroy"
    ET.SubElement(d, "on_reboot").text = "restart"
    ET.SubElement(d, "on_crash").text = "destroy"
    dev = ET.SubElement(d, "devices")
    ET.SubElement(dev, "emulator").text = "/usr/bin/qemu-system-x86_64"
    for i, disk in enumerate(disks):
        el = ET.SubElement(dev, "disk", type=disk["type"], device="disk")
        ET.SubElement(el, "driver", name="qemu", type=disk["format"], cache="none", io="native", discard="unmap")
        ET.SubElement(el, "source", **({"file": disk["path"]} if disk["type"] == "file" else {"dev": disk["path"]}))
        ET.SubElement(el, "target", dev=f"sd{chr(97 + i)}", bus="scsi")
    for i, iso in enumerate(cdroms):
        el = ET.SubElement(dev, "disk", type="file", device="cdrom")
        ET.SubElement(el, "driver", name="qemu", type="raw")
        ET.SubElement(el, "source", file=iso)
        ET.SubElement(el, "target", dev=f"sd{chr(97 + len(disks) + i)}", bus="sata")
        ET.SubElement(el, "readonly")
    ET.SubElement(dev, "controller", type="scsi", index="0", model="virtio-scsi")
    nic = ET.SubElement(dev, "interface", type="bridge")
    ET.SubElement(nic, "source", bridge=bridge)
    ET.SubElement(nic, "model", type="virtio")
    serial = ET.SubElement(dev, "serial", type="pty")
    ET.SubElement(serial, "target", port="0")
    ET.SubElement(ET.SubElement(dev, "console", type="pty"), "target", type="serial", port="0")
    ch = ET.SubElement(dev, "channel", type="unix")
    ET.SubElement(ch, "target", type="virtio", name="org.qemu.guest_agent.0")
    ET.SubElement(dev, "graphics", type="vnc", port="-1", autoport="yes", listen="127.0.0.1")
    ET.SubElement(ET.SubElement(dev, "video"), "model", type="virtio" if not ostype.startswith("win") else "qxl")
    ET.SubElement(dev, "input", type="tablet", bus="usb")
    ET.SubElement(dev, "memballoon", model="virtio")
    if tpm:
        t = ET.SubElement(dev, "tpm", model="tpm-crb")
        ET.SubElement(t, "backend", type="emulator", version="2.0")
    for addr in hostpci:
        dev.append(hostdev_pci(addr))
    for u in usb:
        dev.append(hostdev_usb(u))
    ET.indent(d)
    return ET.tostring(d, encoding="unicode")


def hostdev_pci(addr: str) -> ET.Element:
    """<hostdev> for a PCI function ("0000:01:00.0" or "01:00.0")."""
    full = addr if addr.count(":") == 2 else f"0000:{addr}"
    dom, bus, rest = full.split(":")
    slot, fn = rest.split(".")
    h = ET.Element("hostdev", mode="subsystem", type="pci", managed="yes")
    ET.SubElement(ET.SubElement(h, "source"), "address", domain=f"0x{dom}", bus=f"0x{bus}", slot=f"0x{slot}",
                  function=f"0x{fn}")
    return h


def hostdev_usb(host: str) -> ET.Element:
    """<hostdev> for a USB device by vendor:product ("046d:c52b")."""
    vid, pid = host.split(":")
    h = ET.Element("hostdev", mode="subsystem", type="usb", managed="yes")
    src = ET.SubElement(h, "source")
    ET.SubElement(src, "vendor", id=f"0x{vid}")
    ET.SubElement(src, "product", id=f"0x{pid}")
    return h


def set_vcpus(xml: str, cores: int) -> str:
    """Domain XML with `cores` vCPUs on one socket (the resource editor's core count)."""
    d = ET.fromstring(xml)
    vcpu = d.find("vcpu")
    if vcpu is None:
        vcpu = ET.SubElement(d, "vcpu", placement="static")
    vcpu.text = str(cores)
    vcpu.attrib.pop("current", None)
    topo = d.find("cpu/topology")
    if topo is not None:
        topo.attrib.update(sockets="1", dies="1", cores=str(cores), threads="1")
    return ET.tostring(d, encoding="unicode")


def parse_domain(xml: str) -> dict:
    """The fields SolarDeck reads back from `virsh dumpxml`."""
    d = ET.fromstring(xml)
    topo = d.find("cpu/topology")
    mem = d.find("memory")
    kib = int(mem.text) * {"KiB": 1, "MiB": 1024, "GiB": 2**20}.get(mem.get("unit", "KiB"), 1) if mem is not None else 0
    disks, nets = [], []
    for el in d.findall("devices/disk"):
        src, tgt = el.find("source"), el.find("target")
        if tgt is None:
            continue
        path = src.get("file") or src.get("dev") if src is not None else None
        disks.append({"device": el.get("device"), "target": tgt.get("dev"), "bus": tgt.get("bus"), "path": path,
                      "format": (el.find("driver").get("type") if el.find("driver") is not None else "raw")})
    for i, el in enumerate(d.findall("devices/interface")):
        src, mac = el.find("source"), el.find("mac")
        nets.append({"key": f"net{i}", "bridge": src.get("bridge") if src is not None else None,
                     "mac": (mac.get("address") or "").upper() if mac is not None else None})
    vcpu = int((d.findtext("vcpu") or "1").strip())
    sockets = int(topo.get("sockets", 1)) if topo is not None else 1
    return {"name": d.findtext("name"), "uuid": d.findtext("uuid"), "description": d.findtext("description") or "",
            "memory_mb": kib // 1024, "vcpus": vcpu, "sockets": sockets, "cores": max(1, vcpu // sockets),
            "disks": disks, "nets": nets, "nvram": d.findtext("os/nvram")}
