"""Out-of-band server control (IPMI / Redfish BMCs, Wake-on-LAN) and the browser serial console for guests.

BMC records live in data/oob_hosts.json (mode 600) with their passwords encrypted by the secrets vault. IPMI runs
`ipmitool -I lanplus` on the hypervisor host (the password goes in through the script's environment, never the command
line); Redfish is spoken directly over HTTPS (BMCs ship self-signed certificates, so they are not verified). Wake-on-LAN
magic packets are broadcast from the host, so they reach standby hosts on its own LAN.

The serial console (WS /api/compute/{guest_type}/{guest_id}/serial) is a PTY relay to the hypervisor's own serial /
container console command (the driver's serial_command), so a VM whose display went to a passed-through GPU stays
reachable from the browser.
"""
import ipaddress
import json
import re
import secrets
import shlex
from pathlib import Path as FsPath
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, WebSocket
from pydantic import BaseModel, Field, field_validator

from . import audit_log, host_ssh, platform_modules as pm, secrets_vault
from .auth import COOKIE, require_user, session_claims

MODULE = "oob_bmc"
router = APIRouter(prefix="/api/oob", tags=["oob_control"], dependencies=[Depends(require_user)])
serial = APIRouter(prefix="/api/compute", tags=["oob_control"])
gated = [Depends(pm.require_module(MODULE))]
DATA = FsPath(__file__).resolve().parent.parent / "data"
STATE = DATA / "oob_hosts.json"
MAC_RE = r"^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$"
IPMI_ACTIONS = {"on": "on", "off": "off", "cycle": "cycle", "soft-reset": "soft", "reset": "reset", "status": "status"}
REDFISH_ACTIONS = {"on": "On", "off": "ForceOff", "cycle": "PowerCycle", "soft-reset": "GracefulRestart", "reset": "ForceRestart"}
Action = Literal["on", "off", "cycle", "soft-reset", "reset"]


class BmcBody(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern=r"^[^\n\r\"'`$\\<>]*$")
    protocol: Literal["ipmi", "redfish", "wol_only"] = "ipmi"
    address: str = Field("", max_length=253, pattern=r"^[A-Za-z0-9.:-]*$")
    username: str = Field("", max_length=64, pattern=r"^[^\n\r\"'`$\\ ]*$")
    password: str | None = Field(None, max_length=128, pattern=r"^[^\n\r]*$")  # None keeps the current one
    mac: str = Field("", pattern=rf"^$|{MAC_RE}")
    wol_broadcast: str = "255.255.255.255"

    @field_validator("wol_broadcast")
    @classmethod
    def _bcast(cls, v: str) -> str:
        return str(ipaddress.IPv4Address(v or "255.255.255.255"))


def load() -> list[dict]:
    try:
        return json.loads(STATE.read_text())["hosts"]
    except (OSError, ValueError, KeyError):
        return []


def save(hosts: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"hosts": hosts}, indent=1))
    tmp.chmod(0o600)
    tmp.replace(STATE)


def view(h: dict) -> dict:
    return {k: v for k, v in h.items() if k != "password"} | {"password_set": bool(h.get("password"))}


def _host(host_id: str) -> dict:
    h = next((x for x in load() if x["id"] == host_id), None)
    if not h:
        raise HTTPException(404, "No such host")
    return {**h, "password": secrets_vault.decrypt(h.get("password")) or ""}


# ---------------------------------------------------------------- Pure helpers (tests/test_core_modules.py)


def magic_packet(mac: str) -> bytes:
    raw = bytes.fromhex(re.sub(r"[:-]", "", mac))
    return b"\xff" * 6 + raw * 16


def parse_sdr(text: str) -> list[dict]:
    """`ipmitool sdr elist` -> [{name, status, reading}]."""
    out = []
    for line in text.splitlines():
        cols = [c.strip() for c in line.split("|")]
        if len(cols) >= 5 and cols[0]:
            out.append({"name": cols[0], "status": cols[2], "reading": cols[4]})
    return out


def ipmi_script(h: dict, args: str) -> str:
    return (f"command -v ipmitool >/dev/null || (DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
            f"DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ipmitool >/dev/null)\n"
            f"export IPMI_PASSWORD={shlex.quote(h['password'])}\n"
            f"ipmitool -I lanplus -H {shlex.quote(h['address'])} -U {shlex.quote(h['username'])} -E {args}\n")


# ---------------------------------------------------------------- Redfish


async def _redfish(h: dict, method: str, path: str, body: dict | None = None) -> dict:
    async with httpx.AsyncClient(verify=False, timeout=20, auth=(h["username"], h["password"])) as c:  # noqa: S501 - BMC certs are self-signed
        r = await c.request(method, f"https://{h['address']}{path}", json=body)
    if r.status_code >= 400:
        raise HTTPException(502, f"BMC answered {r.status_code}: {r.text[:200]}")
    return r.json() if r.content else {}


async def _system(h: dict) -> str:
    members = (await _redfish(h, "GET", "/redfish/v1/Systems")).get("Members") or []
    if not members:
        raise HTTPException(502, "The BMC lists no systems")
    return members[0]["@odata.id"]


# ---------------------------------------------------------------- Routes


@router.get("/hosts")
async def list_hosts():
    return {"module": pm.profile(MODULE), "hosts": [view(h) for h in load()]}


@router.post("/hosts", dependencies=gated)
async def add_host(body: BmcBody):
    hosts = load()
    h = {"id": secrets.token_hex(4), **body.model_dump(exclude={"password"}), "password": secrets_vault.encrypt(body.password or "")}
    hosts.append(h)
    save(hosts)
    return view(h)


@router.put("/hosts/{host_id}", dependencies=gated)
async def update_host(body: BmcBody, host_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    hosts = load()
    h = next((x for x in hosts if x["id"] == host_id), None)
    if not h:
        raise HTTPException(404, "No such host")
    h.update(body.model_dump(exclude={"password"}))
    if body.password:  # empty keeps the stored password
        h["password"] = secrets_vault.encrypt(body.password)
    save(hosts)
    return view(h)


@router.delete("/hosts/{host_id}", dependencies=gated)
async def delete_host(host_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    save([x for x in load() if x["id"] != host_id])
    return {"ok": True}


@router.post("/hosts/{host_id}/power/{action}", dependencies=gated)
async def power(action: Action, host_id: str = Path(pattern=r"^[0-9a-f]{8}$"), user: str = Depends(require_user)):
    h = _host(host_id)
    if h["protocol"] == "ipmi":
        out = await host_ssh.run("bash -s", input=ipmi_script(h, f"chassis power {IPMI_ACTIONS[action]}"), timeout=60)
    elif h["protocol"] == "redfish":
        sys_path = await _system(h)
        await _redfish(h, "POST", f"{sys_path}/Actions/ComputerSystem.Reset", {"ResetType": REDFISH_ACTIONS[action]})
        out = f"Redfish {REDFISH_ACTIONS[action]} sent"
    else:
        raise HTTPException(400, "This host only supports Wake-on-LAN")
    audit_log.record("oob.power", user=user, host=h["name"], action=action)
    return {"ok": True, "output": out.strip()[-500:]}


@router.get("/hosts/{host_id}/sensors")
async def sensors(host_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    h = _host(host_id)
    if h["protocol"] == "ipmi":
        state = await host_ssh.run("bash -s", input=ipmi_script(h, "chassis power status"), timeout=30, check=False)
        rows = parse_sdr(await host_ssh.run("bash -s", input=ipmi_script(h, "sdr elist"), timeout=60, check=False))
        return {"power": "on" if "is on" in state else "off" if "is off" in state else "unknown", "sensors": rows}
    if h["protocol"] == "redfish":
        sys_path = await _system(h)
        system = await _redfish(h, "GET", sys_path)
        rows = []
        chassis = ((system.get("Links") or {}).get("Chassis") or [{}])[0].get("@odata.id")
        if chassis:
            thermal = await _redfish(h, "GET", f"{chassis}/Thermal")
            rows += [{"name": t.get("Name"), "status": (t.get("Status") or {}).get("Health", ""),
                      "reading": f"{t.get('ReadingCelsius')} °C"} for t in thermal.get("Temperatures", [])]
            rows += [{"name": f.get("Name"), "status": (f.get("Status") or {}).get("Health", ""),
                      "reading": f"{f.get('Reading')} {f.get('ReadingUnits') or 'RPM'}"} for f in thermal.get("Fans", [])]
        return {"power": str(system.get("PowerState", "unknown")).lower(), "sensors": rows}
    return {"power": "unknown", "sensors": []}


@router.post("/hosts/{host_id}/wake", dependencies=gated)
async def wake(host_id: str = Path(pattern=r"^[0-9a-f]{8}$"), user: str = Depends(require_user)):
    h = _host(host_id)
    if not h.get("mac"):
        raise HTTPException(400, "Enter the host's MAC address for Wake-on-LAN")
    pkt = magic_packet(h["mac"]).hex()
    py = (f"import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);"
          f"[s.sendto(bytes.fromhex('{pkt}'),('{h['wol_broadcast']}',p)) for p in (7,9)]")
    await host_ssh.run(f"python3 -c {shlex.quote(py)}", timeout=15)
    audit_log.record("oob.wake", user=user, host=h["name"])
    return {"ok": True}


@router.post("/serial/{guest_type}/{guest_id}/enable")
async def enable_serial(guest_type: Literal["qemu"], guest_id: int = Path(ge=100)):
    """Give a VM a serial port where the hypervisor needs one for its serial console."""
    return {"ok": True, "restart_needed": await pm.driver().enable_serial(guest_id)}


@serial.websocket("/{guest_type}/{guest_id}/serial")
async def serial_ws(ws: WebSocket, guest_type: Literal["qemu", "lxc"], guest_id: int):
    from . import rbac
    from .console import _accept, ssh_relay
    origin = urlparse(ws.headers.get("origin", "")).hostname
    if origin and origin != (ws.headers.get("host") or "").split(":")[0]:
        await ws.close(code=4403, reason="Cross-origin console refused")
        return
    try:
        claims = session_claims(ws.query_params.get("token") or ws.cookies.get(COOKIE))
    except HTTPException:
        await ws.close(code=4401, reason="Not authenticated")
        return
    if not rbac.can_guest(claims["sub"], guest_id):
        await ws.close(code=4403, reason="Your role does not allow this console")
        return
    try:
        command = pm.driver().serial_command(guest_type, guest_id)
    except HTTPException:
        await ws.close(code=4404, reason="No such guest")
        return
    audit_log.record("serial_console.open", user=claims["sub"], guest=f"{guest_type}/{guest_id}")
    await _accept(ws)
    await ssh_relay(ws, command)
