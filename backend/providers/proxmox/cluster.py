"""Clustering on Proxmox VE (contract: app.cluster).

Membership, quorum and failover are Proxmox VE's own (Corosync, pmxcfs, ha-manager with fencing), so NATIVE_HA is
False: SolarOS writes the HA resource, a node-affinity rule (preferred node priority 2, standbys 1) and storage
replication jobs (pvesr) per policy, and only observes and reports what the HA stack does.

Joining a node that already has guests needs `pvecm add --force`, and the join replaces the node's /etc/pve with the
cluster's. The join job therefore backs up the node's guest configs, storage.cfg, the SolarOS API user / token and the
root authorized_keys first and merges them back once the node is quorate (guest IDs were checked for clashes before).
"""
import asyncio
import re
import shlex
import time

from fastapi import HTTPException

from app import cluster as c
from app import host_ssh

from .api import _safe, pve, pve_settings

NATIVE_HA = False
BACKUP = "/var/lib/solardeck/cluster-join-backup"
COMMENT = "solardeck-ha"
UNITS = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "TiB": 2**40}

MERGE_PY = r"""
import os, re, sys
B, user = sys.argv[1], sys.argv[2]
def read(p):
    try:
        return open(p).read()
    except OSError:
        return ""
def merge(path, lines):
    cur = read(path)
    have = set(cur.splitlines())
    add = [l for l in lines if l.strip() and l not in have]
    if add:
        open(path, "w").write(cur.rstrip("\n") + "\n" + "\n".join(add) + "\n")
old = read(B + "/user.cfg").splitlines()
merge("/etc/pve/user.cfg", [l for l in old if l.startswith(("user:" + user + ":", "token:" + user + "!"))]
      + [l for l in old if l.startswith("acl:") and user in l])
merge("/etc/pve/priv/token.cfg", [l for l in read(B + "/token.cfg").splitlines() if l.startswith(user + "!")])
merge("/etc/pve/priv/authorized_keys", read(B + "/authorized_keys").splitlines())
def blocks(t):
    out, cur = {}, None
    for l in t.splitlines():
        m = re.match(r"^(\w+):\s*(\S+)", l)
        if m:
            cur = m.group(2)
            out[cur] = [l]
        elif cur and l.strip():
            out[cur].append(l)
    return out
node = os.uname().nodename.split(".")[0]
have = blocks(read("/etc/pve/storage.cfg"))
add = ["\n".join([l for l in b if not l.strip().startswith("nodes ")] + ["\tnodes " + node])
       for sid, b in blocks(read(B + "/storage.cfg")).items() if sid not in have]
if add:
    text = read("/etc/pve/storage.cfg").rstrip("\n") + "\n\n" + "\n\n".join(add) + "\n"  # read before "w" truncates
    open("/etc/pve/storage.cfg", "w").write(text)
print("merged: %d storage definition(s) kept for %s" % (len(add), node))
"""


def join_script(coordinator: str, link: str, user: str) -> str:
    q = shlex.quote
    return f"""set -e
B={BACKUP}; N=$(hostname -s)
rm -rf "$B"; mkdir -p "$B"
for d in qemu-server lxc; do cp -a /etc/pve/nodes/$N/$d "$B/" 2>/dev/null || mkdir -p "$B/$d"; done
cp /etc/pve/storage.cfg /etc/pve/user.cfg "$B/"
cp /etc/pve/priv/token.cfg /etc/pve/priv/authorized_keys "$B/" 2>/dev/null || true
echo "Backed up $(ls "$B"/qemu-server "$B"/lxc | grep -c '\\.conf$') guest config(s) to $B"
cat > "$B/merge.py" <<'PYEOF'
{MERGE_PY}
PYEOF
echo '@@stage cluster 1@@'
ssh-keyscan -T 5 {q(coordinator)} >> /root/.ssh/known_hosts 2>/dev/null || true
pvecm add {q(coordinator)} --use_ssh 1 --link0 {q(link)} --force 1
for i in $(seq 90); do pvecm status 2>/dev/null | grep -q 'Quorate:.*Yes' && [ -d /etc/pve/nodes/$N ] && break; sleep 2; done
for d in qemu-server lxc; do
  mkdir -p /etc/pve/nodes/$N/$d
  for f in "$B/$d"/*.conf; do [ -e "$f" ] || continue; t=/etc/pve/nodes/$N/$d/$(basename "$f"); [ -e "$t" ] || cp "$f" "$t"; done
done
python3 "$B/merge.py" "$B" {q(user)}
systemctl restart pveproxy pvedaemon
echo '@@stage cluster 2@@'
echo "Joined; guests restored: $(ls /etc/pve/nodes/$N/qemu-server /etc/pve/nodes/$N/lxc | grep -c '\\.conf$')"
"""


LEAVE_SCRIPT = """set -e
N=$(hostname -s)
systemctl stop pve-cluster corosync
pmxcfs -l
rm -f /etc/pve/corosync.conf
rm -rf /etc/corosync/*
killall pmxcfs
systemctl start pve-cluster
for d in /etc/pve/nodes/*; do [ "$(basename "$d")" = "$N" ] || rm -rf "$d"; done
echo "Left the cluster; this node is standalone again"
"""


async def host_job(name: str, script: str, log) -> None:
    """Run a script as a detached host job (survives the cluster stack restarting) and stream its log."""
    await host_ssh.start_job(name, script)
    shown = 0
    while True:
        await asyncio.sleep(2)
        st = await host_ssh.job_status(name)
        lines = [x for x in st["log"] if not x.startswith("@@stage")]
        for x in lines[shown:]:
            log(x)
        shown = len(lines)
        if not st["running"]:
            if st["exit_code"] != 0:
                raise HTTPException(502, next((x for x in reversed(lines) if x.strip()), "failed"))
            return


async def create(name: str, addr: str, log) -> None:
    log(await host_ssh.run(f"pvecm create {shlex.quote(name)} --link0 {shlex.quote(addr)}", timeout=180))


async def join(info: dict, log) -> None:
    user = pve_settings.token_id.split("!")[0] or "solardeck@pve"
    await host_job("cluster-join", join_script(info["coordinator_address"], info["link_address"], user), log)


async def leave(me: dict, peers: list[dict], log) -> None:
    await host_job("cluster-leave", LEAVE_SCRIPT, log)
    rest = [p for p in peers if p["name"] != me["name"]]
    for p in rest:
        try:  # any remaining node can remove this one; a lone survivor first lowers its expected votes
            await c.on(p, f"{'pvecm expected 1; ' if len(rest) == 1 else ''}pvecm delnode {shlex.quote(me['name'])}; "
                          f"rm -rf /etc/pve/nodes/{shlex.quote(me['name'])}", timeout=120)
            log(f"Removed {me['name']} from the cluster on {p['name']}")
            return
        except HTTPException as e:
            log(f"{p['name']}: {e.detail}")


async def members() -> dict | None:
    rows = await _safe("/cluster/status", [])
    cl = next((r for r in rows if r.get("type") == "cluster"), None)
    if not cl:
        return None
    return {"quorate": bool(cl.get("quorate")), "name": cl.get("name"),
            "nodes": {r["name"]: {"online": bool(r.get("online")), "address": r.get("ip")}
                      for r in rows if r.get("type") == "node"}}


async def inventory() -> list[dict] | None:
    rows = await _safe("/cluster/resources", None, params={"type": "vm"})
    if rows is None:
        return None
    return [{"vmid": int(r["vmid"]), "name": r.get("name") or str(r["vmid"]), "type": r["type"], "status": r.get("status"),
             "host": r["node"], "cpu": r.get("cpu", 0), "maxcpu": r.get("maxcpu", 0), "mem": r.get("mem", 0),
             "maxmem": r.get("maxmem", 0), "uptime": r.get("uptime", 0), "tags": r.get("tags", "")}
            for r in rows if r.get("type") in ("qemu", "lxc") and not r.get("template")]


async def host_metrics() -> dict | None:
    nodes = await _safe("/cluster/resources", [], params={"type": "node"})
    out = {n["node"]: {"cpu": n.get("cpu", 0), "maxcpu": n.get("maxcpu", 0), "mem": n.get("mem", 0),
                       "maxmem": n.get("maxmem", 0)} for n in nodes}

    async def zfs(n: str):
        pools = await _safe(f"/nodes/{n}/disks/zfs", None)
        if pools:
            out[n]["zfs"] = "ONLINE" if all(p.get("health") == "ONLINE" for p in pools) else "DEGRADED"
    await asyncio.gather(*(zfs(n["node"]) for n in nodes if n.get("status") == "online"))
    return out


async def sync_status() -> dict | None:
    nodes = [n["node"] for n in await _safe("/cluster/resources", [], params={"type": "node"}) if n.get("status") == "online"]
    kinds = {r["vmid"]: r["type"] for r in await inventory() or []}
    out: dict = {}
    for jobs in await asyncio.gather(*(_safe(f"/nodes/{n}/replication", []) for n in nodes)):
        for j in jobs:
            k = c.key_of(kinds.get(int(j["guest"]), "qemu"), j["guest"])
            out.setdefault(k, {})[j["target"]] = {"at": j.get("last_sync") or 0, "ok": not j.get("fail_count"),
                                                  "error": j.get("error")}
    return out


def size_of(v: str, unit: str) -> float:
    return float(v) * UNITS.get(unit, 1)


def progress(line: str, had_disk: bool) -> float | None:
    """Overall 30..90 % of a migration from one task-log line (disk mirroring first, then the RAM state)."""
    m = re.search(r"\((\d+(?:\.\d+)?)%\)", line)
    if m and "VM-state" not in line:
        return 30 + 45 * float(m.group(1)) / 100
    m = re.search(r"transferred ([\d.]+) (B|KiB|MiB|GiB|TiB) of ([\d.]+) (B|KiB|MiB|GiB|TiB)", line)
    if m:
        ratio = min(1.0, size_of(m.group(1), m.group(2)) / max(1.0, size_of(m.group(3), m.group(4))))
        base, span = ((75, 15) if had_disk else (30, 60)) if "VM-state" in line else (30, 45)
        return base + span * ratio
    return None


async def follow(node: str, upid: str, job: dict) -> None:
    start, had_disk = 0, False
    while True:
        await asyncio.sleep(1.5)
        lines = await _safe(f"/nodes/{node}/tasks/{upid}/log", [], params={"start": start, "limit": 500})
        for ln in lines:
            t = ln.get("t", "")
            job["logs"].append(t)
            had_disk = had_disk or "drive-" in t
            p = progress(t, had_disk)
            if p is not None:
                c.stage(job, 2, max(p, job["percent"] or 0))
        start += len(lines)
        st = await _safe(f"/nodes/{node}/tasks/{upid}/status", {})
        if st.get("status") == "stopped":
            if st.get("exitstatus") != "OK":
                raise HTTPException(502, f"Migration failed: {st.get('exitstatus')}")
            return


async def migrate(kind: str, vmid: int, name: str, src: dict, dst: dict, online: bool, job: dict) -> None:
    sid = f"{'vm' if kind == 'qemu' else 'ct'}:{vmid}"
    t0 = time.time()
    c.stage(job, 1)
    if any(r.get("sid") == sid for r in await _safe("/cluster/ha/resources", [])):
        await pve("POST", f"/cluster/ha/resources/{sid}/migrate", data={"node": dst["name"]})
        job["logs"].append(f"HA stack asked to move {sid} to {dst['name']}")
        upid = None
        for _ in range(40):  # the HA manager starts the migration task on the source node shortly after
            await asyncio.sleep(1.5)
            tasks = await _safe(f"/nodes/{src['name']}/tasks", [], params={"vmid": vmid, "limit": 5})
            upid = next((t["upid"] for t in tasks if t.get("type") in ("qmigrate", "vzmigrate")
                         and t.get("starttime", 0) >= t0 - 2), None)
            if upid:
                break
        if not upid:
            raise HTTPException(504, "The HA stack did not start the migration")
    else:
        cur = await _safe(f"/nodes/{src['name']}/{kind}/{vmid}/status/current", {})
        running = cur.get("status") == "running"
        data: dict = {"target": dst["name"]}
        if kind == "qemu":
            data.update({"online": 1 if running and online else 0, "with-local-disks": 1})
        elif running:
            data["restart"] = 1
        upid = await pve("POST", f"/nodes/{src['name']}/{kind}/{vmid}/migrate", data=data)
    c.stage(job, 2, 30)
    await follow(src["name"], upid, job)
    c.stage(job, 3)


def schedule(minutes: int) -> str:
    return "*:00" if minutes >= 60 else f"*/{minutes}"


async def apply_ha(kind: str, vmid: int, policy: dict | None, hosts: dict) -> None:
    sid, rule = f"{'vm' if kind == 'qemu' else 'ct'}:{vmid}", f"solardeck-{vmid}"
    resources, rules, repl = await asyncio.gather(_safe("/cluster/ha/resources", []), _safe("/cluster/ha/rules", []),
                                                  _safe("/cluster/replication", []))
    has_res = any(r.get("sid") == sid for r in resources)
    has_rule = any(r.get("rule") == rule for r in rules)
    ours = [j for j in repl if int(j.get("guest", 0)) == vmid and j.get("comment") == COMMENT]
    if policy is None:
        if has_rule:
            await pve("DELETE", f"/cluster/ha/rules/{rule}")
        if has_res:
            await pve("DELETE", f"/cluster/ha/resources/{sid}")
        for j in ours:
            await pve("DELETE", f"/cluster/replication/{j['id']}")
        return
    nodes = ",".join([f"{policy['preferred_active_host']}:2", *(f"{h}:1" for h in policy["passive_standby_hosts"])])
    res = {"state": "started", "failback": 1 if policy["auto_failback"] else 0}
    if has_res:
        await pve("PUT", f"/cluster/ha/resources/{sid}", data=res)
    else:
        await pve("POST", "/cluster/ha/resources", data={"sid": sid, "max_relocate": 1, "max_restart": 1, **res})
    r = {"type": "node-affinity", "nodes": nodes, "resources": sid, "strict": 0}
    if has_rule:
        await pve("PUT", f"/cluster/ha/rules/{rule}", data=r)
    else:
        await pve("POST", "/cluster/ha/rules", data={"rule": rule, "comment": "SolarOS high availability", **r})
    targets = [h for h in [policy["preferred_active_host"], *policy["passive_standby_hosts"]]
               if h != policy.get("current_host")]
    taken = {j["id"] for j in repl}
    for t in targets:
        j = next((j for j in repl if int(j.get("guest", 0)) == vmid and j.get("target") == t), None)
        if j:
            await pve("PUT", f"/cluster/replication/{j['id']}", data={"schedule": schedule(policy["replication_interval_minutes"])})
        else:
            jid = next(f"{vmid}-{i}" for i in range(100) if f"{vmid}-{i}" not in taken)
            taken.add(jid)
            await pve("POST", "/cluster/replication", data={"id": jid, "type": "local", "target": t, "comment": COMMENT,
                                                            "schedule": schedule(policy["replication_interval_minutes"])})
    for j in ours:
        if j.get("target") not in targets and j.get("target") != policy.get("current_host"):
            await pve("DELETE", f"/cluster/replication/{j['id']}")


async def maintenance(host: str, enabled: bool) -> None:
    await host_ssh.run(f"ha-manager crm-command node-maintenance {'enable' if enabled else 'disable'} {shlex.quote(host)}",
                       check=False)


async def witness(address: str | None, hosts: list[dict], log) -> None:
    if address is None:
        await host_ssh.run("pvecm qdevice remove", timeout=120)
        return
    ok, _, _ = await host_ssh.run_host_cmd(f"{c.SSH} root@{shlex.quote(address)} true", timeout=15)
    if not ok:
        raise HTTPException(409, f"This host cannot reach root@{address} over SSH. Install corosync-qnetd on the witness "
                                 f"and authorize this key there: {await c.host_pubkey()}")
    for h in hosts:
        log(f"Installing corosync-qdevice on {h['name']}")
        await c.on(h, "command -v corosync-qdevice >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q "
                      "corosync-qdevice", timeout=600)
    await host_ssh.run(f"pvecm qdevice setup {shlex.quote(address)} --force 1", timeout=600, on_line=log)


async def adopt(kind: str, vmid: int, name: str, tags: str) -> int:
    return vmid  # guest configs are cluster-wide


async def local_guest_state(kind: str, name: str) -> str | None:
    return None


async def _platform_ha(*_a, **_k):
    raise HTTPException(501, "Failover is handled by the cluster's own HA stack on this platform")


replicate = promote = fence = demote = _platform_ha
