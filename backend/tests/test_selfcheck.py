"""Self-check for auth + File Station sandbox. Run: python -m tests.test_selfcheck (from backend/)."""
import os
import tempfile

tmp = tempfile.mkdtemp()
os.environ.update(NODE_NAME="pve", STORAGE_ROOT=tmp, ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)
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
assert c.post("/api/v1/guests/qemu/100/action", json={"action": "destroy"}).status_code == 422

# Mock Proxmox API to check aggregation logic.
import httpx  # noqa: E402

from app import pve  # noqa: E402

FAKE = {
    "/status": {"cpu": 0.1234, "loadavg": ["0.5", "0.4", "0.3"], "memory": {"used": 8, "total": 16, "free": 8},
                "swap": {"used": 0, "total": 4}, "uptime": 99, "kversion": "k", "pveversion": "pve-manager/8",
                "cpuinfo": {"model": "Ryzen", "cpus": 16, "sockets": 1, "cores": 8}},
    "/qemu": [{"vmid": 101, "name": "vm", "status": "running", "maxcpu": 4}, {"vmid": 102, "status": "stopped"}],
    "/lxc": [{"vmid": "100", "name": "ct", "status": "running", "cpus": 2}],
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
o = c.get("/api/v1/overview").json()
assert o["cpu"] == 12.34 and o["memory"]["arc"] == 3 and o["net"] == {"in": 10, "out": 20}, o
assert o["vms"] == {"running": 1, "stopped": 1, "total": 2} and o["containers"]["running"] == 1, o
g = c.get("/api/v1/guests").json()
assert [x["vmid"] for x in g] == [100, 101, 102] and g[0]["type"] == "lxc" and g[2]["name"] == "qemu-102", g
assert [x["maxcpu"] for x in g] == [2, 4, 0], g  # node lists say "cpus", cluster resources "maxcpu"
assert c.post("/api/v1/guests/lxc/100/action", json={"action": "reboot"}).status_code == 200
assert posted == ["/lxc/100/status/reboot"], posted
st = c.get("/api/v1/storage").json()
assert st["pools"][0]["detail"]["name"] == "tank" and st["disks"][0]["devpath"] == "/dev/nvme0n1", st

# ---------------- Phase 2 ----------------

from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app import apps, host, shares  # noqa: E402
from app.config import settings  # noqa: E402

FAKE2 = {
    "/tasks": [{"upid": "UPID:pve:1:2:3:vzcreate:105:root@pam:", "type": "vzcreate", "id": "105", "starttime": 5},
               {"upid": "UPID:pve:1:2:3:qmstart:101:root@pam:", "status": "OK", "endtime": 9},
               {"upid": "UPID:pve:1:2:3:qmstop:101:root@pam:", "status": "command failed", "endtime": 9}],
    "/lxc": [{"vmid": 110, "name": "jf", "status": "running", "tags": f"{apps.TAG};pos-jellyfin"},
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

t = c.get("/api/v1/tasks").json()
assert [x["state"] for x in t] == ["running", "ok", "error"] and t[0]["id"] == "105", t
assert c.get("/api/v1/tasks/not-a-upid/status").status_code == 400

cat = {a["id"]: a for a in c.get("/api/apps/catalog").json()}
assert len(cat) == 7 and [i["vmid"] for i in cat["jellyfin"]["installed"]] == [110], cat["jellyfin"]
assert all((apps.DATA / f"apps/{i}.sh").exists() for i in cat), "missing install script"
body = apps.DeployBody(app_id="jellyfin", hostname="jf", cores=2, memory=2048, disk_gb=16,
                       ip_config={"cidr": "192.168.1.50/24", "gateway": "192.168.1.1"},
                       mount_storage=True, enable_igpu=True)
cp_ = apps.create_params(120, apps.BY_ID["jellyfin"], body, "local:vztmpl/debian-12-standard_12.7-1.tar.zst", "tank")
assert cp_["net0"] == "name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1" and cp_["unprivileged"] == 1, cp_
assert cp_["tags"] == f"{apps.TAG};pos-jellyfin" and cp_["rootfs"] == "tank:16", cp_
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
z = c.get("/api/v1/zfs/snapshots").json()
assert z["datasets"][0]["name"] == "tank" and z["snapshots"][0] == {
    "name": "tank@snap1", "dataset": "tank", "snapshot": "snap1", "used": 1, "refer": 50, "creation": 1700000100}, z
assert c.post("/api/v1/zfs/snapshots", json={"dataset": "tank/media", "name": "daily-1"}).status_code == 200
assert c.post("/api/v1/zfs/snapshots", json={"dataset": "-o x", "name": "a"}).status_code == 422
assert c.post("/api/v1/zfs/snapshots", json={"dataset": "tank", "name": "a;rm"}).status_code == 422
assert c.post("/api/v1/zfs/snapshots/rollback", json={"snapshot": "tank@snap1", "force": True}).status_code == 200
assert c.delete("/api/v1/zfs/snapshots", params={"snapshot": "tank"}).status_code == 422  # never a dataset
assert c.delete("/api/v1/zfs/snapshots", params={"snapshot": "tank@snap1"}).status_code == 200
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
v = c.post("/api/v1/guests/qemu/101/vnc").json()
assert v["password"] == "PVEVNC:t" and v["session"], v
anon = TestClient(app)
for url in (f"/api/v1/ws/vnc/qemu/101?session={v['session']}", "/api/v1/ws/terminal/lxc/100"):
    try:
        with anon.websocket_connect(url):
            raise AssertionError("unauthenticated websocket accepted")
    except WebSocketDisconnect as e:
        assert e.code == 4401, e.code
tok = c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).json()["token"]
try:
    with c.websocket_connect(f"/api/v1/ws/vnc/lxc/101?session={v['session']}&token={tok}"):  # wrong guest
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
hw = c.get("/api/v1/telemetry/hardware").json()
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
listing = "\n".join(f"tank/media@{'solardeck' if i > 1 else 'proxmoxos'}-auto-hourly-{i}\tsnapshot\t1\t1\t{1700000000 + i}\t-" for i in range(4))
listing += "\ntank/media@proxmoxos-auto-daily-0\tsnapshot\t1\t1\t1600000000\t-\ntank/media@manual\tsnapshot\t1\t1\t1\t-"


async def sched_run(args, stdin=None, on_line=None, timeout=120):
    hcalls.append(args)
    return listing if args[0] == "zfs-list" else ""


host.run = sched_run
future = snap["next_run"] + 1
assert asyncio.run(schedules.run_due(future)) == 1  # the scrub is disabled
assert hcalls[0][0] == "zfs-snapshot" and hcalls[0][1].startswith("tank/media@solardeck-auto-hourly-"), hcalls
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

# ---------------- System app ----------------

from app import system  # noqa: E402

assert system.repo_handle("https://enterprise.proxmox.com/debian/pve", ["pve-enterprise"]) == "enterprise"
assert system.repo_handle("http://download.proxmox.com/debian/pve", ["pve-no-subscription"]) == "no-subscription"
assert system.repo_handle("https://enterprise.proxmox.com/debian/ceph-squid", ["enterprise"]) == "ceph-squid-enterprise"
assert system.repo_handle("http://deb.debian.org/debian/", ["main"]) is None
fl = system.flatten({"digest": "ab", "files": [{"path": "/etc/apt/sources.list.d/pve-enterprise.sources", "repositories": [
    {"Enabled": 1, "Types": ["deb"], "URIs": ["https://enterprise.proxmox.com/debian/pve"], "Suites": ["trixie"],
     "Components": ["pve-enterprise"]}]}],
    "standard-repos": [{"handle": "enterprise", "name": "Enterprise", "status": 1},
                       {"handle": "no-subscription", "name": "No-Subscription", "description": "free"}]})
assert fl["repositories"] == [{"path": "/etc/apt/sources.list.d/pve-enterprise.sources", "index": 0, "enabled": True,
                               "types": ["deb"], "uris": ["https://enterprise.proxmox.com/debian/pve"],
                               "suites": ["trixie"], "components": ["pve-enterprise"], "handle": "enterprise"}], fl
assert fl["available"] == [{"handle": "no-subscription", "name": "No-Subscription", "description": "free"}], fl
st = system.parse_upgrade_status("state:inactive\nReading package lists...\nsolardeck: exit 0")
assert st == {"running": False, "exit_code": 0, "log": ["Reading package lists...", "solardeck: exit 0"]}, st
assert system.parse_upgrade_status("state:active\nUnpacking x")["running"] is True

sys_calls = []


def handler4(req: httpx.Request) -> httpx.Response:
    sys_calls.append((req.method, req.url.path.split("/nodes/pve", 1)[-1], req.content.decode()))
    term = {"port": "5900", "ticket": "PVEVNC:t", "user": "u@pve"}
    return httpx.Response(200, json={"data": term if req.url.path.endswith("termproxy") else None})


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler4), base_url="https://pve/api2/json")
ok = {"path": "/etc/apt/sources.list.d/pve-enterprise.sources", "index": 0, "enabled": False, "digest": "ab12"}
assert c.post("/api/system/repositories/toggle", json=ok).status_code == 200
assert sys_calls[-1] == ("POST", "/apt/repositories", "path=%2Fetc%2Fapt%2Fsources.list.d%2Fpve-enterprise.sources&index=0&enabled=0&digest=ab12"), sys_calls
assert c.post("/api/system/repositories/toggle", json={**ok, "path": "/etc/passwd"}).status_code == 422
assert c.post("/api/system/repositories/add", json={"handle": "no-subscription"}).status_code == 200
assert sys_calls[-1][:2] == ("PUT", "/apt/repositories") and "handle=no-subscription" in sys_calls[-1][2]
assert c.post("/api/system/repositories/add", json={"handle": "x; rm"}).status_code == 422
assert c.post("/api/system/power", json={"command": "destroy"}).status_code == 422
assert c.post("/api/system/power", json={"command": "reboot"}).status_code == 200
assert sys_calls[-1] == ("POST", "/status", "command=reboot")
n = len(sys_calls)
assert c.post("/api/v1/guests/node/0/terminal").json()["session"]  # host shell: SSH bridge session, no termproxy
assert c.post("/api/v1/guests/lxc/101/terminal").json()["session"] and len(sys_calls) == n  # pct enter, no ticket
assert c.post("/api/v1/guests/node/0/vnc").status_code == 422  # graphical console stays guests-only

# ---------------- Phase 4 ----------------

from app import config, storage_admin  # noqa: E402

# SMART parsing: NVMe text and ATA attribute tables.
nv = storage_admin.parse_smart({"health": "PASSED", "type": "text", "text": (
    "Temperature:                        44 Celsius\nPercentage Used:                    3%\n"
    "Power On Hours:                     12,345\nUnsafe Shutdowns:                   17\n")})
assert (nv["temperature_c"], nv["wearout_used_pct"], nv["power_on_hours"], nv["unsafe_shutdowns"]) == (44, 3, 12345, 17), nv
assert {"name": "Percentage Used", "raw": "3%"} in nv["attributes"], nv
ata = storage_admin.parse_smart({"health": "PASSED", "type": "ata", "attributes": [
    {"id": "  9", "name": "Power_On_Hours", "value": 90, "raw": "8760"},
    {"id": "177", "name": "Wear_Leveling_Count", "value": 96, "raw": "40"},
    {"id": "194", "name": "Temperature_Celsius", "value": 64, "raw": "36 (Min/Max 20/50)"}]})
assert (ata["temperature_c"], ata["power_on_hours"], ata["wearout_used_pct"]) == (36, 8760, 4), ata

ds = storage_admin.parse_datasets("tank\tfilesystem\t10\t90\t5\t/tank\tlz4\t131072\t0\ton\t-\n"
                                  "tank/vm-100-disk-0\tvolume\t1\t2\t1\t-\tlz4\t-\t0\t-\t34359738368\njunk")
assert len(ds) == 2 and ds[0]["available"] == 90 and ds[0]["quota"] == 0 and ds[0]["pool"] == "tank", ds
assert ds[1]["guest_volume"] and ds[1]["volsize"] == 34359738368, ds

assert storage_admin.bus_type({"devpath": "/dev/nvme0n1"}) == "NVMe"
assert storage_admin.bus_type({"devpath": "/dev/sdb", "type": "hdd", "by_id_link": "/dev/disk/by-id/scsi-SATA_X"}) == "SATA"

p4 = []


def handler5(req: httpx.Request) -> httpx.Response:
    path = req.url.path.removeprefix("/api2/json").removeprefix("/nodes/pve")
    p4.append((req.method, path, req.url.query.decode(), req.content.decode()))
    data = {
        "/disks/list": [{"devpath": "/dev/sda", "by_id_link": "/dev/disk/by-id/ata-WD", "used": "", "wearout": "N/A",
                         "size": 4, "type": "hdd", "health": "PASSED"}],
        "/disks/smart": {"health": "PASSED", "type": "text", "text": "Temperature: 40 Celsius"},
        "/qemu/101/config": {"name": "vm", "cores": 2, "memory": "4096", "onboot": 1, "scsi0": "local-zfs:vm-101-disk-0,size=32G",
                             "ide2": "local:iso/x.iso,media=cdrom", "efidisk0": "local-zfs:vm-101-disk-1,size=1M"},
        "/version": {"version": "8.4.1", "release": "8.4"},
        "/status": {"pveversion": "pve-manager/8.4.1", "kversion": "Linux 6.8", "cpuinfo": {"model": "Ryzen"}},
        "/network": [{"iface": "eno1", "type": "eth"}, {"iface": "vmbr0", "type": "bridge", "cidr": "192.168.1.2/24"}],
        "/dns": {"dns1": "1.1.1.1", "search": "lan"},
    }.get(path, "UPID:x")
    return httpx.Response(200, json={"data": data})


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler5), base_url="https://pve/api2/json")
assert c.get("/api/v1/disks").json()[0] == {"devpath": "/dev/sda", "by_id": "/dev/disk/by-id/ata-WD", "model": "", "serial": "",
                                             "vendor": "", "size": 4, "type": "hdd", "bus": "SATA", "rotational": True,
                                             "rpm": None, "rpm_label": "HDD", "used": "", "gpt": False, "health": "PASSED",
                                             "wearout_pct": None, "pool_name": None, "vdev_name": None, "member_device": None,
                                             "member_state": None, "read_errors": None, "write_errors": None,
                                             "cksum_errors": None}
assert c.get("/api/v1/disks/sda/smart").json()["temperature_c"] == 40
assert p4[-1][2] == "disk=%2Fdev%2Fsda", p4[-1]
assert c.get("/api/v1/disks/%2Fdev%2Fnvme0n1/smart").status_code == 200 and p4[-1][2] == "disk=%2Fdev%2Fnvme0n1", p4[-1]
assert c.get("/api/v1/disks/..%2Fetc/smart").status_code == 422
assert c.post("/api/v1/disks/wipe", json={"disk": "/dev/sda", "confirm_device": "/dev/sdb"}).status_code == 400
assert c.post("/api/v1/disks/wipe", json={"disk": "/dev/sda;x", "confirm_device": "/dev/sda;x"}).status_code == 422
assert c.post("/api/v1/disks/wipe", json={"disk": "/dev/sda", "confirm_device": "/dev/sda"}).json() == {"task": "UPID:x"}
assert p4[-1][:2] == ("PUT", "/disks/wipedisk") and p4[-1][3] == "disk=%2Fdev%2Fsda", p4[-1]
assert c.post("/api/v1/disks/initgpt", json={"disk": "/dev/sda"}).status_code == 200 and p4[-1][1] == "/disks/initgpt"
assert c.post("/api/v1/disks/directory", json={"device": "/dev/sda", "name": "backup", "filesystem": "xfs"}).status_code == 200
assert "filesystem=xfs" in p4[-1][3] and "add_storage=1" in p4[-1][3], p4[-1]
assert c.post("/api/v1/disks/lvm", json={"device": "/dev/sda", "name": "thin1", "thin": True}).status_code == 200
assert p4[-1][1] == "/disks/lvmthin", p4[-1]
assert c.post("/api/v1/disks/lvm", json={"device": "/dev/sda", "name": "Bad Name"}).status_code == 422

pool = {"name": "tank2", "raidlevel": "mirror", "devices": ["/dev/disk/by-id/ata-A", "/dev/disk/by-id/ata-B"]}
assert c.post("/api/v1/zfs/pools", json=pool).status_code == 200
assert p4[-1][:2] == ("POST", "/disks/zfs") and "devices=%2Fdev%2Fdisk%2Fby-id%2Fata-A%2C%2Fdev%2Fdisk%2Fby-id%2Fata-B" in p4[-1][3], p4[-1]
assert "ashift=12" in p4[-1][3] and "compression=lz4" in p4[-1][3], p4[-1]
assert c.post("/api/v1/zfs/pools", json={**pool, "raidlevel": "raidz2"}).status_code == 400  # too few disks
assert c.post("/api/v1/zfs/pools", json={**pool, "devices": ["/dev/sda", "/dev/sda"]}).status_code == 400
assert c.post("/api/v1/zfs/pools", json={**pool, "raidlevel": "raid5"}).status_code == 422
assert c.delete("/api/v1/zfs/pools/tank2", params={"confirm": "tank"}).status_code == 400
assert c.delete("/api/v1/zfs/pools/tank2", params={"confirm": "tank2"}).status_code == 200
assert p4[-1][:3] == ("DELETE", "/disks/zfs/tank2", "cleanup-config=1&cleanup-disks=1"), p4[-1]

# Guest resource editor.
gc = c.get("/api/v1/guests/qemu/101/config").json()
assert gc["memory"] == 4096 and gc["onboot"] is True and [d["key"] for d in gc["disks"]] == ["efidisk0", "scsi0"], gc
assert gc["disks"][1]["size"] == "32G" and gc["disks"][1]["resizable"] and not gc["disks"][0]["resizable"], gc
r = c.patch("/api/v1/guests/qemu/101/config", json={"cores": 4, "memory": 8192, "onboot": False, "description": "",
                                                    "resize_disk": "scsi0", "resize_to": "+10G"})
assert r.json() == {"ok": True, "task": "UPID:x"}, r.text
assert p4[-2] == ("PUT", "/qemu/101/config", "", "cores=4&memory=8192&onboot=0&delete=description"), p4[-2]
assert p4[-1] == ("PUT", "/qemu/101/resize", "", "disk=scsi0&size=%2B10G"), p4[-1]
assert c.patch("/api/v1/guests/qemu/101/config", json={"swap": 512}).status_code == 400
assert c.patch("/api/v1/guests/lxc/100/config", json={"resize_disk": "rootfs"}).status_code == 400
assert c.patch("/api/v1/guests/lxc/100/config", json={"resize_disk": "rootfs", "resize_to": "-5G"}).status_code == 422

# Control Panel: system info + admin password persisted to .env.
si = c.get("/api/system/info").json()
assert si["api"]["connected"] and si["version"]["version"] == "8.4.1" and si["network"][0]["iface"] == "vmbr0", si
assert si["dns"]["dns1"] == "1.1.1.1", si
config.ENV_FILE = __import__("pathlib").Path(tmp).parent / f"env-{os.getpid()}"
config.ENV_FILE.write_text("NODE_NAME=pve\nADMIN_PASSWORD=pw\nJWT_SECRET=x\n")
assert c.post("/api/system/password", json={"current_password": "nope", "new_password": "longenough1"}).status_code == 403
assert c.post("/api/system/password", json={"current_password": "pw", "new_password": "short"}).status_code == 422
assert c.post("/api/system/password", json={"current_password": "pw", "new_password": "it's bad'"}).status_code == 422
new_pw = "N3w pass#word$"
assert c.post("/api/system/password", json={"current_password": "pw", "new_password": new_pw}).status_code == 200
from dotenv import dotenv_values  # noqa: E402

assert dotenv_values(config.ENV_FILE) == {"NODE_NAME": "pve", "ADMIN_PASSWORD": new_pw, "JWT_SECRET": "x"}
assert (config.ENV_FILE.stat().st_mode & 0o777) == 0o600
assert c.post("/api/auth/login", json={"username": "admin", "password": new_pw}).status_code == 200
assert c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).status_code == 401
config.ENV_FILE.unlink()

# ZFS datasets through the helper (mocked).
h4 = []


async def ds_run(args, stdin=None, on_line=None, timeout=120):
    h4.append(args)
    if args[0] == "storage-map":  # emulate the bind mount appearing in the container
        os.makedirs(os.path.join(tmp, args[1]), exist_ok=True)
    return "tank\tfilesystem\t10\t90\t5\t/tank\tlz4\t131072\t0\ton\t-" if args[0] == "zfs-datasets" else ""


host.run = ds_run
assert c.get("/api/v1/zfs/datasets").json()[0]["name"] == "tank"
r = c.post("/api/v1/zfs/datasets", json={"name": "tank/media", "compression": "zstd", "atime": "off", "quota": "500G"})
assert r.json()["path"] == "/tank/media" and h4[-2:] == [["zfs-create", "tank/media", "compression=zstd", "quota=500G", "atime=off"],
                                                          ["storage-map", "tank/media"]], h4
c.post("/api/v1/zfs/datasets", json={"name": "tank/vol1", "kind": "volume", "volsize": "32G", "atime": "off"})
assert h4[-1] == ["zfs-create", "tank/vol1", "volsize=32G"], h4  # no fs-only props, no mapping for ZVOLs
assert c.post("/api/v1/zfs/datasets", json={"name": "tank/vol2", "kind": "volume"}).status_code == 400
assert c.post("/api/v1/zfs/datasets", json={"name": "tank"}).status_code == 422  # pool root
assert c.post("/api/v1/zfs/datasets", json={"name": "tank/x", "recordsize": "3K"}).status_code == 422
assert c.post("/api/v1/zfs/datasets", json={"name": "tank/x", "mountpoint": "/a b"}).status_code == 422
assert c.patch("/api/v1/zfs/datasets", json={"name": "tank/media", "recordsize": "1M"}).status_code == 200
assert h4[-1] == ["zfs-set", "tank/media", "recordsize=1M"], h4
assert c.patch("/api/v1/zfs/datasets", json={"name": "tank/media"}).status_code == 400
assert c.delete("/api/v1/zfs/datasets", params={"name": "tank/media", "confirm": "tank"}).status_code == 400
assert c.delete("/api/v1/zfs/datasets", params={"name": "tank", "confirm": "tank"}).status_code == 422
assert c.delete("/api/v1/zfs/datasets", params={"name": "tank/media", "confirm": "tank/media", "recursive": True}).status_code == 200
assert h4[-1] == ["zfs-destroy-dataset", "tank/media", "recursive"], h4
assert c.post("/api/v1/zfs/pools/tank/scrub").status_code == 200 and h4[-1] == ["zpool-scrub", "tank"]

# Shares: dataset-backed share + Samba options.
settings.samba_conf = __import__("pathlib").Path(tmp).parent / f"smb4-{os.getpid()}.conf"
r = c.post("/api/shares", json={"name": "tm", "dataset": "tank/timemachine", "create_dataset": True, "timemachine": True,
                                "recycle_bin": True, "browseable": False})
assert r.status_code == 200, r.text
assert h4[-2:] == [["zfs-create", "tank/timemachine"], ["storage-map", "tank/timemachine"]], h4
sj = r.json()
assert sj["path"] == "/tank/timemachine" and sj["timemachine"] and sj["recycle_bin"] and not sj["browseable"], sj
conf = settings.samba_conf.read_text()
assert "vfs objects = catia fruit streams_xattr recycle" in conf and "fruit:time machine = yes" in conf, conf
assert c.post("/api/shares", json={"name": "x", "dataset": "tank", "create_dataset": True}).status_code == 422
assert c.post("/api/shares", json={"name": "x"}).status_code == 422  # neither path nor dataset
settings.samba_conf.unlink()
# ---------------- Phase 5 ----------------

from urllib.parse import parse_qs  # noqa: E402

import pyotp  # noqa: E402

from app import auth, backups, provisioning, system_extra  # noqa: E402

p5, h5 = [], []
UPID = "UPID:pve:1:2:3:x:1:root@pam:"
FAKE5 = {
    "/storage/local/content": [
        {"volid": "local:iso/debian.iso", "content": "iso", "format": "iso", "size": 7, "ctime": 2},
        {"volid": "local:vztmpl/deb.tar.zst", "content": "vztmpl", "size": 3, "ctime": 3},
        {"volid": "local:backup/vzdump-lxc-100-2026_01_01-00_00_00.tar.zst", "content": "backup", "vmid": 100, "ctime": 9},
        {"volid": "local:100/vm-100-disk-0.raw", "content": "images", "ctime": 1}],
    "/storage": [{"storage": "local", "active": 1}, {"storage": "nas", "active": 0}],
    "/qemu": [{"vmid": 101, "name": "web", "status": "running", "tags": "prod"}],
    "/lxc": [{"vmid": 100, "name": "dns", "status": "stopped"}],
    "/disks/zfs": [{"name": "tank", "health": "ONLINE"}],
    "/hardware/pci": [{"id": "0000:01:00.0", "class": "0x030000", "iommugroup": 14, "vendor_name": "NVIDIA", "device_name": "RTX"},
                      {"id": "0000:00:1f.3", "class": "0x040300", "iommugroup": 9}],
    "/cluster/nextid": "105",
    "/cluster/backup": [{"id": "backup-abc", "schedule": "sun 01:00", "storage": "local", "all": 1, "enabled": "1",
                         "prune-backups": "keep-last=3"}],
}


def handler6(req: httpx.Request) -> httpx.Response:
    path = req.url.path.split("/api2/json", 1)[1].replace("/nodes/pve", "")
    p5.append((req.method, path, req.content.decode()))
    if req.method == "GET" and path.startswith("/tasks/"):
        return httpx.Response(200, json={"data": {"status": "stopped", "exitstatus": "OK"}})
    return httpx.Response(200, json={"data": FAKE5.get(path, UPID) if req.method == "GET" else UPID})


async def fake_run5(args, stdin=None, on_line=None, timeout=120):
    h5.append(args)
    return "tank/media\tfilesystem\t1\t1\t1\t/tank/media\tlz4\t128K\t0\toff\t-"


host.run = fake_run5
pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler6), base_url="https://pve/api2/json")
form = lambda: {k: v[0] for k, v in parse_qs(p5[-1][2]).items()}  # noqa: E731

sc = c.get("/api/v1/storage/local/content").json()
assert [v["content"] for v in sc] == ["backup", "vztmpl", "iso"] and sc[0]["vmid"] == 100, sc  # images dropped, newest first
assert c.get("/api/v1/storage/Bad;x/content").status_code == 422
assert c.post("/api/v1/storage/local/download-url", json={"url": "https://x.org/a/debian-12.iso"}).status_code == 200
assert form() == {"url": "https://x.org/a/debian-12.iso", "content": "iso", "filename": "debian-12.iso", "verify-certificates": "1"}, form()
assert c.post("/api/v1/storage/local/download-url", json={"url": "file:///etc/passwd.iso"}).status_code == 422
assert c.post("/api/v1/storage/local/download-url", json={"url": "https://x.org/download"}).status_code == 422
assert c.post("/api/v1/storage/local/download-url", json={"url": "https://x.org/a.iso", "filename": "../a.iso"}).status_code == 422
assert c.delete("/api/v1/storage/local/content", params={"volume": "local:iso/debian.iso"}).status_code == 200
assert p5[-1][0] == "DELETE" and p5[-1][1].startswith("/storage/local/content/local"), p5[-1]
assert c.delete("/api/v1/storage/local/content", params={"volume": "other:iso/x.iso"}).status_code == 400
assert c.delete("/api/v1/storage/local/content", params={"volume": "local:100/vm-100-disk-0.raw"}).status_code == 422
from fastapi import HTTPException  # noqa: E402

from app import host_ssh  # noqa: E402

ssh5 = []


async def fake_ssh5(cmd, **kw):
    ssh5.append(cmd)
    if cmd.startswith("lspci"):
        raise HTTPException(503, "no bridge")  # /hardware/pci falls back to the PVE-only list
    return ""


host_ssh.run = fake_ssh5
pci = c.get("/api/v1/hardware/pci").json()
assert [d["gpu"] for d in pci] == [False, True] and pci[1]["iommugroup"] == 14, pci
assert c.get("/api/v1/nextid").json() == {"vmid": 105}

vm = {"vmid": 105, "name": "win", "storage": "local-zfs", "bios": "ovmf", "ostype": "win11", "iso_volume": "local:iso/w.iso"}
qp = provisioning.qemu_params(provisioning.QemuBody(**vm))
assert qp["efidisk0"].startswith("local-zfs:1,") and qp["tpmstate0"] and qp["machine"] == "q35", qp
assert qp["ide2"] == "local:iso/w.iso,media=cdrom" and qp["tags"] == provisioning.GUEST_TAG, qp
assert "efidisk0" not in provisioning.qemu_params(provisioning.QemuBody(**{**vm, "bios": "seabios", "ostype": "l26"}))
assert c.post("/api/v1/guests/qemu", json={**vm, "iso_volume": "local:iso/a.iso,file=/etc"}).status_code == 422
assert c.post("/api/v1/guests/qemu", json={**vm, "hostpci": [{"id": "01:00.0;rm"}]}).status_code == 422
r = c.post("/api/v1/guests/qemu", json={**vm, "hostpci": [{"id": "0000:01:00.0", "x_vga": True}], "usb": [{"host": "1532:025d"}]})
assert r.status_code == 200 and ssh5[-1] == ("qm set 105 -hostpci0 0000:01:00,pcie=1,rombar=1,x-vga=1 -usb0 host=1532:025d"), (r.text, ssh5)
ct = {"vmid": 106, "hostname": "box", "ostemplate": "local:vztmpl/deb.tar.zst", "storage": "local-zfs", "password": "secret1"}
assert c.post("/api/v1/guests/lxc", json={**ct, "ip_config": {"cidr": "10.0.0.9/24", "gateway": "10.0.0.1"}}).status_code == 200
assert form()["net0"] == "name=eth0,bridge=vmbr0,ip=10.0.0.9/24,gw=10.0.0.1" and form()["features"] == "nesting=1", form()
n = len(h5)
assert c.post("/api/v1/guests/lxc", json={**ct, "bind_dataset": "tank/media"}).status_code == 200
assert h5[n:] == [["guest-bindmount", "106", "tank/media"]], h5
assert c.post("/api/v1/guests/lxc", json={**ct, "password": "1"}).status_code == 422

b = c.get("/api/v1/backups").json()
assert b["storages"] == ["local"] and len(b["archives"]) == 1, b
assert b["archives"][0]["type"] == "lxc" and b["archives"][0]["name"] == "dns", b
assert b["schedules"][0]["keep_last"] == 3 and b["schedules"][0]["enabled"] and b["schedules"][0]["all"], b
assert c.post("/api/v1/backups/run", json={"vmid": "all", "storage": "local"}).status_code == 200
assert p5[-1][1] == "/vzdump" and form() == {"all": "1", "storage": "local", "mode": "snapshot", "compress": "zstd"}, form()
assert c.post("/api/v1/backups/run", json={"vmid": "x", "storage": "local"}).status_code == 422
assert backups.restore_params(backups.RestoreBody(volid="local:backup/vzdump-lxc-100.tar.zst", type="lxc", vmid=120,
                                                  storage="tank", force=True)) == {
    "vmid": 120, "storage": "tank", "ostemplate": "local:backup/vzdump-lxc-100.tar.zst", "restore": 1, "force": 1}
assert c.post("/api/v1/backups/restore", json={"volid": "local:backup/x.vma.zst", "type": "qemu", "vmid": 121, "storage": "tank"}).status_code == 200
assert p5[-1][1] == "/qemu" and form()["archive"] == "local:backup/x.vma.zst" and "force" not in form(), form()
assert c.post("/api/v1/backups/schedules", json={"schedule": "daily 02:00", "storage": "local", "vmids": [100, 101], "keep_last": 5}).status_code == 200
assert p5[-1][1] == "/cluster/backup" and form()["vmid"] == "100,101" and form()["prune-backups"] == "keep-last=5", form()
assert c.post("/api/v1/backups/schedules", json={"schedule": "daily; rm", "storage": "local"}).status_code == 422
assert c.post("/api/v1/backups/schedules", json={"schedule": "daily", "storage": "local", "vmids": []}).status_code == 422
assert c.put("/api/v1/backups/schedules/backup-abc", json={"enabled": False}).status_code == 200 and form() == {"enabled": "0"}
assert c.delete("/api/v1/backups/schedules/backup-abc").status_code == 200 and p5[-1][:2] == ("DELETE", "/cluster/backup/backup-abc")

# Spotlight search.
system_extra._ds_cache = (0.0, [])
res = c.get("/api/search", params={"q": "e"}).json()["results"]
kinds = {r["kind"] for r in res}
assert {"qemu", "dataset", "app", "section"} <= kinds, kinds
assert next(r for r in res if r["kind"] == "qemu")["target"] == {"type": "qemu", "vmid": 101, "name": "web", "status": "running"}
assert next(r for r in res if r["kind"] == "dataset")["target"] == {"path": "/tank/media"}
assert [r["title"] for r in c.get("/api/search", params={"q": "2fa"}).json()["results"]] == ["User & Security"]
assert c.get("/api/search", params={"q": ""}).status_code == 422

# Self-update status works without a git checkout or systemd (dev machine / CI).
st = c.get("/api/system/updates/status").json()
assert {"commit", "tag", "branch", "remote", "running", "update_available", "incoming", "settings"} <= st.keys() and not st["running"], st

# TOTP 2FA: setup -> enable -> login requires a code -> disable.
settings.security_file = __import__("pathlib").Path(tmp).parent / f"security-{os.getpid()}.json"
totp = lambda: pyotp.TOTP(setup["secret"]).now()  # noqa: E731
assert c.get("/api/auth/2fa/status").json() == {"enabled": False}
setup = c.post("/api/auth/2fa/setup").json()
assert setup["qr_svg"].lstrip().startswith("<") and setup["otpauth_uri"].startswith("otpauth://totp/"), setup
assert c.post("/api/auth/2fa/enable", json={"code": "000000"}).status_code == 400
assert c.post("/api/auth/2fa/enable", json={"code": totp()}).json() == {"enabled": True}
assert oct(settings.security_file.stat().st_mode & 0o777) == "0o600"
assert c.post("/api/auth/2fa/setup").status_code == 409
r = anon.post("/api/auth/login", json={"username": "admin", "password": settings.admin_password})
assert r.status_code == 401 and r.json()["detail"] == auth.OTP_REQUIRED, r.text
assert anon.post("/api/auth/login", json={"username": "admin", "password": settings.admin_password, "otp": "123456"}).status_code == 401
assert anon.post("/api/auth/login", json={"username": "admin", "password": "nope", "otp": totp()}).status_code == 401
assert anon.post("/api/auth/login", json={"username": "admin", "password": settings.admin_password, "otp": totp()}).status_code == 200
assert c.post("/api/auth/2fa/disable", json={"code": "000000"}).status_code == 400
assert c.post("/api/auth/2fa/disable", json={"code": totp()}).json() == {"enabled": False}
assert anon.post("/api/auth/login", json={"username": "admin", "password": settings.admin_password}).status_code == 200
settings.security_file.unlink()
print("selfcheck OK")
