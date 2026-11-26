"""Smart Compute Groups: automatic network / VLAN / lab groups, administrator-defined custom groups and the ungrouped rest.

GET    /api/compute/groups                    every group with its members, the NICs they use there and resource totals
POST   /api/compute/groups                    create a custom group
PUT    /api/compute/groups/{group_id}         edit a custom group
DELETE /api/compute/groups/{group_id}         delete a custom group (its guests are untouched)
GET    /api/compute/groups/suggest            name / color suggestion for a new group from its guests or a network
POST   /api/compute/groups/{group_id}/power   start / shut down / reboot every member (an OperationProgressCard job)

Custom groups persist in data/compute_groups.json. A guest with NICs on several networks, or in several groups, is listed
in every one of them; `all_group_ids` tells the UI how many.
"""
import asyncio
import json
import secrets
from collections import Counter
from pathlib import Path as FsPath
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from . import architecture as arch, cluster, task_progress, virtual_hardware as vh
from .auth import require_user
from providers.registry import get_provider

router = APIRouter(prefix="/api/compute/groups", tags=["compute_groups"], dependencies=[Depends(require_user)])
STORE = FsPath(__file__).resolve().parent.parent / "data" / "compute_groups.json"
GROUP_ID = Path(pattern=r"^[A-Za-z0-9_.-]{1,40}$")
COLOR = r"^#[0-9a-fA-F]{6}$"
KIND_COLOR = {"switch": "#a78bfa", "vlan": "#c084fc", "lab": "#f59e0b", "custom": "#38bdf8", "ungrouped": "#64748b"}
_lock = asyncio.Lock()


class Member(BaseModel):
    guest_type: Literal["vm", "lxc"]
    guest_id: int = Field(ge=1, le=999_999_999)


class GroupBody(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    color: str = Field("#38bdf8", pattern=COLOR)
    description: str = Field("", max_length=500)
    linked_network_id: str | None = Field(None, pattern=r"^[A-Za-z0-9_.-]{1,24}$")
    members: list[Member] = Field(default_factory=list, max_length=1000)


class PowerBody(BaseModel):
    action: Literal["start", "shutdown", "reboot"]


# ---------------------------------------------------------------- Pure helpers (unit tested)


def network_label(n: dict) -> str:
    """'VLAN 20 · Production' for a named VLAN, else the network's own name."""
    if n["kind"] == "vlan" and n["name"] != f"VLAN {n['vlan_id']}":
        return f"VLAN {n['vlan_id']} · {n['name']}"
    return n["name"]


def on_network(nic: dict, n: dict, vlan_ids: dict[str, set]) -> bool:
    """Does this guest NIC sit on network `n`? Untagged (or tagged with an undefined VLAN) NICs belong to their switch."""
    if nic["bridge"] != n["bridge"]:
        return False
    if n["kind"] == "vlan":
        return nic.get("vlan_tag") == n["vlan_id"]
    if n["kind"] == "lab":
        return True
    return nic.get("vlan_tag") in (None, 0) or nic.get("vlan_tag") not in vlan_ids.get(n["bridge"], set())


def _iface(nic: dict, n: dict | None, vlan_names: dict) -> dict:
    tag = nic.get("vlan_tag") or None
    return {"iface": nic["net_id"], "ip": nic.get("ip_address"), "mac": nic.get("mac"), "bridge": nic["bridge"],
            "vlan_id": tag, "vlan_name": vlan_names.get((nic["bridge"], tag)), "network_id": n["network_id"] if n else None}


def synthesize(nets: list[dict], vnics: list[dict], rows: list[dict], custom: list[dict], devices: dict | None = None) -> list[dict]:
    """Network groups (one per switch / VLAN / lab), custom groups, then 'ungrouped': every guest is in at least one.

    nets: architecture.networks(); vnics: network_switch guest_vnics (ip_address already filled where known);
    rows: cluster workloads (type qemu|lxc, vmid, cpu 0..1, maxcpu, mem, maxmem, status, host);
    devices: network_id -> number of discovered unmanaged devices from the last scan."""
    devices = devices or {}
    lab_bridges = {n["bridge"] for n in nets if n["kind"] == "lab"}
    nets = [n for n in nets if not (n["kind"] == "switch" and n["bridge"] in lab_bridges)]
    vlan_ids: dict[str, set] = {}
    vlan_names = {}
    for n in nets:
        if n["kind"] == "vlan":
            vlan_ids.setdefault(n["bridge"], set()).add(n["vlan_id"])
            vlan_names[(n["bridge"], n["vlan_id"])] = n["name"]
    guests = {("vm" if r["type"] == "qemu" else "lxc", int(r["vmid"])): r for r in rows}
    nics: dict[tuple, list] = {}
    for v in vnics:
        nics.setdefault((v["guest_type"], int(v["guest_id"])), []).append(v)

    groups = []
    for n in nets:
        hits = {k: [x for x in nics.get(k, []) if on_network(x, n, vlan_ids)] for k in guests}
        groups.append({"group_id": f"net-{n['network_id']}", "source": "network", "kind": n["kind"], "name": network_label(n),
                       "color": n.get("color") or KIND_COLOR[n["kind"]], "description": "", "linked_network_id": n["network_id"],
                       "network": n, "_members": {k: [_iface(x, n, vlan_names) for x in v] for k, v in hits.items() if v}})
    by_net = {n["network_id"]: n for n in nets}
    for c in custom:
        n = by_net.get(c.get("linked_network_id") or "")
        members = {}
        for m in c.get("members", []):
            k = (m["guest_type"], int(m["guest_id"]))
            if k in guests:  # deleted guests stay in the file but are not shown
                mine = [x for x in nics.get(k, []) if n is None or on_network(x, n, vlan_ids)]
                members[k] = [_iface(x, n or next((y for y in nets if on_network(x, y, vlan_ids)), None), vlan_names) for x in mine]
        groups.append({"group_id": c["group_id"], "source": "custom", "kind": "custom", "name": c["name"],
                       "color": c.get("color") or KIND_COLOR["custom"], "description": c.get("description", ""),
                       "linked_network_id": n["network_id"] if n else None, "network": n, "_members": members})
    seen = {k for g in groups for k in g["_members"]}
    groups.append({"group_id": "ungrouped", "source": "ungrouped", "kind": "ungrouped", "name": "Ungrouped",
                   "color": KIND_COLOR["ungrouped"], "description": "", "linked_network_id": None, "network": None,
                   "_members": {k: [_iface(x, None, vlan_names) for x in nics.get(k, [])] for k in guests if k not in seen}})

    where: dict[tuple, list] = {}
    for g in groups:
        for k in g["_members"]:
            where.setdefault(k, []).append(g["group_id"])
    out = []
    for g in groups:
        members = []
        for k, ifaces in sorted(g.pop("_members").items(), key=lambda kv: kv[0][1]):
            r = guests[k]
            members.append({"guest_type": k[0], "guest_id": k[1], "name": r.get("name") or str(k[1]), "status": r.get("status"),
                            "host": r.get("host"), "vcpu": int(r.get("maxcpu") or 0), "cpu_pct": round(100 * float(r.get("cpu") or 0), 1),
                            "mem": int(r.get("mem") or 0), "maxmem": int(r.get("maxmem") or 0),
                            "matched_interfaces": ifaces, "all_group_ids": where[k]})
        run = [m for m in members if m["status"] == "running"]
        n = g.pop("network")
        out.append({**g, **{k: (n or {}).get(k) for k in ("vlan_id", "bridge", "subnet_cidr", "gateway_ip", "dhcp_range")},
                    "network_kind": n["kind"] if n else None, "dhcp_active": bool(n and n["dhcp_active"]),
                    "dns_servers": (n or {}).get("dns_servers") or [], "members": members,
                    "device_count": devices.get(n["network_id"], 0) if n else 0,
                    "total_guests": len(members), "running_guests": len(run), "total_vcpu": sum(m["vcpu"] for m in members),
                    "allocated_ram_mb": sum(m["maxmem"] for m in members) // 2**20,
                    "used_ram_mb": sum(m["mem"] for m in run) // 2**20,
                    "avg_cpu_pct": round(sum(m["cpu_pct"] for m in run) / len(run), 1) if run else 0.0})
    return out


SPECIFIC = {"vlan": 0, "lab": 1, "switch": 2}


def suggest(groups: list[dict], keys: set[tuple] | None = None, network_id: str | None = None) -> dict:
    """Name / color for a new group: the network the chosen guests share most (VLANs and labs before plain switches)."""
    nets = [g for g in groups if g["source"] == "network"]
    if network_id:
        pick = next((g for g in nets if g["linked_network_id"] == network_id), None)
    else:
        count = Counter(g["group_id"] for g in nets for m in g["members"] if (m["guest_type"], m["guest_id"]) in (keys or set()))
        ranked = sorted((g for g in nets if count[g["group_id"]]), key=lambda g: (-count[g["group_id"]], SPECIFIC[g["kind"]], g["name"]))
        pick = ranked[0] if ranked else None
    if not pick:
        return {"suggested_name": None, "suggested_color": None, "linked_network_id": None, "source_label": None}
    return {"suggested_name": pick["name"], "suggested_color": pick["color"], "linked_network_id": pick["linked_network_id"],
            "source_label": pick["name"], "network_kind": pick["kind"]}


def parse_keys(guest_ids: str) -> set[tuple]:
    """'vm:101,lxc:200' or bare '101,200' (a bare id matches a VM and a container with that id)."""
    out = set()
    for part in filter(None, (p.strip() for p in guest_ids.split(","))):
        kind, _, gid = part.rpartition(":")
        if not gid.isdigit() or kind not in ("", "vm", "lxc"):
            raise HTTPException(422, f"Not a guest id: {part}")
        out |= {(k, int(gid)) for k in ((kind,) if kind else ("vm", "lxc"))}
    return out


# ---------------------------------------------------------------- Store and live sources


def _custom() -> list[dict]:
    try:
        return json.loads(STORE.read_text()).get("groups", [])
    except (OSError, ValueError, AttributeError):
        return []


def _save(groups: list[dict]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"groups": groups}, indent=2))
    tmp.replace(STORE)


def device_counts() -> dict[str, int]:
    return {k: sum(1 for d in v.get("devices") or [] if not d.get("is_managed_guest") and not d.get("is_solardeck_host"))
            for k, v in arch._all_scans().items()}


def from_sources(state: dict, rows: list[dict], host: dict) -> list[dict]:
    """Groups from the sources architecture._sources() already fetched (shared with /api/architecture/overview)."""
    vnics = [{**v, "ip_address": v.get("ip_address") or host["arp"].get((v.get("mac") or "").upper())}
             for v in state.get("guest_vnics", [])]
    return synthesize(arch.networks(state, vh._labs()), vnics, rows, _custom(), device_counts())


async def live_groups() -> list[dict]:
    _, state, rows, host = await arch._sources()
    return from_sources(state, rows, host)


# ---------------------------------------------------------------- Routes


@router.get("")
async def list_groups():
    return {"groups": await live_groups()}


@router.get("/suggest")
async def suggest_route(guest_ids: str = Query("", max_length=2000), network_id: str | None = Query(None, pattern=r"^[A-Za-z0-9_.-]{1,24}$")):
    return suggest(await live_groups(), parse_keys(guest_ids), network_id)


@router.post("")
async def create(body: GroupBody):
    async with _lock:
        groups = _custom()
        g = {"group_id": f"grp-{secrets.token_hex(6)}", **body.model_dump()}
        _save(groups + [g])
    return g


@router.put("/{group_id}")
async def update(body: GroupBody, group_id: str = GROUP_ID):
    async with _lock:
        groups = _custom()
        i = next((i for i, g in enumerate(groups) if g["group_id"] == group_id), None)
        if i is None:
            raise HTTPException(404 if not group_id.startswith(("net-", "ungrouped")) else 409,
                                "Only custom groups can be edited: network groups follow their switch, VLAN or lab")
        groups[i] = {"group_id": group_id, **body.model_dump()}
        _save(groups)
    return groups[i]


@router.delete("/{group_id}")
async def delete(group_id: str = GROUP_ID):
    async with _lock:
        groups = _custom()
        if not any(g["group_id"] == group_id for g in groups):
            raise HTTPException(404, "No such custom group")
        _save([g for g in groups if g["group_id"] != group_id])
    return {"ok": True}


@router.post("/{group_id}/power")
async def power(body: PowerBody, group_id: str = GROUP_ID):
    g = next((x for x in await live_groups() if x["group_id"] == group_id), None)
    if g is None:
        raise HTTPException(404, "No such group")
    me = cluster.load()["self"]
    want_running = body.action != "start"  # shutdown / reboot act on running guests, start on stopped ones
    todo = [m for m in g["members"] if (m["status"] == "running") == want_running]

    async def work(job: dict):
        p = get_provider()
        job["stage"] = 1
        done = failed = 0
        for i, m in enumerate(todo):
            label = f"{'VM' if m['guest_type'] == 'vm' else 'Container'} {m['guest_id']} ({m['name']})"
            # shortcut: members running on another cluster host are skipped; route them through that host's API if needed.
            if m["host"] and m["host"] != me:
                job["logs"].append(f"{label}: runs on {m['host']}, skipped")
                continue
            try:
                await p.guest_power_action("qemu" if m["guest_type"] == "vm" else "lxc", m["guest_id"], body.action)
                job["logs"].append(f"{label}: {body.action} sent")
                done += 1
            except Exception as e:  # noqa: BLE001 - one guest failing must not stop the others
                job["logs"].append(f"!! {label}: {getattr(e, 'detail', None) or e}")
                failed += 1
            job["percent"] = 10 + 85 * (i + 1) / len(todo)
        if not todo:
            job["logs"].append("Every member is already in the requested state")
        if failed and not done:
            raise RuntimeError(f"{body.action} failed for all {failed} guest(s)")
        return {"done": done, "failed": failed}

    job = task_progress.start_job("group", g["name"], work)
    return {"ok": True, "job_id": job["id"], "count": len(todo)}
