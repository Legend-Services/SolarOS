"""Network & Services: DNS + AdBlock, DHCP, WireGuard server/client, router/NAT and certificates.

Everything runs ON THE PVE HOST through the root SSH bridge. Service state lives as JSON under /etc/proxmox-os/net/ on
the host (survives container redeploys); config files are rendered from it by the pure render_* functions below.
"""
import asyncio
import base64
import ipaddress
import json
import re
import shlex
import time
from collections import Counter
from pathlib import Path as FsPath
from typing import Annotated, Literal
from urllib.parse import urlparse

import httpx
import qrcode
import qrcode.image.svg
from cryptography import x509
from cryptography.hazmat.primitives import serialization as ser
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.responses import PlainTextResponse
from pydantic import AfterValidator, BaseModel, Field, model_validator

from . import host_ssh
from .auth import require_user
from .config import settings
from .pve import _node, _safe, pve

router = APIRouter(prefix="/api/net", tags=["net_services"], dependencies=[Depends(require_user)])

STATE_DIR = "/etc/proxmox-os/net"
DNS_CONF = "/etc/dnsmasq.d/proxmox-os-dns.conf"
DHCP_CONF = "/etc/dnsmasq.d/proxmox-os-dhcp.conf"
ADBLOCK_CONF = "/etc/dnsmasq.d/proxmox-os-adblock.conf"
DNS_LOG = "/var/log/proxmox-os-dnsmasq.log"
LEASES = "/var/lib/misc/dnsmasq.leases"
WG_CONF = "/etc/wireguard/wg0.conf"
ROUTER_SH = f"{STATE_DIR}/router.sh"
HEADER = "# Managed by SolarDeck (Network & Services). Changes here are overwritten.\n"

IFACE_RE = r"^[A-Za-z][A-Za-z0-9_.-]{0,14}$"
HOST_RE = r"^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
DOMAIN_PAT = r"^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,62}$"
DOMAIN_RE = re.compile(DOMAIN_PAT)
NAME_RE = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$"
CLIENT_RE = r"^[a-z][a-z0-9]{0,11}$"
MAC_RE = r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$"

UPSTREAMS = {"cloudflare": ["1.1.1.1", "1.0.0.1"], "quad9": ["9.9.9.9", "149.112.112.112"],
             "google": ["8.8.8.8", "8.8.4.4"]}
BLOCKLISTS = {
    "stevenblack": {"name": "StevenBlack Unified", "url": "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"},
    "oisd": {"name": "OISD Big", "url": "https://big.oisd.nl/dnsmasq2"},
    "hagezi": {"name": "Hagezi Pro", "url": "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/dnsmasq/pro.txt"},
}


def _ip(v: str) -> str:
    return str(ipaddress.ip_address(v))


def _ip4(v: str) -> str:
    return str(ipaddress.IPv4Address(v))


def _net4(v: str) -> str:
    return str(ipaddress.IPv4Network(v, strict=False))


IP = Annotated[str, AfterValidator(_ip)]
IP4 = Annotated[str, AfterValidator(_ip4)]
Net4 = Annotated[str, AfterValidator(_net4)]
Iface = Annotated[str, Field(pattern=IFACE_RE)]
Host = Annotated[str, Field(pattern=HOST_RE, max_length=253)]


async def load(name: str, default: dict) -> dict:
    txt = await host_ssh.read_file(f"{STATE_DIR}/{name}.json")
    try:
        return {**default, **json.loads(txt)}
    except ValueError:
        return dict(default)


async def save(name: str, data: dict) -> None:
    await host_ssh.write_file(f"{STATE_DIR}/{name}.json", json.dumps(data, indent=1), "600")


def q(v) -> str:
    return shlex.quote(str(v))


# ---------------------------------------------------------------- Status + packages

STATUS_CMD = r"""for p in dnsmasq wireguard-tools nftables; do
  dpkg-query -W -f='${Status}' $p 2>/dev/null | grep -q 'install ok installed' && echo "pkg:$p:1" || echo "pkg:$p:0"; done
echo "svc:dnsmasq:$(systemctl is-active dnsmasq 2>/dev/null)"
echo "svc:wg0:$(systemctl is-active wg-quick@wg0 2>/dev/null)"
echo "svc:router:$(systemctl is-active proxmox-os-router 2>/dev/null)"
echo "fwd:ipv4:$(sysctl -n net.ipv4.ip_forward 2>/dev/null)"
echo "fwd:ipv6:$(sysctl -n net.ipv6.conf.all.forwarding 2>/dev/null)"
echo "wgif:x:$(wg show interfaces 2>/dev/null)"
"""


def parse_status(out: str) -> dict:
    s: dict = {"packages": {}, "services": {}, "forwarding": {}, "wg_interfaces": []}
    for line in out.splitlines():
        kind, _, rest = line.partition(":")
        key, _, val = rest.partition(":")
        if kind == "pkg":
            s["packages"][key] = val == "1"
        elif kind == "svc":
            s["services"][key] = val.strip() or "inactive"
        elif kind == "fwd":
            s["forwarding"][key] = val.strip() == "1"
        elif kind == "wgif":
            s["wg_interfaces"] = val.split()
    return s


@router.get("/status")
async def status():
    out, net = await asyncio.gather(host_ssh.run(STATUS_CMD, check=False), _safe(_node("/network"), []))
    ifaces = [{"iface": n["iface"], "type": n.get("type", ""), "cidr": n.get("cidr") or n.get("address") or "",
               "active": bool(n.get("active"))} for n in sorted(net or [], key=lambda n: n.get("iface", ""))]
    return {**parse_status(out), "interfaces": ifaces, "host_ip": urlparse(settings.pve_host).hostname}


PACKAGE_SCRIPTS = {
    ("dnsmasq", "install"): f"""mkdir -p /etc/dnsmasq.d
# port=0 first: Debian starts dnsmasq right after install, which must not become an open resolver on every interface.
[ -f {DNS_CONF} ] || printf '{HEADER.strip()}\\nport=0\\n' > {DNS_CONF}
apt-get update && apt-get install -y dnsmasq || exit 1
systemctl disable --now dnsmasq
printf '{DNS_LOG} {{\\n  daily\\n  rotate 3\\n  maxsize 50M\\n  compress\\n  missingok\\n  notifempty\\n  copytruncate\\n}}\\n' > /etc/logrotate.d/proxmox-os-dnsmasq
echo "dnsmasq installed (disabled until you enable DNS or DHCP)"
""",
    ("dnsmasq", "uninstall"): f"""systemctl disable --now dnsmasq 2>/dev/null
apt-get purge -y dnsmasq dnsmasq-base || exit 1
rm -f {DNS_CONF} {DHCP_CONF} {ADBLOCK_CONF} /etc/logrotate.d/proxmox-os-dnsmasq
echo "dnsmasq removed (settings kept in {STATE_DIR})"
""",
    ("wireguard", "install"): "apt-get update && apt-get install -y wireguard-tools || exit 1\necho 'wireguard-tools installed'\n",
    ("wireguard", "uninstall"): """for f in /etc/wireguard/*.conf; do [ -e "$f" ] && systemctl disable --now "wg-quick@$(basename "$f" .conf)" 2>/dev/null; done
apt-get purge -y wireguard-tools || exit 1
echo "wireguard-tools removed (configs kept in /etc/wireguard)"
""",
}


@router.post("/packages/{pkg}/{action}")
async def package(pkg: Literal["dnsmasq", "wireguard"], action: Literal["install", "uninstall"]):
    job = f"net-{pkg}"
    await host_ssh.start_job(job, PACKAGE_SCRIPTS[(pkg, action)])
    return {"job": job}


# ---------------------------------------------------------------- DNS + AdBlock (dnsmasq)

DNS_DEFAULT = {"enabled": False, "interfaces": [], "upstream": "cloudflare", "custom_upstream": [], "cache_size": 1000,
               "records": [], "adblock": {"lists": [], "whitelist": [], "blacklist": [], "updated": None, "domains": 0}}


class DnsRecord(BaseModel):
    type: Literal["A", "AAAA", "CNAME"]
    name: Host
    value: str = Field(max_length=253)

    @model_validator(mode="after")
    def _value(self):
        if self.type == "A":
            self.value = _ip4(self.value)
        elif self.type == "AAAA":
            self.value = str(ipaddress.IPv6Address(self.value))
        elif not re.fullmatch(HOST_RE, self.value):
            raise ValueError("CNAME target must be a host name")
        return self


class DnsBody(BaseModel):
    enabled: bool
    interfaces: list[Iface] = Field(max_length=16)
    upstream: Literal["cloudflare", "quad9", "google", "custom"]
    custom_upstream: list[IP] = Field([], max_length=8)
    cache_size: int = Field(1000, ge=0, le=100000)
    records: list[DnsRecord] = Field([], max_length=1000)

    @model_validator(mode="after")
    def _check(self):
        if self.enabled and not self.interfaces:
            raise ValueError("Choose at least one interface to listen on")
        if self.upstream == "custom" and not self.custom_upstream:
            raise ValueError("Add at least one custom upstream DNS server")
        return self


def render_dnsmasq_dns(dns: dict) -> str:
    if not dns.get("enabled"):
        return HEADER + "port=0\n"  # DNS off; DHCP (if enabled) keeps working
    servers = dns["custom_upstream"] if dns["upstream"] == "custom" else UPSTREAMS[dns["upstream"]]
    lines = ["bind-interfaces", *[f"interface={i}" for i in dns["interfaces"]], "no-resolv", "domain-needed",
             "bogus-priv", *[f"server={s}" for s in servers], f"cache-size={dns['cache_size']}", "log-queries",
             f"log-facility={DNS_LOG}"]
    for r in dns["records"]:
        lines.append(f"cname={r['name']},{r['value']}" if r["type"] == "CNAME" else f"host-record={r['name']},{r['value']}")
    return HEADER + "\n".join(lines) + "\n"


def parse_blocklist(text: str) -> set[str]:
    """Normalize hosts files, dnsmasq local=/address=/server= lines and plain domain lists into a set of domains."""
    out = set()
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip().lower()
        if not line or line.startswith("!"):
            continue
        m = re.match(r"^(?:local|address|server)=/([^/]+)/", line)
        if m:
            d = m.group(1)
        else:
            parts = line.split()
            if len(parts) >= 2 and parts[0] in ("0.0.0.0", "127.0.0.1", "::", "::1"):
                d = parts[1]
            elif len(parts) == 1:
                d = parts[0]
            else:
                continue
        if len(d) <= 253 and DOMAIN_RE.match(d) and d not in ("localhost.localdomain", "local.localdomain"):
            out.add(d)
    return out


def render_adblock(domains: set[str], whitelist: list[str]) -> str:
    # server=/d/# sends a whitelisted (sub)domain to the normal upstreams; the most specific match wins in dnsmasq.
    return HEADER + "".join(f"server=/{d}/#\n" for d in sorted(whitelist)) + \
        "".join(f"local=/{d}/\n" for d in sorted(domains - set(whitelist)))


def parse_dns_log_stats(text: str) -> dict:
    total = blocked = 0
    top: Counter = Counter()
    cache: dict = {}
    for line in text.splitlines():
        msg = line.split("]: ", 1)[-1]
        if msg.startswith("query["):
            total += 1
        elif m := re.match(r"^config (\S+) is (NXDOMAIN|NODATA)", msg):
            blocked += 1
            top[m.group(1)] += 1
        elif m := re.search(r"cache size (\d+), (\d+)/(\d+) cache insertions", msg):
            cache.update(size=int(m.group(1)), reused=int(m.group(2)), insertions=int(m.group(3)))
        elif m := re.search(r"queries forwarded (\d+), queries answered locally (\d+)", msg):
            cache.update(forwarded=int(m.group(1)), answered_locally=int(m.group(2)))
    return {"queries": total, "blocked": blocked, "blocked_pct": round(blocked * 100 / total, 1) if total else 0,
            "top_blocked": [{"domain": d, "count": n} for d, n in top.most_common(10)], "cache": cache}


async def apply_dnsmasq(dns: dict, dhcp: dict) -> None:
    """Write both dnsmasq confs, validate with `dnsmasq --test` (restoring the old files on failure), then restart."""
    from .domains import domain_records, load as load_domains  # lazy: domains imports this module
    old = await asyncio.gather(host_ssh.read_file(DNS_CONF), host_ssh.read_file(DHCP_CONF))
    # Host names of your domains (Network & Services → Domains) resolve like the records entered in the DNS tab.
    dns = {**dns, "records": [*dns.get("records", []), *domain_records(await load_domains())]}
    await host_ssh.write_file(DNS_CONF, render_dnsmasq_dns(dns))
    await host_ssh.write_file(DHCP_CONF, render_dnsmasq_dhcp(dhcp))
    out = await host_ssh.run("dnsmasq --test 2>&1", check=False)
    if "syntax check OK" not in out:
        await host_ssh.write_file(DNS_CONF, old[0] or HEADER + "port=0\n")
        await host_ssh.write_file(DHCP_CONF, old[1] or HEADER)
        raise HTTPException(400, f"dnsmasq rejected the configuration: {out.strip()[-300:]}")
    if dns.get("enabled") or dhcp.get("enabled"):
        await host_ssh.run("systemctl enable -q dnsmasq && systemctl restart dnsmasq")
    else:
        await host_ssh.run("systemctl disable -q --now dnsmasq || true")


@router.get("/dns")
async def get_dns():
    return {**await load("dns", DNS_DEFAULT), "blocklists": BLOCKLISTS}


@router.put("/dns")
async def put_dns(body: DnsBody):
    dns = {**await load("dns", DNS_DEFAULT), **body.model_dump()}
    await apply_dnsmasq(dns, await load("dhcp", DHCP_DEFAULT))
    await save("dns", dns)
    return {"ok": True}


@router.get("/dns/stats")
async def dns_stats():
    out = await host_ssh.run(f"pkill -USR1 -x dnsmasq && sleep 0.3; tail -n 50000 {DNS_LOG} 2>/dev/null || true",
                             check=False, timeout=30)
    return parse_dns_log_stats(out)


class AdblockBody(BaseModel):
    lists: list[Literal["stevenblack", "oisd", "hagezi"]] = Field(max_length=3)
    whitelist: list[Host] = Field([], max_length=2000)
    blacklist: list[Host] = Field([], max_length=20000)


async def update_adblock(dns: dict) -> dict:
    ab = dns["adblock"]
    domains: set[str] = set(ab["blacklist"])
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
        for lid in ab["lists"]:
            try:
                r = await c.get(BLOCKLISTS[lid]["url"])
                r.raise_for_status()
            except httpx.HTTPError as e:
                raise HTTPException(502, f"Download of {BLOCKLISTS[lid]['name']} failed: {e}")
            domains |= parse_blocklist(r.text)
    await host_ssh.write_file(ADBLOCK_CONF, render_adblock(domains, ab["whitelist"]))
    ab.update(updated=int(time.time()), domains=len(domains - set(ab["whitelist"])))
    if dns.get("enabled"):
        await host_ssh.run("systemctl restart dnsmasq", timeout=120)
    return ab


@router.put("/dns/adblock")
async def put_adblock(body: AdblockBody):
    dns = await load("dns", DNS_DEFAULT)
    dns["adblock"] = {**dns["adblock"], **body.model_dump()}
    await update_adblock(dns)
    await save("dns", dns)
    return dns["adblock"]


@router.post("/dns/adblock/update")
async def adblock_update():
    dns = await load("dns", DNS_DEFAULT)
    await update_adblock(dns)
    await save("dns", dns)
    return dns["adblock"]


# ---------------------------------------------------------------- DHCP (dnsmasq)

DHCP_DEFAULT = {"enabled": False, "interface": "", "start": "", "end": "", "netmask": "255.255.255.0", "gateway": "",
                "dns": [], "lease": "12h", "reservations": []}


class Reservation(BaseModel):
    mac: str = Field(pattern=MAC_RE)
    ip: IP4
    hostname: str = Field("", pattern=r"^$|^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


class DhcpBody(BaseModel):
    enabled: bool
    interface: Iface
    start: IP4
    end: IP4
    netmask: IP4
    gateway: IP4 | None = None
    dns: list[IP4] = Field([], max_length=4)
    lease: str = Field("12h", pattern=r"^([0-9]{1,5}[mhd]|infinite)$")
    reservations: list[Reservation] = Field([], max_length=500)

    @model_validator(mode="after")
    def _subnet(self):
        net = ipaddress.IPv4Network(f"{self.start}/{self.netmask}", strict=False)
        addrs = [self.end, *([self.gateway] if self.gateway else []), *[r.ip for r in self.reservations]]
        bad = [a for a in addrs if ipaddress.IPv4Address(a) not in net]
        if bad:
            raise ValueError(f"{bad[0]} is outside the subnet {net}")
        if ipaddress.IPv4Address(self.start) > ipaddress.IPv4Address(self.end):
            raise ValueError("Range start must not be after range end")
        return self


def render_dnsmasq_dhcp(d: dict) -> str:
    if not d.get("enabled"):
        return HEADER
    i = d["interface"]
    lines = [f"interface={i}", f"dhcp-range={i},{d['start']},{d['end']},{d['netmask']},{d['lease']}"]
    if d.get("gateway"):
        lines.append(f"dhcp-option={i},option:router,{d['gateway']}")
    if d.get("dns"):
        lines.append(f"dhcp-option={i},option:dns-server,{','.join(d['dns'])}")
    for r in d["reservations"]:
        lines.append(f"dhcp-host={r['mac'].lower()},{r['ip']}" + (f",{r['hostname']}" if r.get("hostname") else ""))
    return HEADER + "\n".join(lines) + "\n"


def parse_leases(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        p = line.split()
        if len(p) >= 4 and p[0].isdigit():
            out.append({"expires": int(p[0]), "mac": p[1], "ip": p[2], "hostname": "" if p[3] == "*" else p[3]})
    return out


@router.get("/dhcp")
async def get_dhcp():
    d, leases = await asyncio.gather(load("dhcp", DHCP_DEFAULT), host_ssh.read_file(LEASES))
    return {**d, "leases": parse_leases(leases)}


@router.put("/dhcp")
async def put_dhcp(body: DhcpBody):
    d = body.model_dump()
    await apply_dnsmasq(await load("dns", DNS_DEFAULT), d)
    await save("dhcp", d)
    return {"ok": True}


# ---------------------------------------------------------------- WireGuard server

WG_DEFAULT = {"enabled": False, "port": 51820, "subnet": "10.8.0.0/24", "wan": settings.default_bridge, "endpoint": "",
              "dns": ["1.1.1.1"], "private_key": "", "public_key": "", "peers": []}


def gen_keypair() -> tuple[str, str]:
    k = X25519PrivateKey.generate()
    priv = k.private_bytes(ser.Encoding.Raw, ser.PrivateFormat.Raw, ser.NoEncryption())
    pub = k.public_key().public_bytes(ser.Encoding.Raw, ser.PublicFormat.Raw)
    return base64.b64encode(priv).decode(), base64.b64encode(pub).decode()


def server_address(subnet: str) -> str:
    net = ipaddress.IPv4Network(subnet)
    return f"{next(net.hosts())}/{net.prefixlen}"


def render_wg_server(wg: dict) -> str:
    s, w = wg["subnet"], wg["wan"]
    lines = ["[Interface]", f"Address = {server_address(s)}", f"ListenPort = {wg['port']}",
             f"PrivateKey = {wg['private_key']}",
             f"PostUp = sysctl -qw net.ipv4.ip_forward=1; iptables -t nat -A POSTROUTING -s {s} -o {w} -j MASQUERADE",
             f"PostDown = iptables -t nat -D POSTROUTING -s {s} -o {w} -j MASQUERADE"]
    for p in wg["peers"]:
        lines += ["", "[Peer]", f"# {p['name']}", f"PublicKey = {p['public_key']}", f"AllowedIPs = {p['ip']}/32"]
    return HEADER + "\n".join(lines) + "\n"


def render_wg_client_conf(wg: dict, peer: dict, host_ip: str) -> str:
    lines = ["[Interface]", f"PrivateKey = {peer['private_key']}", f"Address = {peer['ip']}/32"]
    if wg.get("dns"):
        lines.append(f"DNS = {', '.join(wg['dns'])}")
    lines += ["", "[Peer]", f"PublicKey = {wg['public_key']}", f"Endpoint = {wg['endpoint'] or host_ip}:{wg['port']}",
              f"AllowedIPs = {peer.get('allowed_ips') or '0.0.0.0/0, ::/0'}", "PersistentKeepalive = 25"]
    return "\n".join(lines) + "\n"


def parse_wg_dump(text: str) -> dict:
    """`wg show all dump`: interface lines have 5 fields, peer lines 9 (both prefixed with the interface name)."""
    out: dict = {}
    for line in text.splitlines():
        f = line.split("\t")
        if len(f) == 5:
            out[f[0]] = {"public_key": f[2], "listen_port": int(f[3]) if f[3].isdigit() else None, "peers": []}
        elif len(f) == 9 and f[0] in out:
            out[f[0]]["peers"].append({"public_key": f[1], "endpoint": None if f[3] == "(none)" else f[3],
                                       "allowed_ips": f[4], "handshake": int(f[5]), "rx": int(f[6]), "tx": int(f[7])})
    return out


async def wg_dump() -> dict:
    return parse_wg_dump(await host_ssh.run("wg show all dump 2>/dev/null || true", check=False))


async def apply_wg(wg: dict, restart: bool) -> None:
    await host_ssh.write_file(WG_CONF, render_wg_server(wg), "600")
    if not wg["enabled"]:
        await host_ssh.run("systemctl disable -q --now wg-quick@wg0 || true")
        return
    sync = ("if systemctl is-active -q wg-quick@wg0; then wg syncconf wg0 <(wg-quick strip wg0); "
            "else systemctl restart wg-quick@wg0; fi")
    await host_ssh.run("bash -c " + q("systemctl enable -q wg-quick@wg0 && " +
                                      ("systemctl restart wg-quick@wg0" if restart else sync)))


def _peer_public(p: dict) -> dict:
    return {k: v for k, v in p.items() if k != "private_key"}


@router.get("/wg")
async def get_wg():
    wg, dump = await asyncio.gather(load("wg", WG_DEFAULT), wg_dump())
    live = {p["public_key"]: p for p in dump.get("wg0", {}).get("peers", [])}
    return {**{k: v for k, v in wg.items() if k != "private_key"}, "address": server_address(wg["subnet"]),
            "running": "wg0" in dump, "peers": [{**_peer_public(p), "live": live.get(p["public_key"])} for p in wg["peers"]]}


class WgBody(BaseModel):
    enabled: bool
    port: int = Field(51820, ge=1, le=65535)
    subnet: Net4
    wan: Iface
    endpoint: str = Field("", pattern=r"^$|" + HOST_RE, max_length=253)
    dns: list[IP] = Field([], max_length=4)

    @model_validator(mode="after")
    def _prefix(self):
        if ipaddress.IPv4Network(self.subnet).prefixlen > 30:
            raise ValueError("VPN subnet must be /30 or larger")
        return self


@router.put("/wg")
async def put_wg(body: WgBody):
    wg = await load("wg", WG_DEFAULT)
    net = ipaddress.IPv4Network(body.subnet)
    if any(ipaddress.IPv4Address(p["ip"]) not in net for p in wg["peers"]):
        raise HTTPException(400, "Existing peers are outside the new subnet; remove them first")
    if not wg["private_key"]:
        wg["private_key"], wg["public_key"] = gen_keypair()
    wg.update(body.model_dump())
    await apply_wg(wg, restart=True)
    await save("wg", wg)
    return {"ok": True}


class PeerBody(BaseModel):
    name: str = Field(pattern=NAME_RE)
    allowed_ips: str = Field("0.0.0.0/0, ::/0", pattern=r"^[0-9a-fA-F.:/, ]{1,300}$")


@router.post("/wg/peers")
async def add_peer(body: PeerBody):
    wg = await load("wg", WG_DEFAULT)
    if not wg["private_key"]:
        raise HTTPException(400, "Save the server settings first")
    if any(p["name"] == body.name for p in wg["peers"]):
        raise HTTPException(409, "A peer with this name exists")
    net = ipaddress.IPv4Network(wg["subnet"])
    used = {server_address(wg["subnet"]).split("/")[0], *(p["ip"] for p in wg["peers"])}
    ip = next((str(h) for h in net.hosts() if str(h) not in used), None)
    if not ip:
        raise HTTPException(400, "The VPN subnet is full")
    priv, pub = gen_keypair()
    wg["peers"].append({"name": body.name, "ip": ip, "public_key": pub, "private_key": priv,
                        "allowed_ips": body.allowed_ips, "created": int(time.time())})
    await apply_wg(wg, restart=False)
    await save("wg", wg)
    return {"ok": True, "ip": ip}


async def _peer(name: str) -> tuple[dict, dict]:
    wg = await load("wg", WG_DEFAULT)
    p = next((p for p in wg["peers"] if p["name"] == name), None)
    if not p:
        raise HTTPException(404, "No such peer")
    return wg, p


@router.delete("/wg/peers/{name}")
async def delete_peer(name: str = Path(pattern=NAME_RE)):
    wg, p = await _peer(name)
    wg["peers"].remove(p)
    await apply_wg(wg, restart=False)
    await save("wg", wg)
    return {"ok": True}


@router.get("/wg/peers/{name}/conf", response_class=PlainTextResponse)
async def peer_conf(name: str = Path(pattern=NAME_RE)):
    wg, p = await _peer(name)
    return PlainTextResponse(render_wg_client_conf(wg, p, urlparse(settings.pve_host).hostname or ""),
                             headers={"Content-Disposition": f'attachment; filename="{name}.conf"'})


@router.get("/wg/peers/{name}/qr")
async def peer_qr(name: str = Path(pattern=NAME_RE)):
    wg, p = await _peer(name)
    conf = render_wg_client_conf(wg, p, urlparse(settings.pve_host).hostname or "")
    return {"svg": qrcode.make(conf, image_factory=qrcode.image.svg.SvgPathImage, border=2).to_string(encoding="unicode")}


# ---------------------------------------------------------------- WireGuard client tunnels

WG_SECTION_KEYS = {"interface": {"privatekey", "address", "listenport", "mtu", "table", "fwmark", "dns"},
                   "peer": {"publickey", "presharedkey", "allowedips", "endpoint", "persistentkeepalive"}}


def validate_wg_client(text: str, table_off: bool) -> tuple[str, bool]:
    """Normalize a pasted client .conf. Rejects script hooks / unknown keys; drops DNS (the PVE host has no resolvconf
    and host DNS must not change). Returns (conf, full_tunnel)."""
    section, out, full, seen = None, [], False, set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if m := re.fullmatch(r"\[(\w+)\]", line):
            section = m.group(1).lower()
            if section not in WG_SECTION_KEYS:
                raise HTTPException(400, f"Unsupported section [{m.group(1)}]")
            seen.add(section)
            out.append(f"\n[{m.group(1).capitalize()}]")
            continue
        key, sep, val = (x.strip() for x in line.partition("="))
        if not sep or section is None:
            raise HTTPException(400, f"Invalid line: {line[:60]}")
        k = key.lower()
        if k not in WG_SECTION_KEYS[section]:
            raise HTTPException(400, f"Key '{key}' is not allowed (script hooks like PostUp are refused)")
        if not re.fullmatch(r"[A-Za-z0-9+/=.:,\[\] _-]*", val):
            raise HTTPException(400, f"Invalid value for {key}")
        if k == "dns" or (k == "table" and table_off):
            continue
        if k == "allowedips" and re.search(r"(^|[ ,])(0\.0\.0\.0/0|::/0)", val):
            full = True
        out.append(f"{key} = {val}")
        if k == "privatekey" and table_off:
            out.append("Table = off")
    if seen != {"interface", "peer"}:
        raise HTTPException(400, "The profile needs an [Interface] and a [Peer] section")
    return HEADER + "\n".join(out).strip() + "\n", full


class ClientBody(BaseModel):
    name: str = Field(pattern=CLIENT_RE)
    conf: str = Field(max_length=20000)
    table_off: bool = False


@router.get("/wg/clients")
async def wg_clients():
    names, dump = await asyncio.gather(
        host_ssh.run("ls /etc/wireguard/*.conf 2>/dev/null | xargs -rn1 basename | sed 's/\\.conf$//'", check=False),
        wg_dump())
    return [{"name": n, "up": n in dump, "live": dump.get(n)} for n in names.split() if n != "wg0" and re.fullmatch(CLIENT_RE, n)]


@router.post("/wg/clients")
async def add_client(body: ClientBody):
    if body.name == "wg0":
        raise HTTPException(400, "wg0 is reserved for the WireGuard server")
    conf, full = validate_wg_client(body.conf, body.table_off)
    await host_ssh.write_file(f"/etc/wireguard/{body.name}.conf", conf, "600")
    return {"ok": True, "full_tunnel": full and not body.table_off}


@router.post("/wg/clients/{name}/{action}")
async def client_action(action: Literal["up", "down"], name: str = Path(pattern=CLIENT_RE)):
    cmd = f"systemctl enable -q --now wg-quick@{name}" if action == "up" else f"systemctl disable -q --now wg-quick@{name}"
    await host_ssh.run(cmd, timeout=60)
    return {"ok": True}


@router.delete("/wg/clients/{name}")
async def delete_client(name: str = Path(pattern=CLIENT_RE)):
    await host_ssh.run(f"systemctl disable -q --now wg-quick@{name} 2>/dev/null; rm -f /etc/wireguard/{name}.conf")
    return {"ok": True}


# ---------------------------------------------------------------- Router & NAT

ROUTER_DEFAULT = {"ipv4_forward": False, "ipv6_forward": False, "wan": "", "lan": "", "masquerade": False,
                  "forwards": [], "routes": []}


class PortForward(BaseModel):
    proto: Literal["tcp", "udp", "both"]
    ext_port: str = Field(pattern=r"^[0-9]{1,5}(-[0-9]{1,5})?$")
    int_ip: IP4
    int_port: int | None = Field(None, ge=1, le=65535)
    comment: str = Field("", pattern=r"^[^\n\"']{0,60}$")

    @model_validator(mode="after")
    def _ports(self):
        a, _, b = self.ext_port.partition("-")
        if not 1 <= int(a) <= 65535 or (b and not int(a) <= int(b) <= 65535):
            raise ValueError("External port must be 1-65535 (or a range a-b)")
        if b and self.int_port:
            raise ValueError("A port range keeps its ports; leave the internal port empty")
        return self


class StaticRoute(BaseModel):
    dest: Net4
    gateway: IP4 | None = None
    dev: Iface | None = None

    @model_validator(mode="after")
    def _via(self):
        if not self.gateway and not self.dev:
            raise ValueError("A route needs a gateway or a device")
        return self


class RouterBody(BaseModel):
    ipv4_forward: bool
    ipv6_forward: bool
    wan: Iface | Literal[""] = ""
    lan: Iface | Literal[""] = ""
    masquerade: bool
    forwards: list[PortForward] = Field([], max_length=200)
    routes: list[StaticRoute] = Field([], max_length=100)

    @model_validator(mode="after")
    def _wan(self):
        if self.masquerade and not self.wan:
            raise ValueError("Masquerade needs a WAN interface")
        return self


def route_cmd(r: dict, verb: str) -> str:
    return f"ip route {verb} {r['dest']}" + (f" via {r['gateway']}" if r.get("gateway") else "") + \
        (f" dev {r['dev']}" if r.get("dev") else "")


def render_nft(r: dict) -> str:
    iif = f'iifname "{r["wan"]}" ' if r["wan"] else ""
    pre = []
    for f in r["forwards"]:
        match = "meta l4proto { tcp, udp } th" if f["proto"] == "both" else f["proto"]
        to = f["int_ip"] + (f":{f['int_port']}" if f.get("int_port") else "")
        pre.append(f"    {iif}{match} dport {f['ext_port']} dnat to {to}")
    post = []
    if r["masquerade"]:
        lan = f'iifname "{r["lan"]}" ' if r["lan"] else ""
        post.append(f'    {lan}oifname "{r["wan"]}" masquerade')
    return ("table ip proxmox_os {\n"
            "  chain prerouting {\n    type nat hook prerouting priority dstnat; policy accept;\n" +
            "".join(x + "\n" for x in pre) + "  }\n"
            "  chain postrouting {\n    type nat hook postrouting priority srcnat; policy accept;\n" +
            "".join(x + "\n" for x in post) + "  }\n}\n")


def render_router_script(r: dict) -> str:
    # Only our own table is replaced; the PVE firewall and other rulesets are never flushed.
    return ("#!/bin/bash\n" + HEADER + "nft delete table ip proxmox_os 2>/dev/null || true\n"
            f"nft -f - <<'NFT'\n{render_nft(r)}NFT\n" + "".join(route_cmd(x, "replace") + "\n" for x in r["routes"]))


ROUTER_UNIT = """[Unit]
Description=SolarDeck router (NAT, port forwards, static routes)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash /etc/proxmox-os/net/router.sh
ExecStop=/usr/sbin/nft delete table ip proxmox_os

[Install]
WantedBy=multi-user.target
"""


@router.get("/router")
async def get_router():
    r, rules = await asyncio.gather(load("router", ROUTER_DEFAULT),
                                    host_ssh.run("nft list table ip proxmox_os 2>/dev/null || true", check=False))
    return {**r, "ruleset": rules}


@router.put("/router")
async def put_router(body: RouterBody):
    old, new = await load("router", ROUTER_DEFAULT), body.model_dump()
    for gone in [x for x in old["routes"] if x not in new["routes"]]:
        await host_ssh.run(route_cmd(gone, "del") + " 2>/dev/null || true", check=False)
    sysctl = f"{HEADER}net.ipv4.ip_forward={int(new['ipv4_forward'])}\nnet.ipv6.conf.all.forwarding={int(new['ipv6_forward'])}\n"
    await host_ssh.write_file("/etc/sysctl.d/99-proxmox-os-router.conf", sysctl)
    await host_ssh.write_file(ROUTER_SH, render_router_script(new), "700")
    await host_ssh.write_file("/etc/systemd/system/proxmox-os-router.service", ROUTER_UNIT)
    await host_ssh.run("sysctl -q --system >/dev/null; systemctl daemon-reload && systemctl enable -q proxmox-os-router "
                       "&& systemctl restart proxmox-os-router", timeout=60)
    await save("router", new)
    return {"ok": True}


# ---------------------------------------------------------------- Certificates

NGINX_SSL_DIR = FsPath("/etc/nginx/ssl")
NGINX_SNIPPET = FsPath("/etc/nginx/proxmox-os-ssl.conf")
ACME_DIRS = {"production": "https://acme-v02.api.letsencrypt.org/directory",
             "staging": "https://acme-staging-v02.api.letsencrypt.org/directory"}


async def pvesh(args: str, timeout: float = 120):
    out = await host_ssh.run(f"pvesh {args} --output-format json", timeout=timeout)
    try:
        return json.loads(out.strip().splitlines()[-1]) if out.strip() else None
    except (ValueError, IndexError):
        return out


@router.get("/certs")
async def certs():
    info, cfg, accounts, plugins, schema = await asyncio.gather(
        _safe(_node("/certificates/info"), []), _safe(_node("/config"), {}),
        pvesh("get /cluster/acme/account"), pvesh("get /cluster/acme/plugins"),
        pvesh("get /cluster/acme/challenge-schema"))
    domains = [v for k, v in sorted((cfg or {}).items()) if re.fullmatch(r"acmedomain\d", k)]
    return {"certificates": info or [], "acme": (cfg or {}).get("acme", ""), "domains": domains,
            "accounts": accounts or [], "plugins": plugins or [],
            "dns_apis": sorted(s["id"] for s in schema or [] if isinstance(s, dict) and s.get("type") == "dns"),
            "nginx_https": NGINX_SNIPPET.exists()}


class AccountBody(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,40}$")
    contact: str = Field(pattern=r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$", max_length=200)
    directory: Literal["production", "staging"] = "production"
    accept_tos: bool

    @model_validator(mode="after")
    def _tos(self):
        if not self.accept_tos:
            raise ValueError("You must accept the Let's Encrypt terms of service")
        return self


@router.post("/certs/acme/accounts")
async def add_account(body: AccountBody):
    d = ACME_DIRS[body.directory]
    tos = await pvesh(f"get /cluster/acme/tos --directory {q(d)}")
    await pvesh(f"create /cluster/acme/account --name {q(body.name)} --contact {q(body.contact)} --directory {q(d)}"
                + (f" --tos_url {q(tos)}" if isinstance(tos, str) and tos.startswith("http") else ""), timeout=180)
    return {"ok": True}


@router.delete("/certs/acme/accounts/{name}")
async def delete_account(name: str = Path(pattern=r"^[A-Za-z0-9_.-]{1,40}$")):
    await pvesh(f"delete /cluster/acme/account/{name}", timeout=180)
    return {"ok": True}


class PluginBody(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,40}$")
    api: str = Field(pattern=r"^[a-z0-9_]{1,40}$")
    data: str = Field("", max_length=8000)  # KEY=value lines, e.g. CF_Token=...


@router.post("/certs/acme/plugins")
async def add_plugin(body: PluginBody):
    data = base64.b64encode(body.data.strip().encode()).decode()
    await pvesh(f"create /cluster/acme/plugins --id {q(body.id)} --type dns --api {q(body.api)} --data {q(data)}")
    return {"ok": True}


@router.delete("/certs/acme/plugins/{pid}")
async def delete_plugin(pid: str = Path(pattern=r"^[A-Za-z0-9_.-]{1,40}$")):
    await pvesh(f"delete /cluster/acme/plugins/{pid}")
    return {"ok": True}


class AcmeDomain(BaseModel):
    domain: str = Field(pattern=DOMAIN_PAT, max_length=253)
    plugin: str | None = Field(None, pattern=r"^[A-Za-z0-9_.-]{1,40}$")  # None = HTTP-01 standalone on port 80


class AcmeConfigBody(BaseModel):
    account: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,40}$")
    domains: list[AcmeDomain] = Field(min_length=1, max_length=6)


@router.put("/certs/acme/domains")
async def acme_domains(body: AcmeConfigBody):
    data: dict = {"acme": f"account={body.account}"}
    for i, d in enumerate(body.domains):
        data[f"acmedomain{i}"] = f"domain={d.domain}" + (f",plugin={d.plugin}" if d.plugin else "")
    unused = [f"acmedomain{i}" for i in range(len(body.domains), 6)]
    await pve("PUT", _node("/config"), data={**data, "delete": ",".join(unused)})
    return {"ok": True}


class OrderBody(BaseModel):
    renew: bool = False


@router.post("/certs/acme/order")
async def acme_order(body: OrderBody):
    upid = await pve("PUT" if body.renew else "POST", _node("/certificates/acme/certificate"),
                     data={"force": 1} if body.renew else None)
    return {"upid": upid}


class CustomCertBody(BaseModel):
    certificates: str = Field(max_length=64000)
    key: str = Field(max_length=16000)
    node: bool = True
    nginx: bool = False


def check_pem(cert_pem: str, key_pem: str) -> str:
    """Validate PEM blocks and that the private key belongs to the first certificate. Returns the subject."""
    try:
        cert = x509.load_pem_x509_certificates(cert_pem.encode())[0]
        key = ser.load_pem_private_key(key_pem.encode(), password=None)
    except (ValueError, TypeError, IndexError) as e:
        raise HTTPException(400, f"Invalid PEM: {e}")
    spki = lambda k: k.public_bytes(ser.Encoding.DER, ser.PublicFormat.SubjectPublicKeyInfo)  # noqa: E731
    if spki(cert.public_key()) != spki(key.public_key()):
        raise HTTPException(400, "The private key does not match the certificate")
    return cert.subject.rfc4514_string()


async def _sh(*argv: str) -> tuple[int, str]:
    p = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await p.communicate()
    return p.returncode or 0, out.decode(errors="replace")


async def apply_nginx_cert(cert: str | None, key: str | None) -> None:
    """Install (or with None remove) the SolarDeck HTTPS certificate in this container; roll back if nginx -t fails."""
    crt, kf = NGINX_SSL_DIR / "proxmox-os.crt", NGINX_SSL_DIR / "proxmox-os.key"
    backup = {p: p.read_bytes() for p in (crt, kf, NGINX_SNIPPET) if p.exists()}
    try:
        if cert is None:
            for p in (crt, kf, NGINX_SNIPPET):
                p.unlink(missing_ok=True)
        else:
            NGINX_SSL_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
            for p, v in ((crt, cert), (kf, key)):
                p.write_text(v.strip() + "\n")
                p.chmod(0o600)
            NGINX_SNIPPET.write_text(f"listen 443 ssl;\nlisten [::]:443 ssl;\nssl_certificate {crt};\n"
                                     f"ssl_certificate_key {kf};\n")
        code, out = await _sh("nginx", "-t")
    except OSError as e:
        code, out = 1, str(e)
    if code:
        for p in (crt, kf, NGINX_SNIPPET):
            p.unlink(missing_ok=True)
        for p, v in backup.items():
            p.write_bytes(v)
        raise HTTPException(400, f"nginx rejected the certificate; previous files restored: {out.strip()[-300:]}")
    await _sh("systemctl", "reload", "nginx")


@router.post("/certs/custom")
async def custom_cert(body: CustomCertBody):
    subject = check_pem(body.certificates, body.key)
    if body.nginx:
        await apply_nginx_cert(body.certificates, body.key)
    if body.node:
        await pve("POST", _node("/certificates/custom"),
                  data={"certificates": body.certificates.strip(), "key": body.key.strip(), "force": 1, "restart": 1})
    return {"ok": True, "subject": subject}


@router.delete("/certs/custom/{target}")
async def delete_custom_cert(target: Literal["node", "nginx"]):
    if target == "nginx":
        await apply_nginx_cert(None, None)
    else:
        await pve("DELETE", _node("/certificates/custom"), params={"restart": 1})
    return {"ok": True}
