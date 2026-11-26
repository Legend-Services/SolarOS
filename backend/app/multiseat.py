"""Multi-Seat Workstations & Physical Port Passthrough.

A seat is one VM with its own physical GPU (plus its HDMI/DP audio function and optional extra PCIe devices), its own
physical USB ports (bound by bus-port path such as "1-4.2", so two identical mice on different ports stay apart),
optional whole USB host controllers and dedicated CPU threads (physical cores with their SMT siblings). Seats persist in
data/multiseat.json. Topology, the Plug-to-Assign listener and the boot-GPU framebuffer release run on the host over
the SSH bridge, so they are the same for every driver.

Writing a seat into its VM is the active driver's job (get_provider().seat_driver()):
  apply(vmid, seat, state) -> dict   replace the VM's seat devices and CPU affinity with `seat`'s (an empty seat clears
                                     them); `state` is what the previous apply returned, the result is kept for the next
"""
import asyncio
import json
import re
import secrets
import shlex
import time
from pathlib import Path as FsPath

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from . import host_ssh, pci
from .auth import require_step_up_auth, require_user
from providers.registry import get_provider

router = APIRouter(prefix="/api/multiseat", tags=["multiseat"], dependencies=[Depends(require_user)])

DATA = FsPath(__file__).resolve().parent.parent / "data"
SEATS = DATA / "multiseat.json"
PCI_FN_RE = r"^([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$"
USB_PORT_RE = r"^[0-9]{1,3}-[0-9]{1,2}(\.[0-9]{1,2}){0,6}$"
TB_RE = r"^[0-9]{1,2}-[0-9a-f.]{1,20}$"
SEAT_ID = Path(pattern=r"^[0-9a-f]{8}$")
LISTEN_SECONDS = 30
STAGGER_SECONDS = 3
_lock = asyncio.Lock()
_listens: dict[str, dict] = {}

SEAT_PROBE = r"""
r() { tr -d '\t\n' 2>/dev/null <"$1"; }
echo @@PCI@@
for d in /sys/bus/pci/devices/*; do
  case "$(r "$d/class")" in 0x03*|0x0c03*) printf '%s\t%s\t%s\n' "${d##*/}" "$(r "$d/boot_vga")" "$(r "$d/removable")" ;; esac
done
echo @@DRM@@
for c in /sys/class/drm/card*-*; do
  [ -e "$c/status" ] || continue
  n="${c##*/}"
  printf '%s\t%s\t%s\n' "$n" "$(readlink -f "/sys/class/drm/${n%%-*}/device")" "$(r "$c/status")"
done
echo @@TB@@
for d in /sys/bus/thunderbolt/devices/*; do
  [ -e "$d/authorized" ] || continue
  printf '%s\t%s\t%s\t%s\t%s\n' "${d##*/}" "$(r "$d/authorized")" "$(r "$d/vendor_name")" "$(r "$d/device_name")" "$(r "$d/unique_id")"
done
echo @@USB@@
for d in /sys/bus/usb/devices/*; do
  [ -e "$d/busnum" ] || continue
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${d##*/}" "$(r "$d/busnum")" "$(r "$d/idVendor")" "$(r "$d/idProduct")" \
    "$(r "$d/bDeviceClass")" "$(r "$d/speed")" "$(r "$d/product")" "$(r "$d/manufacturer")" "$(readlink -f "$d")"
done
echo @@CPU@@
lscpu -p=CPU,CORE,SOCKET 2>/dev/null
echo @@BOLT@@
command -v boltctl >/dev/null && echo yes
true
"""


# ---------------------------------------------------------------- Pure helpers (unit tested)


def full_slot(s: str) -> str:
    return s if s.count(":") == 2 else f"0000:{s}"


def sections(out: str) -> dict[str, list[str]]:
    secs: dict[str, list[str]] = {}
    cur = None
    for line in out.splitlines():
        m = re.fullmatch(r"@@([A-Z]+)@@", line.strip())
        if m:
            cur = secs.setdefault(m.group(1), [])
        elif cur is not None and line.strip():
            cur.append(line)
    return secs


def parse_cpus(lines: list[str]) -> list[dict]:
    """`lscpu -p=CPU,CORE,SOCKET` -> physical cores [{socket, core, threads: [cpu, sibling]}] in host order."""
    cores: dict[tuple[int, int], list[int]] = {}
    for line in lines:
        if line.startswith("#"):
            continue
        parts = line.split(",")
        if len(parts) >= 3 and all(p.isdigit() for p in parts[:3]):
            cpu, core, sock = map(int, parts[:3])
            cores.setdefault((sock, core), []).append(cpu)
    return [{"socket": s, "core": c, "threads": sorted(t)} for (s, c), t in sorted(cores.items(), key=lambda kv: min(kv[1]))]


def reserved_cores(cores: list[dict]) -> list[dict]:
    """The host keeps its first physical core (two from 8 cores up) for the desktop, the hypervisor and I/O."""
    return cores[:2 if len(cores) >= 8 else 1] if cores else []


def balance(cores: list[dict], seats: int) -> list[list[int]]:
    """Split the non-reserved physical cores into `seats` contiguous groups (SMT siblings stay together)."""
    free = cores[len(reserved_cores(cores)):]
    if seats <= 0:
        return []
    per, extra = divmod(len(free), seats)
    out, i = [], 0
    for n in range(seats):
        take = per + (1 if n < extra else 0)
        out.append(sorted(t for c in free[i:i + take] for t in c["threads"]))
        i += take
    return out


def parse_topology(out: str) -> dict:
    lspci, _, rest = out.partition("@@PCI@@")
    probe = pci.parse(lspci)
    secs = sections("@@PCI@@" + rest)
    sysfs = {}
    for line in secs.get("PCI", []):
        f = line.split("\t")
        sysfs[f[0]] = {"boot_vga": f[1] == "1" if len(f) > 1 else False,
                       "external": len(f) > 2 and f[2] == "removable"}
    connectors: dict[str, list[dict]] = {}
    for line in secs.get("DRM", []):
        f = line.split("\t")
        if len(f) == 3:
            slot = f[1].rsplit("/", 1)[-1]
            name = f[0].split("-", 1)[1] if "-" in f[0] else f[0]
            connectors.setdefault(slot, []).append({"name": name, "status": f[2]})
    gpus, controllers = [], []
    for d in probe["devices"]:
        extra = sysfs.get(d["slot"], {})
        base = {"slot": d["slot"], "id": d["id"], "name": d["name"], "vendor": d["vendor"], "driver": d["driver"],
                "iommu_group": d["iommu_group"], "iommu_shared_with": d["iommu_shared_with"], "warnings": d["warnings"]}
        if d["gpu"]:
            audio = d["audio_function"]
            gpus.append({**base, "boot_vga": extra.get("boot_vga", False), "external": extra.get("external", False),
                         "audio_function": full_slot(f"{d['slot'][:4]}:{audio}") if audio else None,
                         "functions": [full_slot(f"{d['slot'][:4]}:{x}") for x in d["functions"]],
                         "connectors": sorted(connectors.get(d["slot"], []), key=lambda c: c["name"]),
                         # A host driver is fine: the hypervisor rebinds the GPU to vfio-pci when the seat starts.
                         "passthrough_ready": d["iommu_group"] is not None and not d["iommu_shared_with"]})
        elif d["class"] == "0c03":
            controllers.append({**base, "buses": []})
    usb = []
    for line in secs.get("USB", []):
        f = line.split("\t")
        if len(f) < 9:
            continue
        name, bus, vid, pid, cls, speed, product, maker, path = f[:9]
        m = re.findall(r"([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])/usb\d+", path)
        ctrl = m[-1] if m else None
        if name.startswith("usb"):  # a root hub: which bus belongs to which controller
            c = next((c for c in controllers if c["slot"] == ctrl), None)
            if c is not None and bus.isdigit():
                c["buses"].append(int(bus))
            continue
        if ":" in name or not re.fullmatch(USB_PORT_RE, name):
            continue
        usb.append({"port": name, "bus": int(bus) if bus.isdigit() else None, "vendor_id": vid, "product_id": pid,
                    "product": product, "manufacturer": maker, "speed": speed, "hub": cls == "09", "controller": ctrl,
                    "name": product or f"{vid}:{pid}"})
    usb.sort(key=lambda u: [int(x) for x in re.split(r"[-.]", u["port"])])
    tb = []
    for line in secs.get("TB", []):
        f = (line.split("\t") + [""] * 5)[:5]
        tb.append({"id": f[0], "authorized": f[1] not in ("", "0"), "vendor": f[2], "name": f[3], "uuid": f[4]})
    cores = parse_cpus(secs.get("CPU", []))
    return {"gpus": gpus, "usb_controllers": controllers, "usb_devices": usb, "thunderbolt": tb,
            "boltctl": bool(secs.get("BOLT")), "iommu_enabled": probe["iommu_enabled"],
            "cpu": {"cores": cores, "threads": sum(len(c["threads"]) for c in cores),
                    "reserved": sorted(t for c in reserved_cores(cores) for t in c["threads"])}}


def seat_pci(seat: dict) -> list[str]:
    return [x for x in [seat.get("gpu_pci_slot"), seat.get("gpu_audio_pci_slot"), *seat.get("extra_pci_slots", []),
                        *seat.get("usb_controller_pci_slots", [])] if x]


def conflicts(seat: dict, others: list[dict]) -> list[str]:
    """Resources `seat` claims that another seat already holds."""
    out = []
    for o in others:
        n = o.get("name", o.get("seat_id"))
        if seat.get("vm_id") and seat["vm_id"] == o.get("vm_id"):
            out.append(f"VM {seat['vm_id']} already belongs to {n}")
        out += [f"PCIe device {x} is assigned to {n}" for x in set(seat_pci(seat)) & set(seat_pci(o))]
        out += [f"USB port {x} is bound to {n}" for x in set(seat.get("usb_ports", [])) & set(o.get("usb_ports", []))]
        if shared := sorted(set(seat.get("cpu_cores", [])) & set(o.get("cpu_cores", []))):
            out.append(f"CPU threads {', '.join(map(str, shared))} are pinned to {n}")
    return out


def release_script(functions: list[str]) -> str:
    """Free a boot GPU from the host console: unbind the virtual consoles and the firmware framebuffer, then bind all
    of the GPU's functions to vfio-pci, so every GPU in the machine can drive a seat's monitors."""
    fns = " ".join(shlex.quote(full_slot(f)) for f in functions)
    return f"""set -e
for v in /sys/class/vtconsole/vtcon*/bind; do [ -e "$v" ] && echo 0 >"$v" 2>/dev/null || true; done
for fb in /sys/bus/platform/drivers/*/efi-framebuffer.0 /sys/bus/platform/drivers/*/simple-framebuffer.0 \\
          /sys/bus/platform/drivers/*/vesa-framebuffer.0; do
  [ -e "$fb" ] && echo "${{fb##*/}}" >"${{fb%/*}}/unbind" 2>/dev/null || true
done
modprobe vfio-pci
for f in {fns}; do
  d="/sys/bus/pci/devices/$f"
  [ -e "$d" ] || continue
  echo vfio-pci >"$d/driver_override"
  if [ -e "$d/driver" ] && [ "$(basename "$(readlink "$d/driver")")" != vfio-pci ]; then echo "$f" >"$d/driver/unbind"; fi
  [ -e "$d/driver" ] || echo "$f" >/sys/bus/pci/drivers_probe
  echo "$f -> $(basename "$(readlink "$d/driver" 2>/dev/null || echo none)")"
done
"""


def listen_script(seconds: int = LISTEN_SECONDS) -> str:
    """Wait (polling sysfs every 250 ms) for a USB device to appear; 2 s later print every new device (a hub and what
    hangs on it) as port<TAB>class<TAB>product<TAB>manufacturer."""
    return f"""snap() {{ for d in /sys/bus/usb/devices/*; do n="${{d##*/}}"; case "$n" in usb*|*:*) ;; *) echo "$n" ;; esac; done; }}
before="$(snap)"; new=""; i=0
while [ $i -lt {seconds * 4} ]; do
  sleep 0.25; i=$((i + 1))
  new="$(snap | grep -vxF "$before" || true)"
  if [ -n "$new" ]; then sleep 2; new="$(snap | grep -vxF "$before" || true)"; break; fi
done
for n in $new; do
  d="/sys/bus/usb/devices/$n"
  printf '%s\\t%s\\t%s\\t%s\\n' "$n" "$(cat "$d/bDeviceClass" 2>/dev/null)" "$(cat "$d/product" 2>/dev/null)" "$(cat "$d/manufacturer" 2>/dev/null)"
done
true
"""


def parse_new_usb(out: str) -> list[dict]:
    devs = []
    for line in out.splitlines():
        f = (line.split("\t") + [""] * 4)[:4]
        if re.fullmatch(USB_PORT_RE, f[0]):
            devs.append({"port": f[0], "hub": f[1] == "09", "name": f[2] or f[3] or "USB device"})
    return devs


# ---------------------------------------------------------------- Store


def _load() -> list[dict]:
    try:
        data = json.loads(SEATS.read_text())
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save(seats: list[dict]) -> None:
    SEATS.parent.mkdir(parents=True, exist_ok=True)
    tmp = SEATS.with_suffix(".tmp")
    tmp.write_text(json.dumps(seats, indent=2))
    tmp.replace(SEATS)


def _find(seats: list[dict], seat_id: str) -> dict:
    s = next((s for s in seats if s["seat_id"] == seat_id), None)
    if s is None:
        raise HTTPException(404, "Seat not found")
    return s


def driver():
    d = get_provider().seat_driver()
    if d is None:
        raise get_provider().not_available()
    return d


async def topology() -> dict:
    return parse_topology(await host_ssh.run(pci.PROBE + "\n" + SEAT_PROBE, timeout=40))


async def _vms() -> dict[int, dict]:
    return {int(g["vmid"]): g for g in await get_provider().guest_rows() if g.get("type") == "qemu"}


async def _apply(seat: dict, vmid: int | None = None) -> None:
    """Write `seat` into its VM (or clear the seat devices from `vmid`) and remember the driver's state."""
    target = vmid or seat.get("vm_id")
    if not target:
        return
    empty = {"usb_ports": [], "cpu_cores": [], "extra_pci_slots": [], "usb_controller_pci_slots": []}
    seat["driver_state"] = await driver().apply(int(target), empty if vmid else seat, seat.get("driver_state") or {})


# ---------------------------------------------------------------- Models & routes


class SeatBody(BaseModel):
    name: str = Field(min_length=1, max_length=60, pattern=r"^[^\x00-\x1f<>]+$")
    vm_id: int | None = Field(None, ge=100, le=999_999_999)
    enabled: bool = True
    gpu_pci_slot: str | None = Field(None, pattern=PCI_FN_RE)
    gpu_audio_pci_slot: str | None = Field(None, pattern=PCI_FN_RE)
    extra_pci_slots: list[str] = Field([], max_length=8)
    usb_ports: list[str] = Field([], max_length=14)
    usb_names: dict[str, str] = Field({}, max_length=14)
    usb_controller_pci_slots: list[str] = Field([], max_length=4)
    cpu_cores: list[int] = Field([], max_length=512)

    @field_validator("extra_pci_slots", "usb_controller_pci_slots")
    @classmethod
    def _pci(cls, v: list[str]) -> list[str]:
        for x in v:
            if not re.fullmatch(PCI_FN_RE, x):
                raise ValueError(f"invalid PCI address {x!r}")
        return sorted({full_slot(x) for x in v})

    @field_validator("usb_ports")
    @classmethod
    def _ports(cls, v: list[str]) -> list[str]:
        for x in v:
            if not re.fullmatch(USB_PORT_RE, x):
                raise ValueError(f"invalid USB port {x!r} (bus-port such as 1-4 or 3-2.1)")
        return list(dict.fromkeys(v))

    @field_validator("usb_names")
    @classmethod
    def _names(cls, v: dict[str, str]) -> dict[str, str]:
        return {k: re.sub(r"[\x00-\x1f<>]", "", n)[:80] for k, n in v.items() if re.fullmatch(USB_PORT_RE, k)}

    @field_validator("cpu_cores")
    @classmethod
    def _cores(cls, v: list[int]) -> list[int]:
        if any(c < 0 or c > 4095 for c in v):
            raise ValueError("CPU thread numbers are 0-4095")
        return sorted(set(v))

    def record(self) -> dict:
        d = self.model_dump()
        for k in ("gpu_pci_slot", "gpu_audio_pci_slot"):
            d[k] = full_slot(d[k]) if d[k] else None
        d["usb_names"] = {k: n for k, n in d["usb_names"].items() if k in d["usb_ports"]}
        return d


async def _validate(seat: dict, others: list[dict]) -> None:
    if bad := conflicts(seat, others):
        raise HTTPException(409, "; ".join(bad))
    if seat.get("vm_id") and seat["vm_id"] not in await _vms():
        raise HTTPException(404, f"VM {seat['vm_id']} does not exist")
    if seat.get("cpu_cores"):
        cpu = (await topology())["cpu"]
        threads = {t for c in cpu["cores"] for t in c["threads"]}
        if unknown := sorted(set(seat["cpu_cores"]) - threads):
            raise HTTPException(422, f"This host has no CPU thread {', '.join(map(str, unknown))}")
        if set(cpu["reserved"]) & set(seat["cpu_cores"]):
            raise HTTPException(422, f"CPU threads {', '.join(map(str, cpu['reserved']))} stay reserved for the host")


async def seat_view(seats: list[dict]) -> list[dict]:
    try:
        vms = await _vms()
    except HTTPException:
        vms = {}
    out = []
    for s in seats:
        vm = vms.get(s.get("vm_id") or -1)
        out.append({**{k: v for k, v in s.items() if k != "driver_state"},
                    "vm_name": vm.get("name") if vm else None,
                    "status": (vm.get("status") or "unknown") if vm else ("missing" if s.get("vm_id") else "unassigned")})
    return out


@router.get("/topology")
async def get_topology():
    topo = await topology()
    seats = _load()
    owner = lambda pred: next((s["seat_id"] for s in seats if pred(s)), None)  # noqa: E731
    for g in topo["gpus"]:
        g["seat_id"] = owner(lambda s, g=g: g["slot"] in seat_pci(s))
    for c in topo["usb_controllers"]:
        c["seat_id"] = owner(lambda s, c=c: c["slot"] in seat_pci(s))
    for u in topo["usb_devices"]:
        u["seat_id"] = owner(lambda s, u=u: u["port"] in s.get("usb_ports", []))
    return topo


@router.get("/seats")
async def list_seats():
    return {"seats": await seat_view(_load())}


@router.post("/seats")
async def create_seat(body: SeatBody):
    async with _lock:
        seats = _load()
        seat = {"seat_id": secrets.token_hex(4), **body.record()}
        await _validate(seat, seats)
        await _apply(seat)
        seats.append(seat)
        _save(seats)
    return (await seat_view([seat]))[0]


@router.put("/seats/{seat_id}")
async def update_seat(body: SeatBody, seat_id: str = SEAT_ID):
    async with _lock:
        seats = _load()
        old = _find(seats, seat_id)
        seat = {**old, **body.record()}
        await _validate(seat, [s for s in seats if s["seat_id"] != seat_id])
        if old.get("vm_id") and old["vm_id"] != seat.get("vm_id"):
            if old["vm_id"] in await _vms():
                await _apply(old, vmid=old["vm_id"])  # the seat moved to another VM: clear the old one
            seat["driver_state"] = {}
        await _apply(seat)
        seats[seats.index(old)] = seat
        _save(seats)
    return (await seat_view([seat]))[0]


@router.delete("/seats/{seat_id}")
async def delete_seat(seat_id: str = SEAT_ID):
    async with _lock:
        seats = _load()
        seat = _find(seats, seat_id)
        if seat.get("vm_id") and seat["vm_id"] in await _vms():
            await _apply(seat, vmid=seat["vm_id"])
        seats.remove(seat)
        _save(seats)
    return {"ok": True}


class BalanceBody(BaseModel):
    seat_ids: list[str] = Field([], max_length=32)  # empty = every enabled seat


@router.post("/seats/auto-balance")
async def auto_balance(body: BalanceBody):
    """Give each seat an equal, non-overlapping share of whole physical cores (with their SMT siblings)."""
    async with _lock:
        seats = _load()
        picked = [s for s in seats if (s["seat_id"] in body.seat_ids if body.seat_ids else s.get("enabled", True))]
        if not picked:
            raise HTTPException(409, "No seats to balance")
        cores = (await topology())["cpu"]["cores"]
        groups = balance(cores, len(picked))
        if any(not g for g in groups):
            raise HTTPException(409, f"{len(cores)} physical core(s) cannot be split over {len(picked)} seat(s) "
                                     "while the host keeps its own core")
        errors = []
        for s, g in zip(picked, groups):
            s["cpu_cores"] = g
            try:
                await _apply(s)
            except HTTPException as e:
                errors.append(f"{s['name']}: {e.detail}")
        _save(seats)
    return {"seats": await seat_view(seats), "errors": errors}


async def _start(seat: dict, topo: dict) -> dict:
    if not seat.get("vm_id"):
        raise HTTPException(409, f"{seat['name']} has no VM yet")
    vm = (await _vms()).get(seat["vm_id"])
    if vm is None:
        raise HTTPException(404, f"VM {seat['vm_id']} does not exist")
    if vm.get("status") == "running":
        return {"seat_id": seat["seat_id"], "status": "running", "released": []}
    await _apply(seat)  # refresh: USB devices plugged in since the last save, a changed GPU driver
    released = []
    gpu = next((g for g in topo["gpus"] if g["slot"] == seat.get("gpu_pci_slot")), None)
    if gpu and gpu["boot_vga"] and gpu["driver"] != "vfio-pci":
        fns = sorted(set(gpu["functions"]) | ({seat["gpu_audio_pci_slot"]} if seat.get("gpu_audio_pci_slot") else set()))
        await host_ssh.run(release_script(fns), timeout=60)
        released = fns
    await get_provider().guest_power_action("qemu", seat["vm_id"], "start")
    return {"seat_id": seat["seat_id"], "status": "starting", "released": released}


@router.post("/seats/{seat_id}/start")
async def start_seat(seat_id: str = SEAT_ID):
    async with _lock:
        seats = _load()
        seat = _find(seats, seat_id)
        res = await _start(seat, await topology())
        _save(seats)
    return res


@router.post("/seats/{seat_id}/stop")
async def stop_seat(seat_id: str = SEAT_ID):
    seat = _find(_load(), seat_id)
    if not seat.get("vm_id"):
        raise HTTPException(409, f"{seat['name']} has no VM yet")
    await get_provider().guest_power_action("qemu", seat["vm_id"], "shutdown")
    return {"ok": True}


@router.post("/seats/start-all")
async def start_all():
    """Start every enabled seat one after the other, 3 seconds apart (vfio-pci binding first)."""
    results = []
    async with _lock:
        seats = _load()
        topo = await topology()
        todo = [s for s in seats if s.get("enabled", True) and s.get("vm_id")]
        for n, s in enumerate(todo):
            try:
                r = await _start(s, topo)
            except HTTPException as e:
                r = {"seat_id": s["seat_id"], "status": "error", "error": str(e.detail)}
            results.append(r)
            if n < len(todo) - 1 and r["status"] == "starting":
                await asyncio.sleep(STAGGER_SECONDS)
        _save(seats)
    return {"results": results}


# ---------------------------------------------------------------- Plug to Assign


class ListenBody(BaseModel):
    seat_id: str = Field(pattern=r"^[0-9a-f]{8}$")


async def _listen(sid: str) -> None:
    sess = _listens[sid]
    try:
        out = await host_ssh.run(listen_script(), timeout=LISTEN_SECONDS + 20)
        devs = parse_new_usb(out)
        if not devs:
            sess.update(status="timeout")
            return
        sess["devices"] = devs
        bind = [d for d in devs if not d["hub"]]
        if not bind:
            sess.update(status="hub_only")
            return
        async with _lock:
            seats = _load()
            seat = _find(seats, sess["seat_id"])
            taken = {p for s in seats if s is not seat for p in s.get("usb_ports", [])}
            added = [d for d in bind if d["port"] not in taken and d["port"] not in seat.get("usb_ports", [])]
            sess["skipped"] = [d["port"] for d in bind if d["port"] in taken]
            seat["usb_ports"] = [*seat.get("usb_ports", []), *(d["port"] for d in added)][:14]
            seat["usb_names"] = {**seat.get("usb_names", {}), **{d["port"]: d["name"][:80] for d in added}}
            try:
                await _apply(seat)
            except HTTPException as e:
                sess["warning"] = str(e.detail)
            _save(seats)
        sess.update(status="detected", bound=[d["port"] for d in added])
    except HTTPException as e:
        sess.update(status="error", error=str(e.detail))
    except Exception as e:  # noqa: BLE001 - a background task: report instead of dying silently
        sess.update(status="error", error=str(e))


@router.post("/usb/listen")
async def start_listen(body: ListenBody):
    _find(_load(), body.seat_id)
    now = time.time()
    for k in [k for k, s in _listens.items() if now - s["started"] > 600]:
        _listens.pop(k)
    if any(s["status"] == "listening" for s in _listens.values()):
        raise HTTPException(409, "Plug to Assign is already listening for another seat")
    sid = secrets.token_hex(8)
    _listens[sid] = {"session_id": sid, "seat_id": body.seat_id, "status": "listening", "started": now,
                     "seconds": LISTEN_SECONDS, "devices": [], "bound": [], "skipped": []}
    _listens[sid]["task"] = asyncio.create_task(_listen(sid))
    return {k: v for k, v in _listens[sid].items() if k != "task"}


@router.get("/usb/listen/{session_id}")
async def get_listen(session_id: str = Path(pattern=r"^[0-9a-f]{16}$")):
    s = _listens.get(session_id)
    if s is None:
        raise HTTPException(404, "Unknown listener session")
    return {**{k: v for k, v in s.items() if k != "task"},
            "remaining": max(0, round(s["started"] + s["seconds"] - time.time()))}


# ---------------------------------------------------------------- External GPUs (Thunderbolt / USB4)


class EgpuBody(BaseModel):
    device: str = Field(pattern=TB_RE)


@router.post("/egpu/authorize", dependencies=[Depends(require_step_up_auth)])
async def authorize_egpu(body: EgpuBody):
    """Authorize a newly connected Thunderbolt / USB4 enclosure (boltctl enrolls it for good) and rescan PCI."""
    d = shlex.quote(f"/sys/bus/thunderbolt/devices/{body.device}")
    out = await host_ssh.run(
        f"[ -e {d}/authorized ] || {{ echo 'no such Thunderbolt device'; exit 3; }}; "
        f"if command -v boltctl >/dev/null && [ -s {d}/unique_id ]; then boltctl enroll --policy auto \"$(cat {d}/unique_id)\" "
        f"|| boltctl authorize \"$(cat {d}/unique_id)\"; else echo 1 >{d}/authorized; fi; "
        "sleep 1; echo 1 >/sys/bus/pci/rescan; echo authorized=$(cat " + d + "/authorized)", timeout=60)
    return {"ok": "authorized=0" not in out, "log": out[-2000:]}
