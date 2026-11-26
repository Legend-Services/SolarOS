"""Cluster self-check: tokens and signatures, quorum and failover decisions, keepalived / ZFS scripts, preflight
parsing, clustered switch merge and the coordinator side of a join (host bridge mocked). Run: python -m tests.test_cluster"""
import asyncio
import hashlib
import hmac
import json
import os
import shlex
import tempfile
import time
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update(HYPERVISOR_DRIVER="native_ubuntu", STORAGE_ROOT=str(TMP / "storage"), ADMIN_USERNAME="admin",
                  ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32, NODE_NAME="hv1")

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

from app import cluster as c  # noqa: E402
from app import network_switch as ns  # noqa: E402
from providers.native_ubuntu import cluster as nc  # noqa: E402

c.STATE = TMP / "cluster_state.json"
c.DATA = TMP


def raises(status: int, coro_or_fn, *a):
    try:
        r = coro_or_fn if asyncio.iscoroutine(coro_or_fn) else coro_or_fn(*a)
        if asyncio.iscoroutine(r):
            asyncio.run(r)
    except HTTPException as e:
        assert e.status_code == status, (e.status_code, e.detail)
        return e
    raise AssertionError(f"expected HTTP {status}")


# ---------------------------------------------------------------- Signatures & tokens
sig = c.sign("s3cret", "1000.0", "POST", "/api/cluster/peer/heartbeat", b"{}")
assert c.sig_ok("s3cret", "1000.0", "POST", "/api/cluster/peer/heartbeat", b"{}", sig, now=1010)
assert not c.sig_ok("s3cret", "1000.0", "POST", "/api/cluster/peer/heartbeat", b"{}", sig, now=1100)  # stale
assert not c.sig_ok("other", "1000.0", "POST", "/api/cluster/peer/heartbeat", b"{}", sig, now=1010)
assert not c.sig_ok("s3cret", "1000.0", "POST", "/api/cluster/peer/heartbeat", b'{"x":1}', sig, now=1010)
assert not c.sig_ok("s3cret", "nan-ish", "POST", "/p", b"", sig)

tok = c.encode_token({"c": "abc", "u": "http://10.0.0.1", "h": "10.0.0.1", "s": "xyz", "e": time.time() + 60})
assert c.decode_token(tok)["s"] == "xyz" and c.decode_token("  " + tok + "\n")["c"] == "abc"
raises(422, c.decode_token, "nope")
raises(422, c.decode_token, c.TOKEN_PREFIX + "!!!")
raises(410, c.decode_token, c.encode_token({"c": "a", "u": "http://x", "h": "10.0.0.1", "s": "y", "e": 1}))
raises(422, c.decode_token, c.encode_token({"c": "a", "u": "file:///etc", "h": "10.0.0.1", "s": "y", "e": time.time() + 9}))
raises(422, c.decode_token, c.encode_token({"c": "a", "u": "http://x", "h": "x; rm -rf /", "s": "y", "e": time.time() + 9}))

ca, cakey = c.make_ca("lab")
cert, _ = c.issue_cert(ca, cakey, "hv2", "10.0.0.2")
assert len(c.fingerprint(ca).split(":")) == 32 and c.fingerprint(cert) != c.fingerprint(ca)

# ---------------------------------------------------------------- Quorum & HA decisions
assert c.quorum(3, 2, False, False)["quorate"] and not c.quorum(3, 1, False, False)["quorate"]
assert c.quorum(2, 2, False, False)["quorate"] and not c.quorum(2, 1, False, False)["quorate"]  # 2 nodes: no majority
assert c.quorum(2, 1, True, True) == {"quorate": True, "votes": 2, "expected": 3}  # witness breaks the tie
assert not c.quorum(2, 1, True, False)["quorate"]  # the other half holds the witness lease
assert c.quorum(1, 1, False, False)["quorate"]

pol = {"preferred_active_host": "a", "passive_standby_hosts": ["b", "c"]}
assert c.failover_target(pol, {"b", "c"}, set(), "a") == "b"
assert c.failover_target(pol, {"b", "c"}, {"b"}, "a") == "c"  # maintenance hosts are skipped
assert c.failover_target(pol, {"a", "c"}, set(), "b") == "a"  # running on a standby that died: back to preferred
assert c.failover_target(pol, set(), set(), "a") is None
assert c.swap_roles(pol, "b") == {"preferred_active_host": "b", "passive_standby_hosts": ["a", "c"]}
assert c.swap_roles(pol, "c")["passive_standby_hosts"] == ["b", "a"]
assert c.swap_roles(pol, "d")["passive_standby_hosts"] == ["a", "b", "c"]

hosts = {"a": {}, "b": {}, "c": {}}
metrics = {"b": {"mem": 8, "maxmem": 10}, "c": {"mem": 1, "maxmem": 10}}
assert c.drain_target({"host": "a"}, hosts, {"a", "b", "c"}, set(), "a", metrics, None) == "c"  # most free RAM
assert c.drain_target({"host": "a"}, hosts, {"a", "b", "c"}, set(), "a", metrics, {"preferred_active_host": "a",
                                                                                 "passive_standby_hosts": ["b"]}) == "b"
assert c.drain_target({"host": "a"}, hosts, {"a"}, set(), "a", metrics, None) is None

# ---------------------------------------------------------------- keepalived & ZFS replication scripts
vips = [{"id": "v1", "vrid": 51, "address": "192.168.1.50/24", "preferred_host": "b"},
        {"id": "v2", "vrid": 52, "address": "fd00::50/64", "preferred_host": "a"}]
ifs = {"v1": "br0", "v2": "br0.20"}
ka = c.render_keepalived(vips, "b", ["a", "b", "c"], "0123456789abcdef", ifs)
assert ka.startswith("# Managed by SolarOS") and "priority 150" in ka and "192.168.1.50/24 dev br0" in ka
assert "auth_pass 01234567" in ka and ka.count("authentication") == 1  # none for the IPv6 (VRRPv3) instance
ka_a = c.render_keepalived(vips, "a", ["a", "b", "c"], "0123456789abcdef", ifs)
assert "SD_VIP_51" in ka_a and "priority 99" in ka_a and "fd00::50/64 dev br0.20" in ka_a
assert c.render_keepalived(vips, "c", ["a", "b", "c"], "k" * 16, ifs).count("priority 98") == 2

z = c.zfs_sync_script("tank/vm-101-disk-0", "10.0.0.2", guard="! virsh domstate web | grep -qx running")
assert "zfs send -i @\"$last\" tank/vm-101-disk-0@\"$snap\"" in z and "zfs receive -F tank/vm-101-disk-0" in z
assert "root@10.0.0.2" in z and "exit 3" in z and "zfs create -p tank" in z and "head -n -3" in z
# A hostile name stays one word through both shells (local, then the remote one ssh starts).
evil = c.zfs_sync_script("tank/x'; rm -rf /", "10.0.0.2")
line = next(x for x in evil.splitlines() if x.startswith("  zfs send -i"))
remote_cmd = shlex.split(line.split("|", 1)[1])[-1]
assert shlex.split(remote_cmd) == ["zfs", "receive", "-F", "tank/x'; rm -rf /"], remote_cmd
assert shlex.split(nc.copy_disk_script({"kind": "file", "path": "/img/a'b.qcow2"}, {"address": "10.0.0.2"}).split(" && ")[0])[-1] \
    == "mkdir -p /img"

# ---------------------------------------------------------------- Preflight parsing
IP = json.dumps([{"ifname": "br0", "addr_info": [{"family": "inet", "local": "10.0.0.1", "prefixlen": 24,
                                                    "scope": "global"}]},
                 {"ifname": "wlan0", "addr_info": [{"family": "inet", "local": "10.9.0.5", "prefixlen": 24,
                                                      "scope": "global", "dynamic": True}]}])
pre = c.parse_preflight(f"{IP}\n@@\nyes\n@@\ntank\tONLINE\n@@\n/root/.ssh/id_ed25519.pub\nkeygen\n@@\nhv1\n")
assert pre["ready"] and pre["hostname"] == "hv1" and [i["name"] for i in pre["interfaces"]] == ["br0", "wlan0"]
assert pre["interfaces"][1]["dhcp"] and all(x["ok"] for x in pre["checks"])
pre2 = c.parse_preflight(f"{IP}\n@@\nno\n@@\n\n@@\n@@\nhv1\n")
assert not pre2["ready"] and {x["id"] for x in pre2["checks"] if not x["ok"]} == {"ntp", "zfs", "ssh"}
assert c.parse_preflight("garbage")["ready"] is False

# ---------------------------------------------------------------- SolarOS driver helpers
DOM = """<domain type='kvm'><name>web</name><os><nvram>/var/lib/libvirt/qemu/nvram/web_VARS.fd</nvram></os>
<devices><disk type='block' device='disk'><driver name='qemu' type='raw'/><source dev='/dev/zvol/tank/vm-101-disk-0'/>
<target dev='sda' bus='scsi'/></disk><disk type='file' device='disk'><driver name='qemu' type='qcow2'/>
<source file='/var/lib/libvirt/images/vm-101-disk-1.qcow2'/><target dev='sdb' bus='scsi'/></disk>
<disk type='file' device='cdrom'><source file='/var/lib/libvirt/images/vm-101-cloudinit.iso'/><target dev='sdc' bus='sata'/></disk>
<disk type='file' device='cdrom'><target dev='sdd' bus='sata'/></disk></devices></domain>"""
d = nc.disks_of(DOM)
assert [(x["kind"], x["cdrom"]) for x in d] == [("zvol", False), ("file", False), ("file", True)], d
assert "rsync -a --inplace" in nc.copy_disk_script(d[1], {"address": "10.0.0.2"})
assert "zfs receive -F tank/vm-101-disk-0" in nc.copy_disk_script(d[0], {"address": "10.0.0.2"})

# ---------------------------------------------------------------- Clustered switch merge (peer side)
model = {"br0": {**ns.blank("br0", "bridge"), "ports": ["eno1"]}}
vlan_map = {"20": {"name": "IoT", "color": "#111111", "bridge": "br0", "description": "", "host_ipv4_cidr": "10.20.0.2/24",
                   "dhcp_config": {"x": 1}}}
payload = {"bridges": [{"name": "br0", "vlan_aware": True, "mtu": None, "mode": "bridged", "comment": ""},
                       {"name": "br5", "vlan_aware": False, "mtu": 9000, "mode": "nat", "comment": "lab",
                        "address": "10.5.0.1/24"}],
           "vlans": {"20": {"name": "IoT devices", "color": "#222222", "bridge": "br0", "description": "x"},
                     "30": {"name": "Guests", "color": "#333333", "bridge": "br0", "description": ""}}}
ch, vch = ns.merge_cluster_switches(model, vlan_map, payload, r"^br[0-9]{1,4}$")
assert ch and vch and model["br0"]["vlan_aware"] and model["br0"]["ports"] == ["eno1"]  # ports stay per host
assert model["br5"]["mode"] == "nat" and model["br5"]["address"] == "10.5.0.1/24" and model["br5"]["ports"] == []
assert vlan_map["20"]["host_ipv4_cidr"] == "10.20.0.2/24" and vlan_map["20"]["name"] == "IoT devices"  # own IP kept
assert vlan_map["30"]["dhcp_config"] is None
assert ns.merge_cluster_switches(model, vlan_map, payload, r"^br[0-9]{1,4}$") == (False, False)  # idempotent
raises(422, ns.merge_cluster_switches, {}, {}, {"bridges": [{"name": "evil;x", "vlan_aware": False}]}, r"^br[0-9]{1,4}$")

# ---------------------------------------------------------------- Coordinator: create, token, peer join (mocked host)
authorized: list[str] = []


async def fake_preflight():
    return {"ready": True, "checks": [], "interfaces": [{"name": "br0", "address": "10.0.0.1", "dhcp": False}],
            "hostname": "hv1"}


async def fake_pubkey():
    return "ssh-ed25519 AAAAC3NzaCoordinator root@hv1"


async def fake_authorize(add, remove=()):
    authorized.extend(add)


async def fake_summary():
    return {"host": "hv1", "time": time.time(), "metrics": {}, "sync": {},
            "guests": [{"vmid": 100, "name": "web", "type": "qemu", "status": "running"}]}


c.preflight, c.host_pubkey, c.authorize_keys, c.local_summary = fake_preflight, fake_pubkey, fake_authorize, fake_summary

assert c.load()["mode"] == "standalone"
res = asyncio.run(c.create(c.CreateBody(name="lab", interface="br0", api_url="http://10.0.0.1"), "admin"))
st = c.load()
assert res["join_token"].startswith(c.TOKEN_PREFIX) and "<svg" in res["qr_svg"] and res["cluster_ip"] == "10.0.0.1"
assert st["mode"] == "cluster" and st["shared"]["coordinator"] == "hv1" and st["shared"]["rev"] == 1
assert oct(c.STATE.stat().st_mode & 0o777) == "0o600"
raises(409, c.create(c.CreateBody(name="lab", interface="br0", api_url="http://10.0.0.1"), "admin"))
secret = c.decode_token(res["join_token"])["s"]


def request(path: str, body: bytes, headers: dict | None = None, ip: str = "10.0.0.2") -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}
    hdr = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "POST", "path": path, "headers": hdr, "client": (ip, 5555),
                    "query_string": b""}, receive)


join_body = {"cluster_id": st["cluster_id"], "secret": secret, "vmids": [205],
             "host": {"name": "hv2", "address": "10.0.0.2", "ssh_pubkey": "ssh-ed25519 AAAAC3NzaJoiner root@hv2"}}
raises(409, c.peer_join(request("/api/cluster/peer/join", b""), {**join_body, "vmids": [100]}))  # guest ID clash
raises(403, c.peer_join(request("/api/cluster/peer/join", b""), {**join_body, "secret": "wrong"}))
r = asyncio.run(c.peer_join(request("/api/cluster/peer/join", b""), join_body))
mac = r.pop("mac")
assert hmac.compare_digest(mac, hmac.new(secret.encode(), json.dumps(r, sort_keys=True).encode(), hashlib.sha256).hexdigest())
assert r["secret"] == st["secret"] and r["coordinator_ssh_pubkey"].endswith("root@hv1")
assert c.load()["shared"]["hosts"]["hv2"]["api_url"] == "http://10.0.0.2" and authorized[-1].endswith("root@hv2")
raises(403, c.peer_join(request("/api/cluster/peer/join", b""), join_body))  # single use
raises(422, c.put_ha(c.HaBody(preferred_active_host="hv1", passive_standby_hosts=["hv1"]), "qemu", 100))
raises(422, c.put_ha(c.HaBody(preferred_active_host="hv1", passive_standby_hosts=["hv9"]), "qemu", 100))

# Signed peer calls: a valid heartbeat is accepted and marks the host seen; bad signatures are refused.
st = c.load()
body = json.dumps({"host": "hv2", "time": time.time(), "metrics": {}, "guests": [], "sync": {}}).encode()
ts = str(time.time())
good = {"x-cluster-id": st["cluster_id"], "x-cluster-host": "hv2", "x-cluster-ts": ts,
        "x-cluster-sig": c.sign(st["secret"], ts, "POST", "/api/cluster/peer/heartbeat", body)}
hb = asyncio.run(c.peer_heartbeat(request("/api/cluster/peer/heartbeat", body, good)))
assert hb["shared"]["name"] == "lab" and "hv2" in c.online_hosts(c.load())
raises(401, c.peer_heartbeat(request("/api/cluster/peer/heartbeat", body, {**good, "x-cluster-sig": "0" * 64})))
raises(401, c.peer_heartbeat(request("/api/cluster/peer/heartbeat", body + b" ", good)))

# Newer shared state from a peer wins; an older one is ignored.
cur = c.load()
assert c.adopt_shared(cur, {**cur["shared"], "rev": cur["shared"]["rev"] + 1, "writer": "hv2", "name": "lab2"})
assert not c.adopt_shared(cur, {**cur["shared"], "rev": 1, "writer": "zz", "name": "old"}) and cur["shared"]["name"] == "lab2"

# Witness: one lease holder per cluster, pinned key.
k = "a" * 64
assert asyncio.run(c.peer_witness({"cluster_id": "x", "host": "hv1", "key": k}))["granted"]
assert not asyncio.run(c.peer_witness({"cluster_id": "x", "host": "hv2", "key": k}))["granted"]
raises(403, c.peer_witness({"cluster_id": "x", "host": "hv2", "key": "b" * 64}))
c._witness_book["x"]["until"] = 0  # lease expired: the other partition may take it
assert asyncio.run(c.peer_witness({"cluster_id": "x", "host": "hv2", "key": k}))["granted"]

# Unit of a SolarOS adopt: the ID is kept, or a fresh one is given on a clash.
from providers.native_ubuntu import host as nh  # noqa: E402
nh.GUESTS_FILE = TMP / "native_guests.json"
nh.save_guests({100: {"type": "qemu", "name": "other", "tags": ""}})
assert asyncio.run(nc.adopt("qemu", 205, "web", "")) == 205
assert asyncio.run(nc.adopt("qemu", 100, "db", "")) == 101 and nh.load_guests()[101]["name"] == "db"

print("cluster: all checks passed")
