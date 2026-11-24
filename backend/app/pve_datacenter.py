"""Datacenter parity: firewall, logs and storage backends."""
import re
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from .auth import require_user
from .pve import _node, pve
from .storage_admin import STORAGE_RE

router = APIRouter(tags=["pve_datacenter"], dependencies=[Depends(require_user)])

# ---------------------------------------------------------------- Firewall

Scope = Literal["cluster", "node", "qemu", "lxc"]
NAME_RE = r"^[A-Za-z][A-Za-z0-9_-]{1,63}$"  # alias / ipset names
CIDR_RE = r"^!?[0-9A-Fa-f.:]+(/[0-9]{1,3})?$"
ADDR_RE = r"^[A-Za-z0-9_.:/,+!-]*$"  # IPs, CIDRs, ranges, +ipset, alias names
PORT_RE = r"^[A-Za-z0-9:,!-]*$"


def fw_base(scope: str, vmid: int | None) -> str:
    if scope == "cluster":
        return "/cluster/firewall"
    if scope == "node":
        return _node("/firewall")
    if vmid is None:
        raise HTTPException(422, "vmid is required for guest firewalls")
    return _node(f"/{scope}/{vmid}/firewall")


class RuleBody(BaseModel):
    type: Literal["in", "out", "group"] = "in"
    action: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")  # ACCEPT/DROP/REJECT, or a security group name
    enable: bool = True
    macro: str = Field("", pattern=r"^[A-Za-z0-9_-]{0,64}$")
    proto: str = Field("", pattern=r"^[a-z0-9-]{0,20}$")
    source: str = Field("", pattern=ADDR_RE, max_length=500)
    dest: str = Field("", pattern=ADDR_RE, max_length=500)
    sport: str = Field("", pattern=PORT_RE, max_length=200)
    dport: str = Field("", pattern=PORT_RE, max_length=200)
    iface: str = Field("", pattern=r"^[A-Za-z0-9_.-]{0,20}$")
    log: Literal["", "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug", "nolog"] = ""
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


RULE_FIELDS = ("macro", "proto", "source", "dest", "sport", "dport", "iface", "log", "comment")


def rule_params(b: RuleBody, update: bool = False) -> dict:
    """PVE rule data; on update, cleared fields go into `delete` (PVE rejects empty strings)."""
    d = {"type": b.type, "action": b.action, "enable": int(b.enable)}
    d |= {k: getattr(b, k) for k in RULE_FIELDS if getattr(b, k)}
    if update:
        cleared = [k for k in RULE_FIELDS if not getattr(b, k)]
        if cleared:
            d["delete"] = ",".join(cleared)
    return d


class FwOptions(BaseModel):
    enable: bool | None = None
    policy_in: Literal["ACCEPT", "DROP", "REJECT"] | None = None
    policy_out: Literal["ACCEPT", "DROP", "REJECT"] | None = None
    dhcp: bool | None = None
    ndp: bool | None = None
    macfilter: bool | None = None
    ipfilter: bool | None = None
    nosmurfs: bool | None = None
    tcpflags: bool | None = None


@router.get("/api/pve/firewall/{scope}/rules")
async def fw_rules(scope: Scope, vmid: int | None = None):
    return await pve("GET", f"{fw_base(scope, vmid)}/rules") or []


@router.post("/api/pve/firewall/{scope}/rules")
async def fw_add_rule(scope: Scope, body: RuleBody, vmid: int | None = None):
    await pve("POST", f"{fw_base(scope, vmid)}/rules", data=rule_params(body))
    return {"ok": True}


@router.put("/api/pve/firewall/{scope}/rules/{pos}")
async def fw_update_rule(scope: Scope, body: RuleBody, pos: int = Path(ge=0, le=9999), vmid: int | None = None):
    await pve("PUT", f"{fw_base(scope, vmid)}/rules/{pos}", data=rule_params(body, update=True))
    return {"ok": True}


@router.delete("/api/pve/firewall/{scope}/rules/{pos}")
async def fw_delete_rule(scope: Scope, pos: int = Path(ge=0, le=9999), vmid: int | None = None):
    await pve("DELETE", f"{fw_base(scope, vmid)}/rules/{pos}")
    return {"ok": True}


@router.get("/api/pve/firewall/{scope}/options")
async def fw_options(scope: Scope, vmid: int | None = None):
    return await pve("GET", f"{fw_base(scope, vmid)}/options") or {}


@router.put("/api/pve/firewall/{scope}/options")
async def fw_set_options(scope: Scope, body: FwOptions, vmid: int | None = None):
    data = {k: int(v) if isinstance(v, bool) else v for k, v in body.model_dump(exclude_none=True).items()}
    if data:
        await pve("PUT", f"{fw_base(scope, vmid)}/options", data=data)
    return {"ok": True}


class AliasBody(BaseModel):
    name: str = Field(pattern=NAME_RE)
    cidr: str = Field(pattern=CIDR_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


class IpsetBody(BaseModel):
    name: str = Field(pattern=NAME_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


class IpsetEntry(BaseModel):
    cidr: str = Field(pattern=CIDR_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v != ""}


@router.get("/api/pve/firewall/cluster/aliases")
async def fw_aliases():
    return await pve("GET", "/cluster/firewall/aliases") or []


@router.post("/api/pve/firewall/cluster/aliases")
async def fw_add_alias(body: AliasBody):
    await pve("POST", "/cluster/firewall/aliases", data=_clean(body.model_dump()))
    return {"ok": True}


@router.delete("/api/pve/firewall/cluster/aliases/{name}")
async def fw_delete_alias(name: str = Path(pattern=NAME_RE)):
    await pve("DELETE", f"/cluster/firewall/aliases/{name}")
    return {"ok": True}


@router.get("/api/pve/firewall/cluster/ipsets")
async def fw_ipsets():
    return await pve("GET", "/cluster/firewall/ipset") or []


@router.post("/api/pve/firewall/cluster/ipsets")
async def fw_add_ipset(body: IpsetBody):
    await pve("POST", "/cluster/firewall/ipset", data=_clean(body.model_dump()))
    return {"ok": True}


@router.delete("/api/pve/firewall/cluster/ipsets/{name}")
async def fw_delete_ipset(name: str = Path(pattern=NAME_RE)):
    await pve("DELETE", f"/cluster/firewall/ipset/{name}")
    return {"ok": True}


@router.get("/api/pve/firewall/cluster/ipsets/{name}")
async def fw_ipset_entries(name: str = Path(pattern=NAME_RE)):
    return await pve("GET", f"/cluster/firewall/ipset/{name}") or []


@router.post("/api/pve/firewall/cluster/ipsets/{name}")
async def fw_add_ipset_entry(body: IpsetEntry, name: str = Path(pattern=NAME_RE)):
    await pve("POST", f"/cluster/firewall/ipset/{name}", data=_clean(body.model_dump()))
    return {"ok": True}


@router.delete("/api/pve/firewall/cluster/ipsets/{name}/entry")
async def fw_delete_ipset_entry(name: str = Path(pattern=NAME_RE), cidr: str = Query(pattern=CIDR_RE)):
    await pve("DELETE", f"/cluster/firewall/ipset/{name}/{quote(cidr, safe='')}")
    return {"ok": True}


# ---------------------------------------------------------------- Logs

DATE_RE = r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$"
CURSOR_RE = re.compile(r"^s=[0-9a-f]+;i=")


@router.get("/api/pve/logs/syslog")
async def syslog(limit: int = Query(500, ge=1, le=5000), start: int = Query(0, ge=0),
                 since: str | None = Query(None, pattern=DATE_RE), until: str | None = Query(None, pattern=DATE_RE)):
    params = {"limit": limit, "start": start, **({"since": since} if since else {}), **({"until": until} if until else {})}
    return {"lines": [x.get("t", "") for x in await pve("GET", _node("/syslog"), params=params) or []]}


@router.get("/api/pve/logs/journal")
async def journal(lastentries: int = Query(500, ge=1, le=5000)):
    lines = await pve("GET", _node("/journal"), params={"lastentries": lastentries}) or []
    return {"lines": [x for x in lines if not CURSOR_RE.match(x)]}  # drop the start/end journal cursors


@router.get("/api/pve/logs/cluster")
async def cluster_log(max: int = Query(200, ge=1, le=5000)):
    return await pve("GET", "/cluster/log", params={"max": max}) or []


# ---------------------------------------------------------------- Storage backends

StorageType = Literal["dir", "lvm", "lvmthin", "zfspool", "nfs", "cifs"]
Content = Literal["images", "rootdir", "vztmpl", "backup", "iso", "snippets", "import"]
REQUIRED = {"dir": ("path",), "lvm": ("vgname",), "lvmthin": ("vgname", "thinpool"), "zfspool": ("pool",),
            "nfs": ("server", "export"), "cifs": ("server", "share")}
TYPE_FIELDS = {"dir": ("path",), "lvm": ("vgname",), "lvmthin": ("vgname", "thinpool"), "zfspool": ("pool",),
               "nfs": ("server", "export"), "cifs": ("server", "share", "username", "password", "domain")}
HOST_RE = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}$"


class StorageBody(BaseModel):
    storage: str = Field(pattern=STORAGE_RE)
    type: StorageType
    content: list[Content] = Field(min_length=1)
    nodes: list[str] = Field([], max_length=32)
    shared: bool = False
    enable: bool = True
    path: str = Field("", pattern=r"^$|^/[A-Za-z0-9_./-]*$", max_length=300)
    vgname: str = Field("", pattern=r"^[A-Za-z0-9_.+-]{0,128}$")
    thinpool: str = Field("", pattern=r"^[A-Za-z0-9_.+-]{0,128}$")
    pool: str = Field("", pattern=r"^[A-Za-z0-9_.:/-]{0,200}$")
    server: str = Field("", pattern=r"^$|" + HOST_RE)
    export: str = Field("", pattern=r"^$|^/[^\s,]*$", max_length=300)
    share: str = Field("", pattern=r"^[^\s,/\\]{0,80}$")
    username: str = Field("", pattern=r"^[^\s,]{0,100}$")
    password: str = Field("", pattern=r"^[^\r\n]*$", max_length=256)
    domain: str = Field("", pattern=r"^[A-Za-z0-9_.-]{0,100}$")


def storage_params(b: StorageBody) -> dict:
    missing = [k for k in REQUIRED[b.type] if not getattr(b, k)]
    if missing:
        raise HTTPException(422, f"{b.type} storage needs: {', '.join(missing)}")
    if b.path and ".." in b.path:
        raise HTTPException(422, "Invalid path")
    if any(not re.fullmatch(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$", n) for n in b.nodes):
        raise HTTPException(422, "Invalid node name")
    d = {"storage": b.storage, "type": b.type, "content": ",".join(dict.fromkeys(b.content))}
    d |= {k: getattr(b, k) for k in TYPE_FIELDS[b.type] if getattr(b, k)}
    if b.nodes:
        d["nodes"] = ",".join(b.nodes)
    if b.type in ("dir", "lvm") and b.shared:
        d["shared"] = 1  # only meaningful for local types; network storages are always shared
    if not b.enable:
        d["disable"] = 1
    return d


class StorageUpdate(BaseModel):
    enable: bool | None = None
    content: list[Content] | None = Field(None, min_length=1)


@router.get("/api/pve/storage-config")
async def storage_config():
    return await pve("GET", "/storage") or []


@router.post("/api/pve/storage-config")
async def add_storage(body: StorageBody):
    await pve("POST", "/storage", data=storage_params(body))
    return {"ok": True}


@router.put("/api/pve/storage-config/{storage}")
async def update_storage(body: StorageUpdate, storage: str = Path(pattern=STORAGE_RE)):
    data: dict = {}
    if body.enable is not None:
        data["disable"] = int(not body.enable)
    if body.content:
        data["content"] = ",".join(dict.fromkeys(body.content))
    if data:
        await pve("PUT", f"/storage/{storage}", data=data)
    return {"ok": True}


@router.delete("/api/pve/storage-config/{storage}")
async def remove_storage(storage: str = Path(pattern=STORAGE_RE)):
    # Removes the storage definition only; PVE never deletes data on the backend here.
    await pve("DELETE", f"/storage/{storage}")
    return {"ok": True}


@router.get("/api/pve/storage-scan/{kind}")
async def storage_scan(kind: Literal["nfs", "cifs", "lvm", "lvmthin", "zfs"],
                       server: str | None = Query(None, pattern=HOST_RE), vg: str | None = Query(None, pattern=r"^[A-Za-z0-9_.+-]{1,128}$"),
                       username: str | None = Query(None, pattern=r"^[^\s,]{1,100}$"),
                       password: str | None = Query(None, max_length=256), domain: str | None = Query(None, pattern=r"^[A-Za-z0-9_.-]{1,100}$")):
    if kind in ("nfs", "cifs") and not server:
        raise HTTPException(422, "server is required")
    if kind == "lvmthin" and not vg:
        raise HTTPException(422, "vg is required")
    params = {"nfs": {"server": server}, "cifs": {"server": server, "username": username, "password": password, "domain": domain},
              "lvmthin": {"vg": vg}}.get(kind, {})
    return await pve("GET", _node(f"/scan/{kind}"), params={k: v for k, v in params.items() if v}) or []
