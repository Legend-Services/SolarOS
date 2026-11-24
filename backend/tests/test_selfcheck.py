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

# ---------------- Phase 2 ----------------

from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app import apps, host, shares  # noqa: E402
from app.config import settings  # noqa: E402

FAKE2 = {
    "/tasks": [{"upid": "UPID:pve:1:2:3:vzcreate:105:root@pam:", "type": "vzcreate", "id": "105", "starttime": 5},
               {"upid": "UPID:pve:1:2:3:qmstart:101:root@pam:", "status": "OK", "endtime": 9},
               {"upid": "UPID:pve:1:2:3:qmstop:101:root@pam:", "status": "command failed", "endtime": 9}],
    "/lxc": [{"vmid": 110, "name": "jf", "status": "running", "tags": "proxmox-os-app;pos-jellyfin"},
             {"vmid": 111, "name": "other", "tags": "pos-jellyfin"}],
}
calls = []


def handler2(req: httpx.Request) -> httpx.Response:
    path = req.url.path.split("/nodes/pve", 1)[-1]
    calls.append((req.method, path, req.content.decode()))
    if path.endswith("/vncproxy"):
        return httpx.Response(200, json={"data": {"port": "5900", "ticket": "PVEVNC:t", "user": "u@pve"}})
    return httpx.Response(200, json={"data": FAKE2.get(path, "UPID:x")})


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler2), base_url="https://pve/api2/json")

t = c.get("/api/pve/tasks").json()
assert [x["state"] for x in t] == ["running", "ok", "error"] and t[0]["id"] == "105", t
assert c.get("/api/pve/tasks/not-a-upid/status").status_code == 400

cat = {a["id"]: a for a in c.get("/api/apps/catalog").json()}
assert len(cat) == 7 and [i["vmid"] for i in cat["jellyfin"]["installed"]] == [110], cat["jellyfin"]
assert all((apps.DATA / f"apps/{i}.sh").exists() for i in cat), "missing install script"
body = apps.DeployBody(app_id="jellyfin", hostname="jf", cores=2, memory=2048, disk_gb=16,
                       ip_config={"cidr": "192.168.1.50/24", "gateway": "192.168.1.1"},
                       mount_storage=True, enable_igpu=True)
cp_ = apps.create_params(120, apps.BY_ID["jellyfin"], body, "local:vztmpl/debian-12-standard_12.7-1.tar.zst", "tank")
assert cp_["net0"] == "name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1" and cp_["unprivileged"] == 1, cp_
assert cp_["tags"] == "proxmox-os-app;pos-jellyfin" and cp_["rootfs"] == "tank:16", cp_
assert apps.configure_opts(apps.BY_ID["jellyfin"], body) == ["storage", "igpu"]
assert apps.configure_opts(apps.BY_ID["adguard-home"], body) == []  # unsupported options are dropped
assert sorted(["a_12.10-1", "a_12.7-1"], key=apps._natural)[-1] == "a_12.10-1"
bad = {"app_id": "jellyfin", "hostname": "Bad_Host", "cores": 1, "memory": 512, "disk_gb": 4}
assert c.post("/api/apps/deploy", json=bad).status_code == 422
assert c.post("/api/apps/deploy", json={**bad, "hostname": "ok", "ip_config": {"cidr": "10.0.0.5", "gateway": "10.0.0.1"}}).status_code == 422

# ZFS through the host helper (mocked).
helper = []


async def fake_run(args, stdin=None, on_line=None, timeout=120):
    helper.append(args)
    return "tank\tfilesystem\t100\t50\t1700000000\t/tank\ntank@snap1\tsnapshot\t1\t50\t1700000100\t-\nbroken line"


host.run = fake_run
z = c.get("/api/pve/zfs/snapshots").json()
assert z["datasets"][0]["name"] == "tank" and z["snapshots"][0] == {
    "name": "tank@snap1", "dataset": "tank", "snapshot": "snap1", "used": 1, "refer": 50, "creation": 1700000100}, z
assert c.post("/api/pve/zfs/snapshots", json={"dataset": "tank/media", "name": "daily-1"}).status_code == 200
assert c.post("/api/pve/zfs/snapshots", json={"dataset": "-o x", "name": "a"}).status_code == 422
assert c.post("/api/pve/zfs/snapshots", json={"dataset": "tank", "name": "a;rm"}).status_code == 422
assert c.post("/api/pve/zfs/snapshots/rollback", json={"snapshot": "tank@snap1", "force": True}).status_code == 200
assert c.delete("/api/pve/zfs/snapshots", params={"snapshot": "tank"}).status_code == 422  # never a dataset
assert c.delete("/api/pve/zfs/snapshots", params={"snapshot": "tank@snap1"}).status_code == 200
assert helper[1:] == [["zfs-snapshot", "tank/media@daily-1"], ["zfs-rollback", "tank@snap1", "force"],
                      ["zfs-destroy", "tank@snap1"]], helper

# SMB shares (samba commands mocked).
settings.samba_conf = __import__("pathlib").Path(tmp).parent / f"smb-{os.getpid()}.conf"
sh = []
shares._sh = lambda args, stdin=None: sh.append(args) or ""
r = c.post("/api/shares", json={"name": "media", "path": "/media/tv", "comment": "TV", "users": ["alice"]})
assert r.status_code == 200 and r.json()["path"] == "/media/tv" and os.path.isdir(os.path.join(tmp, "media/tv")), r.text
conf = settings.samba_conf.read_text()
assert "[media]" in conf and "valid users = alice" in conf and "force user = root" in conf, conf
assert sh[-1] == ["systemctl", "reload-or-restart", "smbd"]
assert c.post("/api/shares", json={"name": "global", "path": "/x"}).status_code == 400
assert c.post("/api/shares", json={"name": "x", "path": "/../etc"}).status_code == 403
assert c.post("/api/shares", json={"name": "x", "path": "/x", "comment": "a\n[global]"}).status_code == 422
assert c.post("/api/shares", json={"name": "x", "path": "/x", "users": ["Bad User"]}).status_code == 422
assert [s["name"] for s in c.get("/api/shares").json()] == ["media"]
assert c.delete("/api/shares/media").status_code == 200 and c.get("/api/shares").json() == []
assert c.post("/api/shares/users", json={"username": "root;x", "password": "pw12"}).status_code == 422
settings.samba_conf.unlink()

# Console tickets + WebSocket auth.
v = c.post("/api/pve/guests/qemu/101/vnc").json()
assert v["password"] == "PVEVNC:t" and v["session"], v
anon = TestClient(app)
for url in (f"/api/pve/ws/vnc/qemu/101?session={v['session']}", "/api/pve/ws/terminal/lxc/100"):
    try:
        with anon.websocket_connect(url):
            raise AssertionError("unauthenticated websocket accepted")
    except WebSocketDisconnect as e:
        assert e.code == 4401, e.code
tok = c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).json()["token"]
try:
    with c.websocket_connect(f"/api/pve/ws/vnc/lxc/101?session={v['session']}&token={tok}"):  # wrong guest
        raise AssertionError("session for another guest accepted")
except WebSocketDisconnect as e:
    assert e.code == 4403, e.code
assert v["session"] not in __import__("app.console", fromlist=["x"])._sessions  # single use

# ---------------- Phase 3 ----------------

import asyncio  # noqa: E402

from app import notifications, schedules, telemetry  # noqa: E402

# SMART temperature parsing (NVMe text and ATA attributes).
assert telemetry.smart_temp({"text": "Critical Warning: 0x00\nTemperature:                        47 Celsius\n"}) == 47
assert telemetry.smart_temp({"attributes": [{"id": "  9", "raw": "100"}, {"id": "194", "raw": "38 (Min/Max 20/45)"}]}) == 38
assert telemetry.smart_temp({"health": "PASSED"}) is None

# GPU probe parsing; [N/A] values and junk lines degrade to None / are skipped.
gp = telemetry.parse_gpu_probe("dri:/dev/dri/renderD128:0x8086\n"
                               "nvidia:NVIDIA GeForce RTX 3090, 54, 12, 2048, 24576, [N/A]\nnvidia:bad\ngarbage")
assert gp["igpu"] == {"available": True, "quicksync": True,
                      "render_nodes": [{"path": "/dev/dri/renderD128", "vendor": "0x8086", "intel": True}]}, gp
assert gp["gpu"] == {"available": True, "name": "NVIDIA GeForce RTX 3090", "temp_c": 54.0, "utilization_pct": 12.0,
                     "vram_used_mb": 2048.0, "vram_total_mb": 24576.0, "power_w": None}, gp
assert telemetry.parse_gpu_probe("")["gpu"] == telemetry.NO_GPU

# /hardware endpoint with mocked PVE + helper (no GPU on host).
FAKE3 = {
    "/disks/list": [{"devpath": "/dev/nvme0n1", "model": "Samsung 990", "type": "nvme", "wearout": 97, "size": 1},
                    {"devpath": "/dev/sda", "model": "WD Red", "type": "hdd", "wearout": "N/A", "size": 2}],
    "/disks/smart": {"health": "PASSED", "type": "text", "text": "Temperature: 61 Celsius"},
}
pve._client = httpx.AsyncClient(transport=httpx.MockTransport(
    lambda req: httpx.Response(200, json={"data": FAKE3.get(req.url.path.split("/nodes/pve", 1)[-1], [])})),
    base_url="https://pve/api2/json")


async def no_hw(args, stdin=None, on_line=None, timeout=120):
    raise __import__("fastapi").HTTPException(503, "no helper")


host.run = no_hw
hw = c.get("/api/pve/telemetry/hardware").json()
assert hw["gpu"]["available"] is False and hw["disks"][0]["temp_c"] == 61, hw
assert hw["disks"][0]["life_left_pct"] == 97 and hw["disks"][1]["life_left_pct"] is None, hw

# Alert evaluation.
al = notifications.evaluate(
    pools=[{"name": "tank", "health": "DEGRADED", "frag": 85, "alloc": 90, "size": 100},
           {"name": "fast", "health": "ONLINE", "frag": 5, "alloc": 1, "size": 100}],
    details=[{"scan": "resilver in progress since Sun"}, {"scan": "scrub repaired 0B"}],
    targets=[{"storage": "local", "active": 1, "used": 96, "total": 100}, {"storage": "nfs", "active": 0, "used": 99, "total": 100}],
    status={"rootfs": {"used": 10, "total": 100}},
    disks=[{"devpath": "/dev/sda", "model": "WD", "health": "FAILED", "temp_c": 40},
           {"devpath": "/dev/nvme0n1", "model": "S", "health": "PASSED", "temp_c": 61}],
    tasks=[{"upid": "UPID:x", "type": "qmstop", "id": "101", "status": "command failed", "state": "error",
            "starttime": 0}],
)
ids = {a["id"]: a["severity"] for a in al}
assert ids == {"zfs-health:tank": "warning", "zfs-resilver:tank": "warning", "zfs-frag:tank": "warning",
               "zfs-cap:tank": "warning", "storage-cap:local": "critical", "smart:/dev/sda": "critical",
               "disk-temp:/dev/nvme0n1": "warning", "task:UPID:x": "warning"}, ids
assert [a["severity"] for a in al][:2] == ["critical", "critical"]
assert notifications.evaluate([{"name": "t", "health": "FAULTED"}], [{}], [], {}, [], [])[0]["severity"] == "critical"
n = c.get("/api/notifications").json()
assert n["counts"]["warning"] >= 1 and any(a["id"] == "disk-temp:/dev/nvme0n1" for a in n["alerts"]), n

# Schedules: CRUD, validation, execution + retention pruning.
settings.schedules_file = __import__("pathlib").Path(tmp).parent / f"schedules-{os.getpid()}.json"
assert c.get("/api/schedules").json() == []
assert c.post("/api/schedules", json={"kind": "snapshot", "target": "tank", "interval": "monthly"}).status_code == 422
assert c.post("/api/schedules", json={"kind": "scrub", "target": "tank/media"}).status_code == 422
assert c.post("/api/schedules", json={"kind": "snapshot", "target": "-o x"}).status_code == 422
assert c.post("/api/schedules", json={"kind": "snapshot", "target": "tank", "retention": 0}).status_code == 422
snap = c.post("/api/schedules", json={"kind": "snapshot", "target": "tank/media", "interval": "hourly", "retention": 2}).json()
scrub = c.post("/api/schedules", json={"kind": "scrub", "target": "tank", "interval": "daily"}).json()
assert scrub["interval"] == "monthly" and snap["next_run"] > snap["created"], (snap, scrub)
assert c.patch(f"/api/schedules/{scrub['id']}", json={"enabled": False}).json()["enabled"] is False

hcalls = []
listing = "\n".join(f"tank/media@proxmoxos-auto-hourly-{i}\tsnapshot\t1\t1\t{1700000000 + i}\t-" for i in range(4))
listing += "\ntank/media@proxmoxos-auto-daily-0\tsnapshot\t1\t1\t1600000000\t-\ntank/media@manual\tsnapshot\t1\t1\t1\t-"


async def sched_run(args, stdin=None, on_line=None, timeout=120):
    hcalls.append(args)
    return listing if args[0] == "zfs-list" else ""


host.run = sched_run
future = snap["next_run"] + 1
assert asyncio.run(schedules.run_due(future)) == 1  # the scrub is disabled
assert hcalls[0][0] == "zfs-snapshot" and hcalls[0][1].startswith("tank/media@proxmoxos-auto-hourly-"), hcalls
assert [a for a in hcalls if a[0] == "zfs-destroy"] == [["zfs-destroy", "tank/media@proxmoxos-auto-hourly-1"],
                                                       ["zfs-destroy", "tank/media@proxmoxos-auto-hourly-0"]], hcalls
s0 = next(s for s in c.get("/api/schedules").json() if s["id"] == snap["id"])
assert s0["last_status"] == "ok" and s0["next_run"] == future + 3600, s0
assert asyncio.run(schedules.run_due(future)) == 0  # not due again yet
c.patch(f"/api/schedules/{scrub['id']}", json={"enabled": True})
hcalls.clear()
host.run = no_hw
assert asyncio.run(schedules.run_due(future + 10 ** 8)) == 2
assert {s["last_status"] for s in c.get("/api/schedules").json()} == {"error"}  # failures are recorded, not raised
assert c.delete(f"/api/schedules/{snap['id']}").status_code == 200
assert c.delete(f"/api/schedules/{snap['id']}").status_code == 404
settings.schedules_file.unlink()
print("selfcheck OK")
