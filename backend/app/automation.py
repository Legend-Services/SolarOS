"""Automation & Alerts: external notification channels, no-code server rules run by the lifespan scheduler,
their execution log, and the live network topology graph for Network & Services."""
import asyncio
import html
import json
import logging
import os
import re
import smtplib
import ssl
import time
import uuid
from email.message import EmailMessage
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from . import host, host_ssh, net_services, telemetry
from .auth import require_user
from .config import settings
from .pve import _node, _safe, parse_zfs_list, pve
from .schedules import AUTO_PREFIX, LEGACY_AUTO_PREFIX

router = APIRouter(prefix="/api/automation", tags=["automation"], dependencies=[Depends(require_user)])
topology_router = APIRouter(prefix="/api/v1/network", tags=["automation"], dependencies=[Depends(require_user)])
log = logging.getLogger("solardeck.automation")

TICK_S = 60
SCHEDULE_GRACE_S = 600  # a scheduled rule still fires if the tick lands up to 10 minutes late
LOG_MAX = 300
NOTIFY_WINDOW_S = 24 * 3600
MASK = "••••••••"
SECRETS = {"telegram": ("bot_token",), "discord": ("webhook_url",), "webhook": ("bearer_token",), "email": ("password",)}
CHANNELS = ("telegram", "discord", "webhook", "email")
_lock = asyncio.Lock()


# ---------------------------------------------------------------- JSON files

def _read(path: Path, default):
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return default
    return data if isinstance(data, type(default)) else default


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.chmod(tmp, 0o600)  # channel secrets live in here
    os.replace(tmp, path)  # atomic: a crash never leaves a half-written file


# ---------------------------------------------------------------- Channels

Email = Annotated[str, Field(pattern=r"^$|^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)]


class Telegram(BaseModel):
    enabled: bool = False
    bot_token: str = Field("", pattern=r"^$|^\d{3,12}:[A-Za-z0-9_-]{20,80}$")
    chat_id: str = Field("", pattern=r"^$|^-?\d{1,20}$|^@[A-Za-z0-9_]{4,64}$")


class Discord(BaseModel):
    enabled: bool = False
    webhook_url: str = Field("", pattern=r"^$|^https://(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)/api/webhooks/\d+/[A-Za-z0-9_-]+$",
                             max_length=300)


class Webhook(BaseModel):
    enabled: bool = False
    url: str = Field("", pattern=r"^$|^https?://[^\s\"'<>]+$", max_length=1000)
    method: Literal["POST", "PUT"] = "POST"
    bearer_token: str = Field("", pattern=r"^[\x21-\x7e]{0,500}$")


class SmtpEmail(BaseModel):
    enabled: bool = False
    smtp_host: str = Field("", pattern=r"^$|" + net_services.HOST_RE, max_length=253)
    smtp_port: int = Field(587, ge=1, le=65535)
    username: str = Field("", max_length=254)
    password: str = Field("", max_length=500)
    from_email: Email = ""
    to_email: Email = ""
    use_tls: bool = True


class Channels(BaseModel):
    telegram: Telegram = Telegram()
    discord: Discord = Discord()
    webhook: Webhook = Webhook()
    email: SmtpEmail = SmtpEmail()

    @model_validator(mode="after")
    def _complete(self):
        need = {"telegram": ("bot_token", "chat_id"), "discord": ("webhook_url",), "webhook": ("url",),
                "email": ("smtp_host", "from_email", "to_email")}
        for ch, fields in need.items():
            c = getattr(self, ch)
            missing = [f for f in fields if c.enabled and not getattr(c, f)]
            if missing:
                raise ValueError(f"{ch}: fill in {', '.join(missing)} before enabling it")
        return self


def load_channels() -> dict:
    try:
        return Channels.model_validate(_read(settings.alert_channels_file, {})).model_dump()
    except ValidationError:  # hand-edited file: start from defaults rather than crash the scheduler
        return Channels().model_dump()


def masked(ch: dict) -> dict:
    return {name: {k: (MASK if k in SECRETS[name] and v else v) for k, v in cfg.items()} for name, cfg in ch.items()}


def merge_secrets(body: dict, stored: dict) -> dict:
    """A secret sent back as the mask keeps the stored value, so the UI never needs to see it."""
    out = {}
    for name in CHANNELS:
        cfg = dict(body.get(name) or {}) if isinstance(body.get(name), dict) else {}
        for k in SECRETS[name]:
            if cfg.get(k) == MASK:
                cfg[k] = stored[name][k]
        out[name] = cfg
    return out


def _redact(text: str, cfg: dict) -> str:
    for v in cfg.values():
        if isinstance(v, str) and len(v) >= 6:
            text = text.replace(v, "***")
    return text[:300]


SEVERITY_COLOR = {"critical": 0xF43F5E, "warning": 0xF59E0B, "info": 0x38BDF8}


async def _http(method: str, url: str, **kw) -> httpx.Response:
    async with httpx.AsyncClient(timeout=15) as c:
        return await c.request(method, url, **kw)


async def send_one(name: str, cfg: dict, title: str, message: str, severity: str) -> dict:
    """Deliver one alert; returns {channel, ok, detail} and never raises (secrets are scrubbed from errors)."""
    try:
        if name == "telegram":
            text = f"<b>{html.escape(title)}</b>\n{html.escape(message)}\n<i>SolarDeck · {html.escape(settings.node_name)}</i>"
            r = await _http("POST", f"https://api.telegram.org/bot{cfg['bot_token']}/sendMessage",
                            json={"chat_id": cfg["chat_id"], "text": text, "parse_mode": "HTML"})
            ok = r.status_code == 200 and r.json().get("ok") is True
            detail = "Delivered" if ok else (r.json().get("description") if "json" in r.headers.get("content-type", "") else r.text)
        elif name == "discord":
            embed = {"title": title[:256], "description": message[:4000], "color": SEVERITY_COLOR.get(severity, 0x38BDF8),
                     "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "footer": {"text": f"SolarDeck · {settings.node_name}"}}
            r = await _http("POST", cfg["webhook_url"], json={"username": "SolarDeck", "embeds": [embed]})
            ok, detail = r.status_code in (200, 204), f"HTTP {r.status_code}"
        elif name == "webhook":
            headers = {"Authorization": f"Bearer {cfg['bearer_token']}"} if cfg.get("bearer_token") else {}
            payload = {"source": "SolarDeck", "node": settings.node_name, "severity": severity, "title": title,
                       "message": message, "timestamp": int(time.time())}
            r = await _http(cfg.get("method") or "POST", cfg["url"], json=payload, headers=headers)
            ok, detail = r.is_success, f"HTTP {r.status_code}"
        else:
            await asyncio.to_thread(_send_email, cfg, title, message)
            ok, detail = True, f"Sent to {cfg['to_email']}"
    except (httpx.HTTPError, smtplib.SMTPException, OSError, ValueError, KeyError) as e:
        ok, detail = False, f"{type(e).__name__}: {e}"
    return {"channel": name, "ok": ok, "detail": _redact(str(detail), cfg)}


def _send_email(cfg: dict, title: str, message: str) -> None:
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = f"[SolarDeck] {title}", cfg["from_email"], cfg["to_email"]
    msg.set_content(f"{message}\n\n-- SolarDeck on {settings.node_name}")
    ctx = ssl.create_default_context()
    implicit = cfg["use_tls"] and cfg["smtp_port"] == 465  # port 465 = TLS from the start, others upgrade with STARTTLS
    cls = smtplib.SMTP_SSL if implicit else smtplib.SMTP
    kw = {"context": ctx} if implicit else {}
    with cls(cfg["smtp_host"], cfg["smtp_port"], timeout=20, **kw) as s:
        if cfg["use_tls"] and not implicit:
            s.starttls(context=ctx)
        if cfg["username"]:
            s.login(cfg["username"], cfg["password"])
        s.send_message(msg)


async def dispatch(title: str, message: str, severity: str = "warning", only: list[str] | None = None) -> list[dict]:
    ch = load_channels()
    names = [n for n in CHANNELS if ch[n]["enabled"] and (not only or n in only)]
    return list(await asyncio.gather(*[send_one(n, ch[n], title, message, severity) for n in names]))


@router.get("/channels")
def get_channels():
    return masked(load_channels())


@router.put("/channels")
async def put_channels(body: dict = Body(...)):
    async with _lock:
        try:
            ch = Channels.model_validate(merge_secrets(body, load_channels())).model_dump()
        except ValidationError as e:
            err = e.errors()[0]
            raise HTTPException(422, f"{'.'.join(map(str, err['loc'])) or 'channels'}: {err['msg']}")
        _write(settings.alert_channels_file, ch)
    return masked(ch)


class TestBody(BaseModel):
    channel: Literal["telegram", "discord", "webhook", "email"]


@router.post("/channels/test")
async def test_channel(body: TestBody):
    cfg = load_channels()[body.channel]
    if not cfg["enabled"]:
        raise HTTPException(400, "Enable and save this channel first")
    return await send_one(body.channel, cfg, "SolarDeck test alert",
                          "Your SolarDeck alert channel works. Automation rules will send their alerts here.", "info")


# ---------------------------------------------------------------- Rules

Trigger = Literal["gpu_temp_above", "disk_temp_above", "zfs_pool_degraded", "storage_usage_above",
                  "guest_stopped_unexpectedly", "scheduled_time"]
Action = Literal["send_external_alert", "restart_guest", "start_guest", "stop_guest", "prune_old_snapshots"]
THRESHOLD = {"gpu_temp_above": (20, 120), "disk_temp_above": (20, 100), "storage_usage_above": (1, 100)}
GUEST_ACTIONS = {"restart_guest", "start_guest", "stop_guest"}


class GuestRef(BaseModel):
    type: Literal["qemu", "lxc"]
    vmid: int = Field(ge=100, le=999999999)


class RuleBody(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[^\n\r<>]+$")
    enabled: bool = True
    trigger: Trigger
    threshold: float | None = None
    target: GuestRef | None = None  # keep-alive guest for guest_stopped_unexpectedly, and the guest acted on
    time: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    days: list[Annotated[int, Field(ge=0, le=6)]] = Field([], max_length=7)  # 0 = Monday; empty = every day
    action: Action
    channels: list[Literal["telegram", "discord", "webhook", "email"]] = Field([], max_length=4)  # empty = all enabled
    cooldown_minutes: int = Field(15, ge=0, le=10080)
    prune_older_than_days: int = Field(7, ge=0, le=3650)

    @model_validator(mode="after")
    def _check(self):
        if self.trigger in THRESHOLD:
            lo, hi = THRESHOLD[self.trigger]
            if self.threshold is None or not lo <= self.threshold <= hi:
                raise ValueError(f"threshold must be between {lo} and {hi}")
        else:
            self.threshold = None
        if self.trigger == "scheduled_time" and not self.time:
            raise ValueError("a scheduled rule needs a time (HH:MM)")
        if (self.trigger == "guest_stopped_unexpectedly" or self.action in GUEST_ACTIONS) and not self.target:
            raise ValueError("choose the VM or container this rule watches or controls")
        self.days = sorted(set(self.days))
        return self


def load_rules() -> list[dict]:
    return _read(settings.automation_rules_file, [])


def load_logs() -> list[dict]:
    return _read(settings.automation_logs_file, [])


def _append_log(entry: dict) -> None:
    _write(settings.automation_logs_file, [entry, *load_logs()][:LOG_MAX])


@router.get("/rules")
def list_rules():
    return load_rules()


@router.post("/rules")
async def create_rule(body: RuleBody):
    item = {"id": uuid.uuid4().hex[:12], **body.model_dump(), "created": int(time.time()), "last_fired": None,
            "last_status": None}
    async with _lock:
        rules = load_rules()
        if len(rules) >= 100:
            raise HTTPException(400, "At most 100 rules")
        _write(settings.automation_rules_file, [*rules, item])
    return item


@router.put("/rules/{rid}")
async def update_rule(rid: str, body: RuleBody):
    async with _lock:
        rules = load_rules()
        item = next((r for r in rules if r["id"] == rid), None)
        if not item:
            raise HTTPException(404, "Rule not found")
        item.update(body.model_dump())
        _write(settings.automation_rules_file, rules)
    return item


@router.delete("/rules/{rid}")
async def delete_rule(rid: str):
    async with _lock:
        rules = load_rules()
        kept = [r for r in rules if r["id"] != rid]
        if len(kept) == len(rules):
            raise HTTPException(404, "Rule not found")
        _write(settings.automation_rules_file, kept)
    return {"ok": True}


@router.get("/logs")
def get_logs():
    return load_logs()


# ---------------------------------------------------------------- Evaluation

def _pct(used, total) -> float:
    return used / total * 100 if total else 0.0


def scheduled_due(rule: dict, now: float) -> bool:
    lt = time.localtime(now)
    hh, mm = map(int, rule["time"].split(":"))
    at = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, hh, mm, 0, 0, 0, -1))
    if rule.get("days") and time.localtime(at).tm_wday not in rule["days"]:
        return False
    return at <= now < at + SCHEDULE_GRACE_S and (rule.get("last_fired") or 0) < at


def evaluate(rule: dict, ctx: dict, now: float) -> str | None:
    """Plain-English reason the rule's trigger holds right now, or None. Pure: ctx holds the fetched state."""
    t, th = rule["trigger"], rule.get("threshold")
    if t == "scheduled_time":
        return f"Scheduled at {rule['time']}" if scheduled_due(rule, now) else None
    if t == "gpu_temp_above":
        g = ctx.get("gpu") or {}
        return f"{g.get('name') or 'GPU'} is at {g['temp_c']:.0f}°C (limit {th:.0f}°C)" \
            if g.get("available") and g.get("temp_c") is not None and g["temp_c"] > th else None
    if t == "disk_temp_above":
        hot = [f"{d['devpath']} {d['temp_c']}°C" for d in ctx.get("disks", []) if d.get("temp_c") is not None and d["temp_c"] > th]
        return f"Drive temperature above {th:.0f}°C: {', '.join(hot)}" if hot else None
    if t == "zfs_pool_degraded":
        bad = [f"{p['name']} is {(p.get('health') or 'UNKNOWN').upper()}" for p in ctx.get("pools", [])
               if (p.get("health") or "UNKNOWN").upper() != "ONLINE"]
        return "ZFS pool " + ", ".join(bad) if bad else None
    if t == "storage_usage_above":
        full = [(p["name"], _pct(p.get("alloc") or 0, p.get("size") or 0)) for p in ctx.get("pools", [])]
        rootfs = ctx.get("rootfs") or {}
        full.append(("host root filesystem", _pct(rootfs.get("used") or 0, rootfs.get("total") or 0)))
        over = [f"{n} {v:.0f}%" for n, v in full if v > th]
        return f"Storage above {th:.0f}%: {', '.join(over)}" if over else None
    if t == "guest_stopped_unexpectedly":
        g = ctx.get("guests", {}).get((rule["target"]["type"], rule["target"]["vmid"]))
        if g and g.get("status") == "stopped":
            kind = "VM" if rule["target"]["type"] == "qemu" else "Container"
            return f"{kind} {g['vmid']} ({g.get('name') or '?'}) is stopped"
    return None


def cooling_down(rule: dict, now: float) -> bool:
    return rule["trigger"] != "scheduled_time" and bool(rule.get("last_fired")) and \
        now - rule["last_fired"] < rule.get("cooldown_minutes", 15) * 60


async def gather_context(rules: list[dict]) -> dict:
    need = {r["trigger"] for r in rules}
    ctx: dict = {}
    jobs = {}
    if need & {"gpu_temp_above", "disk_temp_above"}:
        jobs["hw"] = telemetry.hardware()
    if need & {"zfs_pool_degraded", "storage_usage_above"} or any(r["action"] == "prune_old_snapshots" for r in rules):
        jobs["pools"] = _safe(_node("/disks/zfs"), [])
        jobs["status"] = _safe(_node("/status"), {})
    if "guest_stopped_unexpectedly" in need:
        jobs["qemu"], jobs["lxc"] = _safe(_node("/qemu"), []), _safe(_node("/lxc"), [])
    res = dict(zip(jobs, await asyncio.gather(*jobs.values())))
    if "hw" in res:
        ctx["gpu"], ctx["disks"] = res["hw"].get("gpu"), res["hw"].get("disks", [])
    ctx["pools"] = res.get("pools") or []
    ctx["rootfs"] = (res.get("status") or {}).get("rootfs") or {}
    ctx["guests"] = {(k, int(g["vmid"])): g for k in ("qemu", "lxc") for g in (res.get(k) or [])}
    return ctx


async def _guest_power(target: dict, action: str) -> str:
    base = _node(f"/{target['type']}/{target['vmid']}/status")
    cur = (await pve("GET", f"{base}/current")).get("status")
    if action == "stop_guest":
        if cur == "stopped":
            return "Already stopped"
        await pve("POST", f"{base}/shutdown", data={"forceStop": 1})
        return "Shutdown sent"
    verb = "reboot" if action == "restart_guest" and cur == "running" else "start"
    if verb == "start" and cur == "running":
        return "Already running"
    await pve("POST", f"{base}/{verb}")
    return "Restart sent" if verb == "reboot" else "Start sent"


async def prune_snapshots(pools: list[str] | None, older_than_days: int, now: float) -> str:
    snaps = parse_zfs_list(await host.run(["zfs-list"]))["snapshots"]
    cutoff = now - older_than_days * 86400
    old = [s for s in snaps if s["snapshot"].startswith((AUTO_PREFIX, LEGACY_AUTO_PREFIX)) and s["creation"] < cutoff
           and (pools is None or s["dataset"].split("/")[0] in pools)]
    for s in old:
        await host.run(["zfs-destroy", s["name"]])
    return f"Removed {len(old)} expired automatic snapshot{'s' if len(old) != 1 else ''}"


async def run_action(rule: dict, summary: str, ctx: dict, now: float) -> tuple[str, str]:
    a = rule["action"]
    if a == "send_external_alert":
        sev = "info" if rule["trigger"] == "scheduled_time" else "critical" if rule["trigger"] == "zfs_pool_degraded" else "warning"
        results = await dispatch(rule["name"], summary, sev, rule.get("channels") or None)
        if not results:
            return "ok", "Notification Center (no external channels enabled)"
        parts = [f"{r['channel']}: {'ok' if r['ok'] else r['detail']}" for r in results]
        good = sum(r["ok"] for r in results)
        return ("ok" if good == len(results) else "partial" if good else "error"), "; ".join(parts)
    if a in GUEST_ACTIONS:
        return "ok", await _guest_power(rule["target"], a)
    over = None
    if rule["trigger"] == "storage_usage_above":
        over = [p["name"] for p in ctx.get("pools", []) if _pct(p.get("alloc") or 0, p.get("size") or 0) > rule["threshold"]]
    return "ok", await prune_snapshots(over, rule.get("prune_older_than_days", 7), now)


async def run_rules(now: float | None = None) -> int:
    """Evaluate every enabled rule once; returns how many fired."""
    now = now or time.time()
    rules = [r for r in load_rules() if r.get("enabled") and not cooling_down(r, now)]
    if not rules:
        return 0
    ctx = await gather_context(rules)
    fired = {}
    for r in rules:
        summary = evaluate(r, ctx, now)
        if not summary:
            continue
        try:
            status, result = await run_action(r, summary, ctx, now)
        except Exception as e:  # noqa: BLE001 - one failing rule must not stop the others
            status, result = "error", str(getattr(e, "detail", None) or e)[:300]
            log.warning("automation rule %s (%s) failed: %s", r["id"], r["name"], result)
        fired[r["id"]] = status
        async with _lock:
            _append_log({"id": uuid.uuid4().hex[:12], "timestamp": int(now), "rule_id": r["id"], "rule_name": r["name"],
                         "trigger_summary": summary, "action": r["action"], "action_result": result, "status": status})
    if fired:
        async with _lock:
            rules = load_rules()
            for r in rules:
                if r["id"] in fired:
                    r["last_fired"], r["last_status"] = int(now), fired[r["id"]]
            _write(settings.automation_rules_file, rules)
    return len(fired)


def recent_alerts(now: float | None = None) -> list[dict]:
    """Rule alerts and failures of the last 24 h, for the TopBar Notification Center."""
    since = (now or time.time()) - NOTIFY_WINDOW_S
    out = []
    for e in load_logs():
        if e["timestamp"] < since:
            break
        if e["action"] == "send_external_alert" or e["status"] == "error":
            sev = "warning" if e["status"] != "ok" or e["action"] == "send_external_alert" else "info"
            out.append({"id": f"automation:{e['id']}", "severity": sev, "category": "automation", "title": e["rule_name"],
                        "message": e["trigger_summary"] + ("" if e["status"] == "ok" else f" — action failed: {e['action_result']}")})
    return out


async def scheduler_loop() -> None:
    while True:
        try:
            await run_rules()
        except Exception:  # noqa: BLE001 - keep the loop alive
            log.exception("automation tick failed")
        await asyncio.sleep(TICK_S)


# ---------------------------------------------------------------- Network topology

NET_KEY_RE = re.compile(r"^net(\d+)$")
MAC_RE = re.compile(r"([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})")


def parse_guest_nets(kind: str, cfg: dict) -> list[dict]:
    """net0..netN of a QEMU (`virtio=MAC,bridge=br0,tag=10`) or LXC (`name=eth0,hwaddr=MAC,bridge=br0,ip=…`) config."""
    out = []
    for k, v in sorted(cfg.items(), key=lambda kv: kv[0]):
        m = NET_KEY_RE.match(k)
        if not m or not isinstance(v, str):
            continue
        opts = dict(p.split("=", 1) for p in v.split(",") if "=" in p)
        mac = opts.get("hwaddr") if kind == "lxc" else next((MAC_RE.search(x).group(1) for x in opts.values() if MAC_RE.fullmatch(x)), None)
        ip = opts.get("ip") if kind == "lxc" and opts.get("ip") not in (None, "dhcp", "manual") else None
        out.append({"key": k, "bridge": opts.get("bridge"), "mac": (mac or "").upper() or None, "tag": opts.get("tag"),
                    "ip": ip.split("/")[0] if ip else None, "name": opts.get("name") or k, "firewall": opts.get("firewall") == "1"})
    return out


def guest_ips(kind: str, live) -> dict[str, list[str]]:
    """MAC -> IPv4 addresses from /lxc/{id}/interfaces or the QEMU guest agent's network-get-interfaces."""
    out: dict[str, list[str]] = {}
    if kind == "lxc":
        for i in live or []:
            if i.get("hwaddr") and i.get("inet"):
                out.setdefault(i["hwaddr"].upper(), []).append(i["inet"].split("/")[0])
    else:
        for i in (live or {}).get("result", []) if isinstance(live, dict) else []:
            mac = (i.get("hardware-address") or "").upper()
            ips = [a["ip-address"] for a in i.get("ip-addresses", []) if a.get("ip-address-type") == "ipv4"
                   and not a["ip-address"].startswith("127.")]
            if mac and ips:
                out.setdefault(mac, []).extend(ips)
    return out


def parse_ip_links(text: str) -> dict[str, dict]:
    try:
        links = json.loads(text or "[]")
    except ValueError:
        return {}
    return {x["ifname"]: {"mac": (x.get("address") or "").upper() or None, "state": (x.get("operstate") or "").lower()}
            for x in links if isinstance(x, dict) and x.get("ifname")}


def build_topology(network: list[dict], links: dict[str, dict], guests: list[dict], wg: dict, wg_live: dict,
                   router: dict) -> dict:
    """Nodes and edges: Internet -> NICs/bonds -> bridges/VLANs -> guests, WireGuard (+ peers), port forwards."""
    nodes, edges = [], []
    ifaces = {i["iface"]: i for i in network if i.get("iface")}

    def add_edge(src: str, dst: str, kind: str, label: str = ""):
        edges.append({"id": f"{src}->{dst}", "source": src, "target": dst, "kind": kind, "label": label})

    nodes.append({"id": "internet", "type": "internet", "label": "Internet / WAN", "ip": None, "mac": None, "status": "up", "meta": {}})
    uplinks = set()
    for name, i in sorted(ifaces.items()):
        typ = {"eth": "nic", "bond": "bond", "bridge": "bridge", "OVSBridge": "bridge", "vlan": "vlan"}.get(i.get("type", ""))
        if not typ:
            continue
        link = links.get(name, {})
        up = bool(i.get("active")) or link.get("state") == "up"
        nodes.append({"id": f"if:{name}", "type": typ, "label": name, "ip": (i.get("cidr") or i.get("address")), "mac": link.get("mac"),
                      "status": "up" if up else "down",
                      "meta": {k: i[k] for k in ("gateway", "comments", "bridge_ports", "slaves", "vlan-id", "bridge_vlan_aware") if i.get(k)}})
        ports = (i.get("bridge_ports") or i.get("slaves") or i.get("ovs_ports") or "").split()
        for p in ports:
            if p in ifaces:
                add_edge(f"if:{p}", f"if:{name}", "port")
        raw = i.get("vlan-raw-device") or (name.rsplit(".", 1)[0] if typ == "vlan" and "." in name else None)
        if raw in ifaces:
            add_edge(f"if:{raw}", f"if:{name}", "port", f"VLAN {i.get('vlan-id') or name.rsplit('.', 1)[-1]}")
        if i.get("gateway"):
            uplinks.add(name)
    # The gateway sits on a bridge (or NIC); the Internet reaches it through that interface's physical ports.
    for name in sorted(uplinks):
        ports = [p for p in (ifaces[name].get("bridge_ports") or ifaces[name].get("slaves") or "").split() if p in ifaces]
        for src in ports or [name]:
            add_edge("internet", f"if:{src}", "uplink", f"gw {ifaces[name]['gateway']}")

    ip_owner: dict[str, str] = {}
    for g in guests:
        gid = f"{g['type']}:{g['vmid']}"
        nets = g.get("nets", [])
        ips = [ip for n in nets for ip in ([n["ip"]] if n.get("ip") else []) + g.get("ips", {}).get(n.get("mac") or "", [])]
        ips = list(dict.fromkeys(ips))
        for ip in ips:
            ip_owner.setdefault(ip, gid)
        nodes.append({"id": gid, "type": "vm" if g["type"] == "qemu" else "lxc", "label": g.get("name") or gid,
                      "ip": ", ".join(ips) or None, "mac": next((n["mac"] for n in nets if n.get("mac")), None),
                      "status": g.get("status", "unknown"), "meta": {"vmid": g["vmid"], "guest_type": g["type"],
                                                                     "nics": [{k: n[k] for k in ("key", "bridge", "mac", "tag")} for n in nets]}})
        for n in nets:
            if n.get("bridge") and n["bridge"] in ifaces:
                add_edge(f"if:{n['bridge']}", gid, "vnic", n["key"] + (f" · VLAN {n['tag']}" if n.get("tag") else ""))

    if wg.get("enabled") or "wg0" in wg_live:
        running = "wg0" in wg_live
        nodes.append({"id": "wg:wg0", "type": "wireguard", "label": "WireGuard wg0", "ip": wg.get("subnet"), "mac": None,
                      "status": "up" if running else "down", "meta": {"port": wg.get("port"), "endpoint": wg.get("endpoint")}})
        if wg.get("wan") in ifaces:
            add_edge(f"if:{wg['wan']}", "wg:wg0", "vpn", f"UDP {wg.get('port')}")
        live = {p["public_key"]: p for p in wg_live.get("wg0", {}).get("peers", [])}
        for p in wg.get("peers", []):
            lp = live.get(p.get("public_key"))
            online = bool(lp and lp.get("handshake") and time.time() - lp["handshake"] < 180)
            nodes.append({"id": f"peer:{p['name']}", "type": "peer", "label": p["name"], "ip": p.get("ip"), "mac": None,
                          "status": "up" if online else "down", "meta": {"endpoint": (lp or {}).get("endpoint")}})
            add_edge("wg:wg0", f"peer:{p['name']}", "vpn")

    wan = router.get("wan")
    for n, f in enumerate(router.get("forwards", [])):
        fid = f"fwd:{n}"
        to = f["int_ip"] + (f":{f['int_port']}" if f.get("int_port") else "")
        nodes.append({"id": fid, "type": "forward", "label": f"{f['proto'].upper()} {f['ext_port']} → {to}", "ip": f["int_ip"],
                      "mac": None, "status": "up", "meta": {"index": n, "comment": f.get("comment", "")}})
        add_edge(f"if:{wan}" if wan in ifaces else "internet", fid, "forward")
        if f["int_ip"] in ip_owner:
            add_edge(fid, ip_owner[f["int_ip"]], "forward")
    known = {x["id"] for x in nodes}
    edges = [e for e in edges if e["source"] in known and e["target"] in known]
    return {"nodes": nodes, "edges": list({e["id"]: e for e in edges}.values()), "generated_at": int(time.time())}


@topology_router.get("/topology")
async def topology():
    network, qemu, lxc, links, wg, wg_live, router_cfg = await asyncio.gather(
        _safe(_node("/network"), []), _safe(_node("/qemu"), []), _safe(_node("/lxc"), []),
        host_ssh.run("ip -j link show", check=False, timeout=15),
        net_services.load("wg", net_services.WG_DEFAULT), net_services.wg_dump(),
        net_services.load("router", net_services.ROUTER_DEFAULT), return_exceptions=True)
    ok = lambda v, d: d if isinstance(v, BaseException) else (v or d)  # noqa: E731 - host bridge down: still show PVE data
    items = [(k, g) for k, lst in (("qemu", ok(qemu, [])), ("lxc", ok(lxc, []))) for g in lst]
    cfgs = await asyncio.gather(*[_safe(_node(f"/{k}/{g['vmid']}/config"), {}) for k, g in items])

    async def live(k, g):
        if g.get("status") != "running":
            return None
        path = f"/lxc/{g['vmid']}/interfaces" if k == "lxc" else f"/qemu/{g['vmid']}/agent/network-get-interfaces"
        return await _safe(_node(path), None)

    lives = await asyncio.gather(*[live(k, g) for k, g in items])
    guests = [{"type": k, "vmid": int(g["vmid"]), "name": g.get("name"), "status": g.get("status"),
               "nets": parse_guest_nets(k, c or {}), "ips": guest_ips(k, lv)} for (k, g), c, lv in zip(items, cfgs, lives)]
    return build_topology(ok(network, []), parse_ip_links(ok(links, "")), sorted(guests, key=lambda g: g["vmid"]),
                          ok(wg, {}), ok(wg_live, {}), ok(router_cfg, {}))
