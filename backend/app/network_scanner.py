"""Deep subnet device & port scanner for the Network Architect.

A scan runs on the hypervisor host (it sits on every bridge and VLAN) over the SSH bridge, in two passes:
  1. discovery: a ping sweep bound to the network's host interface, then the ARP neighbor table, the DHCP lease files,
     the DHCP server the host itself leased from and an mDNS browse (avahi-browse, when installed);
  2. per live host: non-intrusive TCP connect probes (bash /dev/tcp, 1 s timeout) on the PORTS below, reverse DNS and
     the MAC vendor from the host's IEEE OUI tables (ieee-data / arp-scan / nmap, whichever is installed).
Each device is then classified (category, roles and a plain-English functionality summary). UDP services are not
probed: 5353/udp is reported from the mDNS answers, DNS from its TCP listener.
"""
import ipaddress
import itertools
import json
import re
import shlex

from . import host_ssh, network_switch as ns

MAX_SWEEP = 1024  # addresses pinged per scan; larger subnets still list every host already in the ARP table
MAX_PROBE = 256  # live hosts port-probed per scan

# port → (protocol, service, plain-English purpose)
PORTS: dict[int, tuple[str, str, str]] = {
    21: ("tcp", "FTP", "File transfer (unencrypted)"),
    22: ("tcp", "SSH", "Secure remote command line and file copy"),
    23: ("tcp", "Telnet", "Legacy remote command line (unencrypted)"),
    25: ("tcp", "SMTP", "Sending and relaying email"),
    53: ("tcp", "DNS", "Name resolution: turns names into IP addresses"),
    80: ("tcp", "HTTP", "Web page or device admin page (unencrypted)"),
    88: ("tcp", "Kerberos", "Network sign-in tickets for a directory"),
    111: ("tcp", "RPC", "Port mapper used by NFS file sharing"),
    135: ("tcp", "RPC Endpoint", "Remote management of desktop computers"),
    139: ("tcp", "NetBIOS", "Legacy file and printer sharing"),
    389: ("tcp", "LDAP", "User and computer directory"),
    443: ("tcp", "HTTPS", "Encrypted web page or device admin page"),
    445: ("tcp", "SMB", "Shared folders and network drives"),
    515: ("tcp", "LPD", "Line printer queue"),
    548: ("tcp", "AFP", "Legacy file sharing for desktop clients"),
    554: ("tcp", "RTSP", "Live video streams from cameras and recorders"),
    631: ("tcp", "IPP", "Internet Printing Protocol: printing and scanning"),
    636: ("tcp", "LDAPS", "Encrypted user and computer directory"),
    1883: ("tcp", "MQTT", "Messages between smart-home and IoT devices"),
    2049: ("tcp", "NFS", "Network file system shares"),
    3000: ("tcp", "HTTP (3000)", "Web app or monitoring dashboard"),
    3306: ("tcp", "MySQL", "Relational database server"),
    3389: ("tcp", "RDP", "Remote desktop of a computer"),
    5000: ("tcp", "HTTP (5000)", "Web app or storage admin page"),
    5353: ("udp", "mDNS", "Zero-configuration device and service discovery"),
    5432: ("tcp", "PostgreSQL", "Relational database server"),
    5900: ("tcp", "VNC", "Remote screen sharing"),
    6379: ("tcp", "Redis", "In-memory cache and message broker"),
    8006: ("tcp", "Hypervisor UI", "Virtualization host web console"),
    8080: ("tcp", "HTTP (8080)", "Alternative web server or proxy"),
    8096: ("tcp", "Media (8096)", "Media streaming server"),
    8123: ("tcp", "Home Automation", "Smart-home automation hub"),
    8443: ("tcp", "HTTPS (8443)", "Alternative encrypted web admin page"),
    9000: ("tcp", "HTTP (9000)", "Web app, object storage or container console"),
    9090: ("tcp", "HTTP (9090)", "Monitoring or server admin console"),
    9100: ("tcp", "Raw Print", "Direct printing to a network printer"),
    11434: ("tcp", "AI API", "Local AI model server"),
    32400: ("tcp", "Media (32400)", "Personal media streaming server"),
    51820: ("udp", "WireGuard", "WireGuard VPN tunnel endpoint"),
}
TCP_PORTS = [p for p, (proto, *_r) in PORTS.items() if proto == "tcp"]

CATEGORIES = ("router_gateway", "switch_ap", "server_hypervisor", "workstation_pc", "mobile_tablet", "printer_scanner",
              "camera_nvr", "media_tv", "nas_storage", "iot_device", "unknown")
ROLE_TEXT = {
    "gateway": "Gateway", "dhcp": "DHCP", "dns": "DNS Resolver", "web": "Web & Reverse Proxy Host", "ssh": "SSH",
    "remote_shell": "Remote Shell", "file_transfer": "File Transfer", "file_share": "File Sharing",
    "printer": "Network Printer", "camera": "RTSP IP Camera", "media": "Media Streaming Server", "database": "Database",
    "remote_desktop": "Remote Desktop", "hypervisor": "Virtualization Host", "home_automation": "Home Automation Hub",
    "mqtt": "IoT Message Broker", "ai": "Local AI Server", "directory": "Directory Server", "mail": "Mail Server",
    "dashboard": "Web Dashboard", "discovery": "mDNS Discovery", "managed_guest": "SolarDeck Guest",
    "solardeck_host": "SolarDeck Host"}
_ROLE_PORTS = {"dns": {53}, "web": {80, 443, 8080, 8443}, "ssh": {22}, "remote_shell": {23}, "file_transfer": {21},
               "file_share": {139, 445, 548, 2049, 111}, "printer": {515, 631, 9100}, "camera": {554},
               "media": {8096, 32400}, "database": {3306, 5432, 6379}, "remote_desktop": {3389, 5900},
               "hypervisor": {8006}, "home_automation": {8123}, "mqtt": {1883}, "ai": {11434},
               "directory": {88, 389, 636}, "mail": {25}, "dashboard": {3000, 5000, 9000, 9090}, "discovery": {5353}}


# ---------------------------------------------------------------- Pure helpers (unit tested)


def sweep_targets(cidr: str) -> list[str]:
    net = ipaddress.ip_network(cidr, strict=False)
    return [str(a) for a in itertools.islice(net.hosts(), MAX_SWEEP)]


VIRTUAL_OUIS = {"525400": "Virtual machine NIC (emulated)"}  # locally administered, but the emulator's fixed prefix


def locally_administered(mac: str) -> bool:
    """Randomized ('private') MACs, as phones use per network, have the U/L bit set."""
    return bool(mac) and bool(int(mac[:2], 16) & 2) and mac.replace(":", "")[:6].upper() not in VIRTUAL_OUIS


def parse_neigh(text: str, cidr: str) -> dict[str, str]:
    """`ip -j neigh` → {ip: MAC} for reachable / stale entries inside `cidr`."""
    net = ipaddress.ip_network(cidr, strict=False)
    try:
        rows = json.loads(text or "[]")
    except ValueError:
        return {}
    out = {}
    for r in rows:
        mac, ip, st = r.get("lladdr"), r.get("dst", ""), r.get("state") or []
        if mac and "FAILED" not in st and "INCOMPLETE" not in st:
            try:
                if ipaddress.ip_address(ip) in net:
                    out[ip] = mac.upper()
            except ValueError:
                continue
    return out


def parse_mdns(text: str) -> dict[str, str]:
    """`avahi-browse -aprt` resolved lines (=;iface;IPv4;name;type;domain;host;address;port;txt) → {ip: hostname}."""
    out = {}
    for line in text.splitlines():
        f = line.split(";")
        if len(f) >= 8 and f[0] == "=" and f[2] == "IPv4" and f[7]:
            out.setdefault(f[7], f[6].removesuffix(".local"))
    return out


def parse_oui(text: str) -> dict[str, str]:
    """Lines 'PREFIX|<oui file line>' → {PREFIX: vendor}."""
    out = {}
    for line in text.splitlines():
        p, _, rest = line.partition("|")
        vendor = re.sub(r"^\S+\s+(\(hex\)\s+)?", "", rest.strip()).strip()
        if p and vendor:
            out[p.upper()] = vendor
    return out


def parse_open(text: str) -> dict[str, set[int]]:
    out: dict[str, set[int]] = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) == 3 and f[0] == "open" and f[2].isdigit():
            out.setdefault(f[1], set()).add(int(f[2]))
    return out


def classify(ports: set[int], hostname: str = "", mac: str = "", *, gateway: bool = False, dhcp: bool = False,
             managed: bool = False, is_host: bool = False) -> tuple[str, list[str]]:
    """(device_category, role keys) from open ports, name hints and what the network itself knows."""
    roles = [r for r, ps in _ROLE_PORTS.items() if ports & ps]
    roles = (["gateway"] if gateway else []) + (["dhcp"] if dhcp else []) + roles
    roles += ["solardeck_host"] if is_host else ["managed_guest"] if managed else []
    h = hostname.lower()
    hint = lambda *words: any(w in h for w in words)  # noqa: E731
    if is_host or 8006 in ports:
        cat = "server_hypervisor"
    elif gateway:
        cat = "router_gateway"
    elif ports & {515, 631, 9100} or hint("print", "scan"):
        cat = "printer_scanner"
    elif 554 in ports or hint("cam", "nvr", "dvr"):
        cat = "camera_nvr"
    elif ports & {8096, 32400} or hint("tv", "media", "cast", "stream"):
        cat = "media_tv"
    elif ports & {2049, 548} or (445 in ports and 5000 in ports) or hint("nas", "storage"):
        cat = "nas_storage"
    elif ports & {3389, 135}:
        cat = "workstation_pc"
    elif ports & {8123, 1883} or hint("iot", "sensor", "plug", "bulb", "esp-", "thermostat"):
        cat = "iot_device"
    elif hint("switch", "ap-", "access-point", "wap", "mesh"):
        cat = "switch_ap"
    elif hint("phone", "tablet", "mobile", "watch") or (locally_administered(mac) and not ports and not managed):
        cat = "mobile_tablet"
    elif ports & {139, 445} or hint("desktop", "laptop", "pc-", "workstation"):
        cat = "workstation_pc"
    elif managed or ports & {22, 25, 88, 389, 3306, 5432, 6379, 11434}:
        cat = "server_hypervisor"
    elif ports & {80, 443, 8080, 8443}:
        cat = "iot_device"  # a bare web admin page and nothing else: an appliance
    else:
        cat = "unknown"
    return cat, roles


def summary(roles: list[str], category: str) -> str:
    text = [ROLE_TEXT[r] for r in roles if r in ROLE_TEXT and r not in ("managed_guest", "discovery")]
    if "dhcp" in roles and "dns" in roles:  # "Gateway, DHCP & DNS Resolver"
        text = [t for t in text if t not in ("DHCP", "DNS Resolver")]
        text.insert(1 if "gateway" in roles else 0, "DHCP & DNS Resolver")
    if not text:
        return {"mobile_tablet": "Phone or Tablet", "workstation_pc": "Computer", "unknown": "No open services found"
                }.get(category, "Network Device")
    return ", ".join(text[:3]) + (" …" if len(text) > 3 else "")


def port_rows(ports: set[int]) -> list[dict]:
    return [{"port": p, "protocol": PORTS[p][0], "service_name": PORTS[p][1], "purpose_description": PORTS[p][2]}
            for p in sorted(ports) if p in PORTS]


# ---------------------------------------------------------------- Host passes


def discovery_script(iface: str, targets: list[str]) -> str:
    q = shlex.quote(iface)
    return (f"printf '%s\\n' {' '.join(targets)} | xargs -r -P 64 -I@ ping -n -q -c1 -W1 -I {q} @ >/dev/null 2>&1\n"
            f"echo @@neigh; ip -j neigh show dev {q} 2>/dev/null\n"
            "echo @@leases; cat /var/lib/misc/dnsmasq*.leases 2>/dev/null\n"
            "echo @@dhcpsrv; grep -h '^SERVER_ADDRESS=' /run/systemd/netif/leases/* 2>/dev/null | cut -d= -f2; "
            "grep -ho 'dhcp-server-identifier [0-9.]*' /var/lib/dhcp/*.leases 2>/dev/null | awk '{print $2}'\n"
            "echo @@mdns; command -v avahi-browse >/dev/null && timeout 6 avahi-browse -aprt 2>/dev/null\ntrue")


def probe_script(ips: list[str], macs: list[str]) -> str:
    pairs = " ".join(f"{ip}:{p}" for ip in ips for p in TCP_PORTS)
    prefixes = " ".join(sorted({m.replace(":", "")[:6].upper() for m in macs if m}))
    return (f"printf '%s\\n' {pairs} | xargs -r -P 128 -I@ sh -c 'h=${{1%:*}}; p=${{1#*:}}; "
            "timeout 1 bash -c \"</dev/tcp/$h/$p\" 2>/dev/null && echo open $h $p' _ @\n"
            f"echo @@rdns; for ip in {' '.join(ips)}; do echo \"$ip $(getent hosts $ip | awk '{{print $2}}')\"; done\n"
            f"echo @@oui; for p in {prefixes}; do d=$(echo $p | sed 's/../&-/g;s/-$//'); "
            "v=$(grep -h -m1 -i -E \"^($p[[:space:]]|$d[[:space:]]+\\(hex\\))\" /usr/share/ieee-data/oui.txt "
            "/usr/share/arp-scan/ieee-oui.txt /usr/share/nmap/nmap-mac-prefixes 2>/dev/null | head -1); echo \"$p|$v\"; done\ntrue")


def sections(out: str) -> dict[str, str]:
    parts = re.split(r"^@@(\w+)$", out, flags=re.M)
    return {"_": parts[0], **{parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}}


async def scan(iface: str, cidr: str, host_ips: list[str], gateway_ip: str | None, dhcp_ips: set[str],
               managed: dict[str, dict], progress=lambda pct: None) -> list[dict]:
    """Discover and classify every device on `cidr` (reached through host interface `iface`). `managed` maps
    upper-case MACs to SolarDeck guests; `dhcp_ips` are addresses known to run a DHCP server."""
    progress(5)
    s = sections(await host_ssh.run(discovery_script(iface, sweep_targets(cidr)), timeout=240, check=False))
    progress(45)
    net = ipaddress.ip_network(cidr, strict=False)
    found = parse_neigh(s.get("neigh", ""), cidr)
    mdns = parse_mdns(s.get("mdns", ""))
    names = {x["ip"]: x["hostname"] for x in ns.parse_leases(s.get("leases", ""), []) if x["hostname"]} | mdns
    dhcp_ips = dhcp_ips | {x.strip() for x in s.get("dhcpsrv", "").split() if x.strip()}
    for ip in host_ips:
        found.setdefault(ip, "")
    ips = sorted((ip for ip in found if ipaddress.ip_address(ip) in net), key=ipaddress.ip_address)[:MAX_PROBE]
    p = sections(await host_ssh.run(probe_script(ips, list(found.values())), timeout=300, check=False)) if ips else {}
    progress(90)
    opened = parse_open(p.get("_", ""))
    rdns = {f[0]: f[1] for f in (ln.split() for ln in p.get("rdns", "").splitlines()) if len(f) == 2}
    vendors = parse_oui(p.get("oui", ""))
    out = []
    for ip in ips:
        mac = found.get(ip, "")
        guest = managed.get(mac)
        ports = opened.get(ip, set()) | ({5353} if ip in mdns else set())
        hostname = names.get(ip) or rdns.get(ip) or (guest or {}).get("name") or ""
        cat, roles = classify(ports, hostname, mac, gateway=ip == gateway_ip, dhcp=ip in dhcp_ips,
                              managed=bool(guest), is_host=ip in host_ips)
        prefix = mac.replace(":", "")[:6]
        vendor = vendors.get(prefix) or VIRTUAL_OUIS.get(prefix) or (
            "Randomized (private) address" if locally_administered(mac) else "")
        out.append({"ip_address": ip, "mac_address": mac or None, "mac_vendor": vendor or None, "hostname": hostname or None,
                    "display_name": hostname or (guest or {}).get("name") or ip, "device_category": cat,
                    "is_managed_guest": bool(guest), "guest": guest, "is_solardeck_host": ip in host_ips,
                    "roles": roles, "functionality_summary": summary(roles, cat), "open_ports": port_rows(ports)})
    progress(100)
    return out
