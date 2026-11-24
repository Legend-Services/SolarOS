"""Phase 18 self-check: provider contract, registry, capabilities and /api/v1 aliases.
Run: python -m tests.test_phase18_providers (from backend/)."""
import asyncio
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import pve  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from providers import registry  # noqa: E402
from providers.base import HypervisorProvider  # noqa: E402
from providers.native_ubuntu.provider import PLANNED, NativeUbuntuProvider  # noqa: E402
from providers.proxmox.provider import ProxmoxProvider  # noqa: E402

DATA = {
    "/nodes/pve/status": {"cpu": 0.25, "memory": {"used": 1, "total": 4, "free": 3}, "uptime": 9, "loadavg": ["0.5"]},
    "/nodes/pve/qemu": [{"vmid": 101, "name": "vm", "status": "running", "cpus": 2}],
    "/nodes/pve/lxc": [{"vmid": 100, "name": "ct", "status": "stopped", "maxcpu": 1}],
}
calls = []


def handler(req: httpx.Request) -> httpx.Response:
    path = req.url.path.split("/api2/json", 1)[-1]
    calls.append((req.method, path))
    return httpx.Response(200, json={"data": "UPID:pve:1" if req.method == "POST" else DATA.get(path, [])})


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://pve/api2/json")
c = TestClient(app)
assert c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).status_code == 200

# Both drivers are concrete implementations of the full contract.
assert not ProxmoxProvider.__abstractmethods__ and len(HypervisorProvider.__abstractmethods__) >= 70
assert isinstance(registry.get_provider(), ProxmoxProvider)  # HYPERVISOR_DRIVER unset -> proxmox

# Capabilities on the legacy and the v1 path.
for path in ("/api/system/capabilities", "/api/v1/system/capabilities"):
    caps = c.get(path).json()
    assert caps["driver"] == "proxmox" and caps["supports_clustering"] is True, caps
anon = TestClient(app)
assert anon.get("/api/v1/system/capabilities").status_code == 200  # public: the sign-in screen shows the platform
assert anon.get("/api/v1/guests").status_code == 401 and anon.get("/api/pve/guests").status_code == 401  # aliases keep auth

# Legacy and v1 paths resolve identically through the provider.
legacy, v1 = c.get("/api/pve/guests").json(), c.get("/api/v1/guests").json()
assert legacy == v1 and [g["vmid"] for g in v1] == [100, 101] and v1[1]["maxcpu"] == 2, v1
o = c.get("/api/v1/overview").json()
assert o["cpu"] == 25 and o["vms"] == {"running": 1, "stopped": 0, "total": 1} and o["loadavg"] == [0.5], o
assert c.post("/api/v1/guests/lxc/100/action", json={"action": "start"}).json() == {"ok": True, "task": "UPID:pve:1"}
assert calls[-1] == ("POST", "/nodes/pve/lxc/100/status/start")
assert c.post("/api/v1/guests/lxc/100/action", json={"action": "explode"}).status_code == 422

# Standalone driver: capabilities live, everything else is a clear 501.
native = NativeUbuntuProvider()
caps = native.get_capabilities()
assert caps.driver == "native_ubuntu" and caps.platform_label == "SolarDeck Hypervisor"
assert not caps.supports_clustering and not caps.supports_rbac_realms and caps.supports_host_shell
try:
    asyncio.run(native.list_guests())
    raise AssertionError("stub should raise")
except NotImplementedError as e:
    assert str(e) == PLANNED

registry.get_provider.cache_clear()
settings.hypervisor_driver = "native_ubuntu"
try:
    assert c.get("/api/v1/system/capabilities").json()["driver"] == "native_ubuntu"
    r = c.get("/api/v1/guests")
    assert r.status_code == 501 and r.json()["detail"] == PLANNED, r.text
    settings.hypervisor_driver = "bogus"
    registry.get_provider.cache_clear()
    try:
        registry.get_provider()
        raise AssertionError("unknown driver should fail")
    except RuntimeError:
        pass
finally:
    settings.hypervisor_driver = "proxmox"
    registry.get_provider.cache_clear()

print("phase 18 provider self-check OK")
