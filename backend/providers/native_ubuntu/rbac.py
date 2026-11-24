"""Local users, groups, roles, ACLs and resource pools for the standalone driver (no external realms).

Persisted in backend/data/local_rbac.json in the same shapes the Proxmox access API returns, so Datacenter ->
Permissions renders unchanged. Passwords are stored as scrypt hashes.
"""
import hashlib
import json
import secrets
from pathlib import Path

from fastapi import HTTPException

from app import pve_access as pa

FILE = Path(__file__).resolve().parents[2] / "data" / "local_rbac.json"
REALM = "solardeck"
ADMIN_PRIVS = sorted({
    "Datastore.Allocate", "Datastore.AllocateSpace", "Datastore.AllocateTemplate", "Datastore.Audit", "Group.Allocate",
    "Pool.Allocate", "Pool.Audit", "Realm.Allocate", "Sys.Audit", "Sys.Console", "Sys.Modify", "Sys.PowerMgmt",
    "User.Modify", "VM.Allocate", "VM.Audit", "VM.Backup", "VM.Clone", "VM.Config.CDROM", "VM.Config.CPU",
    "VM.Config.Disk", "VM.Config.HWType", "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options",
    "VM.Console", "VM.Migrate", "VM.PowerMgmt", "VM.Snapshot", "VM.Snapshot.Rollback"})
BUILTIN_ROLES = {
    "Administrator": ADMIN_PRIVS,
    "Auditor": ["Datastore.Audit", "Pool.Audit", "Sys.Audit", "VM.Audit"],
    "VMUser": ["VM.Audit", "VM.Backup", "VM.Config.CDROM", "VM.Console", "VM.PowerMgmt"],
    "NoAccess": [],
}


def load() -> dict:
    try:
        data = json.loads(FILE.read_text())
    except (OSError, ValueError):
        data = {}
    return {"users": {}, "groups": {}, "roles": {}, "acl": [], "pools": {}, **(data if isinstance(data, dict) else {})}


def save(data: dict) -> dict:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.chmod(0o600)  # holds password hashes
    tmp.replace(FILE)
    return {"ok": True}


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    return f"scrypt${salt.hex()}${hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1).hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    calc = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1).hex()
    return secrets.compare_digest(calc, digest)


def _group_members(data: dict, gid: str) -> list[str]:
    return sorted(u for u, v in data["users"].items() if gid in v.get("groups", []))


# ---------------------------------------------------------------- Users
def users() -> list[dict]:
    data = load()
    return [{"userid": u, **{k: v for k, v in rec.items() if k not in ("password", "groups")},
             "groups": ",".join(rec.get("groups", [])), "realm-type": "solardeck"}
            for u, rec in sorted(data["users"].items())]


def create_user(body: pa.UserCreate) -> dict:
    data = load()
    if body.userid in data["users"]:
        raise HTTPException(409, f"User {body.userid} already exists")
    fields = body.model_dump(exclude_none=True, exclude={"userid", "password"})
    rec = {"enable": 1, "expire": 0, **fields, "groups": body.groups or []}
    if "enable" in fields:
        rec["enable"] = int(body.enable)
    if body.password:
        rec["password"] = hash_password(body.password)
    data["users"][body.userid] = rec
    return save(data)


def update_user(userid: str, body: pa.UserFields) -> dict:
    data = load()
    rec = data["users"].get(userid)
    if rec is None:
        raise HTTPException(404, f"User {userid} not found")
    fields = body.model_dump(exclude_none=True)
    if "enable" in fields:
        fields["enable"] = int(body.enable)
    rec.update(fields)
    return save(data)


def set_password(userid: str, password: str) -> dict:
    data = load()
    if userid not in data["users"]:
        raise HTTPException(404, f"User {userid} not found")
    data["users"][userid]["password"] = hash_password(password)
    return save(data)


def delete_user(userid: str) -> dict:
    data = load()
    if data["users"].pop(userid, None) is None:
        raise HTTPException(404, f"User {userid} not found")
    data["acl"] = [a for a in data["acl"] if not (a["type"] == "user" and a["ugid"] == userid)]
    return save(data)


# ---------------------------------------------------------------- Groups
def groups() -> list[dict]:
    data = load()
    return [{"groupid": g, "comment": v.get("comment", ""), "users": ",".join(_group_members(data, g))}
            for g, v in sorted(data["groups"].items())]


def create_group(body: pa.GroupBody) -> dict:
    data = load()
    if body.groupid in data["groups"]:
        raise HTTPException(409, f"Group {body.groupid} already exists")
    data["groups"][body.groupid] = {"comment": body.comment}
    return save(data)


def delete_group(gid: str) -> dict:
    data = load()
    if data["groups"].pop(gid, None) is None:
        raise HTTPException(404, f"Group {gid} not found")
    for u in data["users"].values():
        u["groups"] = [g for g in u.get("groups", []) if g != gid]
    data["acl"] = [a for a in data["acl"] if not (a["type"] == "group" and a["ugid"] == gid)]
    return save(data)


# ---------------------------------------------------------------- Roles & ACL
def roles() -> list[dict]:
    custom = load()["roles"]
    out = [{"roleid": r, "privs": ",".join(p), "special": 1} for r, p in BUILTIN_ROLES.items()]
    return out + [{"roleid": r, "privs": ",".join(p), "special": 0} for r, p in sorted(custom.items())]


def save_role(roleid: str, privs: list[str], create: bool) -> dict:
    if roleid in BUILTIN_ROLES:
        raise HTTPException(403, f"{roleid} is a built-in role")
    data = load()
    if create and roleid in data["roles"]:
        raise HTTPException(409, f"Role {roleid} already exists")
    if not create and roleid not in data["roles"]:
        raise HTTPException(404, f"Role {roleid} not found")
    data["roles"][roleid] = sorted(set(privs))
    return save(data)


def delete_role(roleid: str) -> dict:
    if roleid in BUILTIN_ROLES:
        raise HTTPException(403, f"{roleid} is a built-in role")
    data = load()
    if data["roles"].pop(roleid, None) is None:
        raise HTTPException(404, f"Role {roleid} not found")
    data["acl"] = [a for a in data["acl"] if a["roleid"] != roleid]
    return save(data)


def acl() -> list[dict]:
    return load()["acl"]


def update_acl(body: pa.AclBody, delete: bool) -> dict:
    data = load()
    if body.roleid not in BUILTIN_ROLES and body.roleid not in data["roles"]:
        raise HTTPException(404, f"Role {body.roleid} not found")
    key = (body.path, body.roleid, body.type, body.ugid)
    data["acl"] = [a for a in data["acl"] if (a["path"], a["roleid"], a["type"], a["ugid"]) != key]
    if not delete:
        data["acl"].append({"path": body.path, "roleid": body.roleid, "type": body.type, "ugid": body.ugid,
                            "propagate": int(body.propagate)})
    return save(data)


# ---------------------------------------------------------------- Resource pools
def pools() -> list[dict]:
    return [{"poolid": p, "comment": v.get("comment", ""), "members": v.get("members", [])}
            for p, v in sorted(load()["pools"].items())]


def create_pool(body: pa.PoolBody) -> dict:
    data = load()
    if body.poolid in data["pools"]:
        raise HTTPException(409, f"Pool {body.poolid} already exists")
    data["pools"][body.poolid] = {"comment": body.comment, "members": []}
    return save(data)


def pool_members(poolid: str, body: pa.PoolMembers, guests: dict[int, dict]) -> dict:
    data = load()
    pool = data["pools"].get(poolid)
    if pool is None:
        raise HTTPException(404, f"Pool {poolid} not found")
    ids = {f"{guests[v]['type']}/{v}" if v in guests else f"qemu/{v}" for v in body.vms} | \
          {f"storage/{s}" for s in body.storage}
    cur = {m["id"]: m for m in pool["members"]}
    for i in ids:
        if body.remove:
            cur.pop(i, None)
        else:
            kind, _, ref = i.partition("/")
            cur[i] = {"id": i, "type": kind, **({"storage": ref} if kind == "storage" else {"vmid": int(ref)})}
    pool["members"] = sorted(cur.values(), key=lambda m: m["id"])
    return save(data)


def delete_pool(poolid: str) -> dict:
    data = load()
    if data["pools"].pop(poolid, None) is None:
        raise HTTPException(404, f"Pool {poolid} not found")
    return save(data)
