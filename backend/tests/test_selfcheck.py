"""Self-check for auth + File Station sandbox. Run: python -m tests.test_selfcheck (from backend/)."""
import os
import tempfile

tmp = tempfile.mkdtemp()
os.environ.update(STORAGE_ROOT=tmp, ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)
os.makedirs(os.path.join(tmp, ".hidden"))
outside = tempfile.mkdtemp()
os.symlink(outside, os.path.join(tmp, "escape"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

c = TestClient(app)
assert c.get("/api/health").json()["status"] == "ok"
assert c.get("/api/files/list").status_code == 401
assert c.post("/api/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401
assert c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).status_code == 200  # sets cookie

names = {e["name"]: e["path"] for e in c.get("/api/files/list").json()["items"]}
assert names[".hidden"] == "/.hidden", names
for bad in ("/../", "../../etc", "/escape", "/escape/x"):
    assert c.get("/api/files/list", params={"path": bad}).status_code == 403, bad
assert c.post("/api/files/mkdir", json={"path": "/", "name": "../x"}).status_code == 400
assert c.post("/api/files/mkdir", json={"path": "/", "name": "docs"}).status_code == 200
r = c.post("/api/files/upload", data={"path": "/docs"}, files=[("files", ("../a.txt", b"hello")), ("files", ("b.txt", b"hi"))])
assert r.status_code == 200 and [e["path"] for e in r.json()["saved"]] == ["/docs/a.txt", "/docs/b.txt"], r.text
assert c.get("/api/files/download", params={"path": "/docs/a.txt"}).content == b"hello"
assert c.patch("/api/files/rename", json={"path": "/docs/a.txt", "new_name": "c.txt"}).json()["path"] == "/docs/c.txt"
assert c.delete("/api/files/delete", params={"path": "/"}).status_code == 403
assert c.delete("/api/files/delete", params={"path": "/docs"}).status_code == 200
assert not os.path.exists(os.path.join(tmp, "docs"))
assert c.post("/api/pve/guests/qemu/100/action", json={"action": "destroy"}).status_code == 422

# Mock Proxmox API to check aggregation logic.
import httpx  # noqa: E402

from app import pve  # noqa: E402

FAKE = {
    "/status": {"cpu": 0.1234, "loadavg": ["0.5", "0.4", "0.3"], "memory": {"used": 8, "total": 16, "free": 8},
                "swap": {"used": 0, "total": 4}, "uptime": 99, "kversion": "k", "pveversion": "pve-manager/8",
                "cpuinfo": {"model": "Ryzen", "cpus": 16, "sockets": 1, "cores": 8}},
    "/qemu": [{"vmid": 101, "name": "vm", "status": "running"}, {"vmid": 102, "status": "stopped"}],
    "/lxc": [{"vmid": "100", "name": "ct", "status": "running"}],
    "/rrddata": [{"netin": 10, "netout": 20, "arcsize": 3}, {}],
    "/disks/zfs": [{"name": "tank", "health": "ONLINE"}],
    "/disks/zfs/tank": {"name": "tank", "children": []},
    "/storage": [{"storage": "local"}],
    "/disks/list": [{"devpath": "/dev/nvme0n1"}],
}
posted = []


def handler(req: httpx.Request) -> httpx.Response:
    path = req.url.path.split("/nodes/pve", 1)[1]
    if req.method == "POST":
        posted.append(path)
        return httpx.Response(200, json={"data": "UPID:x"})
    return httpx.Response(200, json={"data": FAKE[path]})


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://pve/api2/json")
o = c.get("/api/pve/overview").json()
assert o["cpu"] == 12.34 and o["memory"]["arc"] == 3 and o["net"] == {"in": 10, "out": 20}, o
assert o["vms"] == {"running": 1, "stopped": 1, "total": 2} and o["containers"]["running"] == 1, o
g = c.get("/api/pve/guests").json()
assert [x["vmid"] for x in g] == [100, 101, 102] and g[0]["type"] == "lxc" and g[2]["name"] == "qemu-102", g
assert c.post("/api/pve/guests/lxc/100/action", json={"action": "reboot"}).status_code == 200
assert posted == ["/lxc/100/status/reboot"], posted
st = c.get("/api/pve/storage").json()
assert st["pools"][0]["detail"]["name"] == "tank" and st["disks"][0]["devpath"] == "/dev/nvme0n1", st
print("selfcheck OK")
