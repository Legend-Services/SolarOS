"""Access control request models and id patterns shared by the drivers (users, groups, roles, ACLs, pools)."""
import re

from fastapi import HTTPException
from pydantic import BaseModel, Field


USERID_RE = r"^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,32}$"
ID_RE = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"  # group, role, pool ids
TOKEN_RE = r"^[A-Za-z][A-Za-z0-9._-]{0,63}$"
PRIV_RE = r"^[A-Za-z]+(\.[A-Za-z]+)+$"
ACL_PATH_RE = r"^/([A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*)?$"
TOKEN_FULL_RE = r"^[A-Za-z0-9._-]{1,64}@[A-Za-z0-9._-]{1,32}![A-Za-z][A-Za-z0-9._-]{0,63}$"


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


class GroupBody(BaseModel):
    groupid: str = Field(pattern=ID_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


class RoleBody(BaseModel):
    privs: list[str] = Field(max_length=200)

    def joined(self) -> str:
        bad = [p for p in self.privs if not re.fullmatch(PRIV_RE, p)]
        if bad:
            raise HTTPException(422, f"Invalid privilege: {bad[0]}")
        return ",".join(self.privs)


class RoleCreate(RoleBody):
    roleid: str = Field(pattern=ID_RE)


class AclBody(BaseModel):
    path: str = Field(pattern=ACL_PATH_RE, max_length=300)
    roleid: str = Field(pattern=ID_RE)
    type: str = Field(pattern=r"^(user|group|token)$")
    ugid: str = Field(max_length=200)
    propagate: bool = True


class PoolBody(BaseModel):
    poolid: str = Field(pattern=ID_RE)
    comment: str = Field("", pattern=r"^[^\n]*$", max_length=500)


class PoolMembers(BaseModel):
    vms: list[int] = Field([], max_length=500)
    storage: list[str] = Field([], max_length=100)
    remove: bool = False
