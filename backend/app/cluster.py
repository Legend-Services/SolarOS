"""Multi-host clustering, live migration, active/passive high availability and floating cluster VIPs.

Every host runs its own backend. Cluster state lives in data/cluster_state.json (mode 600): the local identity and
secrets, plus a replicated `shared` part (hosts, HA policies, VIPs, clustered virtual switches, witness) that every
heartbeat carries; a host adopts a peer's copy when its (rev, writer) is newer. A fresh install is standalone.

Joining: the coordinator issues a single-use join token (base64 JSON: coordinator URL and address, a random secret,
the cluster CA fingerprint, expiry). The joining backend posts its host's root SSH key to /api/cluster/peer/join with
the token secret; the coordinator authorizes the key on its host and answers with the cluster secret, HMAC-signed with
the token secret. After that, peer calls are signed with the cluster secret (X-Cluster-* headers, 30 s window), and
every host authorizes every member's root key, so any backend can orchestrate migrations and replication over SSH.

Platform work is the active driver's (get_provider().cluster_driver()); the module documents the contract:
  NATIVE_HA                          True when this backend runs failover itself (else the platform's HA stack does)
  create(name, addr, log)            turn this standalone host into a one-host cluster
  join(info, log)                    join the coordinator's cluster (info: coordinator, coordinator_address, link_address)
  leave(me, peers, log)              leave the cluster and become standalone again
  members() -> dict | None           {"quorate", "nodes": {name: {"online", "address"}}} from the platform, or None
  inventory() -> list | None         every guest of the cluster with its "host", or None (built from heartbeats)
  host_metrics() -> dict | None      {host: {cpu, maxcpu, mem, maxmem, zfs}} from the platform, or None
  sync_status() -> dict | None       {"qemu:100": {target: {at, ok, error}}} from the platform, or None
  migrate(kind, vmid, name, src, dst, online, job)    move a guest (hosts are host records); updates job progress
  apply_ha(kind, vmid, policy, hosts)                 write or (policy None) remove the platform's HA config
  replicate(kind, vmid, name, dst, log) / promote(kind, vmid, name, host) / fence(kind, vmid, name)
  demote(kind, vmid, name) / adopt(kind, vmid, name, tags) -> vmid / local_guest_state(kind, name) -> str | None
  maintenance(host, enabled) / witness(address | None, hosts, log)   (None removes the witness)
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import shlex
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path as FsPath
from typing import Literal

import httpx
import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field, field_validator

from . import audit_log, host_ssh
from .auth import client_ip, require_step_up_auth, require_user
from .config import settings
from providers.registry import get_provider

router = APIRouter(prefix="/api/cluster", tags=["cluster"], dependencies=[Depends(require_user)])
peer = APIRouter(prefix="/api/cluster/peer", tags=["cluster-peer"])  # signed with the cluster secret, no session
log = logging.getLogger(__name__)

DATA = FsPath(__file__).resolve().parent.parent / "data"
STATE = DATA / "cluster_state.json"
HEARTBEAT_S = 3
OFFLINE_AFTER = 7  # seconds without a heartbeat before a host counts as offline
FAILBACK_STABLE_S = 60
WITNESS_LEASE_S = 15
TOKEN_PREFIX = "SDJ1."
SIG_WINDOW = 30
HA_DIR = f"/var/lib/{settings.system_prefix}/ha"
SSH = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5"
NAME_RE = r"^[A-Za-z][A-Za-z0-9-]{0,14}$"
HOST_RE = r"^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$"
GUEST_TYPE = Literal["qemu", "lxc"]
_lock = asyncio.Lock()
_BOOT = time.time()
BOOT_GRACE_S = 30  # no failover decisions right after a backend start, before every peer had a chance to answer


# ---------------------------------------------------------------- State


def blank_shared() -> dict:
    return {"rev": 0, "writer": "", "name": "", "coordinator": "", "hosts": {}, "ha_policies": {}, "vips": [],
            "clustered_switches": [], "witness": None}


def load() -> dict:
    try:
        st = json.loads(STATE.read_text())
    except (OSError, ValueError):
        st = {}
    st.setdefault("mode", "standalone")
    st.setdefault("shared", blank_shared())
    st["self"] = settings.node_name
    return st


def save(st: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.touch(mode=0o600)
    tmp.write_text(json.dumps(st, indent=1))
    tmp.replace(STATE)


def bump(st: dict) -> None:
    """Mark the shared part changed here, so peers adopt it with their next heartbeat."""
    st["shared"]["rev"] += 1
    st["shared"]["writer"] = st["self"]


def newer(a: dict, b: dict) -> bool:
    """Is shared state `a` newer than `b`? Ties on rev go to the writer that sorts last, so every host agrees."""
    return (a.get("rev", 0), a.get("writer", "")) > (b.get("rev", 0), b.get("writer", ""))


def in_cluster(st: dict) -> bool:
    return st["mode"] == "cluster"


def driver():
    d = get_provider().cluster_driver()
    if d is None:
        raise get_provider().not_available()
    return d


# ---------------------------------------------------------------- Signing, tokens & certificates (pure)


def sign(secret: str, ts: str, method: str, path: str, body: bytes) -> str:
    return hmac.new(secret.encode(), f"{ts}\n{method}\n{path}\n".encode() + body, hashlib.sha256).hexdigest()


def sig_ok(secret: str, ts: str, method: str, path: str, body: bytes, sig: str, now: float | None = None) -> bool:
    try:
        fresh = abs((now or time.time()) - float(ts)) <= SIG_WINDOW
    except ValueError:
        return False
    return fresh and hmac.compare_digest(sign(secret, ts, method, path, body), sig or "")


def encode_token(d: dict) -> str:
    return TOKEN_PREFIX + base64.urlsafe_b64encode(json.dumps(d, separators=(",", ":")).encode()).decode().rstrip("=")


def decode_token(token: str) -> dict:
    t = token.strip()
    if not t.startswith(TOKEN_PREFIX):
        raise HTTPException(422, "This is not a cluster join token")
    raw = t[len(TOKEN_PREFIX):]
    try:
        d = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        assert all(k in d for k in ("c", "u", "h", "s", "e"))
    except (ValueError, AssertionError):
        raise HTTPException(422, "The join token is damaged; copy it again")
    if not str(d["u"]).startswith(("http://", "https://")):
        raise HTTPException(422, "The join token has an invalid coordinator address")
    try:
        ipaddress.ip_address(d["h"])
    except ValueError:
        raise HTTPException(422, "The join token has an invalid coordinator address")
    if d["e"] < time.time():
        raise HTTPException(410, "The join token has expired; create a new one on the cluster")
    return d


def make_ca(name: str) -> tuple[str, str]:
    """Self-signed cluster CA (EC P-256, 10 years): (cert PEM, key PEM)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"SolarOS Cluster CA {name}")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .sign(key, hashes.SHA256()))
    return (cert.public_bytes(serialization.Encoding.PEM).decode(),
            key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()).decode())


def issue_cert(ca_cert: str, ca_key: str, host: str, address: str) -> tuple[str, str]:
    """Host certificate signed by the cluster CA (client + server auth, 5 years): (cert PEM, key PEM)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    ca = x509.load_pem_x509_certificate(ca_cert.encode())
    cakey = serialization.load_pem_private_key(ca_key.encode(), None)
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    alt: list = [x509.DNSName(host)]
    try:
        alt.append(x509.IPAddress(ipaddress.ip_address(address)))
    except ValueError:
        pass
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1825))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH, ExtendedKeyUsageOID.CLIENT_AUTH]),
                           critical=False)
            .sign(cakey, hashes.SHA256()))
    return (cert.public_bytes(serialization.Encoding.PEM).decode(),
            key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()).decode())


def fingerprint(pem: str) -> str:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    return x509.load_pem_x509_certificate(pem.encode()).fingerprint(hashes.SHA256()).hex(":").upper()


# ---------------------------------------------------------------- Quorum & HA decisions (pure)


def quorum(total: int, online: int, witness: bool, lease: bool) -> dict:
    """Majority of votes: one per host plus the witness vote, which only the partition holding its lease gets."""
    expected = total + (1 if witness else 0)
    votes = online + (1 if witness and lease else 0)
    return {"quorate": votes * 2 > expected, "votes": votes, "expected": expected}


def failover_target(policy: dict, online: set[str], maintenance: set[str], lost: str) -> str | None:
    """The healthy host a workload moves to when `lost` fails: the preferred host first, then the standbys in order."""
    for h in [policy["preferred_active_host"], *policy["passive_standby_hosts"]]:
        if h != lost and h in online and h not in maintenance:
            return h
    return None


def swap_roles(policy: dict, new_active: str) -> dict:
    """Policy after a switchover to `new_active`: it becomes preferred, the old preferred takes its standby slot."""
    old = policy["preferred_active_host"]
    standbys = [old if h == new_active else h for h in policy["passive_standby_hosts"]]
    if new_active not in policy["passive_standby_hosts"]:
        standbys = [old, *[h for h in standbys if h != new_active]]
    return {**policy, "preferred_active_host": new_active, "passive_standby_hosts": standbys}


def drain_target(guest: dict, hosts: dict[str, dict], online: set[str], maintenance: set[str], me: str,
                 metrics: dict[str, dict], policy: dict | None) -> str | None:
    """Where a guest goes when its host is drained: its HA standby if healthy, else the online host with most free RAM."""
    src = guest["host"]
    ok = [h for h in hosts if h != src and h in online and h not in maintenance]
    if policy:
        t = next((h for h in [policy["preferred_active_host"], *policy["passive_standby_hosts"]] if h in ok), None)
        if t:
            return t

    def free(h: str) -> float:
        m = metrics.get(h, {})
        return (m.get("maxmem") or 0) - (m.get("mem") or 0)
    return max(ok, key=free, default=None)


def render_keepalived(vips: list[dict], me: str, hosts: list[str], auth: str, ifaces: dict[str, str]) -> str:
    """keepalived.conf for host `me`: one VRRP instance per VIP; the VIP's preferred host gets the highest priority."""
    out = [f"# Managed by SolarOS cluster floating VIPs. Changes here are overwritten.",
           f"global_defs {{\n  router_id sd-{me}\n  enable_script_security\n}}"]
    for v in vips:
        iface = ifaces[v["id"]]
        order = [v["preferred_host"], *sorted(h for h in hosts if h != v["preferred_host"])]
        prio = 150 if me == v["preferred_host"] else max(10, 100 - order.index(me)) if me in order else 50
        v6 = ":" in v["address"]
        block = [f"vrrp_instance SD_VIP_{v['vrid']} {{", "  state BACKUP", f"  interface {iface}",
                 f"  virtual_router_id {v['vrid']}", f"  priority {prio}", "  advert_int 1"]
        if not v6:  # VRRPv3 (IPv6) has no authentication
            block.append(f"  authentication {{\n    auth_type PASS\n    auth_pass {auth[:8]}\n  }}")
        block += [f"  virtual_ipaddress {{\n    {v['address']} dev {iface}\n  }}", "}"]
        out.append("\n".join(block))
    return "\n\n".join(out) + "\n"


def zfs_sync_script(ds: str, addr: str, guard: str = "", keep: int = 3) -> str:
    """Bash (run on the active host) that snapshots `ds` and sends it to the same dataset on `addr`: incremental from
    the newest snapshot both sides share, else a full stream. `guard` runs first on the target and aborts on failure."""
    q = shlex.quote(ds)

    def remote(cmd: str) -> str:  # the whole remote command is one quoted word, so nothing in it reaches this shell
        return f"{SSH} root@{shlex.quote(addr)} {shlex.quote(cmd)}"
    parent = shlex.quote(ds.rsplit("/", 1)[0]) if "/" in ds else ""
    prune = f"zfs list -H -t snapshot -o name -s creation {q} | grep '@sdha-' | head -n -{keep} | xargs -r -n1 zfs destroy"
    return f"""set -eo pipefail
{f"{remote(guard)} || {{ echo '!! the workload is running on the standby; not overwriting it'; exit 3; }}" if guard else ""}
snap="sdha-$(date +%s)"
zfs snapshot {q}@"$snap"
last=""
for s in $({remote(f"zfs list -H -t snapshot -o name -s creation {q} 2>/dev/null")} | sed 's/.*@//' | grep '^sdha-' || true); do
  zfs list -H {q}@"$s" >/dev/null 2>&1 && last="$s"
done
if [ -n "$last" ]; then
  zfs send -i @"$last" {q}@"$snap" | {remote(f"zfs receive -F {q}")}
else
  {remote((f"zfs create -p {parent} 2>/dev/null; " if parent else "") + f"zfs destroy -r {q} 2>/dev/null; true")}
  zfs send {q}@"$snap" | {remote(f"zfs receive -F {q}")}
fi
{prune}
{remote(prune)}
echo synced {q} '->' {shlex.quote(addr)}
"""


def parse_preflight(out: str) -> dict:
    parts = (out.split("@@\n") + [""] * 5)[:5]
    try:
        addrs = json.loads(parts[0] or "[]")
    except ValueError:
        addrs = []
    ifaces = []
    for i in addrs:
        for a in i.get("addr_info", []):
            if a.get("family") == "inet" and a.get("scope") == "global":
                ifaces.append({"name": i["ifname"], "address": a["local"], "prefix": a.get("prefixlen"),
                               "dhcp": bool(a.get("dynamic"))})
    ntp = parts[1].strip() == "yes"
    pools = [ln.split("\t") for ln in parts[2].splitlines() if "\t" in ln]
    healthy = [p[0] for p in pools if p[1] == "ONLINE"]
    keyinfo = parts[3].split()
    ssh_ok = bool(keyinfo)
    checks = [
        {"id": "network", "ok": bool(ifaces), "required": True,
         "detail": ("DHCP address — a static address or DHCP reservation is recommended"
                    if ifaces and all(i["dhcp"] for i in ifaces) else
                    f"{ifaces[0]['address']} on {ifaces[0]['name']}" if ifaces else "No IPv4 address on this host")},
        {"id": "ntp", "ok": ntp, "required": True,
         "detail": "Clock synchronized" if ntp else "The clock is not synchronized (enable NTP / time sync)"},
        {"id": "zfs", "ok": bool(healthy), "required": False,
         "detail": f"Healthy pool(s): {', '.join(healthy)}" if healthy else
                   "No healthy ZFS pool: live migration works, replication-based failover needs ZFS"},
        {"id": "ssh", "ok": ssh_ok, "required": True,
         "detail": "Host SSH key and cluster certificates ready" if ssh_ok else "ssh-keygen is missing on the host"},
    ]
    return {"ready": all(c["ok"] for c in checks if c["required"]), "checks": checks, "interfaces": ifaces,
            "hostname": parts[4].strip()}


# ---------------------------------------------------------------- Host commands


PREFLIGHT = r"""ip -j -4 addr show scope global 2>/dev/null; echo @@
timedatectl show -p NTPSynchronized --value 2>/dev/null; echo @@
zpool list -H -o name,health 2>/dev/null; echo @@
for k in /root/.ssh/id_ed25519.pub /root/.ssh/id_rsa.pub; do [ -f $k ] && { echo $k; break; }; done
command -v ssh-keygen >/dev/null && echo keygen; echo @@
hostname -s
"""


async def on(host: dict | str, cmd: str, timeout: float = 600, on_line=None, check: bool = True) -> str:
    """Run a shell command as root on a cluster host: locally over the host bridge, else hop over SSH from here."""
    h = host if isinstance(host, dict) else load()["shared"]["hosts"].get(host, {"name": host, "address": host})
    if h["name"] == settings.node_name:
        return await host_ssh.run(cmd, timeout=timeout, on_line=on_line, check=check)
    return await host_ssh.run(f"{SSH} root@{shlex.quote(h['address'])} {shlex.quote(cmd)}", timeout=timeout,
                              on_line=on_line, check=check)


async def host_pubkey() -> str:
    """The host's root SSH public key (created on first use)."""
    return (await host_ssh.run("[ -f /root/.ssh/id_ed25519.pub ] || [ -f /root/.ssh/id_rsa.pub ] || "
                               "ssh-keygen -q -t ed25519 -N '' -f /root/.ssh/id_ed25519; "
                               "cat /root/.ssh/id_ed25519.pub 2>/dev/null || cat /root/.ssh/id_rsa.pub")).strip()


async def authorize_keys(add: list[str], remove: list[str] = ()) -> None:
    """Add / remove root SSH keys on this host (authorized_keys may be a symlink; it is edited in place)."""
    keys = [k.strip() for k in add if re.fullmatch(r"(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+) [A-Za-z0-9+/=]+( \S+)?",
                                                   k.strip())]
    script = "f=/root/.ssh/authorized_keys; mkdir -p /root/.ssh; touch \"$f\"\n"
    for k in remove:
        body = k.split()[1] if len(k.split()) > 1 else ""
        if re.fullmatch(r"[A-Za-z0-9+/=]+", body):
            script += f"grep -v -F {shlex.quote(body)} \"$f\" > \"$f.sd\" || true; cat \"$f.sd\" > \"$f\"; rm -f \"$f.sd\"\n"
    for k in keys:
        script += f"grep -qF {shlex.quote(k.split()[1])} \"$f\" || echo {shlex.quote(k)} >> \"$f\"\n"
    await host_ssh.run(script)


async def preflight() -> dict:
    ok, out, err = await host_ssh.run_host_cmd(PREFLIGHT, timeout=15)
    if not ok and not out:
        return {"ready": False, "checks": [{"id": "ssh", "ok": False, "required": True, "detail": err[:200]}],
                "interfaces": [], "hostname": settings.node_name}
    return parse_preflight(out)


# ---------------------------------------------------------------- Runtime (heartbeats, metrics, jobs)

_seen: dict[str, float] = {}        # host -> last heartbeat
_info: dict[str, dict] = {}         # host -> its last summary (metrics, guests, sync)
_online_since: dict[str, float] = {}
_quorum: dict = {"quorate": True, "votes": 1, "expected": 1}
_lost_quorum_at: float | None = None
_lease = {"holder": False, "checked": 0.0}
_platform: dict = {"members": None, "at": 0.0}
_alerted: dict[str, str] = {}       # host -> "online"|"offline" last alerted
_sync: dict[str, dict] = {}         # "qemu:100" -> {target: {at, ok, error}} for workloads this host replicates
_replicating: set[str] = set()
_summary: dict = {"at": 0.0}
_witness_book: dict[str, dict] = {}  # this host acting as witness: cluster id -> {key, holder, until}
_jobs: dict[str, dict] = {}
_bg: set[asyncio.Task] = set()


def spawn(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return t


def new_job(kind: str, subject: str, key: str = "") -> dict:
    jid = f"cluster-{secrets.token_hex(6)}"
    job = {"id": jid, "kind": kind, "subject": subject, "key": key, "status": "running", "stage": 0,
           "percent": None, "logs": [], "error": None, "started": time.time()}
    _jobs[jid] = job
    for old in sorted(_jobs, key=lambda k: _jobs[k]["started"])[:-100]:
        _jobs.pop(old, None)
    return job


def stage(job: dict, index: int, percent: float | None = None) -> None:
    job["stage"], job["percent"] = index, percent


def job_running(key: str) -> bool:
    return any(j["key"] == key and j["status"] == "running" for j in _jobs.values())


def run_job(job: dict, coro) -> None:
    async def wrap():
        try:
            await coro
            job["status"] = "completed"
        except Exception as e:  # noqa: BLE001 - surfaced in the progress card
            job["status"] = "failed"
            job["error"] = str(e.detail if isinstance(e, HTTPException) else e)[:400] or type(e).__name__
            job["logs"].append(f"!! {job['error']}")
            log.warning("cluster job %s failed: %s", job["id"], job["error"])
    spawn(wrap())


async def local_summary() -> dict:
    """This host's heartbeat summary: metrics, guests (cached 10 s) and the replication status it owns."""
    now = time.time()
    if now - _summary["at"] > 10:
        p = get_provider()
        try:
            m = await p.get_node_metrics()
            metrics = {"cpu": m.cpu, "maxcpu": int(m.cpuinfo.get("cpus") or m.cpuinfo.get("cores") or 0),
                       "mem": m.memory.get("used", 0), "maxmem": m.memory.get("total", 0)}
        except Exception:  # noqa: BLE001 - a heartbeat must never fail on telemetry
            metrics = {}
        pools = await p.zfs_pool_list()
        metrics["zfs"] = ("DEGRADED" if any(x.get("health") != "ONLINE" for x in pools) else "ONLINE") if pools else None
        guests = [{k: g.get(k) for k in ("vmid", "name", "type", "status", "cpu", "maxcpu", "mem", "maxmem", "uptime",
                                         "tags")} for g in await p.guest_rows()]
        _summary.update(at=now, metrics=metrics, guests=guests)
    return {"host": settings.node_name, "time": now, "metrics": _summary.get("metrics", {}),
            "guests": _summary.get("guests", []), "sync": _sync}


def online_hosts(st: dict) -> set[str]:
    """Hosts that are up: from the platform's membership when it reports one, else from recent heartbeats."""
    hosts = st["shared"]["hosts"]
    mem = _platform["members"]
    if mem:
        return {n for n in hosts if mem["nodes"].get(n, {}).get("online")} | {st["self"]}
    now = time.time()
    return {n for n in hosts if n == st["self"] or now - _seen.get(n, 0) < OFFLINE_AFTER}


def leader(st: dict, online: set[str]) -> bool:
    """One backend acts for the cluster (failover, alerts): the online host with a backend whose name sorts first."""
    able = sorted(n for n in online if n == st["self"] or st["shared"]["hosts"].get(n, {}).get("api_url"))
    return bool(able) and able[0] == st["self"] and _quorum["quorate"]


async def inventory(st: dict) -> list[dict]:
    """Every guest of the cluster with its host."""
    if in_cluster(st):
        rows = await driver().inventory()
        if rows is not None:
            return rows
    me = await local_summary()
    rows = [{**g, "host": st["self"]} for g in me["guests"]]
    if in_cluster(st):
        online = online_hosts(st)
        for n, info in _info.items():
            if n != st["self"] and n in st["shared"]["hosts"] and n in online:
                rows += [{**g, "host": n} for g in info.get("guests", [])]
    return rows


def key_of(kind: str, vmid: int | str) -> str:
    return f"{kind}:{int(vmid)}"


async def find_guest(st: dict, kind: str, vmid: int) -> dict:
    g = next((r for r in await inventory(st) if r["type"] == kind and int(r["vmid"]) == vmid), None)
    if not g:
        raise HTTPException(404, f"{'VM' if kind == 'qemu' else 'Container'} {vmid} was not found on any cluster host")
    return g


# ---------------------------------------------------------------- Peer calls


async def peer_call(st: dict, host: str, path: str, payload: dict, timeout: float = 4) -> dict:
    h = st["shared"]["hosts"].get(host) or {}
    if not h.get("api_url"):
        raise HTTPException(409, f"{host} has no reachable backend")
    body = json.dumps(payload, separators=(",", ":")).encode()
    full = f"/api/cluster/peer{path}"
    ts = str(time.time())
    headers = {"content-type": "application/json", "x-cluster-id": st["cluster_id"], "x-cluster-host": st["self"],
               "x-cluster-ts": ts, "x-cluster-sig": sign(st["secret"], ts, "POST", full, body)}
    try:
        async with httpx.AsyncClient(verify=False, timeout=timeout) as c:  # identity comes from the HMAC, not TLS
            r = await c.post(h["api_url"].rstrip("/") + full, content=body, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"{host} is unreachable: {type(e).__name__}")
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = r.text[:200]
        raise HTTPException(r.status_code if r.status_code < 500 else 502, f"{host}: {detail}")
    return r.json()


async def verified(request: Request) -> tuple[dict, dict]:
    """(state, payload) of a peer request signed with this cluster's secret; 401 otherwise."""
    st = load()
    body = await request.body()
    h = request.headers
    if not in_cluster(st) or h.get("x-cluster-id") != st.get("cluster_id") or not sig_ok(
            st["secret"], h.get("x-cluster-ts", ""), request.method, request.url.path, body, h.get("x-cluster-sig", "")):
        raise HTTPException(401, "Invalid cluster signature")
    try:
        return st, json.loads(body or b"{}")
    except ValueError:
        raise HTTPException(422, "Invalid JSON")


def adopt_shared(st: dict, other: dict | None) -> bool:
    if other and newer(other, st["shared"]):
        st["shared"] = other
        return True
    return False


async def sync_keys(st: dict) -> None:
    """Every member's root key is authorized on this host; keys of hosts that left are removed again."""
    want = [h["ssh_pubkey"] for n, h in st["shared"]["hosts"].items() if h.get("ssh_pubkey") and n != st["self"]]
    gone = [k for k in st.get("authorized_keys", []) if k not in want]
    if set(want) != set(st.get("authorized_keys", [])):
        await authorize_keys(want, gone)
        st["authorized_keys"] = want
        save(st)


# ---------------------------------------------------------------- Background monitor


async def alert(title: str, message: str, severity: str = "warning") -> None:
    from . import automation  # lazy: automation imports heavy modules
    try:
        await automation.dispatch(title, message, severity)
    except Exception as e:  # noqa: BLE001 - an alert channel must never stop the monitor
        log.warning("cluster alert failed: %s", e)


async def heartbeat_round(st: dict) -> None:
    me = await local_summary()
    targets = [n for n, h in st["shared"]["hosts"].items() if n != st["self"] and h.get("api_url")]

    async def one(n: str):
        try:
            r = await peer_call(st, n, "/heartbeat", {**me, "shared": st["shared"]}, timeout=2.5)
        except HTTPException:
            return
        _seen[n] = time.time()
        _info[n] = r
        if adopt_shared(st, r.get("shared")):
            save(st)
    await asyncio.gather(*(one(n) for n in targets))


async def check_witness(st: dict, online: set[str]) -> bool:
    w = st["shared"].get("witness")
    if not w or w.get("type") != "http":
        return False
    try:
        async with httpx.AsyncClient(verify=False, timeout=2.5) as c:
            r = await c.post(w["url"].rstrip("/") + "/api/cluster/peer/witness",
                             json={"cluster_id": st["cluster_id"], "host": st["self"],
                                   "key": hashlib.sha256((st["secret"] + ":witness").encode()).hexdigest()})
        return r.status_code == 200 and r.json().get("granted") is True
    except (httpx.HTTPError, ValueError):
        return False


async def tick() -> None:
    global _quorum, _lost_quorum_at
    st = load()
    if not in_cluster(st):
        return
    d = driver()
    await heartbeat_round(st)
    st = load()
    now = time.time()
    if now - _platform["at"] >= HEARTBEAT_S:
        try:
            _platform["members"] = await d.members()
        except Exception:  # noqa: BLE001 - the platform API may blip while a node rejoins
            pass
        _platform["at"] = now
    hosts = st["shared"]["hosts"]
    online = online_hosts(st)
    for n in hosts:
        if n in online:
            _online_since.setdefault(n, now)
        else:
            _online_since.pop(n, None)
    mem = _platform["members"]
    if mem:
        _quorum = {"quorate": bool(mem["quorate"]), "votes": len(online), "expected": len(hosts)
                   + (1 if st["shared"].get("witness") else 0)}
    else:
        lease = await check_witness(st, online)
        _quorum = quorum(len(hosts), len(online & set(hosts)), bool(st["shared"].get("witness")), lease)
    _lost_quorum_at = None if _quorum["quorate"] else (_lost_quorum_at or now)
    await sync_keys(st)
    lead = leader(st, online)
    if lead:
        for n in hosts:
            state = "online" if n in online else "offline"
            prev = _alerted.get(n)
            if prev and prev != state:
                audit_log.record(f"cluster.host.{state}", user="system", host=n)
                spawn(alert(f"Cluster host {n} is {state}", f"{n} {'rejoined' if state == 'online' else 'stopped answering'}"
                            f" the cluster {st['shared']['name']}.", "info" if state == "online" else "critical"))
            _alerted[n] = state
    if d.NATIVE_HA:
        await native_ha(st, online, lead)
    elif lead:
        await observe_platform_ha(st)


async def observe_platform_ha(st: dict) -> None:
    """Platform-managed HA: follow where each HA workload runs and report moves the platform made on its own."""
    rows = {key_of(r["type"], r["vmid"]): r for r in await inventory(st)}
    changed = False
    for k, p in st["shared"]["ha_policies"].items():
        r = rows.get(k)
        if r and r["host"] != p.get("current_host"):
            prev = p.get("current_host")
            p["current_host"] = r["host"]
            changed = True
            if prev and not job_running(k):
                audit_log.record("cluster.failover", user="system", workload=k, source=prev, target=r["host"])
                spawn(alert(f"Workload {p.get('name') or k} moved to {r['host']}",
                            f"High availability moved {k} from {prev} to {r['host']}.", "critical"))
    if changed:
        bump(st)
        save(st)


async def native_ha(st: dict, online: set[str], lead: bool) -> None:
    d, me, now = driver(), st["self"], time.time()
    hosts, policies = st["shared"]["hosts"], st["shared"]["ha_policies"]
    maint = {n for n, h in hosts.items() if h.get("maintenance")}
    # 1. Self-fencing: without quorum this host stops the HA workloads it runs, so a partition never runs them twice.
    if _lost_quorum_at:
        for k, p in policies.items():
            if p.get("enabled") and p.get("current_host") == me and now - _lost_quorum_at > p["failover_timeout_seconds"]:
                kind, vmid = k.split(":")
                if await d.local_guest_state(kind, p["name"]) == "running":
                    await d.fence(kind, int(vmid), p["name"])
                    audit_log.record("cluster.fence", user="system", workload=k, host=me)
        return
    # 2. Replication of the workloads this host runs to every other host of their policy.
    for k, p in policies.items():
        if not p.get("enabled") or p.get("current_host") != me or k in _replicating or job_running(k):
            continue
        due = [h for h in [p["preferred_active_host"], *p["passive_standby_hosts"]] if h != me and h in online
               and now - _sync.get(k, {}).get(h, {}).get("at", 0) >= p["replication_interval_minutes"] * 60]
        if due:
            _replicating.add(k)
            spawn(replicate(st, k, p, due))
    # 3. Demote stale local copies after a failover moved the workload elsewhere.
    for k, p in policies.items():
        cur = p.get("current_host")
        if p.get("enabled") and cur and cur != me and cur in online and not job_running(k):
            kind, vmid = k.split(":")
            running_there = any(g["type"] == kind and int(g["vmid"]) == int(vmid) and g["status"] == "running"
                                for g in _info.get(cur, {}).get("guests", []))
            if running_there and await d.local_guest_state(kind, p["name"]) not in (None, "running"):
                await d.demote(kind, int(vmid), p["name"])
                audit_log.record("cluster.demote", user="system", workload=k, host=me)
    if not lead:
        return
    # 4. Failover (leader only): the active host has been gone longer than the policy allows.
    for k, p in list(policies.items()):
        cur = p.get("current_host")
        if not p.get("enabled") or not cur or cur in online or job_running(k):
            continue
        gone = now - _seen.get(cur, _BOOT) if cur != me else 0
        if gone < p["failover_timeout_seconds"] or now - _BOOT < BOOT_GRACE_S:
            continue
        target = failover_target(p, online, maint, cur)
        if target:
            job = new_job("failover", f"{p.get('name') or k}: {cur} → {target}", k)
            run_job(job, failover(job, k, cur, target))
    # 5. Auto-failback once the preferred host is back and stable.
    for k, p in policies.items():
        pref = p["preferred_active_host"]
        if (p.get("enabled") and p.get("auto_failback") and p.get("current_host") not in (None, pref) and pref in online
                and pref not in maint and now - _online_since.get(pref, now) >= FAILBACK_STABLE_S
                and p.get("current_host") in online and not job_running(k)):
            kind, vmid = k.split(":")
            job = new_job("migrate", f"{p.get('name') or k}: failback to {pref}", k)
            run_job(job, migration(job, kind, int(vmid), pref, True))


async def replicate(st: dict, key: str, p: dict, targets: list[str]) -> None:
    kind, vmid = key.split(":")
    try:
        for t in targets:
            try:
                await driver().replicate(kind, int(vmid), p["name"], st["shared"]["hosts"][t], lambda _l: None)
                _sync.setdefault(key, {})[t] = {"at": time.time(), "ok": True, "error": None}
            except Exception as e:  # noqa: BLE001 - reported per target in the HA matrix
                prev = _sync.setdefault(key, {}).get(t, {})
                _sync[key][t] = {"at": prev.get("at", 0), "ok": False, "tried": time.time(),
                                 "error": str(getattr(e, "detail", e))[:200]}
    finally:
        _replicating.discard(key)


async def failover(job: dict, key: str, lost: str, target: str) -> None:
    st = load()
    p = st["shared"]["ha_policies"][key]
    kind, vmid = key.split(":")
    d = driver()
    job["logs"].append(f"{lost} has been unreachable for over {p['failover_timeout_seconds']} s; promoting {target}")
    stage(job, 1)
    await d.promote(kind, int(vmid), p["name"], st["shared"]["hosts"][target])
    stage(job, 2)
    await adopt_on(st, target, kind, int(vmid), p["name"])
    st = load()
    st["shared"]["ha_policies"][key].update(current_host=target, last_failover={"at": time.time(), "from": lost,
                                                                                 "to": target})
    bump(st)
    save(st)
    audit_log.record("cluster.failover", user="system", workload=key, source=lost, target=target)
    await alert(f"Failover: {p['name']} now runs on {target}",
                f"{lost} stopped answering; {p['name']} ({key}) was started on {target} from its latest replica.",
                "critical")


async def adopt_on(st: dict, host: str, kind: str, vmid: int, name: str) -> None:
    if host == st["self"]:
        await driver().adopt(kind, vmid, name, "")
    else:
        await peer_call(st, host, "/adopt", {"kind": kind, "vmid": vmid, "name": name}, timeout=20)


async def monitor_loop() -> None:
    """Lifespan task: heartbeats, quorum, replication, failover and failback every HEARTBEAT_S seconds."""
    while True:
        try:
            await tick()
        except Exception:  # noqa: BLE001 - keep monitoring whatever one round hit
            log.exception("cluster monitor round failed")
        await asyncio.sleep(HEARTBEAT_S)


# ---------------------------------------------------------------- Migration


async def migration(job: dict, kind: str, vmid: int, target: str, online: bool) -> None:
    st = load()
    g = await find_guest(st, kind, vmid)
    hosts = st["shared"]["hosts"]
    if target not in hosts:
        raise HTTPException(404, f"{target} is not a cluster host")
    if g["host"] == target:
        raise HTTPException(409, f"{g['name']} already runs on {target}")
    if target not in online_hosts(st):
        raise HTTPException(409, f"{target} is offline")
    job["logs"].append(f"Moving {g['name']} ({kind} {vmid}) from {g['host']} to {target}"
                       f"{' live' if online and g['status'] == 'running' else ''}")
    stage(job, 0)
    await driver().migrate(kind, vmid, g["name"], hosts[g["host"]], hosts[target], online, job)
    if driver().NATIVE_HA:
        stage(job, 3)
        await adopt_on(st, target, kind, vmid, g["name"])
    st = load()
    p = st["shared"]["ha_policies"].get(key_of(kind, vmid))
    if p:
        p["current_host"] = target
        bump(st)
        save(st)
    _summary["at"] = 0
    job["logs"].append(f"{g['name']} now runs on {target}")


# ---------------------------------------------------------------- Views


def host_view(st: dict, online: set[str], metrics: dict[str, dict], rows: list[dict]) -> list[dict]:
    out = []
    for n, h in sorted(st["shared"]["hosts"].items()):
        m = metrics.get(n) or (_summary.get("metrics", {}) if n == st["self"] else _info.get(n, {}).get("metrics", {}))
        out.append({"name": n, "address": h.get("address"), "role": "coordinator" if n == st["shared"]["coordinator"]
                    else "member", "online": n in online, "maintenance": bool(h.get("maintenance")),
                    "local": n == st["self"], "has_backend": bool(h.get("api_url")) or n == st["self"],
                    "cpu": m.get("cpu", 0), "maxcpu": m.get("maxcpu", 0), "mem": m.get("mem", 0),
                    "maxmem": m.get("maxmem", 0), "zfs": m.get("zfs"),
                    "running": sum(1 for r in rows if r["host"] == n and r.get("status") == "running"),
                    "guests": sum(1 for r in rows if r["host"] == n),
                    "clock_skew": round(_info[n]["time"] - _seen[n], 1) if n in _info and n in _seen and
                    "time" in _info[n] else None})
    return out


async def sync_view(st: dict) -> dict:
    platform = await driver().sync_status() if in_cluster(st) else None
    if platform is not None:
        return platform
    merged: dict = {k: dict(v) for k, v in _sync.items()}
    for info in _info.values():
        for k, v in (info.get("sync") or {}).items():
            merged.setdefault(k, {}).update(v)
    return merged


def policy_view(k: str, p: dict, sync: dict, rows: dict) -> dict:
    kind, vmid = k.split(":")
    s = sync.get(k, {})
    last = max((v.get("at") or 0 for v in s.values()), default=0)
    r = rows.get(k)
    return {**p, "guest_type": kind, "guest_id": int(vmid), "key": k, "sync": s, "last_sync": last or None,
            "sync_ok": bool(s) and all(v.get("ok") for v in s.values()),
            "status": r["status"] if r else "unknown", "host": r["host"] if r else p.get("current_host")}


# ---------------------------------------------------------------- Request bodies


class CreateBody(BaseModel):
    name: str = Field(pattern=NAME_RE)
    interface: str = Field(pattern=r"^[A-Za-z0-9_.:-]{1,15}$")
    api_url: str = Field(pattern=r"^https?://[^\s/]+$")


class JoinBody(BaseModel):
    token: str = Field(min_length=20, max_length=4000)


class TokenBody(BaseModel):
    ttl_minutes: int = Field(60, ge=5, le=1440)


class WitnessBody(BaseModel):
    address: str = Field(min_length=3, max_length=200, pattern=r"^[^\s'\"`$\\;|&<>]+$")


class MaintenanceBody(BaseModel):
    enabled: bool


class MigrateBody(BaseModel):
    target_host: str = Field(pattern=HOST_RE)
    online: bool = True
    with_local_disks: bool = True


class HaBody(BaseModel):
    enabled: bool = True
    preferred_active_host: str = Field(pattern=HOST_RE)
    passive_standby_hosts: list[str] = Field(min_length=1, max_length=8)
    replication_interval_minutes: Literal[1, 5, 15, 60] = 5
    failover_timeout_seconds: int = Field(15, ge=10, le=120)
    auto_failback: bool = False

    @field_validator("passive_standby_hosts")
    @classmethod
    def _hosts(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v) or not all(re.fullmatch(HOST_RE, h) for h in v):
            raise ValueError("Standby hosts must be distinct host names")
        return v


class SwitchoverBody(BaseModel):
    target_host: str | None = Field(None, pattern=HOST_RE)


class VipBody(BaseModel):
    address: str = Field(description="IPv4 or IPv6 address in CIDR notation")
    bridge: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,14}$")
    vlan: int | None = Field(None, ge=1, le=4094)
    preferred_host: str = Field(pattern=HOST_RE)
    label: str = Field("", pattern=r"^[^\n\r\"'`$\\<>]{0,40}$")

    @field_validator("address")
    @classmethod
    def _cidr(cls, v: str) -> str:
        if "/" not in v:
            raise ValueError("Use CIDR notation, e.g. 192.168.1.50/24")
        return str(ipaddress.ip_interface(v))


# ---------------------------------------------------------------- Admin routes


@router.get("/status")
async def status():
    st = load()
    caps = get_provider().get_capabilities()
    base = {"mode": st["mode"], "driver": caps.driver, "supported": get_provider().cluster_driver() is not None, "self": st["self"],
            "native_ha": bool(get_provider().cluster_driver() and driver().NATIVE_HA)}
    if not in_cluster(st):
        pre, rows = await asyncio.gather(preflight(), inventory(st))
        return {**base, "ready_to_cluster": pre, "interfaces": pre["interfaces"],
                "hosts": [{"name": st["self"], "address": pre["interfaces"][0]["address"] if pre["interfaces"] else "",
                           "role": "standalone", "online": True, "maintenance": False, "local": True,
                           "has_backend": True, **_summary.get("metrics", {}),
                           "running": sum(1 for r in rows if r.get("status") == "running"), "guests": len(rows)}],
                "workloads": len(rows), "ha_policies": [], "vips": [], "clustered_switches": [], "quorum": None}
    online = online_hosts(st)
    metrics, rows, sync = await asyncio.gather(driver().host_metrics(), inventory(st), sync_view(st))
    by_key = {key_of(r["type"], r["vmid"]): r for r in rows}
    sh = st["shared"]
    return {**base, "cluster": {"name": sh["name"], "id": st["cluster_id"], "coordinator": sh["coordinator"],
                                "fingerprint": st.get("ca_fingerprint"), "created": st.get("created")},
            "quorum": {**_quorum, "witness": sh.get("witness"), "online": len(online & set(sh["hosts"])),
                       "total": len(sh["hosts"])},
            "hosts": host_view(st, online, metrics or {}, rows), "workloads": len(rows),
            "ha_policies": [policy_view(k, p, sync, by_key) for k, p in sorted(sh["ha_policies"].items())],
            "vips": sh["vips"], "clustered_switches": sh["clustered_switches"],
            "interfaces": [], "last_switch_sync": st.get("last_switch_sync")}


@router.get("/workloads")
async def workloads():
    st = load()
    rows = await inventory(st)
    pol = st["shared"]["ha_policies"]
    return {"mode": st["mode"], "self": st["self"],
            "workloads": [{**r, "ha": key_of(r["type"], r["vmid"]) in pol and pol[key_of(r["type"], r["vmid"])]["enabled"]}
                          for r in sorted(rows, key=lambda r: (r["host"], int(r["vmid"])))]}


def new_token(st: dict, ttl_minutes: int) -> dict:
    secret = secrets.token_urlsafe(24)
    exp = time.time() + ttl_minutes * 60
    st["join_tokens"] = [t for t in st.get("join_tokens", []) if t["expires"] > time.time() and not t["used"]][-9:]
    st["join_tokens"].append({"hash": hashlib.sha256(secret.encode()).hexdigest(), "expires": exp, "used": False})
    me = st["shared"]["hosts"][st["self"]]
    token = encode_token({"v": 1, "c": st["cluster_id"], "n": st["shared"]["name"], "u": me["api_url"],
                          "h": me["address"], "x": st["self"], "s": secret, "f": st.get("ca_fingerprint", ""),
                          "e": int(exp)})
    svg = qrcode.make(token, image_factory=qrcode.image.svg.SvgPathImage, border=2).to_string(encoding="unicode")
    return {"join_token": token, "expires": int(exp), "cluster_ip": me["address"], "fingerprint": st.get("ca_fingerprint"),
            "qr_svg": svg}


@router.post("/create")
async def create(body: CreateBody, _: str = Depends(require_step_up_auth)):
    async with _lock:
        st = load()
        if in_cluster(st):
            raise HTTPException(409, "This host is already part of a cluster")
        if get_provider().cluster_driver() is None:
            raise get_provider().not_available()
        pre = await preflight()
        iface = next((i for i in pre["interfaces"] if i["name"] == body.interface), None)
        if not iface:
            raise HTTPException(422, f"{body.interface} has no IPv4 address on this host")
        if not pre["ready"]:
            failed = ", ".join(c["detail"] for c in pre["checks"] if c["required"] and not c["ok"])
            raise HTTPException(409, f"This host is not ready for a cluster: {failed}")
        d = driver()
        steps: list[str] = []
        await d.create(body.name, iface["address"], steps.append)
        ca_cert, ca_key = make_ca(body.name)
        host_cert, host_key = issue_cert(ca_cert, ca_key, st["self"], iface["address"])
        st.update(mode="cluster", cluster_id=secrets.token_hex(8), secret=secrets.token_hex(32), created=int(time.time()),
                  ca_cert=ca_cert, ca_key=ca_key, ca_fingerprint=fingerprint(ca_cert), host_cert=host_cert,
                  host_key=host_key, join_tokens=[], authorized_keys=[])
        st["shared"] = {**blank_shared(), "name": body.name, "coordinator": st["self"],
                        "hosts": {st["self"]: {"name": st["self"], "address": iface["address"], "api_url": body.api_url,
                                               "ssh_pubkey": await host_pubkey(), "joined": int(time.time())}}}
        bump(st)
        tok = new_token(st, 60)
        save(st)
    return {"ok": True, "log": steps, **tok}


@router.post("/token")
async def token(body: TokenBody):
    async with _lock:
        st = load()
        if not in_cluster(st):
            raise HTTPException(409, "Create a cluster first")
        if not st.get("ca_key"):
            raise HTTPException(409, f"Join tokens are issued by the coordinator ({st['shared']['coordinator']})")
        tok = new_token(st, body.ttl_minutes)
        save(st)
    return tok


@router.post("/join")
async def join(body: JoinBody, _: str = Depends(require_step_up_auth)):
    st = load()
    if in_cluster(st):
        raise HTTPException(409, "This host is already part of a cluster; leave it first")
    tok = decode_token(body.token)
    route = await host_ssh.run(f"ip -j route get {shlex.quote(str(ipaddress.ip_address(tok['h'])))}", check=False)
    try:
        addr = json.loads(route)[0]["prefsrc"]
    except (ValueError, KeyError, IndexError):
        raise HTTPException(409, f"This host has no route to the coordinator {tok['h']}")
    rows = await get_provider().guest_rows()
    req = {"cluster_id": tok["c"], "secret": tok["s"],
           "host": {"name": st["self"], "address": addr, "ssh_pubkey": await host_pubkey()},
           "vmids": sorted({int(r["vmid"]) for r in rows})}
    try:
        async with httpx.AsyncClient(verify=False, timeout=30) as c:
            r = await c.post(tok["u"].rstrip("/") + "/api/cluster/peer/join", json=req)
    except httpx.HTTPError as e:
        raise HTTPException(503, f"The coordinator at {tok['u']} is unreachable: {type(e).__name__}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code if r.status_code < 500 else 502, r.json().get("detail", r.text[:200]))
    res = r.json()
    mac = res.pop("mac", "")
    if not hmac.compare_digest(mac, hmac.new(tok["s"].encode(), json.dumps(res, sort_keys=True).encode(),
                                             hashlib.sha256).hexdigest()):
        raise HTTPException(502, "The coordinator's answer failed verification (wrong token or tampered response)")
    if tok.get("f") and fingerprint(res["ca_cert"]) != tok["f"]:
        raise HTTPException(502, "The cluster certificate does not match the token's fingerprint")
    await authorize_keys([res["coordinator_ssh_pubkey"]])
    st.update(mode="cluster", cluster_id=res["cluster_id"], secret=res["secret"], created=res["created"],
              ca_cert=res["ca_cert"], ca_fingerprint=fingerprint(res["ca_cert"]), host_cert=res["host_cert"],
              host_key=res["host_key"], join_tokens=[], authorized_keys=[res["coordinator_ssh_pubkey"]],
              shared=res["shared"])
    save(st)
    job = new_job("cluster", f"Join {res['shared']['name']}")

    async def go():
        stage(job, 1)
        try:
            await driver().join({"coordinator": tok.get("x") or res["shared"]["coordinator"],
                                 "coordinator_address": tok["h"], "link_address": addr}, job["logs"].append)
        except Exception:
            back = load()
            try:
                await peer_call(back, back["shared"]["coordinator"], "/leave", {"host": back["self"]})
            except HTTPException:
                pass
            save({"mode": "standalone", "shared": blank_shared()})
            raise
        stage(job, 2)
        await sync_keys(load())
    run_job(job, go())
    return {"ok": True, "job_id": job["id"], "cluster": res["shared"]["name"]}


@router.post("/leave")
async def leave(_: str = Depends(require_step_up_auth)):
    st = load()
    if not in_cluster(st):
        raise HTTPException(409, "This host is standalone")
    mine = [k for k, p in st["shared"]["ha_policies"].items() if p.get("current_host") == st["self"] and p.get("enabled")]
    if mine:
        raise HTTPException(409, f"Move or disable high availability for {', '.join(mine)} first")
    peers = [h for n, h in st["shared"]["hosts"].items() if n != st["self"]]
    job = new_job("cluster", f"Leave {st['shared']['name']}")

    async def go():
        stage(job, 1)
        await driver().leave(st["shared"]["hosts"][st["self"]], peers, job["logs"].append)
        stage(job, 2)
        for h in peers:
            if h.get("api_url"):
                try:
                    await peer_call(st, h["name"], "/leave", {"host": st["self"]})
                except HTTPException as e:
                    job["logs"].append(f"{h['name']}: {e.detail}")
        await authorize_keys([], st.get("authorized_keys", []))
        save({"mode": "standalone", "shared": blank_shared()})
    run_job(job, go())
    return {"ok": True, "job_id": job["id"]}


@router.post("/witness")
async def set_witness(body: WitnessBody):
    st = load()
    if not in_cluster(st):
        raise HTTPException(409, "Create a cluster first")
    d = driver()
    if d.NATIVE_HA:
        url = body.address if body.address.startswith(("http://", "https://")) else f"http://{body.address}"
        st["shared"]["witness"] = {"type": "http", "url": url.rstrip("/")}
        if not await check_witness(st, online_hosts(st)):
            raise HTTPException(502, f"{url} did not grant a witness vote (is it a reachable SolarOS host?)")
        st = load()
        st["shared"]["witness"] = {"type": "http", "url": url.rstrip("/")}
        bump(st)
        save(st)
        return {"ok": True}
    job = new_job("cluster", f"Quorum witness {body.address}")

    async def go():
        stage(job, 1)
        await d.witness(body.address, list(load()["shared"]["hosts"].values()), job["logs"].append)
        s = load()
        s["shared"]["witness"] = {"type": "qdevice", "address": body.address}
        bump(s)
        save(s)
    run_job(job, go())
    return {"ok": True, "job_id": job["id"], "host_key": await host_pubkey()}


@router.delete("/witness")
async def remove_witness():
    st = load()
    if (st["shared"].get("witness") or {}).get("type") == "qdevice":
        await driver().witness(None, list(st["shared"]["hosts"].values()), lambda _l: None)
    st["shared"]["witness"] = None
    bump(st)
    save(st)
    return {"ok": True}


@router.post("/hosts/{host_id}/maintenance")
async def maintenance(body: MaintenanceBody, host_id: str = Path(pattern=HOST_RE)):
    st = load()
    hosts = st["shared"]["hosts"]
    if host_id not in hosts:
        raise HTTPException(404, f"{host_id} is not a cluster host")
    hosts[host_id]["maintenance"] = body.enabled
    bump(st)
    save(st)
    await driver().maintenance(host_id, body.enabled)
    if not body.enabled:
        return {"ok": True}
    job = new_job("drain", f"Drain {host_id}", f"drain:{host_id}")

    async def go():
        s = load()
        online = online_hosts(s)
        rows = [r for r in await inventory(s) if r["host"] == host_id and r.get("status") == "running"]
        maint = {n for n, h in s["shared"]["hosts"].items() if h.get("maintenance")}
        if not rows:
            job["logs"].append(f"No running workloads on {host_id}")
        for i, g in enumerate(rows):
            stage(job, 0, 100 * i / len(rows))
            pol = s["shared"]["ha_policies"].get(key_of(g["type"], g["vmid"]))
            t = drain_target(g, s["shared"]["hosts"], online, maint, s["self"], _metrics_now(s), pol)
            if not t:
                raise HTTPException(409, f"No healthy host can take {g['name']}")
            sub = new_job("migrate", f"{g['name']}: {host_id} → {t}", key_of(g["type"], g["vmid"]))
            await migration(sub, g["type"], int(g["vmid"]), t, True)
            sub["status"] = "completed"
            job["logs"] += sub["logs"]
    run_job(job, go())
    return {"ok": True, "job_id": job["id"]}


def _metrics_now(st: dict) -> dict[str, dict]:
    out = {n: i.get("metrics", {}) for n, i in _info.items()}
    out[st["self"]] = _summary.get("metrics", {})
    return out


@router.post("/workloads/{guest_type}/{guest_id}/migrate")
async def migrate(body: MigrateBody, guest_type: GUEST_TYPE, guest_id: int = Path(ge=100)):
    st = load()
    if not in_cluster(st):
        raise HTTPException(409, "Live migration needs a cluster")
    k = key_of(guest_type, guest_id)
    if job_running(k):
        raise HTTPException(409, "A migration of this workload is already running")
    g = await find_guest(st, guest_type, guest_id)
    job = new_job("migrate", f"{g['name']}: {g['host']} → {body.target_host}", k)
    run_job(job, migration(job, guest_type, guest_id, body.target_host, body.online))
    return {"ok": True, "job_id": job["id"]}


def _validate_policy(st: dict, b: HaBody) -> None:
    hosts = st["shared"]["hosts"]
    for h in [b.preferred_active_host, *b.passive_standby_hosts]:
        if h not in hosts:
            raise HTTPException(422, f"{h} is not a cluster host")
    if b.preferred_active_host in b.passive_standby_hosts:
        raise HTTPException(422, "The preferred host cannot also be a standby")


@router.get("/ha/{guest_type}/{guest_id}")
async def get_ha(guest_type: GUEST_TYPE, guest_id: int = Path(ge=100)):
    st = load()
    k = key_of(guest_type, guest_id)
    p = st["shared"]["ha_policies"].get(k)
    if not p:
        return {"enabled": False, "key": k}
    rows = {key_of(r["type"], r["vmid"]): r for r in await inventory(st)}
    return policy_view(k, p, await sync_view(st), rows)


@router.put("/ha/{guest_type}/{guest_id}")
async def put_ha(body: HaBody, guest_type: GUEST_TYPE, guest_id: int = Path(ge=100)):
    st = load()
    if not in_cluster(st):
        raise HTTPException(409, "High availability needs a cluster")
    _validate_policy(st, body)
    g = await find_guest(st, guest_type, guest_id)
    k = key_of(guest_type, guest_id)
    pol = {**body.model_dump(), "name": g["name"], "current_host": g["host"], "updated": int(time.time())}
    await driver().apply_ha(guest_type, guest_id, pol if body.enabled else None, st["shared"]["hosts"])
    async with _lock:
        st = load()
        st["shared"]["ha_policies"][k] = {**st["shared"]["ha_policies"].get(k, {}), **pol}
        bump(st)
        save(st)
    return {"ok": True}


@router.delete("/ha/{guest_type}/{guest_id}")
async def delete_ha(guest_type: GUEST_TYPE, guest_id: int = Path(ge=100)):
    st = load()
    k = key_of(guest_type, guest_id)
    if k not in st["shared"]["ha_policies"]:
        raise HTTPException(404, "No high availability policy for this workload")
    await driver().apply_ha(guest_type, guest_id, None, st["shared"]["hosts"])
    async with _lock:
        st = load()
        st["shared"]["ha_policies"].pop(k, None)
        bump(st)
        save(st)
    return {"ok": True}


@router.post("/ha/{guest_type}/{guest_id}/switchover")
async def switchover(body: SwitchoverBody, guest_type: GUEST_TYPE, guest_id: int = Path(ge=100)):
    st = load()
    k = key_of(guest_type, guest_id)
    p = st["shared"]["ha_policies"].get(k)
    if not p or not p.get("enabled"):
        raise HTTPException(404, "Enable high availability for this workload first")
    online = online_hosts(st)
    maint = {n for n, h in st["shared"]["hosts"].items() if h.get("maintenance")}
    g = await find_guest(st, guest_type, guest_id)
    target = body.target_host or next((h for h in [p["preferred_active_host"], *p["passive_standby_hosts"]]
                                       if h != g["host"] and h in online and h not in maint), None)
    if not target or target == g["host"]:
        raise HTTPException(409, "No healthy standby host to switch over to")
    if job_running(k):
        raise HTTPException(409, "A migration of this workload is already running")
    job = new_job("migrate", f"{g['name']}: switchover {g['host']} → {target}", k)

    async def go():
        await migration(job, guest_type, guest_id, target, True)
        s = load()
        cur = s["shared"]["ha_policies"][k]
        new = swap_roles(cur, target) if target != cur["preferred_active_host"] else cur
        new["current_host"] = target
        await driver().apply_ha(guest_type, guest_id, new, s["shared"]["hosts"])
        s["shared"]["ha_policies"][k] = new
        bump(s)
        save(s)
    run_job(job, go())
    return {"ok": True, "job_id": job["id"], "target_host": target}


# ---------------------------------------------------------------- Floating VIPs


async def vip_ifaces(vips: list[dict]) -> dict[str, str]:
    return {v["id"]: f"{v['bridge']}.{v['vlan']}" if v.get("vlan") else v["bridge"] for v in vips}


async def apply_vips(st: dict) -> dict[str, str]:
    """Write keepalived.conf on every online host (installing keepalived where it is missing); {host: error}."""
    sh = st["shared"]
    ifaces = await vip_ifaces(sh["vips"])
    auth = hashlib.sha256((st["secret"] + ":vrrp").encode()).hexdigest()
    errors: dict[str, str] = {}
    online = online_hosts(st)

    async def one(n: str):
        conf = render_keepalived(sh["vips"], n, list(sh["hosts"]), auth, ifaces)
        script = ("f=/etc/keepalived/keepalived.conf\n"
                  "if [ -s $f ] && ! head -1 $f | grep -q 'Managed by SolarOS'; then "
                  "echo '!! keepalived.conf exists and is not managed here; not overwriting it'; exit 3; fi\n"
                  "command -v keepalived >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q keepalived\n"
                  f"mkdir -p /etc/keepalived && printf %s {shlex.quote(conf)} > $f.tmp && mv $f.tmp $f\n"
                  + ("systemctl enable -q keepalived && systemctl reload-or-restart keepalived\n" if sh["vips"] else
                     "systemctl disable -q --now keepalived 2>/dev/null; true\n"))
        try:
            await on(sh["hosts"][n], script, timeout=300)
        except HTTPException as e:
            errors[n] = str(e.detail)[:200]
    await asyncio.gather(*(one(n) for n in sh["hosts"] if n in online))
    return errors


@router.get("/vips")
async def list_vips():
    return {"vips": load()["shared"]["vips"]}


@router.post("/vips")
async def create_vip(body: VipBody):
    async with _lock:
        st = load()
        if not in_cluster(st):
            raise HTTPException(409, "Floating VIPs need a cluster")
        if body.preferred_host not in st["shared"]["hosts"]:
            raise HTTPException(422, f"{body.preferred_host} is not a cluster host")
        if any(v["address"].split("/")[0] == body.address.split("/")[0] for v in st["shared"]["vips"]):
            raise HTTPException(409, f"{body.address} is already a floating VIP")
        used = {v["vrid"] for v in st["shared"]["vips"]}
        vrid = next(i for i in range(51, 255) if i not in used)
        st["shared"]["vips"].append({"id": secrets.token_hex(4), "vrid": vrid, **body.model_dump()})
        bump(st)
        save(st)
    errors = await apply_vips(st)
    return {"ok": not errors, "errors": errors}


@router.delete("/vips/{vip_id}")
async def delete_vip(vip_id: str = Path(pattern=r"^[0-9a-f]{8}$")):
    async with _lock:
        st = load()
        before = len(st["shared"]["vips"])
        st["shared"]["vips"] = [v for v in st["shared"]["vips"] if v["id"] != vip_id]
        if len(st["shared"]["vips"]) == before:
            raise HTTPException(404, "No such VIP")
        bump(st)
        save(st)
    errors = await apply_vips(st)
    return {"ok": not errors, "errors": errors}


# ---------------------------------------------------------------- Peer routes (signed, no session)


@peer.post("/join")
async def peer_join(request: Request, body: dict = Body(...)):
    async with _lock:
        st = load()
        if not in_cluster(st) or body.get("cluster_id") != st.get("cluster_id") or not st.get("ca_key"):
            raise HTTPException(404, "No such cluster on this host")
        h = hashlib.sha256(str(body.get("secret", "")).encode()).hexdigest()
        tok = next((t for t in st.get("join_tokens", []) if hmac.compare_digest(t["hash"], h)), None)
        if not tok or tok["used"] or tok["expires"] < time.time():
            raise HTTPException(403, "The join token is invalid, expired or already used")
        host = body.get("host") or {}
        name, addr, key = host.get("name", ""), host.get("address", ""), host.get("ssh_pubkey", "")
        if not re.fullmatch(HOST_RE, name):
            raise HTTPException(422, "Invalid host name")
        ipaddress.ip_address(addr)
        if name in st["shared"]["hosts"]:
            raise HTTPException(409, f"A host named {name} is already in the cluster")
        taken = {int(r["vmid"]) for r in await inventory(st)}
        clash = sorted(taken & {int(v) for v in body.get("vmids", [])})
        if clash:
            raise HTTPException(409, f"Guest IDs {', '.join(map(str, clash[:10]))} already exist in the cluster; "
                                     f"renumber them on the joining host first")
        await authorize_keys([key])
        tok["used"] = True
        cert, ckey = issue_cert(st["ca_cert"], st["ca_key"], name, addr)
        st["shared"]["hosts"][name] = {"name": name, "address": addr, "api_url": f"http://{client_ip(request)}",
                                       "ssh_pubkey": key, "joined": int(time.time())}
        bump(st)
        save(st)
    res = {"cluster_id": st["cluster_id"], "secret": st["secret"], "created": st["created"], "ca_cert": st["ca_cert"],
           "host_cert": cert, "host_key": ckey, "shared": st["shared"],
           "coordinator_ssh_pubkey": st["shared"]["hosts"][st["self"]]["ssh_pubkey"]}
    res["mac"] = hmac.new(str(body["secret"]).encode(), json.dumps(res, sort_keys=True).encode(), hashlib.sha256).hexdigest()
    audit_log.record("cluster.host.add", user="system", host=name, address=addr)
    return res


@peer.post("/heartbeat")
async def peer_heartbeat(request: Request):
    st, body = await verified(request)
    n = request.headers.get("x-cluster-host", "")
    if n in st["shared"]["hosts"]:
        _seen[n] = time.time()
        _info[n] = {k: body.get(k) for k in ("host", "time", "metrics", "guests", "sync")}
    if adopt_shared(st, body.get("shared")):
        save(st)
    return {**await local_summary(), "shared": st["shared"]}


@peer.post("/adopt")
async def peer_adopt(request: Request):
    _, body = await verified(request)
    vmid = await driver().adopt(body["kind"], int(body["vmid"]), str(body["name"]), str(body.get("tags", "")))
    _summary["at"] = 0
    return {"ok": True, "vmid": vmid}


@peer.post("/leave")
async def peer_leave(request: Request):
    async with _lock:
        st, body = await verified(request)
        if st["shared"]["hosts"].pop(str(body.get("host")), None) is not None:
            for k in [k for k, p in st["shared"]["ha_policies"].items() if body["host"] in
                      [p["preferred_active_host"], *p["passive_standby_hosts"]] and p.get("current_host") != body["host"]]:
                p = st["shared"]["ha_policies"][k]
                p["passive_standby_hosts"] = [h for h in p["passive_standby_hosts"] if h != body["host"]]
            bump(st)
            save(st)
    return {"ok": True}


@peer.post("/switch-sync")
async def peer_switch_sync(request: Request):
    _, body = await verified(request)
    from . import network_switch  # lazy: network_switch imports this module
    return await network_switch.apply_cluster_switches(body)


@peer.post("/witness")
async def peer_witness(body: dict = Body(...)):
    """This host as a lightweight quorum witness: grants its vote to one host of a cluster at a time (lease)."""
    cid, host, key = str(body.get("cluster_id", ""))[:32], str(body.get("host", ""))[:64], str(body.get("key", ""))
    if not (cid and host and re.fullmatch(r"[0-9a-f]{64}", key)):
        raise HTTPException(422, "cluster_id, host and key are required")
    now = time.time()
    rec = _witness_book.get(cid)
    if rec is None:
        if len(_witness_book) >= 16:
            raise HTTPException(429, "This witness serves too many clusters")
        rec = _witness_book[cid] = {"key": key, "holder": None, "until": 0.0}  # first contact pins the key
    if not hmac.compare_digest(rec["key"], key):
        raise HTTPException(403, "Wrong witness key for this cluster")
    if rec["holder"] in (None, host) or rec["until"] < now:
        rec.update(holder=host, until=now + WITNESS_LEASE_S)
    return {"granted": rec["holder"] == host, "holder": rec["holder"]}
