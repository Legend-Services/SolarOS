"""Clustering on Proxmox VE: join backup/merge, migration progress, HA rule + replication calls.
Run: python -m tests.test_proxmox_cluster"""
import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update(STORAGE_ROOT=str(TMP / "s"), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from providers.proxmox import cluster as pc  # noqa: E402

# Migration progress: disk mirroring 30..75 %, then the RAM state up to 90 %.
assert pc.progress("drive-scsi0: transferred 16.0 GiB of 32.0 GiB (50.00%) in 1m", True) == 52.5
assert pc.progress("migration active, transferred 2.0 GiB of 4.0 GiB VM-state, 110 MiB/s", True) == 82.5
assert pc.progress("migration active, transferred 1.0 GiB of 4.0 GiB VM-state, 110 MiB/s", False) == 45
assert pc.progress("starting migration of VM 100 to node 'b'", False) is None
assert pc.schedule(1) == "*/1" and pc.schedule(15) == "*/15" and pc.schedule(60) == "*:00"

js = pc.join_script("10.0.0.1", "10.0.0.2", "solardeck@pve")
assert "pvecm add 10.0.0.1 --use_ssh 1 --link0 10.0.0.2 --force 1" in js and "merge.py" in js
assert js.index("cp /etc/pve/storage.cfg") < js.index("pvecm add") < js.index('python3 "$B/merge.py"')

# The merge keeps the API user/token, root keys and node-only storages after the cluster's /etc/pve replaced ours.
B, PVE = TMP / "backup", TMP / "pve"
(B).mkdir()
(PVE / "priv").mkdir(parents=True)
(B / "user.cfg").write_text("user:root@pam:1:0:::::\nuser:solardeck@pve:1:0::::SolarDeck::\n"
                            "token:solardeck@pve!solardeck:0:0::\nacl:1:/:solardeck@pve:Administrator:\n")
(B / "token.cfg").write_text("solardeck@pve!solardeck 1111-2222\nother@pve!x 3333\n")
(B / "authorized_keys").write_text("ssh-ed25519 AAAA bridge\nssh-rsa BBBB root@b\n")
(B / "storage.cfg").write_text("dir: local\n\tpath /var/lib/vz\n\tcontent iso\n\nzfspool: fast\n\tpool fast/data\n"
                               "\tcontent images\n\tnodes b\n")
(PVE / "user.cfg").write_text("user:root@pam:1:0:::::\nuser:solardeck@pve:1:0::::SolarDeck::\n"
                              "token:solardeck@pve!solardeck:0:0::\nacl:1:/:solardeck@pve:Administrator:\n"
                              "token:solardeck@pve!other:0:0::\n")
(PVE / "priv/token.cfg").write_text("solardeck@pve!other 9999\n")
(PVE / "priv/authorized_keys").write_text("ssh-rsa CCCC root@a\n")
(PVE / "storage.cfg").write_text("dir: local\n\tpath /var/lib/vz\n\tcontent iso,backup\n")
script = TMP / "merge.py"
script.write_text(pc.MERGE_PY.replace("/etc/pve", str(PVE)))
out = subprocess.run([sys.executable, str(script), str(B), "solardeck@pve"], capture_output=True, text=True, check=True)
assert "1 storage definition" in out.stdout, out
assert (PVE / "priv/token.cfg").read_text() == "solardeck@pve!other 9999\nsolardeck@pve!solardeck 1111-2222\n"
assert (PVE / "user.cfg").read_text().count("token:solardeck@pve!solardeck") == 1  # already there: not doubled
assert "ssh-ed25519 AAAA bridge" in (PVE / "priv/authorized_keys").read_text()
st = (PVE / "storage.cfg").read_text()
assert "zfspool: fast" in st and f"\tnodes {os.uname().nodename.split('.')[0]}" in st and "content iso,backup" in st
assert st.count("dir: local") == 1  # the cluster's own definition wins
subprocess.run([sys.executable, str(script), str(B), "solardeck@pve"], check=True, capture_output=True)
assert (PVE / "storage.cfg").read_text() == st  # idempotent

# HA policy -> resource, node-affinity rule and replication jobs (PVE client mocked).
calls: list[tuple] = []
existing = {"/cluster/ha/resources": [], "/cluster/ha/rules": [],
            "/cluster/replication": [{"id": "100-0", "guest": "100", "target": "c", "comment": "solardeck-ha"}]}


async def fake_safe(path, default=None, **kw):
    return existing.get(path, default)


async def fake_pve(method, path, **kw):
    calls.append((method, path, kw.get("data")))


pc._safe, pc.pve = fake_safe, fake_pve
pol = {"preferred_active_host": "a", "passive_standby_hosts": ["b"], "replication_interval_minutes": 5,
       "auto_failback": False, "current_host": "a"}
asyncio.run(pc.apply_ha("qemu", 100, pol, {}))
assert calls[0] == ("POST", "/cluster/ha/resources", {"sid": "vm:100", "max_relocate": 1, "max_restart": 1,
                                                      "state": "started", "failback": 0}), calls
assert calls[1][:2] == ("POST", "/cluster/ha/rules") and calls[1][2]["nodes"] == "a:2,b:1" and \
    calls[1][2]["type"] == "node-affinity" and calls[1][2]["resources"] == "vm:100"
assert calls[2] == ("POST", "/cluster/replication", {"id": "100-1", "type": "local", "target": "b",
                                                     "comment": "solardeck-ha", "schedule": "*/5"}), calls[2]
assert calls[3] == ("DELETE", "/cluster/replication/100-0", None)  # c is no longer part of the policy
calls.clear()
existing["/cluster/ha/resources"] = [{"sid": "ct:101"}]
existing["/cluster/ha/rules"] = [{"rule": "solardeck-101"}]
existing["/cluster/replication"] = [{"id": "101-0", "guest": "101", "target": "b", "comment": "solardeck-ha"}]
asyncio.run(pc.apply_ha("lxc", 101, None, {}))
assert calls == [("DELETE", "/cluster/ha/rules/solardeck-101", None), ("DELETE", "/cluster/ha/resources/ct:101", None),
                 ("DELETE", "/cluster/replication/101-0", None)], calls

print("proxmox cluster: all checks passed")
