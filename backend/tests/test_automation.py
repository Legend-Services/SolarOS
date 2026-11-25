"""Automation rules, channel secrets and topology self-check. Run: python -m tests.test_automation"""
import asyncio
import tempfile
import time
from pathlib import Path

from pydantic import ValidationError

from app import automation as a
from app.config import settings


def bad(**kw):
    try:
        a.RuleBody(**kw)
    except ValidationError:
        return True
    raise AssertionError(f"accepted {kw}")


# Rule validation.
r = a.RuleBody(name="Hot GPU", trigger="gpu_temp_above", threshold=80, action="send_external_alert").model_dump()
assert r["cooldown_minutes"] == 15 and r["channels"] == []
assert bad(name="x", trigger="gpu_temp_above", action="send_external_alert")  # no threshold
assert bad(name="x", trigger="storage_usage_above", threshold=150, action="send_external_alert")
assert bad(name="x", trigger="scheduled_time", action="start_guest", target={"type": "qemu", "vmid": 101})  # no time
assert bad(name="x", trigger="zfs_pool_degraded", action="restart_guest")  # no target
assert bad(name="x", trigger="scheduled_time", time="25:00", action="send_external_alert")
assert a.RuleBody(name="x", trigger="zfs_pool_degraded", threshold=5, action="send_external_alert").threshold is None

# Evaluation.
now = time.time()
ctx = {"gpu": {"available": True, "name": "RTX 3090", "temp_c": 84}, "disks": [{"devpath": "/dev/nvme0n1", "temp_c": 61}],
       "pools": [{"name": "tank", "health": "DEGRADED", "alloc": 90, "size": 100}], "rootfs": {"used": 1, "total": 10},
       "guests": {("lxc", 101): {"vmid": 101, "name": "ai", "status": "stopped"}}}
assert "84°C" in a.evaluate(r, ctx, now)
assert a.evaluate({**r, "threshold": 90}, ctx, now) is None
assert "/dev/nvme0n1" in a.evaluate({"trigger": "disk_temp_above", "threshold": 55}, ctx, now)
assert "tank is DEGRADED" in a.evaluate({"trigger": "zfs_pool_degraded"}, ctx, now)
s = a.evaluate({"trigger": "storage_usage_above", "threshold": 85}, ctx, now)
assert "tank 90%" in s and "root" not in s
keep = {"trigger": "guest_stopped_unexpectedly", "target": {"type": "lxc", "vmid": 101}}
assert "Container 101 (ai) is stopped" == a.evaluate(keep, ctx, now)
assert a.evaluate({**keep, "target": {"type": "qemu", "vmid": 101}}, ctx, now) is None
assert a.evaluate(r, {"gpu": {"available": False}}, now) is None

# Scheduled: fires once inside the grace window, not again after last_fired, respects weekdays.
lt = time.localtime(now - 60)
sched = {"trigger": "scheduled_time", "time": f"{lt.tm_hour:02d}:{lt.tm_min:02d}", "days": [], "last_fired": None}
assert a.scheduled_due(sched, now)
assert not a.scheduled_due({**sched, "last_fired": int(now)}, now)
assert not a.scheduled_due({**sched, "days": [(lt.tm_wday + 1) % 7]}, now)
assert not a.scheduled_due(sched, now + a.SCHEDULE_GRACE_S + 120)

# Cooldown.
assert a.cooling_down({"trigger": "gpu_temp_above", "last_fired": now - 60, "cooldown_minutes": 15}, now)
assert not a.cooling_down({"trigger": "gpu_temp_above", "last_fired": now - 16 * 60, "cooldown_minutes": 15}, now)

# Channels: secrets masked on read, kept when the mask comes back, required fields when enabled.
with tempfile.TemporaryDirectory() as d:
    settings.alert_channels_file = Path(d) / "alert_channels.json"
    settings.automation_rules_file = Path(d) / "automation_rules.json"
    settings.automation_logs_file = Path(d) / "automation_logs.json"
    tok = "123456:" + "A" * 35
    out = asyncio.run(a.put_channels({"telegram": {"enabled": True, "bot_token": tok, "chat_id": "-100123"}}))
    assert out["telegram"]["bot_token"] == a.MASK and out["email"]["smtp_port"] == 587
    asyncio.run(a.put_channels({"telegram": {"enabled": True, "bot_token": a.MASK, "chat_id": "-100123"}}))
    assert a.load_channels()["telegram"]["bot_token"] == tok
    try:
        asyncio.run(a.put_channels({"discord": {"enabled": True, "webhook_url": ""}}))
        raise AssertionError("enabled discord without URL accepted")
    except a.HTTPException as e:
        assert e.status_code == 422
    try:
        asyncio.run(a.put_channels({"discord": {"enabled": True, "webhook_url": "https://evil.example/api/webhooks/1/x"}}))
        raise AssertionError("non-Discord webhook accepted")
    except a.HTTPException:
        pass
    assert a._redact(f"error at https://api.telegram.org/bot{tok}/sendMessage", a.load_channels()["telegram"]).count(tok) == 0

    # A firing rule with no channels enabled logs, sets last_fired and shows up in the Notification Center.
    asyncio.run(a.put_channels({}))
    asyncio.run(a.create_rule(a.RuleBody(name="Pool check", trigger="scheduled_time", time=sched["time"], action="send_external_alert")))
    assert asyncio.run(a.run_rules(now)) == 1
    assert asyncio.run(a.run_rules(now)) == 0  # already fired for this slot
    log = a.get_logs()[0]
    assert log["rule_name"] == "Pool check" and log["status"] == "ok" and "Notification Center" in log["action_result"]
    assert a.list_rules()[0]["last_fired"] == int(now)
    assert a.recent_alerts(now)[0]["id"] == f"automation:{log['id']}"

# Guest NIC parsing.
q = a.parse_guest_nets("qemu", {"net0": "virtio=BC:24:11:aa:bb:cc,bridge=br0,firewall=1,tag=20", "scsi0": "x"})
assert q == [{"key": "net0", "bridge": "br0", "mac": "BC:24:11:AA:BB:CC", "tag": "20", "ip": None, "name": "net0", "firewall": True}]
lx = a.parse_guest_nets("lxc", {"net0": "name=eth0,bridge=br1,hwaddr=BC:24:11:00:00:01,ip=10.0.0.5/24,type=veth"})
assert lx[0]["ip"] == "10.0.0.5" and lx[0]["bridge"] == "br1"
assert a.guest_ips("qemu", {"result": [{"hardware-address": "bc:24:11:aa:bb:cc", "ip-addresses": [
    {"ip-address": "192.168.1.9", "ip-address-type": "ipv4"}, {"ip-address": "fe80::1", "ip-address-type": "ipv6"}]}]}) == {
    "BC:24:11:AA:BB:CC": ["192.168.1.9"]}

# Topology graph.
net = [{"iface": "enp1s0", "type": "eth", "active": 1}, {"iface": "br0", "type": "bridge", "active": 1, "bridge_ports": "enp1s0",
       "cidr": "192.168.1.2/24", "gateway": "192.168.1.1"}, {"iface": "br0.30", "type": "vlan", "active": 1}]
guests = [{"type": "qemu", "vmid": 100, "name": "web", "status": "running", "nets": q, "ips": {"BC:24:11:AA:BB:CC": ["192.168.1.9"]}}]
wg = {"enabled": True, "port": 51820, "subnet": "10.8.0.0/24", "wan": "br0", "peers": [{"name": "phone", "ip": "10.8.0.2", "public_key": "k"}]}
router = {"wan": "br0", "forwards": [{"proto": "tcp", "ext_port": "443", "int_ip": "192.168.1.9", "int_port": None}]}
t = a.build_topology(net, a.parse_ip_links('[{"ifname":"enp1s0","address":"aa:bb:cc:dd:ee:ff","operstate":"UP"}]'),
                     guests, wg, {"wg0": {"peers": []}}, router)
ids = {n["id"] for n in t["nodes"]}
assert {"internet", "if:enp1s0", "if:br0", "if:br0.30", "qemu:100", "wg:wg0", "peer:phone", "fwd:0"} <= ids, ids
pairs = {(e["source"], e["target"]) for e in t["edges"]}
assert {("internet", "if:enp1s0"), ("if:enp1s0", "if:br0"), ("if:br0", "if:br0.30"), ("if:br0", "qemu:100"),
        ("if:br0", "wg:wg0"), ("wg:wg0", "peer:phone"), ("if:br0", "fwd:0"), ("fwd:0", "qemu:100")} <= pairs, pairs
assert next(n for n in t["nodes"] if n["id"] == "if:enp1s0")["mac"] == "AA:BB:CC:DD:EE:FF"
assert next(n for n in t["nodes"] if n["id"] == "qemu:100")["ip"] == "192.168.1.9"

print("automation self-check OK")
