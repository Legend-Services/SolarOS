"""Core OS modules self-check (RBAC, firewall & IDS, UPS, out-of-band, storage extensions, image hub, disaster recovery).
Run: python -m tests.test_core_modules (from backend/)."""
import io
import json
import os
import tarfile
import tempfile
import time
from pathlib import Path

_tmp = tempfile.mkdtemp()
os.environ.update(STORAGE_ROOT=_tmp, ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32,
                  **{k: f"{_tmp}/{k.lower()}" for k in ("SESSIONS_FILE", "LOGIN_FAILURES_FILE", "AUDIT_LOG_FILE",
                                                         "SECURITY_FILE", "VAULT_KEY_FILE")})

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import (disaster_recovery as dr, image_hub as ih, oob_control as oob, rbac, storage_extensions as se,  # noqa: E402
                 ups_power as ups, vlan_firewall as fw)


def bad(model, **kw):
    try:
        model(**kw)
    except ValidationError:
        return True
    raise AssertionError(f"{model.__name__} accepted {kw}")


# ---- RBAC: role and scope decisions.
viewer = {"username": "v", "role": "viewer", "enabled": True}
op = {"username": "o", "role": "operator", "enabled": True}
seat = {"username": "s", "role": "seat_user", "enabled": True, "allowed_vm_ids": [105], "allowed_seat_ids": ["seat-1"]}
assert rbac.decide(viewer, "GET", "/api/v1/guests") and not rbac.decide(viewer, "POST", "/api/v1/guests/qemu/105/action")
assert not rbac.decide(viewer, "GET", "/api/net/wg/peers/phone/conf")  # secret material
assert rbac.decide(op, "POST", "/api/v1/guests/qemu/200/action") and rbac.decide(op, "PUT", "/api/proxy/hosts/abcd1234")
for path in ("/api/rbac/users", "/api/auth/2fa/setup", "/api/platform/modules/rbac_users", "/api/cluster/create",
             "/api/v1/guests/node/0/terminal", "/api/dr/host-restore"):
    assert not rbac.decide(op, "POST", path), path
assert rbac.decide(seat, "POST", "/api/v1/guests/qemu/105/action") and rbac.decide(seat, "POST", "/api/v1/guests/qemu/105/vnc")
assert not rbac.decide(seat, "POST", "/api/v1/guests/qemu/106/action")
assert rbac.decide(seat, "POST", "/api/multiseat/seats/seat-1/start") and not rbac.decide(seat, "POST", "/api/multiseat/seats/seat-2/start")
assert rbac.decide(seat, "GET", "/api/v1/guests") and not rbac.decide(seat, "GET", "/api/storage/nfs")
assert not rbac.decide(seat, "DELETE", "/api/multiseat/seats/seat-1")
assert rbac.decide(None, "GET", "/api/auth/me") and not rbac.decide(None, "GET", "/api/v1/guests")
assert not rbac.decide({**op, "enabled": False}, "GET", "/api/v1/guests")
assert rbac.authorize("admin", "POST", "/api/rbac/users")  # the administrator is never limited
assert bad(rbac.NewUserBody, username="Bad Name", role="viewer")
assert bad(rbac.NewUserBody, username="eve", role="root")

# ---- Firewall zones & IDS.
state = {"zones": [{"id": "lan", "name": "LAN", "kind": "management", "interfaces": ["br0"]},
                   {"id": "dmz", "name": "DMZ", "kind": "dmz", "interfaces": ["br0.40", "br1"]}],
         "rules": [{"source_zone": "dmz", "dest_zone": "lan", "protocol": "tcp", "port_range": "22", "action": "accept", "log": True},
                   {"source_zone": "dmz", "dest_zone": "lan", "protocol": "any", "port_range": "", "action": "drop", "log": False},
                   {"source_zone": "lan", "dest_zone": "dmz", "protocol": "icmp", "port_range": "", "action": "reject", "enabled": False},
                   {"source_zone": "ghost", "dest_zone": "lan", "protocol": "any", "port_range": "", "action": "drop"}]}
nft = fw.render_zone_rules(state)
assert 'set z_dmz { type ifname; elements = { "br0.40", "br1" } }' in nft
assert 'iifname @z_dmz oifname @z_lan meta l4proto tcp th dport 22 log prefix "sd-fw-1 " counter accept' in nft
assert 'iifname @z_dmz oifname @z_lan counter drop comment "rule 2"' in nft
assert "icmp" not in nft and "ghost" not in nft and nft.count("{") == nft.count("}")
assert nft.index("rule 1") < nft.index("rule 2")  # order is kept: first match wins
assert bad(fw.RuleBody, source_zone="a", dest_zone="b", protocol="any", port_range="22")
assert bad(fw.ZoneBody, id="x", name="x", interfaces=["br0; reboot"])
jails = fw.render_jails({"jails": ["sshd", "recidive"], "bantime": 600, "findtime": 600, "maxretry": 3, "ignoreip": ["192.168.0.0/16"]})
assert "[sshd]\nenabled = true\nbackend = systemd" in jails and "[nginx-http-auth]\nenabled = false" in jails
assert "ignoreip = 127.0.0.1/8 ::1 192.168.0.0/16" in jails
st = fw.parse_jail_status("Status for the jail: sshd\n|- Filter\n|  |- Currently failed: 2\n|  `- Total failed: 9\n"
                          "`- Actions\n   |- Currently banned: 2\n   |- Total banned: 4\n   `- Banned IP list: 1.2.3.4 5.6.7.8\n")
assert st == {"failed": 2, "banned_total": 4, "banned": ["1.2.3.4", "5.6.7.8"]}
assert bad(fw.BanBody, jail="sshd", ip="1.2.3.4; reboot")

# ---- UPS.
s = ups.parse_upsc("battery.charge: 42\nbattery.runtime: 610\nups.load: 23\ninput.voltage: 0.0\nups.status: OB DISCHRG\ndevice.model: Back-UPS 900\n")
assert s["on_battery"] and s["charge_percent"] == 42 and s["runtime_seconds"] == 610 and s["model"] == "Back-UPS 900"
cfg = {**ups.DEFAULT, "shutdown_charge_percent": 40, "shutdown_runtime_seconds": 180}
assert not ups.must_shut_down(s, {**cfg, "shutdown_charge_percent": 20})
assert ups.must_shut_down({**s, "charge_percent": 39}, cfg)
assert ups.must_shut_down({**s, "charge_percent": 90, "runtime_seconds": 120}, cfg)
assert not ups.must_shut_down({**s, "on_battery": False, "charge_percent": 5}, cfg)
assert ups.must_shut_down({**s, "low_battery": True, "charge_percent": 90}, cfg)
assert not ups.parse_upsc("")["online"]
guests = [{"vmid": 100, "type": "lxc", "status": "running"}, {"vmid": 101, "type": "qemu", "status": "running"},
          {"vmid": 102, "type": "qemu", "status": "stopped"}, {"vmid": 103, "type": "qemu", "status": "running"}]
assert [g["vmid"] for g in ups.shutdown_sequence(guests, [103])] == [103, 101, 100]
nut = ups.render_nut({**ups.DEFAULT, "password": "pw123"})
assert "MODE=standalone" in nut["/etc/nut/nut.conf"] and "driver = usbhid-ups" in nut["/etc/nut/ups.conf"]
assert "MONITOR solardeck@localhost 1 solardeck pw123 primary" in nut["/etc/nut/upsmon.conf"]
net = ups.render_nut({**ups.DEFAULT, "mode": "netclient", "remote": "ups@10.0.0.2", "password": "x"})
assert "MODE=netclient" in net["/etc/nut/nut.conf"] and "/etc/nut/ups.conf" not in net and "secondary" in net["/etc/nut/upsmon.conf"]
wed = time.struct_time((2026, 11, 25, 23, 0, 0, 2, 329, 0))
assert ups.due_profile([{"at": "23:00", "days": ["wed"], "profile": "eco"}], wed) == "eco"
assert ups.due_profile([{"at": "23:00", "days": ["thu"], "profile": "eco"}], wed) is None
assert bad(ups.UpsBody, driver="usbhid-ups; reboot")

# ---- Out-of-band.
pkt = oob.magic_packet("aa:bb:cc:dd:ee:ff")
assert len(pkt) == 102 and pkt[:6] == b"\xff" * 6 and pkt[6:12] == bytes.fromhex("aabbccddeeff")
sdr = oob.parse_sdr("CPU Temp         | 30h | ok  |  3.1 | 45 degrees C\nFan1             | 41h | ok  | 29.1 | 4800 RPM\n")
assert sdr == [{"name": "CPU Temp", "status": "ok", "reading": "45 degrees C"}, {"name": "Fan1", "status": "ok", "reading": "4800 RPM"}]
script = oob.ipmi_script({"password": "p'w", "address": "10.0.0.9", "username": "admin"}, "chassis power on")
assert "export IPMI_PASSWORD='p'\"'\"'w'" in script and "-E chassis power on" in script and "p'w" not in script.split("\n")[-2]
assert bad(oob.BmcBody, name="x", address="10.0.0.1; reboot")

# ---- Storage extensions.
assert se.host_path("/tank/media/") == "/tank/media" and se.host_path("/var/lib/vz/dump") == "/var/lib/vz/dump"
for p in ("/", "/etc", "/etc/ssh", "relative/path", "/mnt/../etc", "/root/x", "/var/log"):
    try:
        se.host_path(p)
        raise AssertionError(p)
    except ValueError:
        pass
assert se.rel_path("../../etc/passwd") == "etc/passwd" and se.rel_path("") == "" and se.rel_path("docs/a.txt") == "docs/a.txt"
exp = se.render_exports([{"name": "media", "path": "/tank/media", "clients": [{"network": "192.168.1.0/24", "read_only": True, "root_squash": True},
                                                                             {"network": "10.0.0.5", "read_only": False, "root_squash": False}]}])
assert '"/tank/media" 192.168.1.0/24(ro,sync,no_subtree_check,root_squash) 10.0.0.5(rw,sync,no_subtree_check,no_root_squash)' in exp
dav = se.render_webdav(8090, [{"name": "media", "path": "/tank/media", "read_only": True}, {"name": "drop", "path": "/tank/drop", "read_only": False}])
assert "listen 8090 ssl;" in dav and "limit_except GET HEAD OPTIONS PROPFIND { deny all; }" in dav and "dav_methods PUT DELETE MKCOL COPY MOVE;" in dav
assert dav.count("{") == dav.count("}")
listing = se.parse_listing("f\t12\t1700000000.5\tb.txt\nd\t4096\t1700000000\tA dir\n")
assert [x["name"] for x in listing] == ["A dir", "b.txt"] and listing[1]["size"] == 12
lsblk = json.dumps({"blockdevices": [{"name": "sdb", "tran": "usb", "size": "1T", "model": "Ext ", "type": "disk",
                                      "children": [{"name": "sdb1", "fstype": "exfat", "label": "BACKUP", "type": "part"}]},
                                     {"name": "nvme0n1", "tran": "nvme", "type": "disk"}]})
drives = se.usb_drives(lsblk, "usb-Ext_123-0:0 /dev/sdb\nusb-Ext_123-0:0-part1 /dev/sdb1\nnvme-x /dev/nvme0n1\n")
assert [d["device"] for d in drives] == ["/dev/disk/by-id/usb-Ext_123-0:0", "/dev/disk/by-id/usb-Ext_123-0:0-part1"]
assert drives[1]["label"] == "BACKUP" and drives[0]["model"] == "Ext"
assert bad(se.UsbMountBody, device="/dev/sda", name="x")
assert bad(se.RestoreBody, dataset="tank/data", snapshot="s1", path="..")

# ---- Image hub & zero-touch.
sums = ih.parse_sums("abc123" * 8 + "  ubuntu-24.04.2-live-server-amd64.iso\n" + "def456" * 8 + " *ubuntu-24.04.10-live-server-amd64.iso\n"
                     "SHA256 (AlmaLinux-9.6-x86_64-minimal.iso) = " + "0a" * 32 + "\n")
assert ih.pick(sums, r"ubuntu-24\.04(\.[0-9]+)?-live-server-amd64\.iso")[0] == "ubuntu-24.04.10-live-server-amd64.iso"
assert ih.pick(sums, r"AlmaLinux-9\.[0-9]+-x86_64-minimal\.iso")[1] == "0a" * 32
assert ih.pick(sums, r"nothing") is None
assert all({"id", "name", "category", "base_url"} <= set(e) for e in ih.CATALOG) and len({e["id"] for e in ih.CATALOG}) == len(ih.CATALOG)
zt = ih.ZeroTouchBody(image_volume="local:iso/noble-server-cloudimg-amd64.img", vmid=150, name="web01", storage="local-zfs",
                      bridge="br0", vlan_tag=40, password="correct-horse", ssh_keys=["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc"],
                      network={"cidr": "192.168.40.10/24", "gateway": "192.168.40.1"})
ud = ih.user_data(zt)
assert ud.startswith("#cloud-config\n") and "hostname: web01" in ud and "qemu-guest-agent" in ud and '"correct-horse"' in ud
assert "addresses: [192.168.40.10/24]" in ih.network_config(zt) and "via: 192.168.40.1" in ih.network_config(zt)
assert bad(ih.ZeroTouchBody, image_volume="local:iso/x.img", vmid=150, name="a", storage="local")  # no password or key
assert bad(ih.ZeroTouchBody, image_volume="local:iso/x.img", vmid=150, name="a", storage="local", ssh_keys=["not a key"])
assert bad(ih.ZeroTouchBody, image_volume="local:iso/../../etc.img", vmid=150, name="a", storage="local", password="longenough")

# ---- Disaster recovery: sealing, bundles, safe extraction, rclone.
blob = dr.seal(b"secret config", "a long passphrase")
assert blob.startswith(dr.MAGIC) and b"secret config" not in blob and dr.unseal(blob, "a long passphrase") == b"secret config"
for broken in (lambda: dr.unseal(blob, "wrong passphrase!"), lambda: dr.unseal(blob[:-1] + bytes([blob[-1] ^ 1]), "a long passphrase"),
               lambda: dr.unseal(b"nope", "a long passphrase")):
    try:
        broken()
        raise AssertionError("unseal accepted a bad archive")
    except HTTPException as e:
        assert e.status_code == 400
d = Path(tempfile.mkdtemp())
(d / "settings.json").write_text("{}")
(d / "audit_log.jsonl").write_text("big")
(d / "x.tmp").write_text("partial")
env = d / ".env"
env.write_text("JWT_SECRET=x")
with tarfile.open(fileobj=io.BytesIO(dr.pack_local(d, env))) as tar:
    assert sorted(tar.getnames()) == ["data/.env", "data/settings.json", "env/.env"], tar.getnames()
parts = dr.unbundle(dr.bundle(b"L", b"H", {"node": "host1"}))
assert parts["local.tar.gz"] == b"L" and json.loads(parts["meta.json"]) == {"node": "host1"}
evil = io.BytesIO()
with tarfile.open(fileobj=evil, mode="w") as tar:
    for name in ("data/ok.json", "../etc/passwd", "/etc/shadow", "data/../../x", "other/y"):
        info = tarfile.TarInfo(name)
        tar.addfile(info, io.BytesIO(b""))
evil.seek(0)
with tarfile.open(fileobj=evil) as tar:
    assert [m.name for m in dr.safe_members(tar, ("data/", "env/"))] == ["data/ok.json"]
t = {"type": "sftp", "endpoint": "backup.example.net", "username": "sd", "port": 2222, "bucket": "solardeck",
     "password": dr.secrets_vault.encrypt("s3cret"), "retention_days": 30, "include_hypervisor_backups": True}
script = dr.offsite_script(t, ["/var/lib/solardeck/dr-outbox"])
assert "export RCLONE_CONFIG_SD_TYPE=sftp" in script and "RCLONE_CONFIG_SD_PASS=$(rclone obscure s3cret)" in script
assert "rclone copy /var/lib/solardeck/dr-outbox sd:solardeck/dr-outbox" in script and "--min-age 30d" in script
assert dr.rclone_env({"type": "s3", "endpoint": "https://s3.example.com", "region": "", "access_key_id": "AK",
                      "secret_access_key": dr.secrets_vault.encrypt("SK")})["SECRET_ACCESS_KEY"] == "SK"
assert "secret_access_key" not in dr.target_view({"secret_access_key": "x", "password": "", "name": "n"})
assert dr.sources_for({"include_hypervisor_backups": False}, "container") == [f"/mnt/storage/backups/{dr.P}-dr"]
assert bad(dr.SnapshotBody, passphrase="short")

# ---- RBAC end to end through the real app: an extra account signs in and the middleware applies its role.
from fastapi.testclient import TestClient  # noqa: E402

from app import accounts, platform_modules as pm  # noqa: E402
from app.main import app  # noqa: E402

pm.STATE, rbac.STATE = Path(_tmp) / "platform_modules.json", Path(_tmp) / "rbac_users.json"
rbac.save([{"username": "viewer1", "role": "viewer", "enabled": True, "password_hash": accounts.hash_password("Viewer-pass-1"),
            "allowed_vm_ids": [], "allowed_seat_ids": [], "allowed_shares": []}])
client = TestClient(app)
assert client.post("/api/auth/login", json={"username": "viewer1", "password": "Viewer-pass-1"}).status_code == 401  # module off
pm.update_profile("rbac_users", enabled=True)
r = client.post("/api/auth/login", json={"username": "viewer1", "password": "Viewer-pass-1"})
assert r.status_code == 200, r.text
auth = {"Authorization": f"Bearer {r.json()['token']}"}
assert client.get("/api/rbac/me", headers=auth).json()["role"] == "viewer"
assert client.get("/api/platform/modules", headers=auth).status_code == 200
assert client.put("/api/platform/modules/rbac_users", headers=auth, json={}).status_code == 403
assert client.post("/api/rbac/users", headers=auth, json={"username": "eve", "password": "Whatever-123"}).status_code == 403
assert client.post("/api/auth/2fa/setup", headers=auth).status_code == 403  # the administrator's 2FA is out of reach
pm.update_profile("rbac_users", enabled=False)  # switching the module off locks extra accounts out at once
assert client.get("/api/platform/modules", headers=auth).status_code == 403
assert client.get("/api/auth/me", headers=auth).status_code == 200

print("core OS modules: all checks passed")
