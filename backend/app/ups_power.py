"""UPS power protection (Network UPS Tools) and the eco power scheduler.

NUT runs on the host: a USB UPS (`usbhid-ups` and friends, standalone mode) or a UPS another machine serves
(netclient mode). SolarDeck polls `upsc` every 10 s for the live battery (charge %, load %, input voltage, runtime);
when the UPS is on battery and the charge falls to the configured threshold (or the runtime below the minimum), it shuts
down every running guest in order (VMs and containers by the configured order, then the rest), syncs ZFS and powers the
host off. upsmon's own SHUTDOWNCMD stays as the safety net when the backend is not running.

Power profiles set the host CPU governor (performance / balanced / eco); eco can also pause chosen lab guests. A
schedule switches profiles at set times.
"""
import asyncio
import logging
import re
import secrets
import time
from contextlib import suppress
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import audit_log, automation, host_ssh, platform_modules as pm, secrets_vault
from .auth import require_user
from .net_services import load as host_load, save as host_save

MODULE = "ups_power"
router = APIRouter(prefix="/api/ups", tags=["ups_power"], dependencies=[Depends(require_user)])
gated = [Depends(pm.require_module(MODULE))]
log = logging.getLogger(__name__)
UPS = "solardeck"
HEADER = "# Managed by SolarDeck (Power & UPS). Changes here are overwritten.\n"
GOVERNORS = {"performance": "performance", "balanced": "schedutil", "eco": "powersave"}
DEFAULT = {"mode": "usb", "driver": "usbhid-ups", "port": "auto", "remote": "", "username": "solardeck", "password": "",
           "shutdown_charge_percent": 20, "shutdown_runtime_seconds": 180, "shutdown_order": [], "guest_timeout_seconds": 120,
           "profile": "balanced", "eco_pause_vmids": [], "schedule": []}
SECRET = ("password",)
_status: dict = {"online": False, "at": 0}
_shutting_down = False


class ScheduleEntry(BaseModel):
    at: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    days: list[Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]] = Field(min_length=1)
    profile: Literal["performance", "balanced", "eco"]


class UpsBody(BaseModel):
    mode: Literal["usb", "netclient"] = "usb"
    driver: str = Field("usbhid-ups", pattern=r"^[a-z0-9_-]{2,32}$")
    port: str = Field("auto", pattern=r"^[A-Za-z0-9/._:-]{1,64}$")
    remote: str = Field("", pattern=r"^([A-Za-z0-9_-]+@[A-Za-z0-9.:-]+)?$")  # ups@host for netclient
    username: str = Field("solardeck", pattern=r"^[a-z][a-z0-9_-]{0,31}$")
    password: str | None = Field(None, max_length=64, pattern=r"^[A-Za-z0-9._~!@#%^*+=-]*$")  # None keeps the current one
    shutdown_charge_percent: int = Field(20, ge=5, le=90)
    shutdown_runtime_seconds: int = Field(180, ge=0, le=7200)
    shutdown_order: list[int] = Field([], max_length=500)
    guest_timeout_seconds: int = Field(120, ge=10, le=900)


class ProfileBody(BaseModel):
    profile: Literal["performance", "balanced", "eco"]
    eco_pause_vmids: list[int] | None = Field(None, max_length=200)
    schedule: list[ScheduleEntry] | None = Field(None, max_length=50)


# ---------------------------------------------------------------- Rendering & parsing (pure, tests/test_core_modules.py)


def render_nut(c: dict) -> dict[str, str]:
    """NUT config files for standalone (USB) or netclient mode."""
    pw = c["password"]
    files = {"/etc/nut/nut.conf": f"{HEADER}MODE={'netclient' if c['mode'] == 'netclient' else 'standalone'}\n"}
    target = c["remote"] if c["mode"] == "netclient" else f"{UPS}@localhost"
    role = "secondary" if c["mode"] == "netclient" else "primary"
    files["/etc/nut/upsmon.conf"] = (f"{HEADER}MONITOR {target} 1 {c['username']} {pw} {role}\nMINSUPPLIES 1\n"
                                     'SHUTDOWNCMD "/sbin/shutdown -h +0"\nPOWERDOWNFLAG /etc/killpower\n')
    if c["mode"] == "usb":
        files["/etc/nut/ups.conf"] = f"{HEADER}[{UPS}]\n  driver = {c['driver']}\n  port = {c['port']}\n  desc = \"SolarDeck UPS\"\n"
        files["/etc/nut/upsd.conf"] = f"{HEADER}LISTEN 127.0.0.1 3493\nLISTEN ::1 3493\n"
        files["/etc/nut/upsd.users"] = f"{HEADER}[{c['username']}]\n  password = {pw}\n  upsmon primary\n"
    return files


def parse_upsc(text: str) -> dict:
    v = dict(line.split(": ", 1) for line in text.splitlines() if ": " in line)
    num = lambda k: float(v[k]) if re.fullmatch(r"-?[0-9.]+", v.get(k, "")) else None  # noqa: E731
    flags = v.get("ups.status", "").split()
    return {"online": bool(v), "status": v.get("ups.status", ""), "on_battery": "OB" in flags, "low_battery": "LB" in flags,
            "charge_percent": num("battery.charge"), "load_percent": num("ups.load"), "input_voltage": num("input.voltage"),
            "runtime_seconds": num("battery.runtime"), "model": v.get("device.model") or v.get("ups.model", ""),
            "manufacturer": v.get("device.mfr") or v.get("ups.mfr", "")}


def must_shut_down(s: dict, c: dict) -> bool:
    if not s.get("on_battery"):
        return False
    charge, runtime = s.get("charge_percent"), s.get("runtime_seconds")
    return bool(s.get("low_battery") or (charge is not None and charge <= c["shutdown_charge_percent"]) or
                (runtime is not None and c["shutdown_runtime_seconds"] and runtime <= c["shutdown_runtime_seconds"]))


def shutdown_sequence(guests: list[dict], order: list[int]) -> list[dict]:
    """Running guests in shutdown order: the configured VMIDs first, in that order, then the rest (VMs before containers)."""
    running = [g for g in guests if g.get("status") == "running" and g.get("type") in ("qemu", "lxc")]
    pos = {vmid: i for i, vmid in enumerate(order)}
    return sorted(running, key=lambda g: (pos.get(int(g["vmid"]), len(pos)), g["type"] != "qemu", int(g["vmid"])))


def due_profile(schedule: list[dict], now: time.struct_time) -> str | None:
    day = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[now.tm_wday]
    hhmm = f"{now.tm_hour:02d}:{now.tm_min:02d}"
    return next((e["profile"] for e in schedule if e["at"] == hhmm and day in e["days"]), None)


# ---------------------------------------------------------------- State


async def load() -> dict:
    return secrets_vault.decrypt_fields(await host_load("ups", DEFAULT), SECRET)


async def store(c: dict) -> None:
    await host_save("ups", secrets_vault.encrypt_fields(c, SECRET))


async def read_status() -> dict:
    global _status
    c = await load()
    target = c["remote"] if c["mode"] == "netclient" and c["remote"] else f"{UPS}@localhost"
    out = await host_ssh.run(f"upsc {target} 2>/dev/null || true", check=False, timeout=15)
    _status = {**parse_upsc(out), "at": int(time.time()), "shutting_down": _shutting_down}
    return _status


async def graceful_shutdown(reason: str) -> None:
    """Ordered guest shutdown, ZFS sync, host power-off."""
    global _shutting_down
    from providers.registry import get_provider
    if _shutting_down:
        return
    _shutting_down = True
    c = await load()
    audit_log.record("ups.shutdown", reason=reason)
    with suppress(Exception):
        await automation.dispatch("UPS: shutting down the server", reason, "critical")
    p = get_provider()
    for g in shutdown_sequence(await p.guest_rows(), c["shutdown_order"]):
        try:
            await p.guest_power_action(g["type"], int(g["vmid"]), "shutdown")
        except Exception as e:  # noqa: BLE001 - keep going: the host must still power off
            log.warning("UPS shutdown of %s %s failed: %s", g["type"], g["vmid"], e)
        for _ in range(c["guest_timeout_seconds"] // 5):  # one guest at a time, so the order holds
            await asyncio.sleep(5)
            if not any(str(x.get("vmid")) == str(g["vmid"]) and x.get("status") == "running" for x in await p.guest_rows()):
                break
    await host_ssh.run("sync; command -v zpool >/dev/null && zpool sync; sync; shutdown -h +0", check=False, timeout=60)


async def monitor_loop() -> None:
    last_profile_min = None
    while True:
        await asyncio.sleep(10)
        try:
            if not pm.profile(MODULE)["enabled"]:
                continue
            s = await read_status()
            c = await load()
            if must_shut_down(s, c):
                await graceful_shutdown(f"UPS on battery at {s.get('charge_percent')} % ({s.get('runtime_seconds')} s left)")
            now = time.localtime()
            if (now.tm_hour, now.tm_min) != last_profile_min:
                last_profile_min = (now.tm_hour, now.tm_min)
                if (prof := due_profile(c["schedule"], now)) and prof != c["profile"]:
                    await set_profile(prof, c)
        except Exception as e:  # noqa: BLE001 - the watchdog must keep running
            log.debug("UPS poll failed: %s", e)


# ---------------------------------------------------------------- Power profiles


async def set_profile(profile: str, c: dict) -> None:
    from providers.registry import get_provider
    gov = GOVERNORS[profile]
    await host_ssh.run(f"for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do "
                       f"grep -qw {gov} ${{f%/*}}/scaling_available_governors 2>/dev/null && echo {gov} > $f "
                       f"|| {{ [ {gov} = schedutil ] && echo ondemand > $f 2>/dev/null; }}; done; true", check=False)
    p = get_provider()
    if (profile == "eco") != (c.get("profile") == "eco"):  # entering eco pauses the lab guests, leaving it starts them
        rows = {int(g["vmid"]): g for g in await p.guest_rows()}
        for vmid in c.get("eco_pause_vmids", []):
            if g := rows.get(vmid):
                with suppress(Exception):
                    await p.guest_power_action(g["type"], vmid, "shutdown" if profile == "eco" else "start")
    c["profile"] = profile
    await store(c)


# ---------------------------------------------------------------- Routes


@router.get("/status")
async def status():
    if not pm.profile(MODULE)["enabled"]:
        return {"enabled": False}
    s = _status if time.time() - _status.get("at", 0) < 15 else await read_status()
    return {"enabled": True, **s}


@router.get("/config")
async def get_config():
    c = await load()
    governors = await host_ssh.run("cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors 2>/dev/null || true", check=False)
    return {**{k: v for k, v in c.items() if k != "password"}, "password_set": bool(c["password"]),
            "available_governors": governors.split(), "module": pm.profile(MODULE)}


@router.put("/config", dependencies=gated)
async def put_config(body: UpsBody):
    c = await load()
    c.update(body.model_dump(exclude={"password"}))
    if body.password:
        c["password"] = body.password
    if not c["password"]:
        c["password"] = secrets.token_urlsafe(18)  # upsd <-> upsmon on the host only
    if c["mode"] == "netclient" and not c["remote"]:
        raise HTTPException(422, "Enter the UPS to monitor as name@host")
    await store(c)
    await host_ssh.run("command -v upsc >/dev/null || (DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
                       "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nut >/dev/null)", timeout=600)
    for path, text in render_nut(c).items():
        await host_ssh.write_file(path, text, "640")
    await host_ssh.run("chgrp nut /etc/nut/*.conf /etc/nut/upsd.users 2>/dev/null; "
                       + ("upsdrvctl stop >/dev/null 2>&1; upsdrvctl start; systemctl restart nut-server; " if c["mode"] == "usb" else "")
                       + "systemctl restart nut-monitor || systemctl restart nut-client", check=False, timeout=90)
    await asyncio.sleep(2)
    return await read_status()


@router.put("/profile", dependencies=gated)
async def put_profile(body: ProfileBody):
    c = await load()
    if body.eco_pause_vmids is not None:
        c["eco_pause_vmids"] = body.eco_pause_vmids
    if body.schedule is not None:
        c["schedule"] = [e.model_dump() for e in body.schedule]
    await set_profile(body.profile, c)
    return {"ok": True, "profile": body.profile}


@router.get("/drivers")
async def drivers():
    """USB devices that look like a UPS (`nut-scanner -U`), for the setup form."""
    out = await host_ssh.run("command -v nut-scanner >/dev/null && nut-scanner -U -q 2>/dev/null || true", check=False, timeout=60)
    return {"found": [dict(re.findall(r'(\w+) = "([^"]*)"', block)) for block in out.split("[") if "driver" in block]}
