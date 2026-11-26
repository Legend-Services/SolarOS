"""Network & Infrastructure Architect: the live topology graph and per-network device scans.

GET  /api/architecture/overview                     standalone host or cluster, uplinks, gateways, switches, VLANs, labs, guests
POST /api/architecture/networks/{network_id}/scan   start a scan (network_id: a switch name, vlan-<id> or lab-<id>)
GET  /api/architecture/networks/{network_id}/devices  scan status and the classified devices
The last result of every network persists in data/network_scans.json.
"""
import asyncio
import ipaddress
import json
import time
from pathlib import Path as FsPath

from fastapi import APIRouter, Depends, HTTPException, Path

from . import cluster, host_ssh, network_scanner as scanner, network_switch as ns, virtual_hardware as vh
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/architecture", tags=["architecture"], dependencies=[Depends(require_user)])
SCANS = FsPath(__file__).resolve().parent.parent / "data" / "network_scans.json"
NETWORK_ID = Path(pattern=r"^[A-Za-z0-9_.-]{1,24}$")
_jobs: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()

HOST_CMD = r"""ip -j route show default 2>/dev/null; echo '@@'
ip -j neigh 2>/dev/null; echo '@@'
command -v lldpctl >/dev/null && lldpctl -f json 2>/dev/null; echo '@@'
awk '/^nameserver/{print $2}' /etc/resolv.conf 2>/dev/null; resolvectl dns 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}'
"""


# ---------------------------------------------------------------- Pure helpers (unit tested)


def _net(cidr: str | None) -> str | None:
    try:
        return str(ipaddress.ip_interface(cidr).network) if cidr else None
    except ValueError:
        return None


def networks(state: dict, labs: list[dict]) -> list[dict]:
    """Every scannable network: switches, VLANs and lab sandboxes, with the host interface and address on it."""
    out = []
    for b in state.get("bridges", []):
        cidr = b.get("ipv4_cidr") or next((a for a in b.get("live_addrs", []) if "." in a), None)
        out.append({"network_id": b["name"], "kind": "switch", "name": b["name"], "bridge": b["name"], "vlan_id": None,
                    "iface": b["name"], "host_cidr": cidr, "subnet_cidr": _net(cidr), "gateway_ip": b.get("ipv4_gateway"),
                    "dhcp_active": False, "dhcp_range": None, "dns_servers": b.get("dns_servers") or [], "color": None,
                    "clustered": bool(b.get("clustered")), "vlan_aware": bool(b.get("vlan_aware"))})
    lab_bridges = {x["bridge"]: x for x in labs}
    for v in state.get("vlans", []):
        if v.get("lab") or v.get("bridge") in lab_bridges:
            continue
        d = v.get("dhcp_config") or {}
        cidr = v.get("host_ipv4_cidr")
        out.append({"network_id": f"vlan-{v['vlan_id']}", "kind": "vlan", "name": v.get("name") or f"VLAN {v['vlan_id']}",
                    "bridge": v.get("bridge"), "vlan_id": v["vlan_id"], "iface": f"{v.get('bridge')}.{v['vlan_id']}",
                    "host_cidr": cidr, "subnet_cidr": _net(cidr) or (str(ipaddress.IPv4Network(
                        f"{d['gateway_ip']}/{d.get('subnet_mask', '255.255.255.0')}", strict=False)) if d.get("gateway_ip") else None),
                    "gateway_ip": d.get("gateway_ip") or (str(ipaddress.ip_interface(cidr).ip) if cidr else None),
                    "dhcp_active": bool(v.get("dhcp_active")),
                    "dhcp_range": f"{d['range_start']} – {d['range_end']}" if d.get("range_start") else None,
                    "dns_servers": d.get("dns_servers") or [], "color": v.get("color"), "clustered": False, "vlan_aware": False})
    dhcp_by_vid = {str(v["vlan_id"]): bool(v.get("dhcp_active")) for v in state.get("vlans", [])}
    for x in labs:
        out.append({"network_id": f"lab-{x['id']}", "kind": "lab", "name": x["name"], "bridge": x["bridge"],
                    "vlan_id": x.get("vlan_id"), "iface": x["bridge"], "host_cidr": x["gateway_cidr"],
                    "subnet_cidr": _net(x["gateway_cidr"]), "gateway_ip": str(ipaddress.ip_interface(x["gateway_cidr"]).ip),
                    "dhcp_active": dhcp_by_vid.get(str(x.get("vlan_id")), False),
                    "dhcp_range": f"{x['range_start']} – {x['range_end']}", "dns_servers": [], "color": "#f59e0b",
                    "clustered": False, "vlan_aware": False})
    return out


def parse_host(out: str) -> dict:
    """Default routes, the gateways' MACs, LLDP / CDP neighbors and the host's DNS servers."""
    parts = (out.split("@@\n") + ["", "", "", ""])[:4]
    load = lambda t: json.loads(t) if t.strip() else []  # noqa: E731
    try:
        routes, neigh = load(parts[0]), load(parts[1])
    except ValueError:
        routes, neigh = [], []
    macs = {n.get("dst"): (n.get("lladdr") or "").upper() for n in neigh if n.get("lladdr")}
    gws = [{"ip": r["gateway"], "dev": r.get("dev"), "mac": macs.get(r["gateway"]) or None}
           for r in routes if r.get("gateway")]
    lldp = []
    try:
        ifaces = (json.loads(parts[2]) if parts[2].strip() else {}).get("lldp", {}).get("interface", [])
    except (ValueError, AttributeError):
        ifaces = []
    for item in ifaces if isinstance(ifaces, list) else [ifaces]:
        for name, info in (item or {}).items():
            chassis = info.get("chassis") or {}
            cname = next(iter(chassis), "") if isinstance(chassis, dict) else ""
            port = info.get("port") or {}
            lldp.append({"local_port": name, "neighbor": cname, "protocol": info.get("via"),
                         "neighbor_port": (port.get("descr") if isinstance(port.get("descr"), str) else None)
                         or (port.get("id") or {}).get("value")})
    dns = []
    for x in parts[3].split():
        if x not in dns and not x.startswith("127."):
            dns.append(x)
    return {"gateways": gws, "lldp": lldp, "dns": dns}


def pct(used: float, total: float) -> float | None:
    return round(100 * used / total, 1) if total else None


# ---------------------------------------------------------------- Live sources


async def _safe(coro, default):
    try:
        return await coro
    except Exception:  # noqa: BLE001 - a missing source (no switch driver, host offline) leaves its part empty
        return default


async def _sources() -> tuple[dict, dict, list[dict], dict]:
    await _safe(cluster.local_summary(), {})  # fills the metrics cache the status view reads
    st, state, wl, host = await asyncio.gather(
        _safe(cluster.status(), {"mode": "standalone", "hosts": []}), _safe(ns.state(), {}),
        _safe(cluster.workloads(), {"workloads": []}), _safe(host_ssh.run(HOST_CMD, check=False), ""))
    return st, state, wl["workloads"], parse_host(host)


@router.get("/overview")
async def overview():
    st, state, rows, host = await _sources()
    labs = vh._labs()
    nets = networks(state, labs)
    pol = cluster.load()["shared"]["ha_policies"]
    nics: dict[tuple, list] = {}
    for g in state.get("guest_vnics", []):
        nics.setdefault((g["guest_type"], g["guest_id"]), []).append(
            {"net_id": g["net_id"], "bridge": g["bridge"], "vlan_tag": g["vlan_tag"], "ip_address": g["ip_address"],
             "mac_address": g["mac"], "link_up": not g["link_disconnected"]})
    lab_of = {(m["guest_type"], int(m["guest_id"])): x["id"] for x in labs for m in x["members"]}
    guests = []
    for r in rows:
        gt = "vm" if r["type"] == "qemu" else "lxc"
        p = pol.get(cluster.key_of(r["type"], r["vmid"])) or {}
        guests.append({"guest_type": gt, "guest_id": int(r["vmid"]), "name": r.get("name") or str(r["vmid"]),
                       "status": r.get("status"), "host": r.get("host"), "ha": bool(r.get("ha")),
                       "standby_hosts": p.get("passive_standby_hosts", []), "lab_id": lab_of.get((gt, int(r["vmid"]))),
                       "interfaces": nics.get((gt, int(r["vmid"])), [])})
    vendors = await _safe(_vendors([g["mac"] for g in host["gateways"] if g["mac"]]), {})
    for g in host["gateways"]:
        g["mac_vendor"] = vendors.get((g["mac"] or "").replace(":", "")[:6]) or None
    q = st.get("quorum")
    hosts = [{"host_id": h["name"], "hostname": h["name"],
              "ip_addresses": [h["address"]] if h.get("address") else [i["address"] for i in st.get("interfaces", [])],
              "role": h["role"], "status": "maintenance" if h.get("maintenance") else "online" if h.get("online") else "offline",
              "cpu_pct": round(min(h.get("cpu", 0), 1) * 100, 1) if h.get("maxcpu") or h.get("cpu") else None,
              "ram_pct": pct(h.get("mem", 0), h.get("maxmem", 0)), "local": bool(h.get("local")),
              "guests": h.get("guests"), "running": h.get("running")} for h in st.get("hosts", [])]
    return {"mode": st.get("mode", "standalone"), "cluster_name": (st.get("cluster") or {}).get("name"),
            "quorum_status": None if not q else "healthy" if q.get("quorate") else "lost",
            "quorum": q, "floating_vips": st.get("vips", []), "hosts": hosts,
            "uplinks": [{"name": p["name"], "mac": p["mac"], "link_up": p["link_up"], "speed_mbps": p["speed_mbps"],
                         "bridge": p["assigned_bridge"]} for p in state.get("physical", [])],
            "gateways": host["gateways"], "lldp_neighbors": host["lldp"], "host_dns_servers": host["dns"],
            "switches": [{"name": b["name"], "vlan_aware": b["vlan_aware"], "clustered": bool(b.get("clustered")),
                          "ipv4_cidr": b["ipv4_cidr"] or next((a for a in b.get("live_addrs", []) if "." in a), None),
                          "mode": b["mode"], "member_ports": b["member_ports"], "comment": b["comment"]}
                         for b in state.get("bridges", [])],
            "vlans": [n for n in nets if n["kind"] == "vlan"],
            "labs": [{**n, "lab_id": n["network_id"][4:], "members": [
                {"guest_type": m["guest_type"], "guest_id": m["guest_id"], "net_id": m["net_id"]}
                for m in next(x for x in labs if x["id"] == n["network_id"][4:])["members"]]}
                for n in nets if n["kind"] == "lab"],
            "networks": nets, "guests": guests, "scans": {k: _brief(v) for k, v in _all_scans().items()},
            "driver": settings.hypervisor_driver, "node": settings.node_name}


async def _vendors(macs: list[str]) -> dict[str, str]:
    if not macs:
        return {}
    out = await host_ssh.run(scanner.probe_script([], macs), check=False)
    return scanner.parse_oui(scanner.sections(out).get("oui", ""))


# ---------------------------------------------------------------- Scans


def _all_scans() -> dict:
    try:
        saved = json.loads(SCANS.read_text())
    except (OSError, ValueError):
        saved = {}
    return {**saved, **_jobs}


def _brief(j: dict) -> dict:
    return {"status": j.get("status"), "finished_at": j.get("finished_at"), "devices": len(j.get("devices") or [])}


def _persist(network_id: str, job: dict) -> None:
    try:
        saved = json.loads(SCANS.read_text())
    except (OSError, ValueError):
        saved = {}
    saved[network_id] = job
    SCANS.parent.mkdir(parents=True, exist_ok=True)
    tmp = SCANS.with_suffix(".tmp")
    tmp.write_text(json.dumps(saved))
    tmp.replace(SCANS)


async def _run_scan(network_id: str, net: dict, job: dict, gateways: list[dict], managed: dict, host_ips: list[str]) -> None:
    try:
        gw = net.get("gateway_ip") or next((g["ip"] for g in gateways
                                            if ipaddress.ip_address(g["ip"]) in ipaddress.ip_network(net["subnet_cidr"])), None)
        dhcp = {gw} if net.get("dhcp_active") and gw else set()
        job["devices"] = await scanner.scan(net["iface"], net["subnet_cidr"], host_ips, gw, dhcp, managed,
                                            progress=lambda p: job.update(progress=p))
        job.update(status="done", finished_at=time.time(), gateway_ip=gw)
    except Exception as e:  # noqa: BLE001 - the error is shown with the scan
        job.update(status="failed", error=str(getattr(e, "detail", e))[:300], finished_at=time.time())
    _persist(network_id, job)
    _jobs.pop(network_id, None)


@router.post("/networks/{network_id}/scan")
async def start_scan(network_id: str = NETWORK_ID):
    if (_jobs.get(network_id) or {}).get("status") == "running":
        return {"ok": True, "status": "running"}
    st, state, rows, host = await _sources()
    net = next((n for n in networks(state, vh._labs()) if n["network_id"] == network_id), None)
    if net is None:
        raise HTTPException(404, f"Network {network_id} does not exist")
    if not net["host_cidr"] or not net["subnet_cidr"]:
        raise HTTPException(409, "The host has no address on this network, so it cannot scan it: give the switch or VLAN "
                                 "a host address first")
    managed = {g["mac"].upper(): {"guest_type": g["guest_type"], "guest_id": g["guest_id"], "name": g["guest_name"]}
               for g in state.get("guest_vnics", []) if g.get("mac")}
    host_ips = [str(ipaddress.ip_interface(net["host_cidr"]).ip)]
    job = {"status": "running", "progress": 0, "started_at": time.time(), "finished_at": None, "devices": [],
           "network": {k: net[k] for k in ("network_id", "kind", "name", "subnet_cidr", "gateway_ip", "dhcp_active")}}
    _jobs[network_id] = job
    t = asyncio.create_task(_run_scan(network_id, net, job, host["gateways"], managed, host_ips))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return {"ok": True, "status": "running"}


@router.get("/networks/{network_id}/devices")
async def devices(network_id: str = NETWORK_ID):
    job = _all_scans().get(network_id)
    if not job:
        return {"status": "idle", "progress": 0, "devices": [], "network_id": network_id}
    return {**job, "network_id": network_id}
