"""Visual inter-VLAN / DMZ firewall (nftables zones and ordered rules) and intrusion prevention (fail2ban jails).

Zones name a set of host interfaces (a switch, a VLAN sub-interface, a lab bridge). Ordered rules between zones are
rendered into their own `inet <prefix>_zones` table (forward hook), applied by a oneshot unit so they survive reboots;
traffic no rule matches keeps today's behaviour (accept), so turning the module on never cuts a network by itself.
Intrusion prevention installs fail2ban on the host with SolarDeck's jail file and exposes the jails' banned addresses
with manual ban / unban.
"""
import asyncio
import ipaddress
import re
import secrets
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator, model_validator

from . import host_ssh, platform_modules as pm
from .auth import require_user
from .config import settings
from .net_services import load as host_load, save as host_save

MODULE = "vlan_firewall"
router = APIRouter(prefix="/api/firewall", tags=["vlan_firewall"], dependencies=[Depends(require_user)])
gated = [Depends(pm.require_module(MODULE))]
P = settings.system_prefix
TABLE = f"{P.replace('-', '_')}_zones"
UNIT = f"{P}-zone-firewall"
SCRIPT = f"/etc/{P}/net/zone-firewall.sh"
JAIL_FILE = f"/etc/fail2ban/jail.d/{P}.local"
HEADER = "# Managed by SolarDeck (Firewall & IDS). Changes here are overwritten.\n"
ZONE_RE = r"^[a-z][a-z0-9_]{0,15}$"
IFACE_RE = r"^[A-Za-z][A-Za-z0-9_.-]{0,14}$"
JAIL_RE = r"^[a-z][a-z0-9_-]{0,31}$"
DEFAULT = {"zones": [], "rules": [], "ids": {"jails": ["sshd"], "bantime": 3600, "findtime": 600, "maxretry": 5,
                                             "ignoreip": []}}
JAILS = {"sshd": "SSH sign-ins", "recidive": "Repeat offenders (bans again for a week)",
         "nginx-http-auth": "Web password prompts", "nginx-limit-req": "Web rate-limit violations"}


class ZoneBody(BaseModel):
    id: str = Field(pattern=ZONE_RE)
    name: str = Field(min_length=1, max_length=40, pattern=r"^[^\n\r\"'`$\\]*$")
    kind: Literal["management", "vlan", "dmz", "isolated_lab", "wan"] = "vlan"
    interfaces: list[str] = Field(min_length=1, max_length=16)
    color: str = Field("#38bdf8", pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("interfaces")
    @classmethod
    def _ifaces(cls, v: list[str]) -> list[str]:
        if bad := [i for i in v if not re.fullmatch(IFACE_RE, i)]:
            raise ValueError(f"Invalid interface: {bad[0]}")
        return v


class RuleBody(BaseModel):
    source_zone: str = Field(pattern=ZONE_RE)
    dest_zone: str = Field(pattern=ZONE_RE)
    protocol: Literal["any", "tcp", "udp", "icmp"] = "any"
    port_range: str = Field("", pattern=r"^([0-9]{1,5}(-[0-9]{1,5})?)?$")
    action: Literal["accept", "drop", "reject"] = "drop"
    log: bool = False
    enabled: bool = True
    comment: str = Field("", max_length=60, pattern=r"^[^\n\r\"'`$\\]*$")

    @model_validator(mode="after")
    def _ports(self):
        if self.port_range:
            if self.protocol not in ("tcp", "udp"):
                raise ValueError("Ports need TCP or UDP")
            a, _, b = self.port_range.partition("-")
            if not 1 <= int(a) <= 65535 or (b and not int(a) <= int(b) <= 65535):
                raise ValueError("Ports are 1-65535 (or a range a-b)")
        return self


class IdsBody(BaseModel):
    jails: list[Literal["sshd", "recidive", "nginx-http-auth", "nginx-limit-req"]] = ["sshd"]
    bantime: int = Field(3600, ge=60, le=31_536_000)
    findtime: int = Field(600, ge=60, le=86400)
    maxretry: int = Field(5, ge=1, le=100)
    ignoreip: list[str] = Field([], max_length=50)

    @field_validator("ignoreip")
    @classmethod
    def _nets(cls, v: list[str]) -> list[str]:
        return [str(ipaddress.ip_network(x.strip(), strict=False)) for x in v if x.strip()]


class BanBody(BaseModel):
    jail: str = Field(pattern=JAIL_RE)
    ip: str

    @field_validator("ip")
    @classmethod
    def _ip(cls, v: str) -> str:
        return str(ipaddress.ip_address(v.strip()))


# ---------------------------------------------------------------- Rendering (pure, tests/test_core_modules.py)


def render_zone_rules(state: dict) -> str:
    zones = {z["id"]: z for z in state["zones"]}
    quoted = lambda d: ", ".join(f'"{i}"' for i in d["interfaces"])  # noqa: E731
    sets = "".join(f"  set z_{z} {{ type ifname; elements = {{ {quoted(d)} }} }}\n" for z, d in zones.items())
    lines = []
    for n, r in enumerate(state["rules"], 1):
        if not r.get("enabled", True) or r["source_zone"] not in zones or r["dest_zone"] not in zones:
            continue
        m = f"iifname @z_{r['source_zone']} oifname @z_{r['dest_zone']}"
        if r["protocol"] == "icmp":
            m += " meta l4proto { icmp, ipv6-icmp }"
        elif r["protocol"] != "any":
            m += f" meta l4proto {r['protocol']}" + (f" th dport {r['port_range']}" if r.get("port_range") else "")
        log = f' log prefix "sd-fw-{n} "' if r.get("log") else ""
        lines.append(f'    {m}{log} counter {r["action"]} comment "rule {n}"')
    return (f"table inet {TABLE} {{\n{sets}  chain forward {{\n    type filter hook forward priority 0; policy accept;\n"
            "    ct state established,related accept\n    ct state invalid drop\n" + "".join(x + "\n" for x in lines) + "  }\n}\n")


def render_script(state: dict) -> str:
    return f"#!/bin/bash\n{HEADER}nft delete table inet {TABLE} 2>/dev/null || true\nnft -f - <<'NFT'\n{render_zone_rules(state)}NFT\n"


def render_jails(ids: dict) -> str:
    out = [HEADER, "[DEFAULT]", f"bantime = {ids['bantime']}", f"findtime = {ids['findtime']}", f"maxretry = {ids['maxretry']}",
           "banaction = nftables-multiport", "banaction_allports = nftables-allports",
           f"ignoreip = 127.0.0.1/8 ::1 {' '.join(ids.get('ignoreip', []))}".rstrip(), ""]
    for j in JAILS:
        out += [f"[{j}]", f"enabled = {'true' if j in ids['jails'] else 'false'}"]
        if j == "sshd":
            out.append("backend = systemd")
        if j == "recidive":
            out += ["bantime = 604800", "findtime = 86400"]
        out.append("")
    return "\n".join(out)


def parse_jail_status(text: str) -> dict:
    """`fail2ban-client status <jail>` -> {failed, banned_total, banned}."""
    val = lambda k: (re.search(rf"{k}:\s*(.*)", text) or [None, ""])[1].strip()  # noqa: E731
    return {"failed": int(val("Currently failed") or 0), "banned_total": int(val("Total banned") or 0),
            "banned": val("Banned IP list").split()}


UNIT_TEXT = f"""[Unit]
Description=SolarDeck inter-VLAN zone firewall
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash {SCRIPT}
ExecStop=/usr/sbin/nft delete table inet {TABLE}

[Install]
WantedBy=multi-user.target
"""


# ---------------------------------------------------------------- State & apply


async def load() -> dict:
    return await host_load("zone_firewall", DEFAULT)


async def apply(state: dict) -> str:
    await host_ssh.write_file(SCRIPT, render_script(state), "700")
    await host_ssh.write_file(f"/etc/systemd/system/{UNIT}.service", UNIT_TEXT)
    await host_ssh.run(f"systemctl daemon-reload && systemctl enable -q {UNIT} && systemctl restart {UNIT}", timeout=60)
    return await host_ssh.run(f"nft list table inet {TABLE}", check=False)


async def migrate(before: dict, after: dict) -> None:
    if before["enabled"] and not after["enabled"]:
        await host_ssh.run(f"systemctl disable -q --now {UNIT} 2>/dev/null; true", check=False)
    elif after["enabled"]:
        await apply(await load())


pm.HOOKS[MODULE] = migrate


@router.get("")
async def overview():
    s = await load()
    live = await host_ssh.run(f"nft list table inet {TABLE} 2>/dev/null || true", check=False)
    return {**s, "module": pm.profile(MODULE), "ruleset": live, "jail_catalog": JAILS}


@router.put("/zones", dependencies=gated)
async def put_zones(zones: list[ZoneBody]):
    if len({z.id for z in zones}) != len(zones):
        raise HTTPException(422, "Zone ids must be unique")
    s = await load()
    s["zones"] = [z.model_dump() for z in zones]
    known = {z.id for z in zones}
    s["rules"] = [r for r in s["rules"] if r["source_zone"] in known and r["dest_zone"] in known]
    await host_save("zone_firewall", s)
    return {**s, "ruleset": await apply(s)}


@router.put("/rules", dependencies=gated)
async def put_rules(rules: list[RuleBody]):
    """The whole ordered rule list (first match wins); the UI reorders by sending it again."""
    s = await load()
    known = {z["id"] for z in s["zones"]}
    if bad := next((r for r in rules if r.source_zone not in known or r.dest_zone not in known), None):
        raise HTTPException(422, f"Unknown zone in rule {bad.source_zone} → {bad.dest_zone}")
    s["rules"] = [{"id": secrets.token_hex(4), **r.model_dump()} for r in rules]
    await host_save("zone_firewall", s)
    return {**s, "ruleset": await apply(s)}


# ---------------------------------------------------------------- Intrusion prevention (fail2ban)


@router.get("/ids")
async def ids_status():
    s = await load()
    installed = "1" in await host_ssh.run("command -v fail2ban-client >/dev/null && echo 1 || echo 0", check=False)
    jails = {}
    if installed:
        names = await host_ssh.run("fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:\\s*//p'", check=False)
        for j in [x.strip() for x in names.split(",") if re.fullmatch(JAIL_RE, x.strip())]:
            jails[j] = parse_jail_status(await host_ssh.run(f"fail2ban-client status {j}", check=False))
    return {"installed": installed, "settings": s["ids"], "jails": jails, "catalog": JAILS}


@router.put("/ids", dependencies=gated)
async def put_ids(body: IdsBody):
    s = await load()
    s["ids"] = body.model_dump()
    await host_save("zone_firewall", s)
    await host_ssh.run("command -v fail2ban-client >/dev/null || (DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
                       "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null)", timeout=600)
    await host_ssh.write_file(JAIL_FILE, render_jails(s["ids"]))
    await host_ssh.run("systemctl enable -q fail2ban && systemctl restart fail2ban", timeout=60)
    await asyncio.sleep(1)
    return await ids_status()


@router.post("/ids/{action}", dependencies=gated)
async def ban(body: BanBody, action: Literal["ban", "unban"] = Path()):
    cmd = "banip" if action == "ban" else "unbanip"
    out = await host_ssh.run(f"fail2ban-client set {body.jail} {cmd} {body.ip}", check=False)
    if "ERROR" in out or "does not exist" in out:
        raise HTTPException(400, out.strip()[-200:])
    return {"ok": True}
