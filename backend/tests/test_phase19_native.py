"""Phase 19 self-check: the standalone driver against recorded host command output (no libvirt/Incus/ZFS needed).
Run: python -m tests.test_phase19_native (from backend/)."""
import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update(HYPERVISOR_DRIVER="native_ubuntu", STORAGE_ROOT=str(TMP / "storage"), ADMIN_USERNAME="admin",
                  ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32, PVE_BRIDGE="br0", PVE_NODE="hv1")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from providers.native_ubuntu import host, provider as nat, rbac, routes  # noqa: E402

host.GUESTS_FILE = TMP / "native_guests.json"
rbac.FILE = TMP / "local_rbac.json"
nat.SCHEDULES_FILE = TMP / "native_backup_jobs.json"
nat.PROC, nat.SYS_NET = TMP / "proc", TMP / "net"
host.NVRAM, host.IMAGES = TMP / "nvram", TMP / "images"
(TMP / "proc/spl/kstat/zfs").mkdir(parents=True)
(TMP / "proc/stat").write_text("cpu  100 0 100 800 0 0 0 0 0 0\n")
(TMP / "proc/meminfo").write_text("MemTotal: 8000 kB\nMemAvailable: 6000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
(TMP / "proc/loadavg").write_text("0.50 0.40 0.30 1/100 1\n")
(TMP / "proc/uptime").write_text("3600.5 100\n")
(TMP / "proc/cpuinfo").write_text("processor : 0\nmodel name : Test CPU\nphysical id : 0\ncore id : 0\n\n")
(TMP / "proc/spl/kstat/zfs/arcstats").write_text("size 4 1048576\n")

DOMXML = """<domain type='kvm'><name>web</name><uuid>u1</uuid><description>hello</description>
<memory unit='KiB'>4194304</memory><vcpu placement='static'>4</vcpu>
<os><type>hvm</type><nvram>/var/lib/libvirt/qemu/nvram/web_VARS.fd</nvram></os>
<cpu><topology sockets='1' dies='1' cores='4' threads='1'/></cpu>
<devices><disk type='block' device='disk'><driver name='qemu' type='raw'/><source dev='/dev/zvol/tank/vm-101-disk-0'/>
<target dev='sda' bus='scsi'/></disk><interface type='bridge'><mac address='52:54:00:aa:bb:cc'/><source bridge='br0'/>
</interface></devices></domain>"""
INCUS = [{"name": "dns", "type": "container", "status": "Running", "last_used_at": "2026-11-24T10:00:00Z",
          "expanded_config": {"limits.cpu": "2", "limits.memory": "1024MiB"},
          "expanded_devices": {"root": {"size": "8GiB", "pool": "default"},
                               "eth0": {"type": "nic", "parent": "br0"}},
          "state": {"cpu": {"usage": 5_000_000_000}, "memory": {"usage": 300_000_000},
                    "disk": {"root": {"usage": 1_000_000_000}},
                    "network": {"eth0": {"hwaddr": "00:16:3e:00:00:01", "counters": {"bytes_received": 10, "bytes_sent": 20},
                                         "addresses": [{"family": "inet", "address": "192.168.1.50", "scope": "global"}]}}}}]
OUT = {
    ("virsh", "domstats"): "Domain: 'web'\n  state.state=1\n  cpu.time=1000000000\n  balloon.current=4194304\n"
                           "  balloon.maximum=4194304\n  vcpu.current=4\n  vcpu.maximum=4\n  net.0.rx.bytes=100\n"
                           "  net.0.tx.bytes=200\n  block.0.capacity=34359738368\n  block.0.allocation=1073741824\n",
    ("incus", "query"): json.dumps(INCUS),
    ("virsh", "dumpxml"): DOMXML,
    ("virsh", "dominfo"): "Name: web\nAutostart:      enable\n",
    ("virsh", "domblkinfo"): "Capacity:       34359738368\nAllocation: 1\n",
    ("zpool", "list"): "tank\t1000\t400\t600\t3%\t1.00x\tONLINE\n",
    ("zpool", "status"): (Path(__file__).parent / "fixtures/zpool_status.txt").read_text(),
    ("incus", "storage"): json.dumps([{"name": "tank", "driver": "zfs"}]),
    ("lsblk",): json.dumps({"blockdevices": []}),
    ("zfs", "list"): "tank\n",
    ("virsh", "vncdisplay"): "127.0.0.1:3\n",
}
calls: list[tuple] = []


async def fake_run(*argv, input=None, stdin_path=None, stdout_path=None, timeout=120, check=True, log=None):
    calls.append((argv, input))
    for n in (2, 1):
        if argv[:n] in OUT:
            return OUT[argv[:n]]
    if argv[0] in ("ip",):
        raise HTTPException(503, "missing")
    return ""


async def fake_ok(*argv, timeout=30):
    try:
        return await fake_run(*argv)
    except HTTPException:
        return None


async def fake_json(*argv, timeout=60):
    return json.loads(await fake_run(*argv) or "null")


for mod in (nat, routes, host):
    for name, fn in (("run", fake_run), ("ok", fake_ok), ("run_json", fake_json)):
        if hasattr(mod, name):
            setattr(mod, name, fn)


def wait(c, upid):
    for _ in range(50):
        s = c.get(f"/api/v1/tasks/{upid}/status").json()
        if not s["running"]:
            return s
        time.sleep(0.05)
    raise AssertionError("job did not finish")


c = TestClient(app)
assert c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).status_code == 200
assert c.get("/api/v1/system/capabilities").json()["platform_label"] == "SolarDeck Hypervisor"

# Guests: libvirt domain + Incus container get stable VMIDs, persisted in the registry.
g = c.get("/api/v1/guests").json()
assert [(x["vmid"], x["type"], x["name"], x["status"]) for x in g] == [(100, "qemu", "web", "running"),
                                                                       (101, "lxc", "dns", "running")], g
assert g[0]["maxmem"] == 4 * 2**30 and g[0]["maxdisk"] == 32 * 2**30 and g[1]["maxmem"] == 2**30 and g[1]["maxcpu"] == 2
assert c.get("/api/v1/guests").json()[0]["vmid"] == 100  # stable across calls
o = c.get("/api/v1/overview").json()
assert o["vms"] == {"running": 1, "stopped": 0, "total": 1} and o["containers"]["total"] == 1 and o["memory"] == {"used": 2048000, "total": 8192000, "free": 6144000, "arc": 1048576}

cfg = c.get("/api/v1/guests/qemu/100/config").json()
assert cfg["cores"] == 4 and cfg["memory"] == 4096 and cfg["onboot"] and cfg["disks"][0]["key"] == "scsi0", cfg
assert cfg["disks"][0]["size"] == "32G"
assert c.patch("/api/v1/guests/qemu/100/config", json={"cores": 6, "memory": 8192}).json()["ok"]
redefined = host.parse_domain(next(i for a, i in reversed(calls) if a[:2] == ("virsh", "define")))
assert (redefined["vcpus"], redefined["cores"], redefined["sockets"]) == (6, 6, 1)
assert (("virsh", "setmaxmem", "web", "8192M", "--config"), None) in calls

# Power actions run as jobs visible in the Task Center.
r = c.post("/api/v1/guests/lxc/101/action", json={"action": "stop"}).json()
assert wait(c, r["task"])["state"] == "ok" and (("incus", "stop", "--force", "dns"), None) in calls
assert any(t["upid"] == r["task"] for t in c.get("/api/v1/tasks").json())

# VM creation: ZVOL disk, OVMF, VNC on localhost, bridge mapped from vmbr0 to br0, GPU passthrough.
(TMP / "storage/isos").mkdir(parents=True)
(TMP / "storage/isos/ubuntu.iso").write_bytes(b"iso")
r = c.post("/api/v1/guests/qemu", json={"vmid": 120, "name": "gpu-vm", "storage": "tank", "disk_gb": 40,
                                         "iso_volume": "local:iso/ubuntu.iso", "hostpci": [{"id": "01:00.0"}],
                                         "usb": [{"host": "046d:c52b"}]})
assert r.status_code == 200, r.text
s = wait(c, r.json()["upid"])
assert s["state"] == "ok", c.get(f"/api/v1/tasks/{r.json()['upid']}/log").json()
xml = next(i for a, i in calls if a[:2] == ("virsh", "define") and "gpu-vm" in i)
for needle in ("OVMF_CODE_4M.fd", "<source dev=\"/dev/zvol/tank/vm-120-disk-0\"", "listen=\"127.0.0.1\"",
               "<source bridge=\"br0\"", "bus=\"0x01\"", "function=\"0x1\"", "id=\"0x046d\"", "ubuntu.iso"):
    assert needle in xml, needle
assert host.load_guests()[120]["name"] == "gpu-vm"
assert any(a[:4] == ("zfs", "create", "-s", "-V") for a, _ in calls)

# Storage: ZFS pools + targets; Proxmox-only routes are a clear 501.
st = c.get("/api/v1/storage").json()
assert st["zfs_available"] and st["pools"][0]["name"] == "tank"
assert {t["storage"] for t in st["targets"]} >= {"local", "images", "tank"}
assert c.get("/api/v1/storage-config").status_code == 501
tm = c.get("/api/v1/storage/images/content", params={"content": "vztmpl"}).json()
assert "images:vztmpl/debian/12" in [v["volid"] for v in tm]
assert c.get("/api/v1/storage/local/content", params={"content": "iso"}).json()[0]["volid"] == "local:iso/ubuntu.iso"

# Consoles: VNC on the libvirt display port; container terminal through incus exec.
assert c.post("/api/v1/guests/qemu/100/vnc").json()["session"]
assert c.post("/api/v1/guests/lxc/101/terminal").json()["session"]

# Local RBAC.
assert c.post("/api/v1/access/groups", json={"groupid": "ops"}).json() == {"ok": True}
assert c.post("/api/v1/access/users", json={"userid": "ann@solardeck", "password": "secret123", "groups": ["ops"]}).json()["ok"]
assert c.get("/api/v1/access/groups").json()[0]["users"] == "ann@solardeck"
assert c.post("/api/v1/access/acl", json={"path": "/vms/100", "roleid": "VMUser", "type": "user",
                                          "ugid": "ann@solardeck"}).json()["ok"]
assert c.get("/api/v1/access/acl").json()[0]["roleid"] == "VMUser"
assert "password" not in json.dumps(c.get("/api/v1/access/users").json())
assert rbac.verify_password("secret123", rbac.load()["users"]["ann@solardeck"]["password"])
assert c.put("/api/v1/access/roles/Administrator", json={"privs": []}).status_code == 403

# Pure helpers.
assert nat.zpool_layout("raid10", ["a", "b", "c", "d"]) == ["mirror", "a", "b", "mirror", "c", "d"]
assert nat.zpool_layout("raidz2", ["a", "b"]) == ["raidz2", "a", "b"]
assert host.size_bytes("2048MiB") == 2**31 and host.size_bytes("+10G") == 10 * 2**30
assert host.reconcile({5: {"type": "qemu", "name": "a"}}, [("qemu", "a"), ("lxc", "b")]) == \
    {5: {"type": "qemu", "name": "a"}, 100: {"type": "lxc", "name": "b", "tags": ""}}
assert host.reconcile({5: {"type": "qemu", "name": "a"}}, []) == {}
assert nat.parse_calendar_next("  Next elapse: Wed 2026-11-25 03:00:00 CET\n     (in UTC): Wed 2026-11-25 02:00:00 UTC\n") \
    == 1795572000
assert routes.parse_apt_upgradable("Listing...\nbash/noble-updates 5.2-2ubuntu1 amd64 [upgradable from: 5.2-2]\n") == \
    [{"Package": "bash", "Origin": "noble-updates", "Version": "5.2-2ubuntu1", "OldVersion": "5.2-2", "Title": "",
      "Priority": "", "Section": ""}]
srcs = routes.parse_sources({"/etc/apt/sources.list.d/ubuntu.sources":
                             "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\n"
                             "Components: main universe\n", "/etc/apt/sources.list": "# deb http://x/y noble main\n"})
assert [(r["enabled"], r["suites"]) for r in srcs] == [(False, ["noble"]), (True, ["noble", "noble-updates"])]
addrs = [{"ifname": "enp1s0", "flags": ["UP"], "master": "br0", "addr_info": []},
         {"ifname": "br0", "flags": ["UP"], "linkinfo": {"info_kind": "bridge"},
          "addr_info": [{"family": "inet", "local": "192.168.1.10", "prefixlen": 24}]},
         {"ifname": "vnet0", "flags": ["UP"], "linkinfo": {"info_kind": "tun"}, "addr_info": []}]
net = nat.parse_ip_addr(addrs, {"br0": "192.168.1.1"}, {"br0": "static"})
assert [(n["iface"], n["type"]) for n in net] == [("br0", "bridge"), ("enp1s0", "eth")]
assert net[0]["bridge_ports"] == "enp1s0" and net[0]["cidr"] == "192.168.1.10/24" and net[0]["gateway"] == "192.168.1.1"
rules = nat.parse_nft_rules({"nftables": [{"rule": {"chain": "input", "expr": [
    {"match": {"left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 22}}, {"accept": None}]}}]})
assert rules[0]["dport"] == "22" and rules[0]["action"] == "ACCEPT" and rules[0]["type"] == "in"
bk = TMP / "bk"
bk.mkdir()
for d in ("01", "02", "03"):
    (bk / f"solardeck-qemu-100-2026_11_{d}-03_00_00.tar.zst").touch()
(bk / "solardeck-lxc-100-2026_11_01-03_00_00.tar.zst").touch()
assert nat.prune(bk, "qemu", 100, 2) == ["solardeck-qemu-100-2026_11_01-03_00_00.tar.zst"]
assert len(list(bk.iterdir())) == 3
tree = nat.zpool_tree([{"name": "tank", "state": "ONLINE", "depth": 0, "read": 0, "write": 0, "cksum": 0, "msg": ""},
                       {"name": "mirror-0", "state": "ONLINE", "depth": 1, "read": 0, "write": 0, "cksum": 0, "msg": ""},
                       {"name": "/dev/sda", "state": "ONLINE", "depth": 2, "read": 0, "write": 0, "cksum": 0, "msg": ""}],
                      "tank")
assert tree[0]["children"][0]["children"][0]["name"] == "/dev/sda"
from app import updater  # noqa: E402
assert updater.edition() == {"driver": "native_ubuntu", "edition": "SolarDeck Standalone Hypervisor",
                             "service": "solardeck-backend", "supports_system_packages": True}
asyncio.run(asyncio.sleep(0))
print("phase 19 native driver self-check OK")
