"""Self-check for RBAC + Datacenter routers. Run: python -m tests.test_datacenter (from backend/)."""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32,
                  PVE_TOKEN_ID="pve-desktop@pve!webui")

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import pve, pve_datacenter as dc  # noqa: E402
from app.main import app  # noqa: E402

calls = []


def handler(req: httpx.Request) -> httpx.Response:
    calls.append((req.method, req.url.path.split("/api2/json", 1)[-1], req.content.decode(), str(req.url.params)))
    return httpx.Response(200, json={"data": None})


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://pve/api2/json")
c = TestClient(app)
assert c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).status_code == 200

# Storage params per type.
sp = dc.storage_params(dc.StorageBody(storage="nas", type="nfs", content=["backup", "iso", "backup"], server="10.0.0.5",
                                      export="/srv/pve", path="/ignored"))
assert sp == {"storage": "nas", "type": "nfs", "content": "backup,iso", "server": "10.0.0.5", "export": "/srv/pve"}, sp
sp = dc.storage_params(dc.StorageBody(storage="thin", type="lvmthin", content=["images"], vgname="pve", thinpool="data", enable=False))
assert sp["vgname"] == "pve" and sp["thinpool"] == "data" and sp["disable"] == 1
assert c.post("/api/pve/storage-config", json={"storage": "z", "type": "zfspool", "content": ["images"]}).status_code == 422
assert c.post("/api/pve/storage-config", json={"storage": "ok1", "type": "cifs", "content": ["iso"], "server": "a;b",
                                               "share": "x"}).status_code == 422
assert c.post("/api/pve/storage-config", json={"storage": "smb1", "type": "cifs", "content": ["iso"], "server": "nas.lan",
                                               "share": "pve", "username": "u", "password": "p w"}).status_code == 200
assert calls[-1][:2] == ("POST", "/storage") and "share=pve" in calls[-1][2] and "password=p+w" in calls[-1][2]

# Firewall rule mapping: cleared fields are deleted on update.
r = dc.RuleBody(action="ACCEPT", proto="tcp", dport="8006", comment="web")
assert dc.rule_params(r) == {"type": "in", "action": "ACCEPT", "enable": 1, "proto": "tcp", "dport": "8006", "comment": "web"}
assert "source" in dc.rule_params(r, update=True)["delete"].split(",")
assert c.post("/api/pve/firewall/qemu/rules", json={"action": "ACCEPT"}).status_code == 422  # guest scope needs vmid
assert c.post("/api/pve/firewall/qemu/rules?vmid=101", json={"action": "DROP", "source": "1.2.3.4; rm"}).status_code == 422
assert c.post("/api/pve/firewall/lxc/rules?vmid=101", json={"action": "DROP", "dport": "22"}).status_code == 200
assert calls[-1][1] == "/nodes/pve/lxc/101/firewall/rules", calls[-1]
assert c.put("/api/pve/firewall/cluster/options", json={"enable": True, "policy_in": "DROP"}).status_code == 200
assert calls[-1][2] == "enable=1&policy_in=DROP", calls[-1]

# Protected service account / token / root.
assert c.delete("/api/pve/access/users/pve-desktop@pve").status_code == 403
assert c.put("/api/pve/access/users/pve-desktop@pve", json={"enable": False}).status_code == 403
assert c.delete("/api/pve/access/users/root@pam").status_code == 403
assert c.delete("/api/pve/access/tokens/pve-desktop@pve/webui").status_code == 403
assert c.delete("/api/pve/access/acl", params={"path": "/", "roleid": "Administrator", "type": "user",
                                               "ugid": "pve-desktop@pve"}).status_code == 403
n = len(calls)
assert c.post("/api/pve/access/users", json={"userid": "bob@pam", "password": "longenough"}).status_code == 422
assert c.post("/api/pve/access/users", json={"userid": "bob@pve", "password": "longenough", "groups": ["ops"],
                                             "enable": True}).status_code == 200
assert len(calls) == n + 1 and "groups=ops" in calls[-1][2] and "enable=1" in calls[-1][2]

# ACL + pools.
assert c.post("/api/pve/access/acl", json={"path": "/vms/101", "roleid": "PVEVMUser", "type": "group", "ugid": "ops"}).status_code == 200
assert calls[-1][:2] == ("PUT", "/access/acl") and "groups=ops" in calls[-1][2] and "propagate=1" in calls[-1][2]
assert c.post("/api/pve/access/acl", json={"path": "/../x", "roleid": "R", "type": "user", "ugid": "a@pve"}).status_code == 422
assert c.put("/api/pve/pools/lab/members", json={"vms": [101, 102], "storage": ["local"], "remove": True}).status_code == 200
assert calls[-1][:2] == ("PUT", "/pools") and "vms=101%2C102" in calls[-1][2] and "delete=1" in calls[-1][2], calls[-1]
assert c.put("/api/pve/pools/lab/members", json={"vms": [5]}).status_code == 422

# Journal cursors are stripped.
pve._client = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, json={"data": [
    "s=abc123;i=1;b=x", "Nov 24 pve kernel: hi", "s=abc124;i=2;b=x"]})), base_url="https://pve/api2/json")
assert c.get("/api/pve/logs/journal").json() == {"lines": ["Nov 24 pve kernel: hi"]}
print("datacenter self-check OK")
