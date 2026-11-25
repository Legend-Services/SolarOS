"""Proxmox VE REST client (/api2/json, API token auth) and its connection settings."""
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import ENV_FILE, settings


class ProxmoxSettings(BaseSettings):
    """PVE_HOST, PVE_PORT, PVE_TOKEN_ID, PVE_TOKEN_SECRET, PVE_VERIFY_SSL from the environment / backend/.env."""
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_prefix="pve_", extra="ignore")

    host: str = "https://127.0.0.1:8006"  # full URL including the port
    port: int = 8006  # written by install.sh next to PVE_HOST; the client uses PVE_HOST as given
    token_id: str = ""
    token_secret: str = ""
    verify_ssl: bool = False

    @property
    def hostname(self) -> str:
        return urlparse(self.host).hostname or "127.0.0.1"

    @property
    def auth_header(self) -> dict:
        return {"Authorization": f"PVEAPIToken={self.token_id}={self.token_secret}"}


pve_settings = ProxmoxSettings()
_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=f"{pve_settings.host.rstrip('/')}/api2/json", headers=pve_settings.auth_header,
                                    verify=pve_settings.verify_ssl, timeout=15)
    return _client


async def close_client() -> None:
    if _client is not None:
        await _client.aclose()


async def pve(method: str, path: str, **kw):
    try:
        r = await client().request(method, path, **kw)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Proxmox API unreachable: {e}")
    if r.status_code >= 400:
        raise HTTPException(502 if r.status_code >= 500 else r.status_code, f"Proxmox API error: {r.text[:300]}")
    return r.json().get("data")


async def _safe(path: str, default=None, **kw):
    try:
        return await pve("GET", path, **kw)
    except HTTPException:
        return default


def _node(path: str = "") -> str:
    return f"/nodes/{settings.node_name}{path}"
