"""Proxmox users, groups, roles, ACLs, pools, API tokens and realms (Datacenter → Permissions)."""
import re
import shlex
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from . import host_ssh
from .auth import require_user
from .config import settings
from .pve import pve
from .storage_admin import STORAGE_RE

router = APIRouter(tags=["pve_access"], dependencies=[Depends(require_user)])

USERID_RE = r"^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,32}$"
ID_RE = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"  # group, role, pool ids
TOKEN_RE = r"^[A-Za-z][A-Za-z0-9._-]{0,63}$"
PRIV_RE = r"^[A-Za-z]+(\.[A-Za-z]+)+$"
ACL_PATH_RE = r"^/([A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*)?$"
TOKEN_FULL_RE = r"^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,32}![A-Za-z][A-Za-z0-9._-]{0,63}$"


def _q(v: str) -> str:
    return quote(v, safe="")


def service_ids() -> tuple[str, str]:
    """(userid, tokenid) SolarDeck itself authenticates with; changing them would lock the app out."""
    user, _, token = (settings.pve_token_id or "pve-desktop@pve!webui").partition("!")
    return user, token


def guard_user(userid: str, deleting: bool = False) -> None:
    if userid == service_ids()[0]:
        raise HTTPException(403, f"{userid} is the SolarDeck service account; changing it would break SolarDeck")
    if deleting and userid == "root@pam":
        raise HTTPException(403, "root@pam cannot be deleted")


def guard_token(userid: str, tokenid: str) -> None:
    if (userid, tokenid) == service_ids():
        raise HTTPException(403, "This API token is used by SolarDeck itself and cannot be removed")


# ---------------------------------------------------------------- Users


class UserFields(BaseModel):
    email: str | None = Field(None, pattern=r"^$|^[^\s@,]+@[^\s@,]+$", max_length=200)
    firstname: str | None = Field(None, pattern=r"^[^,\n]*$", max_length=100)
    lastname: str | None = Field(None, pattern=r"^[^,\n]*$", max_length=100)
    comment: str | None = Field(None, pattern=r"^[^\n]*$", max_length=500)
    expire: int | None = Field(None, ge=0)  # unix time, 0 = never
    enable: bool | None = None
    groups: list[str] | None = Field(None, max_length=100)

    def params(self) -> dict:
        bad = [g for g in self.groups or [] if not re.fullmatch(ID_RE, g)]
        if bad:
            raise HTTPException(422, f"Invalid group: {bad[0]}")
        d = self.model_dump(exclude_none=True, exclude={"groups", "enable"})
        if self.enable is not None:
            d["enable"] = int(self.enable)
        if self.groups is not None:
            d["groups"] = ",".join(self.groups)
        return d


class UserCreate(UserFields):
    userid: str = Field(pattern=USERID_RE)
    password: str | None = Field(None, min_length=8, max_length=256)


class PasswordBody(BaseModel):
    password: str = Field(min_length=8, max_length=256, pattern=r"^[^\r\n]+$")


@router.get("/api/v1/access/users")
async def users():
    return await pve("GET", "/access/users", params={"full": 1}) or []


@router.post("/api/v1/access/users")
async def create_user(body: UserCreate):
    data = {"userid": body.userid, **body.params()}
    if body.password:
        if not body.userid.endswith("@pve"):
            raise HTTPException(422, "Passwords can only be set for the Proxmox VE (@pve) realm")
        data["password"] = body.password
    await pve("POST", "/access/users", data=data)
    return {"ok": True}


@router.put("/api/v1/access/users/{userid}")
async def update_user(body: UserFields, userid: str = Path(pattern=USERID_RE)):
    guard_user(userid)
    await pve("PUT", f"/access/users/{_q(userid)}", data=body.params())
    return {"ok": True}


@router.delete("/api/v1/access/users/{userid}")
async def delete_user(userid: str = Path(pattern=USERID_RE)):
    guard_user(userid, deleting=True)
    await pve("DELETE", f"/access/users/{_q(userid)}")
    return {"ok": True}


@router.put("/api/v1/access/users/{userid}/password")
async def set_password(body: PasswordBody, userid: str = Path(pattern=USERID_RE)):
    guard_user(userid)
    # API tokens may not change passwords; root's pvesh on the host can.
    await host_ssh.run(f"pvesh set /access/password --userid {shlex.quote(userid)} --password {shlex.quote(body.password)}")
    return {"ok": True}


# ---------------------------------------------------------------- Groups


class GroupBody(BaseModel):
    groupid: str = Field(pattern=ID_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


@router.get("/api/v1/access/groups")
async def groups():
    return await pve("GET", "/access/groups") or []


@router.post("/api/v1/access/groups")
async def create_group(body: GroupBody):
    await pve("POST", "/access/groups", data={k: v for k, v in body.model_dump().items() if v})
    return {"ok": True}


@router.delete("/api/v1/access/groups/{groupid}")
async def delete_group(groupid: str = Path(pattern=ID_RE)):
    await pve("DELETE", f"/access/groups/{_q(groupid)}")
    return {"ok": True}


# ---------------------------------------------------------------- Roles


class RoleBody(BaseModel):
    privs: list[str] = Field(max_length=200)

    def joined(self) -> str:
        bad = [p for p in self.privs if not re.fullmatch(PRIV_RE, p)]
        if bad:
            raise HTTPException(422, f"Invalid privilege: {bad[0]}")
        return ",".join(self.privs)


class RoleCreate(RoleBody):
    roleid: str = Field(pattern=ID_RE)


@router.get("/api/v1/access/roles")
async def roles():
    return await pve("GET", "/access/roles") or []


@router.get("/api/v1/access/privileges")
async def privileges():
    # The built-in Administrator role holds every privilege PVE knows.
    admin = await pve("GET", "/access/roles/Administrator") or {}
    return sorted(admin)


@router.post("/api/v1/access/roles")
async def create_role(body: RoleCreate):
    await pve("POST", "/access/roles", data={"roleid": body.roleid, "privs": body.joined()})
    return {"ok": True}


@router.put("/api/v1/access/roles/{roleid}")
async def update_role(body: RoleBody, roleid: str = Path(pattern=ID_RE)):
    await pve("PUT", f"/access/roles/{_q(roleid)}", data={"privs": body.joined()})
    return {"ok": True}


@router.delete("/api/v1/access/roles/{roleid}")
async def delete_role(roleid: str = Path(pattern=ID_RE)):
    await pve("DELETE", f"/access/roles/{_q(roleid)}")
    return {"ok": True}


# ---------------------------------------------------------------- ACL


class AclBody(BaseModel):
    path: str = Field(pattern=ACL_PATH_RE, max_length=300)
    roleid: str = Field(pattern=ID_RE)
    type: str = Field(pattern=r"^(user|group|token)$")
    ugid: str = Field(max_length=200)
    propagate: bool = True


def acl_params(path: str, roleid: str, type_: str, ugid: str) -> dict:
    if not re.fullmatch({"user": USERID_RE, "group": ID_RE, "token": TOKEN_FULL_RE}[type_], ugid):
        raise HTTPException(422, f"Invalid {type_}: {ugid}")
    return {"path": path, "roles": roleid, {"user": "users", "group": "groups", "token": "tokens"}[type_]: ugid}


@router.get("/api/v1/access/acl")
async def acl():
    return await pve("GET", "/access/acl") or []


@router.post("/api/v1/access/acl")
async def add_acl(body: AclBody):
    await pve("PUT", "/access/acl", data={**acl_params(body.path, body.roleid, body.type, body.ugid),
                                          "propagate": int(body.propagate)})
    return {"ok": True}


@router.delete("/api/v1/access/acl")
async def delete_acl(path: str = Query(pattern=ACL_PATH_RE, max_length=300), roleid: str = Query(pattern=ID_RE),
                     type: str = Query(pattern=r"^(user|group|token)$"), ugid: str = Query(max_length=200)):
    if ugid in (service_ids()[0], "!".join(service_ids())):
        raise HTTPException(403, "These permissions belong to the SolarDeck service account")
    await pve("PUT", "/access/acl", data={**acl_params(path, roleid, type, ugid), "delete": 1})
    return {"ok": True}


# ---------------------------------------------------------------- Pools


class PoolBody(BaseModel):
    poolid: str = Field(pattern=ID_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


class PoolMembers(BaseModel):
    vms: list[int] = Field([], max_length=500)
    storage: list[str] = Field([], max_length=100)
    remove: bool = False


def pool_member_params(poolid: str, body: PoolMembers) -> dict:
    if any(not 100 <= v <= 999_999_999 for v in body.vms) or any(not re.fullmatch(STORAGE_RE, s) for s in body.storage):
        raise HTTPException(422, "Invalid VMID or storage id")
    d: dict = {"poolid": poolid}
    if body.vms:
        d["vms"] = ",".join(map(str, body.vms))
    if body.storage:
        d["storage"] = ",".join(body.storage)
    if body.remove:
        d["delete"] = 1
    return d


@router.get("/api/v1/pools")
async def pools():
    return await pve("GET", "/pools") or []


@router.get("/api/v1/pools/{poolid}")
async def pool(poolid: str = Path(pattern=ID_RE)):
    items = await pve("GET", "/pools", params={"poolid": poolid}) or []
    return items[0] if items else {"poolid": poolid, "members": []}


@router.post("/api/v1/pools")
async def create_pool(body: PoolBody):
    await pve("POST", "/pools", data={k: v for k, v in body.model_dump().items() if v})
    return {"ok": True}


@router.put("/api/v1/pools/{poolid}/members")
async def pool_members(body: PoolMembers, poolid: str = Path(pattern=ID_RE)):
    await pve("PUT", "/pools", data=pool_member_params(poolid, body))
    return {"ok": True}


@router.delete("/api/v1/pools/{poolid}")
async def delete_pool(poolid: str = Path(pattern=ID_RE)):
    await pve("DELETE", "/pools", params={"poolid": poolid})
    return {"ok": True}


# ---------------------------------------------------------------- API tokens & realms


class TokenBody(BaseModel):
    userid: str = Field(pattern=USERID_RE)
    tokenid: str = Field(pattern=TOKEN_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)
    expire: int = Field(0, ge=0)
    privsep: bool = True


@router.get("/api/v1/access/tokens")
async def tokens():
    out = []
    for u in await pve("GET", "/access/users", params={"full": 1}) or []:
        for t in u.get("tokens") or []:
            out.append({"userid": u["userid"], **t, "service": (u["userid"], t.get("tokenid")) == service_ids()})
    return out


@router.post("/api/v1/access/tokens")
async def create_token(body: TokenBody):
    data = {"comment": body.comment, "expire": body.expire, "privsep": int(body.privsep)}
    res = await pve("POST", f"/access/users/{_q(body.userid)}/token/{_q(body.tokenid)}",
                    data={k: v for k, v in data.items() if v != ""})
    return {"full_tokenid": res.get("full-tokenid"), "value": res.get("value")}  # the secret is only shown once


@router.delete("/api/v1/access/tokens/{userid}/{tokenid}")
async def delete_token(userid: str = Path(pattern=USERID_RE), tokenid: str = Path(pattern=TOKEN_RE)):
    guard_token(userid, tokenid)
    await pve("DELETE", f"/access/users/{_q(userid)}/token/{_q(tokenid)}")
    return {"ok": True}


@router.get("/api/v1/access/domains")
async def domains():
    return await pve("GET", "/access/domains") or []
