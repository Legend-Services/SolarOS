"""App Center: curated catalog, deploy request model and deployment job tracking shared by the drivers."""
import ipaddress
import json
import re
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints, field_validator

from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/apps", tags=["apps"], dependencies=[Depends(require_user)])


DATA = Path(__file__).resolve().parent.parent / "data"
CATALOG: list[dict] = json.loads((DATA / "app_catalog.json").read_text())
BY_ID = {a["id"]: a for a in CATALOG}
TAG = settings.name("app")
ALIASES = {"ollama": "local-ai"}  # pre-v1.6 Ollama installs show up under Local AI Studio


# Local AI compute targets: "cpu", "nvidia:<index or PCI address>", "intel|amd:/dev/dri/renderD<N>".
TARGET_RE = r"^(cpu|nvidia:([0-9]{1,2}|([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])|(intel|amd):/dev/dri/renderD[0-9]{3})$"


MODEL_RE = r"^[a-z0-9][a-z0-9._/-]{0,100}(:[A-Za-z0-9._-]{1,60})?$"


# shortcut: deployment jobs live in memory and are lost on backend restart; the driver tasks + container remain.
_jobs: dict[int, dict] = {}


def installed_map(lxc: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in lxc:
        tags = set(re.split(r"[;, ]+", c.get("tags", "")))
        if TAG not in tags:
            continue
        for t in tags:
            app_id = ALIASES.get(t[4:], t[4:])
            if t.startswith("pos-") and app_id in BY_ID:
                out.setdefault(app_id, []).append(
                    {"vmid": int(c["vmid"]), "name": c.get("name", ""), "status": c.get("status", "")})
    return out


class StaticIP(BaseModel):
    cidr: str
    gateway: str

    @field_validator("cidr")
    @classmethod
    def _cidr(cls, v: str) -> str:
        if "/" not in v:
            raise ValueError("CIDR needs a prefix, e.g. 192.168.1.50/24")
        return str(ipaddress.IPv4Interface(v))

    @field_validator("gateway")
    @classmethod
    def _gw(cls, v: str) -> str:
        return str(ipaddress.IPv4Address(v))


class DeployBody(BaseModel):
    app_id: str
    hostname: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    cores: int = Field(ge=1, le=64)
    memory: int = Field(ge=256, le=262144, description="MB")
    disk_gb: int = Field(ge=2, le=4096)
    ip_config: Literal["dhcp"] | StaticIP = "dhcp"
    mount_storage: bool = False
    enable_igpu: bool = False
    # Local AI Studio only (app_id "local-ai").
    compute_target: str = Field("cpu", pattern=TARGET_RE)
    install_open_webui: bool = False
    starter_models: list[Annotated[str, StringConstraints(pattern=MODEL_RE)]] = Field([], max_length=5)


@router.get("/deployments/{vmid}")
async def deployment(vmid: int):
    job = _jobs.get(vmid)
    if not job:
        raise HTTPException(404, "No deployment job for this container (backend restarted?)")
    return {**job, "log": job["log"][-500:]}
