"""Visual Virtual Switch: bridges, VLANs, host and guest virtual NICs, interface IPs and per-VLAN DHCP servers.

Host network edits are staged (switch-staged.json on the host) and applied in one step: the current config is
snapshotted, the new one written and reloaded by a transient unit, and a 60-second host-side timer restores the
snapshot unless POST /confirm arrives, so a change that cuts the administrator off undoes itself.

The platform's own config format lives in the active driver's network_switch module (get_provider().switch_driver()):
`read(meta)` -> interface model, `render(model)` -> {path: content | None}, SNAPSHOT paths, RELOAD command,
`vlan_script(model)` and the guest NIC handlers `hardware` / `set_net` / `delete_net`. Interface model (one dict per
interface): name, kind (eth|bridge|vlan|dummy|bond|other), method (static|dhcp|manual), address, gateway, address6,
gateway6, dns, mtu, auto, ports, vlan_aware, raw (VLAN parent), vid, pvid (untagged VLAN of a bridge port),
vids (tagged VLANs of a bridge port), mode (bridged|nat|isolated), comment, extra (driver-private).
"""
import asyncio
import ipaddress
import json
import re
import shlex
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import AfterValidator, BaseModel, Field, model_validator

from . import host_ssh
from .auth import require_user
from .config import settings
from .guest_hardware import MAC_RE, GuestType, NetBody
from .net_services import HEADER, NFT_TABLE, STATE_DIR, load, save
from providers.registry import get_provider

router = APIRouter(prefix="/api/network/switch", tags=["network_switch"], dependencies=[Depends(require_user)])

P = settings.system_prefix
STAGED = f"{STATE_DIR}/switch-staged.json"
META = f"{STATE_DIR}/switch.json"
SWITCH_SH = f"{STATE_DIR}/switch.sh"
SWITCH_UNIT = settings.name("switch")
ROLLBACK_DIR = f"/var/lib/{P}/net-rollback"
ROLLBACK_UNIT = settings.name("net-rollback")
APPLY_UNIT = settings.name("net-apply")
ROLLBACK_SECONDS = 60
DHCP_DIR = f"/etc/dnsmasq.d/{P}-vlan"  # a subdirectory: the system dnsmasq's conf-dir only reads regular files
DHCP_UNIT = settings.name("vlan-dhcp")
IFACE_RE = r"^[A-Za-z][A-Za-z0-9_.-]{0,14}$"
COLOR_RE = r"^#[0-9a-fA-F]{6}$"
META_KEYS = ("mode", "comment", "vlan_aware", "pvid", "vids")
LEASE_RE = r"^([0-9]{1,5}[mhd]|infinite)$"


def _cidr(v: str) -> str:
    i = ipaddress.ip_interface(v)
    if "/" not in v:
        raise ValueError("Use CIDR notation, e.g. 10.10.20.1/24")
    return str(i)


def _ip4(v: str) -> str:
    return str(ipaddress.IPv4Address(v))


def _ip(v: str) -> str:
    return str(ipaddress.ip_address(v))


Cidr = Annotated[str, AfterValidator(_cidr)]
IP4 = Annotated[str, AfterValidator(_ip4)]
IP = Annotated[str, AfterValidator(_ip)]
Iface = Annotated[str, Field(pattern=IFACE_RE)]
Vid = Annotated[int, Field(ge=1, le=4094)]


# ---------------------------------------------------------------- Pure helpers (unit tested)


def blank(name: str, kind: str) -> dict:
    return {"name": name, "kind": kind, "method": "manual", "address": None, "gateway": None, "address6": None,
            "gateway6": None, "dns": [], "mtu": None, "auto": True, "ports": [], "vlan_aware": False, "raw": None,
            "vid": None, "pvid": None, "vids": [], "mode": "bridged" if kind == "bridge" else None, "comment": "",
            "extra": None}


def with_meta(model: dict[str, dict], meta: dict) -> dict[str, dict]:
    """Overlay the stored switch metadata (fields a platform config cannot hold) onto a freshly read model."""
    for name, m in (meta or {}).items():
        if name in model:
            model[name].update({k: v for k, v in m.items() if k in META_KEYS and v not in (None, "", [])})
    return model


def meta_of(model: dict[str, dict]) -> dict:
    return {n: {k: i.get(k) for k in META_KEYS} for n, i in model.items()}


def bridge_of(model: dict[str, dict], port: str) -> str | None:
    return next((n for n, i in model.items() if i["kind"] == "bridge" and port in i["ports"]), None)


def port_mode(bridge: dict | None, port: dict) -> tuple[str, int | None, list[int]]:
    """(vlan_mode, access_vlan, tagged_vlans) of a bridge port."""
    if bridge is None:
        return "unassigned", None, []
    if port.get("vids"):
        return "trunk", port.get("pvid") or 1, sorted(port["vids"])
    return "access", port.get("pvid") or 1, []


def assign(model: dict[str, dict], port: str, bridge: str | None, mode: str, vid: int | None, tagged: list[int]) -> None:
    """Move a host port onto `bridge` as an access or trunk port, or out of every bridge (mode unassigned)."""
    for i in model.values():
        if i["kind"] == "bridge" and port in i["ports"]:
            i["ports"].remove(port)
    p = model[port]
    p.update(pvid=None, vids=[])
    if mode == "unassigned":
        return
    if not bridge or model.get(bridge, {}).get("kind") != "bridge":
        raise HTTPException(404, f"Virtual switch {bridge} does not exist")
    b = model[bridge]
    b["ports"] = sorted({*b["ports"], port})
    p.update(method="manual", address=None, gateway=None, address6=None, gateway6=None)
    if mode == "access":
        p["pvid"] = vid if vid and vid != 1 else None
    else:
        p.update(pvid=vid if vid and vid != 1 else None, vids=sorted({v for v in tagged if v != vid}))
    if p["pvid"] or p["vids"]:
        b["vlan_aware"] = True


def guest_tag(mode: str, vid: int | None, tagged: list[int]) -> tuple[int | None, str | None]:
    """(tag, trunks) of a guest NIC for an access / trunk / unassigned assignment."""
    if mode == "access":
        return (vid if vid and vid != 1 else None), None
    if mode == "trunk":
        vids = sorted({v for v in tagged if v != vid})
        return (vid if vid and vid != 1 else None), (";".join(map(str, vids)) or None)
    return None, None


def protected_bridges(model: dict[str, dict]) -> set[str]:
    """Switches that must never be deleted: the default one and any carrying the host's default gateway."""
    return {settings.default_bridge} | {n for n, i in model.items() if i["kind"] == "bridge" and (i["gateway"] or i["method"] == "dhcp")}


def parse_links(ip_json: str, sysinfo: str) -> dict[str, dict]:
    """`ip -j -d addr` + the sysfs lines of LINK_CMD -> {name: live link facts}."""
    out: dict[str, dict] = {}
    for x in json.loads(ip_json or "[]"):
        info = x.get("linkinfo") or {}
        out[x["ifname"]] = {"mac": (x.get("address") or "").upper(), "up": x.get("operstate") == "UP",
                            "kind": info.get("info_kind") or "", "master": x.get("master"), "mtu": x.get("mtu"),
                            "addrs": [f"{a['local']}/{a['prefixlen']}" for a in x.get("addr_info", [])
                                      if a.get("scope") == "global"]}
    for line in sysinfo.splitlines():
        p = line.split("|")
        if len(p) == 6 and p[0] in out:
            speed = int(p[3]) if p[3].lstrip("-").isdigit() and int(p[3]) > 0 else None
            out[p[0]].update(physical=True, link_up=p[1] == "1" or p[2] == "up", speed_mbps=speed, driver=p[4] or None,
                             pci_slot=p[5] or None)
    return out


def render_dhcp(vid: int, iface: str, d: dict) -> str:
    """dnsmasq config of one VLAN: DHCP only (port=0), bound strictly to the VLAN's host interface."""
    lines = [f"interface={iface}", "bind-interfaces", "except-interface=lo", "port=0", "pid-file=",
             f"dhcp-leasefile=/var/lib/misc/dnsmasq.vlan-{vid}.leases", "dhcp-authoritative",
             f"dhcp-range={d['range_start']},{d['range_end']},{d['subnet_mask']},{d['lease_time']}",
             f"dhcp-option=option:router,{d['gateway_ip']}"]
    if d.get("dns_servers"):
        lines.append(f"dhcp-option=option:dns-server,{','.join(d['dns_servers'])}")
    for r in d.get("static_leases") or []:
        lines.append(f"dhcp-host={r['mac'].lower()},{r['ip']}" + (f",{r['hostname']}" if r.get("hostname") else ""))
    return HEADER + "\n".join(lines) + "\n"


def parse_leases(text: str, static: list[dict]) -> list[dict]:
    pinned = {r["mac"].lower() for r in static or []}
    out = []
    for line in text.splitlines():
        p = line.split()
        if len(p) >= 4 and p[0].isdigit():
            out.append({"expires_at": int(p[0]), "mac": p[1].upper(), "ip": p[2], "hostname": "" if p[3] == "*" else p[3],
                        "is_static": p[1].lower() in pinned})
    return out


def render_switch_script(model: dict[str, dict], vlan_lines: str) -> str:
    """Runs after every network reload and at boot: VLAN filtering the platform config cannot express, NAT bridges."""
    nat = [i for i in model.values() if i["kind"] == "bridge" and i.get("mode") == "nat" and i.get("address")]
    rules = "".join(f'    ip saddr {ipaddress.ip_interface(i["address"]).network} oifname != "{i["name"]}" masquerade\n'
                    for i in nat if ipaddress.ip_interface(i["address"]).version == 4)
    sh = "#!/bin/bash\n" + HEADER + vlan_lines
    sh += f"nft delete table ip {NFT_TABLE}_switch 2>/dev/null || true\n"
    if rules:
        sh += ("sysctl -qw net.ipv4.ip_forward=1\n"
               f"nft -f - <<'NFT'\ntable ip {NFT_TABLE}_switch {{\n  chain postrouting {{\n"
               "    type nat hook postrouting priority srcnat; policy accept;\n" + rules + "  }\n}\nNFT\n")
    return sh + "exit 0\n"


def check_model(model: dict[str, dict]) -> None:
    """Refuse a model that cannot work: missing bridge ports or VLAN parents, a port in two switches."""
    seen: dict[str, str] = {}
    for n, i in model.items():
        for p in i["ports"]:
            if p not in model:
                raise HTTPException(422, f"{n}: port {p} does not exist")
            if p in seen:
                raise HTTPException(422, f"{p} is a port of both {seen[p]} and {n}")
            seen[p] = n
        if i["kind"] == "vlan" and i["raw"] not in model:
            raise HTTPException(422, f"{n}: parent interface {i['raw']} does not exist")


# ---------------------------------------------------------------- Host state


def driver():
    d = get_provider().switch_driver()
    if d is None:
        raise get_provider().not_available()
    return d


LINK_CMD = r"""ip -j -d addr; echo '@@'
for d in /sys/class/net/*; do n=${d##*/}; [ -e "$d/device" ] || continue
  echo "$n|$(cat $d/carrier 2>/dev/null)|$(cat $d/operstate 2>/dev/null)|$(cat $d/speed 2>/dev/null)|$(basename "$(readlink $d/device/driver)" 2>/dev/null)|$(basename "$(readlink $d/device)")"
done; echo '@@'
""" + f"""echo now:$(date +%s); systemctl is-active -q {ROLLBACK_UNIT}.timer && echo deadline:$(cat {ROLLBACK_DIR}/deadline 2>/dev/null)
for f in {DHCP_DIR}/*.conf; do [ -e "$f" ] || continue; v=$(basename "$f" .conf); echo dhcp:$v:$(systemctl is-active {DHCP_UNIT}@$v 2>/dev/null); done
command -v dnsmasq >/dev/null && echo dnsmasq:1
"""


async def live() -> tuple[dict[str, dict], dict]:
    out = await host_ssh.run(LINK_CMD, check=False)
    ip_json, sysinfo, tail = (out.split("@@\n") + ["", ""])[:3]
    facts: dict = {"rollback": None, "dhcp": {}, "dnsmasq": False}
    now = 0
    for line in tail.splitlines():
        k, _, v = line.partition(":")
        if k == "now":
            now = int(v)
        elif k == "deadline" and v.strip().isdigit():
            facts["rollback"] = max(0, int(v) - now)
        elif k == "dhcp":
            vid, _, st = v.partition(":")
            facts["dhcp"][vid] = st == "active"
        elif k == "dnsmasq":
            facts["dnsmasq"] = True
    try:
        links = parse_links(ip_json.strip(), sysinfo)
    except ValueError:
        links = {}
    return links, facts


async def current() -> tuple[dict[str, dict], bool]:
    """(staged model if there is one, else the live config; whether it is staged)."""
    txt = await host_ssh.read_file(STAGED)
    if txt.strip():
        try:
            return json.loads(txt), True
        except ValueError:
            pass
    return with_meta(await driver().read(), (await load("switch", {}))), False


async def stage(model: dict[str, dict]) -> dict:
    check_model(model)
    await host_ssh.write_file(STAGED, json.dumps(model, indent=1), "600")
    return {"ok": True, "pending": True}


async def vlans() -> dict[str, dict]:
    return (await load("vlans", {"vlans": {}}))["vlans"]


async def save_vlans(v: dict[str, dict]) -> None:
    await save("vlans", {"vlans": v})


async def guest_nics() -> list[dict]:
    d = driver()
    rows = [g for g in await get_provider().guest_rows() if g.get("type") in ("qemu", "lxc")]

    async def one(g: dict) -> list[dict]:
        try:
            nets = (await d.hardware(g["type"], int(g["vmid"])))["devices"]["net"]
        except (HTTPException, KeyError, ValueError):
            return []
        return [{"guest_id": int(g["vmid"]), "guest_name": g.get("name") or str(g["vmid"]),
                 "guest_type": "vm" if g["type"] == "qemu" else "lxc", "status": g.get("status"),
                 "net_id": n["key"], "index": n["index"], "bridge": n.get("bridge") or "", "vlan_tag": n.get("tag"),
                 "trunks": [int(x) for x in str(n.get("trunks") or "").split(";") if x.isdigit()],
                 "model": n.get("model") or "veth", "mac": n.get("macaddr"), "ip_address": None,
                 "rate_mbps": n.get("rate"), "link_disconnected": bool(n.get("link_down")),
                 "name": n.get("name")} for n in nets]

    return [n for chunk in await asyncio.gather(*(one(g) for g in rows)) for n in chunk]


def view(model: dict[str, dict], links: dict[str, dict], vlan_map: dict[str, dict], guests: list[dict]) -> dict:
    physical = []
    for name, lk in sorted(links.items()):
        if not lk.get("physical"):
            continue
        i = model.get(name) or blank(name, "eth")
        br = bridge_of(model, name)
        mode, access, tagged = port_mode(model.get(br) if br else None, i)
        physical.append({"name": name, "mac": lk["mac"], "link_up": lk["link_up"], "speed_mbps": lk["speed_mbps"],
                         "driver": lk["driver"], "pci_slot": lk["pci_slot"], "assigned_bridge": br, "vlan_mode": mode,
                         "access_vlan": access, "tagged_vlans": tagged, "ipv4_cidr": i["address"],
                         "method": i["method"], "mtu": i["mtu"] or lk["mtu"], "configured": name in model})
    bridges = [{"name": n, "vlan_aware": i["vlan_aware"], "ipv4_cidr": i["address"], "ipv4_gateway": i["gateway"],
                "ipv6_cidr": i["address6"], "ipv6_gateway": i["gateway6"], "dns_servers": i["dns"], "method": i["method"],
                "mtu": i["mtu"] or links.get(n, {}).get("mtu"), "autostart": i["auto"], "mode": i.get("mode") or "bridged",
                "member_ports": i["ports"], "comment": i.get("comment") or "", "live": n in links,
                "live_addrs": links.get(n, {}).get("addrs", []), "protected": n in protected_bridges(model)}
               for n, i in sorted(model.items()) if i["kind"] == "bridge"]
    host_vnics = []
    for n, i in sorted(model.items()):
        if i["kind"] in ("vlan", "dummy"):
            br = bridge_of(model, n)
            mode, access, tagged = port_mode(model.get(br) if br else None, i)
            host_vnics.append({"name": n, "type": i["kind"], "parent": i["raw"], "vlan_id": i["vid"],
                               "ipv4_cidr": i["address"], "method": i["method"], "link_up": links.get(n, {}).get("up", False),
                               "assigned_bridge": br or (i["raw"] if i["kind"] == "vlan" else None),
                               "vlan_mode": mode if br else ("access" if i["kind"] == "vlan" else "unassigned"),
                               "access_vlan": access if br else i["vid"], "tagged_vlans": tagged})
    for n, lk in sorted(links.items()):  # host-side veth pairs that are not a guest's port
        if lk["kind"] == "veth" and not lk.get("master") and n not in model:
            host_vnics.append({"name": n, "type": "veth", "parent": None, "vlan_id": None, "ipv4_cidr": (lk["addrs"] or [None])[0],
                               "method": "manual", "link_up": lk["up"], "assigned_bridge": None, "vlan_mode": "unassigned",
                               "access_vlan": None, "tagged_vlans": []})
    other = [{"name": n, "kind": i["kind"], "ipv4_cidr": i["address"], "method": i["method"]}
             for n, i in sorted(model.items()) if i["kind"] in ("bond", "other")]
    for g in guests:
        g["vlan_mode"] = "trunk" if g["trunks"] else ("access" if g["bridge"] else "unassigned")
    return {"physical": physical, "bridges": bridges, "host_vnics": host_vnics, "guest_vnics": guests,
            "other_interfaces": other,
            "vlans": sorted(({"vlan_id": int(k), **v} for k, v in vlan_map.items()), key=lambda v: v["vlan_id"])}


@router.get("/state")
async def state():
    d = driver()
    (links, facts), (model, pending), vlan_map, guests = await asyncio.gather(live(), current(), vlans(), guest_nics())
    leases = {}  # guest IPs from the per-VLAN DHCP leases, by MAC
    if vlan_map:
        txt = await host_ssh.run("cat /var/lib/misc/dnsmasq.vlan-*.leases /var/lib/misc/dnsmasq.leases 2>/dev/null || true",
                                 check=False)
        leases = {x["mac"]: x["ip"] for x in parse_leases(txt, [])}
    for g in guests:
        g["ip_address"] = leases.get((g["mac"] or "").upper())
    out = view(model, links, vlan_map, guests)
    for v in out["vlans"]:
        v["dhcp_active"] = facts["dhcp"].get(str(v["vlan_id"]), False)
    return {**out, "driver": settings.hypervisor_driver, "default_bridge": settings.default_bridge,
            "bridge_prefix": d.BRIDGE_PREFIX, "pending": pending, "rollback_seconds_left": facts["rollback"],
            "dnsmasq_installed": facts["dnsmasq"], "nic_models": list(d.NIC_MODELS)}


# ---------------------------------------------------------------- Virtual switches & interface IP config


class BridgeBody(BaseModel):
    name: Iface
    vlan_aware: bool = False
    ipv4_cidr: Cidr | None = None
    ipv4_gateway: IP4 | None = None
    ipv6_cidr: Cidr | None = None
    mtu: int | None = Field(None, ge=576, le=9216)
    autostart: bool = True
    mode: Literal["bridged", "nat", "isolated"] = "bridged"
    member_ports: list[Iface] = Field([], max_length=16)
    comment: str = Field("", pattern=r"^[^\n\r\"'`$\\]{0,60}$")

    @model_validator(mode="after")
    def _check(self):
        if self.mode == "nat" and not self.ipv4_cidr:
            raise ValueError("A NAT switch needs its own IPv4 address (the gateway of its guests), e.g. 10.10.10.1/24")
        if self.mode != "bridged" and self.member_ports:
            raise ValueError("Only a bridged switch has physical ports; NAT and isolated switches stay internal")
        return self


def _bridge_fields(i: dict, b: BridgeBody) -> None:
    i.update(vlan_aware=b.vlan_aware, mtu=b.mtu, auto=b.autostart, mode=b.mode,
             comment=b.comment, address=b.ipv4_cidr, gateway=b.ipv4_gateway, address6=b.ipv6_cidr,
             method="static" if b.ipv4_cidr else ("dhcp" if i["method"] == "dhcp" else "manual"))


@router.post("/bridges")
async def create_bridge(body: BridgeBody):
    d = driver()
    if not re.fullmatch(d.BRIDGE_RE, body.name):
        raise HTTPException(422, f"Virtual switch names on this platform look like {d.BRIDGE_PREFIX}1, {d.BRIDGE_PREFIX}2, …")
    model, _ = await current()
    if body.name in model:
        raise HTTPException(409, f"{body.name} already exists")
    model[body.name] = blank(body.name, "bridge")
    _bridge_fields(model[body.name], body)
    for p in body.member_ports:
        model.setdefault(p, blank(p, "eth"))
        assign(model, p, body.name, "access", None, [])
    return await stage(model)


@router.put("/bridges/{name}")
async def update_bridge(body: BridgeBody, name: str = Path(pattern=IFACE_RE)):
    model, _ = await current()
    i = model.get(name)
    if not i or i["kind"] != "bridge":
        raise HTTPException(404, f"Virtual switch {name} does not exist")
    _bridge_fields(i, body)
    for p in set(i["ports"]) - set(body.member_ports):
        assign(model, p, None, "unassigned", None, [])
    for p in set(body.member_ports) - set(i["ports"]):
        model.setdefault(p, blank(p, "eth"))
        assign(model, p, name, "access", None, [])
    return await stage(model)


@router.delete("/bridges/{name}")
async def delete_bridge(name: str = Path(pattern=IFACE_RE)):
    model, _ = await current()
    if name not in model or model[name]["kind"] != "bridge":
        raise HTTPException(404, f"Virtual switch {name} does not exist")
    if name in protected_bridges(model):
        raise HTTPException(409, f"{name} carries the host's own connection and cannot be deleted")
    used = [n for n, i in model.items() if i["kind"] == "vlan" and i["raw"] == name]
    if used:
        raise HTTPException(409, f"Remove the VLAN interfaces on {name} first: {', '.join(used)}")
    del model[name]
    return await stage(model)


class InterfaceBody(BaseModel):
    method: Literal["static", "dhcp", "manual"]
    ipv4_cidr: Cidr | None = None
    ipv4_gateway: IP4 | None = None
    ipv6_cidr: Cidr | None = None
    ipv6_gateway: IP | None = None
    dns_servers: list[IP] = Field([], max_length=4)
    mtu: int | None = Field(None, ge=576, le=9216)
    autostart: bool = True

    @model_validator(mode="after")
    def _check(self):
        if self.method == "static" and not self.ipv4_cidr:
            raise ValueError("A static configuration needs an IPv4 address in CIDR notation")
        if self.ipv4_gateway and self.ipv4_cidr and \
                ipaddress.IPv4Address(self.ipv4_gateway) not in ipaddress.ip_interface(self.ipv4_cidr).network:
            raise ValueError(f"Gateway {self.ipv4_gateway} is outside {ipaddress.ip_interface(self.ipv4_cidr).network}")
        return self


@router.put("/interfaces/{name}")
async def update_interface(body: InterfaceBody, name: str = Path(pattern=IFACE_RE)):
    model, _ = await current()
    links, _ = await live()
    if name not in model and name not in links:
        raise HTTPException(404, f"Interface {name} does not exist")
    i = model.setdefault(name, blank(name, "eth"))
    if bridge_of(model, name) and body.method != "manual":
        raise HTTPException(409, f"{name} is a port of {bridge_of(model, name)}: set the address on the virtual switch instead")
    static = body.method == "static"
    i.update(method=body.method, address=body.ipv4_cidr if static else None, gateway=body.ipv4_gateway if static else None,
             address6=body.ipv6_cidr, gateway6=body.ipv6_gateway, dns=body.dns_servers, mtu=body.mtu, auto=body.autostart)
    if body.ipv4_gateway:  # one default gateway per host
        for other in model.values():
            if other is not i:
                other["gateway"] = None
    return await stage(model)


# ---------------------------------------------------------------- Apply / confirm / revert


def apply_script(snapshot: list[str], reload_cmd: str) -> str:
    """Snapshot the config, write the restore script and arm the rollback timer (one host command)."""
    paths = " ".join(shlex.quote(p) for p in snapshot)
    restore = (f"#!/bin/bash\nfor p in {paths}; do rm -rf \"$p\"; [ -e \"{ROLLBACK_DIR}/files$p\" ] && cp -a "
               f"\"{ROLLBACK_DIR}/files$p\" \"$p\"; done\n{reload_cmd}\nbash {SWITCH_SH} || true\n"
               f"rm -f {ROLLBACK_DIR}/deadline\n")
    return (f"set -e\nif systemctl is-active -q {ROLLBACK_UNIT}.timer; then echo 'A network change is still waiting for "
            f"confirmation' >&2; exit 3; fi\nrm -rf {ROLLBACK_DIR} && mkdir -p {ROLLBACK_DIR}/files\n"
            f"for p in {paths}; do [ -e \"$p\" ] && cp -a --parents \"$p\" {ROLLBACK_DIR}/files/; done\n"
            f"cat > {ROLLBACK_DIR}/restore.sh <<'RESTORE'\n{restore}RESTORE\n"
            f"echo $(( $(date +%s) + {ROLLBACK_SECONDS} )) > {ROLLBACK_DIR}/deadline\n"
            f"systemctl reset-failed {ROLLBACK_UNIT}.timer {ROLLBACK_UNIT}.service 2>/dev/null || true\n"
            f"systemd-run --quiet --unit={ROLLBACK_UNIT} --on-active={ROLLBACK_SECONDS} --timer-property=AccuracySec=1s "
            f"/bin/bash {ROLLBACK_DIR}/restore.sh\n")


SWITCH_SERVICE = f"""[Unit]
Description=SolarDeck virtual switch (VLAN filtering, NAT switches)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash {SWITCH_SH}

[Install]
WantedBy=multi-user.target
"""


async def apply_model(model: dict[str, dict]) -> dict:
    d = driver()
    check_model(model)
    files = {**d.render(model), META: json.dumps(meta_of(model), indent=1),
             SWITCH_SH: render_switch_script(model, d.vlan_script(model))}
    snapshot = [*d.SNAPSHOT, META, SWITCH_SH]
    try:
        await host_ssh.run(apply_script(snapshot, d.RELOAD), timeout=30)
    except HTTPException as e:
        raise HTTPException(409, "A network change is still waiting for confirmation: confirm or revert it first") \
            if "exit 3" in str(e.detail) else e
    try:
        for path, content in files.items():
            if content is None:
                await host_ssh.run(f"rm -f {shlex.quote(path)}")
            else:
                await host_ssh.write_file(path, content, "700" if path == SWITCH_SH else "600")
        await host_ssh.write_file(f"/etc/systemd/system/{SWITCH_UNIT}.service", SWITCH_SERVICE)
        await host_ssh.run(f"rm -f {STAGED}; systemctl daemon-reload; systemctl enable -q {SWITCH_UNIT} || true; "
                           f"systemctl reset-failed {APPLY_UNIT} 2>/dev/null; "
                           f"systemd-run --quiet --collect --unit={APPLY_UNIT} /bin/bash -c "
                           f"{shlex.quote(d.RELOAD + f'; systemctl restart {SWITCH_UNIT}')}")
    except HTTPException:
        await host_ssh.run(f"systemctl stop {ROLLBACK_UNIT}.timer; bash {ROLLBACK_DIR}/restore.sh", check=False, timeout=90)
        raise
    # Wait (best effort) for the reload, so follow-up calls see the new network; the SSH link may drop meanwhile.
    ok, out, _ = await host_ssh.run_host_cmd(
        f"for i in $(seq 40); do systemctl is-active -q {APPLY_UNIT} || break; sleep 0.5; done; echo done", timeout=30)
    return {"ok": True, "pending": False, "rollback_seconds_left": ROLLBACK_SECONDS, "reloaded": ok and "done" in out}


@router.post("/apply")
async def apply():
    model, pending = await current()
    if not pending:
        raise HTTPException(409, "There are no pending network changes")
    return await apply_model(model)


@router.post("/confirm")
async def confirm():
    await host_ssh.run(f"systemctl stop {ROLLBACK_UNIT}.timer 2>/dev/null; rm -rf {ROLLBACK_DIR}; true")
    return {"ok": True}


@router.post("/revert")
async def revert():
    """Undo an unconfirmed apply now (the same restore the timer would run)."""
    out = await host_ssh.run(f"[ -e {ROLLBACK_DIR}/restore.sh ] || exit 4; systemctl stop {ROLLBACK_UNIT}.timer; "
                             f"bash {ROLLBACK_DIR}/restore.sh; rm -rf {ROLLBACK_DIR}", check=False, timeout=120)
    return {"ok": True, "detail": out[-300:]}


@router.post("/discard")
async def discard():
    """Drop the staged (not yet applied) changes."""
    await host_ssh.run(f"rm -f {STAGED}")
    return {"ok": True}


# ---------------------------------------------------------------- Host virtual NICs


class HostVnicBody(BaseModel):
    type: Literal["vlan", "dummy"]
    parent: Iface | None = None
    vlan_id: Vid | None = None
    name: Iface | None = None
    ipv4_cidr: Cidr | None = None

    @model_validator(mode="after")
    def _check(self):
        if self.type == "vlan" and (not self.parent or not self.vlan_id):
            raise ValueError("A VLAN interface needs a parent switch and a VLAN ID")
        if self.type == "dummy" and not self.name:
            raise ValueError("Give the virtual NIC a name, e.g. dummy0")
        return self


def add_host_vnic(model: dict[str, dict], b: HostVnicBody) -> str:
    name = f"{b.parent}.{b.vlan_id}" if b.type == "vlan" else b.name
    if len(name) > 15:
        raise HTTPException(422, f"{name} is longer than the 15 characters an interface name may have")
    if name in model:
        raise HTTPException(409, f"{name} already exists")
    if b.type == "vlan":
        if b.parent not in model:
            raise HTTPException(404, f"{b.parent} does not exist")
        if model[b.parent]["kind"] == "bridge":
            model[b.parent]["vlan_aware"] = True
    i = model[name] = blank(name, b.type)
    i.update(raw=b.parent if b.type == "vlan" else None, vid=b.vlan_id if b.type == "vlan" else None,
             method="static" if b.ipv4_cidr else "manual", address=b.ipv4_cidr)
    return name


@router.post("/vnics/host")
async def create_host_vnic(body: HostVnicBody):
    model, _ = await current()
    name = add_host_vnic(model, body)
    return {**await stage(model), "name": name}


@router.delete("/vnics/host/{name}")
async def delete_host_vnic(name: str = Path(pattern=IFACE_RE)):
    model, _ = await current()
    if model.get(name, {}).get("kind") not in ("vlan", "dummy"):
        raise HTTPException(404, f"{name} is not a host virtual NIC")
    assign(model, name, None, "unassigned", None, [])
    del model[name]
    return await stage(model)


# ---------------------------------------------------------------- Guest virtual NICs


class GuestVnicBody(BaseModel):
    bridge: Iface
    vlan_tag: Vid | None = None
    trunks: list[Vid] = Field([], max_length=64)
    model: Literal["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"] = "virtio"
    mac: str | None = Field(None, pattern=MAC_RE)
    rate_mbps: float | None = Field(None, gt=0, le=100_000)
    link_disconnected: bool = False


class NewGuestVnicBody(GuestVnicBody):
    guest_type: Literal["vm", "lxc"]
    guest_id: int = Field(ge=100, le=999_999_999)


def _kind(guest_type: str) -> GuestType:
    return "qemu" if guest_type == "vm" else "lxc"


def _net_body(b: GuestVnicBody, idx: int, cur: dict | None = None) -> NetBody:
    cur = cur or {}
    return NetBody(bridge=b.bridge, tag=b.vlan_tag, trunks=";".join(map(str, sorted(set(b.trunks)))) or None,
                   model=b.model, macaddr=b.mac, rate=b.rate_mbps, link_down=b.link_disconnected,
                   firewall=bool(cur.get("firewall", True)), name=cur.get("name") or f"eth{idx}", **_keep_ip(cur))


def _keep_ip(cur: dict) -> dict:
    """A container NIC's own address settings, so a re-tag never resets a static address to DHCP."""
    ip = cur.get("ip")
    return {"ip": ip if ip and re.fullmatch(r"dhcp|manual|\d{1,3}(\.\d{1,3}){3}/\d{1,2}", ip) else None,
            "gw": cur.get("gw") or None, "ip6": cur.get("ip6") if cur.get("ip6") in ("auto", "dhcp", "manual") else None}


async def _nets(kind: GuestType, vmid: int) -> list[dict]:
    return (await driver().hardware(kind, vmid))["devices"]["net"]


async def _ensure_vlan_aware(bridge: str, needed: bool) -> dict:
    """Guest VLAN tags need a VLAN-aware switch: switch it on (and apply, with rollback) when it is not yet."""
    if not needed:
        return {}
    model, pending = await current()
    if model.get(bridge, {}).get("kind") != "bridge":
        raise HTTPException(404, f"Virtual switch {bridge} does not exist")
    if model[bridge]["vlan_aware"]:
        return {}
    if pending:
        raise HTTPException(409, f"{bridge} must become VLAN-aware, but other network changes are pending: apply or discard them first")
    model[bridge]["vlan_aware"] = True
    return await apply_model(model)


@router.post("/vnics/guest")
async def create_guest_vnic(body: NewGuestVnicBody):
    kind = _kind(body.guest_type)
    used = {n["index"] for n in await _nets(kind, body.guest_id)}
    idx = next((i for i in range(8) if i not in used), None)
    if idx is None:
        raise HTTPException(409, "This guest already has 8 virtual network cards")
    extra = await _ensure_vlan_aware(body.bridge, bool(body.vlan_tag or body.trunks))
    await driver().set_net(kind, body.guest_id, _net_body(body, idx), idx)
    return {"ok": True, "net_id": f"net{idx}", **extra}


NET_ID = Path(pattern=r"^net[0-7]$")


@router.put("/vnics/guest/{guest_type}/{guest_id}/{net_id}")
async def update_guest_vnic(body: GuestVnicBody, guest_type: Literal["vm", "lxc"], guest_id: int = Path(ge=100),
                            net_id: str = NET_ID):
    idx, kind = int(net_id[3:]), _kind(guest_type)
    cur = next((n for n in await _nets(kind, guest_id) if n["index"] == idx), None)
    if cur is None:
        raise HTTPException(404, f"{guest_type} {guest_id} has no {net_id}")
    extra = await _ensure_vlan_aware(body.bridge, bool(body.vlan_tag or body.trunks))
    await driver().set_net(kind, guest_id, _net_body(body, idx, cur), idx)
    return {"ok": True, **extra}


@router.delete("/vnics/guest/{guest_type}/{guest_id}/{net_id}")
async def delete_guest_vnic(guest_type: Literal["vm", "lxc"], guest_id: int = Path(ge=100), net_id: str = NET_ID):
    await driver().delete_net(_kind(guest_type), guest_id, int(net_id[3:]))
    return {"ok": True}


# ---------------------------------------------------------------- VLANs & drag-and-drop port assignment


class VlanBody(BaseModel):
    vlan_id: Vid
    name: str = Field(pattern=r"^[^\n\r\"'`$\\<>]{1,40}$")
    color: str = Field("#38bdf8", pattern=COLOR_RE)
    bridge: Iface
    host_ipv4_cidr: Cidr | None = None
    description: str = Field("", pattern=r"^[^\n\r\"'`$\\<>]{0,120}$")


class VlanUpdate(BaseModel):
    name: str = Field(pattern=r"^[^\n\r\"'`$\\<>]{1,40}$")
    color: str = Field(pattern=COLOR_RE)
    description: str = Field("", pattern=r"^[^\n\r\"'`$\\<>]{0,120}$")
    host_ipv4_cidr: Cidr | None = None


def set_vlan_host_ip(model: dict[str, dict], bridge: str, vid: int, cidr: str | None) -> bool:
    """Create, readdress or remove the host's interface on a VLAN; True when the model changed."""
    name = f"{bridge}.{vid}"
    i = model.get(name)
    if cidr is None:
        if i is None:
            return False
        del model[name]
        return True
    if i is not None and i["address"] == cidr:
        return False
    if i is None:
        add_host_vnic(model, HostVnicBody(type="vlan", parent=bridge, vlan_id=vid, ipv4_cidr=cidr))
    else:
        i.update(method="static", address=cidr)
    return True


@router.post("/vlans")
async def create_vlan(body: VlanBody):
    v = await vlans()
    if str(body.vlan_id) in v:
        raise HTTPException(409, f"VLAN {body.vlan_id} already exists")
    model, _ = await current()
    if model.get(body.bridge, {}).get("kind") != "bridge":
        raise HTTPException(404, f"Virtual switch {body.bridge} does not exist")
    v[str(body.vlan_id)] = {**body.model_dump(exclude={"vlan_id"}), "dhcp_config": None}
    await save_vlans(v)
    if body.host_ipv4_cidr and set_vlan_host_ip(model, body.bridge, body.vlan_id, body.host_ipv4_cidr):
        return await stage(model)
    return {"ok": True, "pending": False}


@router.put("/vlans/{vlan_id}")
async def update_vlan(body: VlanUpdate, vlan_id: int = Path(ge=1, le=4094)):
    v = await vlans()
    cur = v.get(str(vlan_id))
    if not cur:
        raise HTTPException(404, f"VLAN {vlan_id} does not exist")
    cur.update(body.model_dump())
    await save_vlans(v)
    model, _ = await current()
    if set_vlan_host_ip(model, cur["bridge"], vlan_id, body.host_ipv4_cidr):
        return await stage(model)
    return {"ok": True, "pending": False}


@router.delete("/vlans/{vlan_id}")
async def delete_vlan(vlan_id: int = Path(ge=1, le=4094)):
    v = await vlans()
    cur = v.pop(str(vlan_id), None)
    if not cur:
        raise HTTPException(404, f"VLAN {vlan_id} does not exist")
    await host_ssh.run(f"systemctl disable -q --now {DHCP_UNIT}@{vlan_id} 2>/dev/null; rm -f {DHCP_DIR}/{vlan_id}.conf; true")
    await save_vlans(v)
    model, _ = await current()
    changed = set_vlan_host_ip(model, cur["bridge"], vlan_id, None)
    for i in model.values():  # the VLAN leaves every port's tagged list
        if vlan_id in (i.get("vids") or []) or i.get("pvid") == vlan_id:
            i["vids"] = [x for x in i["vids"] if x != vlan_id]
            i["pvid"] = None if i["pvid"] == vlan_id else i["pvid"]
            changed = True
    return await stage(model) if changed else {"ok": True, "pending": False}


class AssignBody(BaseModel):
    port_kind: Literal["physical", "host_vnic", "guest_vnic"]
    port: str = Field(pattern=r"^[A-Za-z0-9_.:/-]{1,40}$")  # interface name, or "<vm|lxc>/<guest_id>/<net_id>"
    target_bridge: Iface | None = None
    mode: Literal["access", "trunk", "unassigned"]
    vlan_id: Vid | None = None
    tagged_vlans: list[Vid] = Field([], max_length=64)

    @model_validator(mode="after")
    def _check(self):
        if self.mode != "unassigned" and not self.target_bridge:
            raise ValueError("Choose the virtual switch the port joins")
        if self.mode == "trunk" and not self.tagged_vlans:
            raise ValueError("Tick at least one VLAN the trunk carries")
        return self


@router.post("/assign-port")
async def assign_port(body: AssignBody):
    if body.port_kind == "guest_vnic":
        m = re.fullmatch(r"(vm|lxc)/(\d{3,9})/net([0-7])", body.port)
        if not m:
            raise HTTPException(422, "A guest port is <vm|lxc>/<guest id>/<net id>, e.g. vm/101/net0")
        kind, vmid, idx = _kind(m.group(1)), int(m.group(2)), int(m.group(3))
        cur = next((n for n in await _nets(kind, vmid) if n["index"] == idx), None)
        if cur is None:
            raise HTTPException(404, f"{body.port} does not exist")
        tag, trunks = guest_tag(body.mode, body.vlan_id, body.tagged_vlans)
        bridge = body.target_bridge or cur.get("bridge") or settings.default_bridge
        extra = await _ensure_vlan_aware(bridge, bool(tag or trunks))
        nb = NetBody(bridge=bridge, tag=tag, trunks=trunks, model=cur.get("model") or "virtio", macaddr=cur.get("macaddr"),
                     rate=cur.get("rate"), link_down=body.mode == "unassigned", firewall=bool(cur.get("firewall")),
                     name=cur.get("name") or None, **_keep_ip(cur))
        await driver().set_net(kind, vmid, nb, idx)
        return {"ok": True, "pending": False, **extra}
    if not re.fullmatch(IFACE_RE, body.port):
        raise HTTPException(422, f"Invalid interface name {body.port}")
    model, _ = await current()
    links, _ = await live()
    if body.port not in model:
        if body.port_kind == "host_vnic" or body.port not in links:
            raise HTTPException(404, f"{body.port} does not exist")
        model[body.port] = blank(body.port, "eth")
    port = model[body.port]
    if port["kind"] == "bridge":
        raise HTTPException(422, "A virtual switch cannot be a port of another switch here")
    if port["kind"] == "vlan":  # a host VLAN NIC "moves" by becoming <switch>.<vlan>
        if body.mode != "access" or not body.vlan_id or body.vlan_id == 1:
            raise HTTPException(422, "A host VLAN interface sits on exactly one VLAN: drop it on a VLAN card")
        new = HostVnicBody(type="vlan", parent=body.target_bridge, vlan_id=body.vlan_id, ipv4_cidr=port["address"])
        del model[body.port]
        add_host_vnic(model, new)
        return await stage(model)
    if port["address"] and port["gateway"] and body.mode != "unassigned":
        # The host's uplink address moves to the switch it joins, so the host stays reachable.
        b = model.get(body.target_bridge or "")
        if b and not b["address"]:
            b.update(method="static", address=port["address"], gateway=port["gateway"], dns=port["dns"])
    assign(model, body.port, body.target_bridge, body.mode, body.vlan_id, body.tagged_vlans)
    return await stage(model)


# ---------------------------------------------------------------- Per-VLAN DHCP servers


class StaticLease(BaseModel):
    mac: str = Field(pattern=MAC_RE)
    ip: IP4
    hostname: str = Field("", pattern=r"^$|^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


class DhcpBody(BaseModel):
    enabled: bool
    gateway_ip: IP4
    subnet_mask: IP4 = "255.255.255.0"
    range_start: IP4
    range_end: IP4
    lease_time: str = Field("24h", pattern=LEASE_RE)
    dns_servers: list[IP4] = Field([], max_length=4)
    static_leases: list[StaticLease] = Field([], max_length=500)

    @model_validator(mode="after")
    def _subnet(self):
        try:
            net = ipaddress.IPv4Network(f"{self.gateway_ip}/{self.subnet_mask}", strict=False)
        except ValueError:
            raise ValueError(f"{self.subnet_mask} is not a valid subnet mask")
        for a in (self.range_start, self.range_end, *[r.ip for r in self.static_leases]):
            if ipaddress.IPv4Address(a) not in net:
                raise ValueError(f"{a} is outside the subnet {net}")
        lo, hi = ipaddress.IPv4Address(self.range_start), ipaddress.IPv4Address(self.range_end)
        if lo > hi:
            raise ValueError("The start address must not be after the end address")
        if lo <= ipaddress.IPv4Address(self.gateway_ip) <= hi:
            raise ValueError("The gateway address must lie outside the address range it hands out")
        return self

    @property
    def cidr(self) -> str:
        return str(ipaddress.IPv4Interface(f"{self.gateway_ip}/{self.subnet_mask}"))


@router.put("/vlans/{vlan_id}/dhcp")
async def put_dhcp(body: DhcpBody, vlan_id: int = Path(ge=1, le=4094)):
    v = await vlans()
    cur = v.get(str(vlan_id))
    if not cur:
        raise HTTPException(404, f"VLAN {vlan_id} does not exist")
    iface, unit = f"{cur['bridge']}.{vlan_id}", f"{DHCP_UNIT}@{vlan_id}"
    extra: dict = {}
    if body.enabled:
        if "dnsmasq:1" not in await host_ssh.run("command -v dnsmasq >/dev/null && echo dnsmasq:1; true"):
            raise HTTPException(409, "dnsmasq_missing")
        model, pending = await current()
        if set_vlan_host_ip(model, cur["bridge"], vlan_id, body.cidr):
            if pending:
                raise HTTPException(409, "The VLAN's gateway interface must be created, but other network changes are "
                                         "pending: apply or discard them first")
            model[cur["bridge"]]["vlan_aware"] = True
            extra = await apply_model(model)  # the DHCP server needs its gateway interface first
        cur["host_ipv4_cidr"] = body.cidr
        await host_ssh.write_file(f"{DHCP_DIR}/{vlan_id}.conf", render_dhcp(vlan_id, iface, body.model_dump()))
        await host_ssh.write_file(f"/etc/systemd/system/{DHCP_UNIT}@.service", DHCP_SERVICE)
        out = await host_ssh.run(f"dnsmasq --test --conf-file={DHCP_DIR}/{vlan_id}.conf 2>&1", check=False)
        if "syntax check OK" not in out:
            raise HTTPException(400, f"dnsmasq rejected the configuration: {out.strip()[-300:]}")
        await host_ssh.run(f"systemctl daemon-reload && systemctl enable -q {unit} && systemctl restart {unit}")
    else:
        await host_ssh.run(f"systemctl disable -q --now {unit} 2>/dev/null; true")
    cur["dhcp_config"] = body.model_dump()
    await save_vlans(v)
    return {"ok": True, **extra}


DHCP_SERVICE = f"""[Unit]
Description=SolarDeck DHCP server for VLAN %i
After=network-online.target {SWITCH_UNIT}.service
Wants=network-online.target

[Service]
ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file={DHCP_DIR}/%i.conf
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
"""


@router.get("/vlans/{vlan_id}/leases")
async def leases(vlan_id: int = Path(ge=1, le=4094)):
    v = (await vlans()).get(str(vlan_id))
    if not v:
        raise HTTPException(404, f"VLAN {vlan_id} does not exist")
    txt = await host_ssh.read_file(f"/var/lib/misc/dnsmasq.vlan-{vlan_id}.leases")
    return {"leases": parse_leases(txt, ((v.get("dhcp_config") or {}).get("static_leases")) or [])}
