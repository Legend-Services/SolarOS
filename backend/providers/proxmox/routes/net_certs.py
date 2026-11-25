"""Proxmox node certificates: ACME accounts, DNS plugins, domains and orders (pvesh over the root SSH bridge + API)."""
import asyncio
import base64
import json
import re
from typing import Literal

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field, model_validator

from app import host_ssh
from app.auth import require_user
from app.net_services import DOMAIN_PAT, NGINX_SNIPPET, q

from ..api import _node, _safe, pve

router = APIRouter(prefix="/api/net", tags=["net_services"], dependencies=[Depends(require_user)])
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


async def set_node_certificate(cert: str, key: str) -> None:
    await pve("POST", _node("/certificates/custom"), data={"certificates": cert, "key": key, "force": 1, "restart": 1})


async def remove_node_certificate() -> None:
    await pve("DELETE", _node("/certificates/custom"), params={"restart": 1})
