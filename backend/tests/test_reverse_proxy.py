"""Reverse proxy & SSL + module orchestrator self-check. Run: python -m tests.test_reverse_proxy (from backend/)."""
import base64
import hashlib
import io
import os
import tarfile
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from cryptography import x509  # noqa: E402
from cryptography.x509.oid import ExtensionOID  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import platform_modules as pm, reverse_proxy as rp, secrets_vault  # noqa: E402


def bad(model, **kw):
    try:
        model(**kw)
    except ValidationError:
        return True
    raise AssertionError(f"{model.__name__} accepted {kw}")


# ---- Models: everything that reaches an nginx file is validated.
h = rp.HostBody(domain_names=["AI.solardeck.local", "*.media.example.com"], upstream_host="192.168.1.20", upstream_port=8080)
assert h.domain_names == ["ai.solardeck.local", "*.media.example.com"]
assert bad(rp.HostBody, domain_names=["bad domain"], upstream_host="10.0.0.1", upstream_port=80)
assert bad(rp.HostBody, domain_names=["a.com", "a.com"], upstream_host="10.0.0.1", upstream_port=80)
assert bad(rp.HostBody, domain_names=["a.com"], upstream_host="10.0.0.1; rm -rf /", upstream_port=80)
assert bad(rp.HostBody, domain_names=["a.com"], upstream_host="10.0.0.1", upstream_port=80, client_max_body_size="1t; x")
for snippet in ("include /etc/passwd;", "root /;", "alias /etc/;", "location / { }", "proxy_buffering off", "lua_code_cache off;"):
    assert bad(rp.HostBody, domain_names=["a.com"], upstream_host="10.0.0.1", upstream_port=80, custom_nginx_config=snippet), snippet
assert rp.check_snippet("# tuning\nproxy_buffering off;\n\nadd_header X-Frame-Options DENY;") == \
    "proxy_buffering off;\nadd_header X-Frame-Options DENY;"
assert bad(rp.StreamBody, listen_port=443, upstream_host="10.0.0.5", upstream_port=22)
assert bad(rp.AcmeBody, domains=["*.example.com"], email="a@b.nl")  # wildcards need DNS-01
assert bad(rp.AcmeBody, domains=["a.example.com"], email="a@b.nl", challenge="dns-01")  # no plugin / credentials
rp.AcmeBody(domains=["*.example.com"], email="a@b.nl", challenge="dns-01", dns_plugin="dns_cf", credentials={"CF_Token": "abcd"})

# ---- Rendering a proxy host: TLS, websockets, rate limit, ACL, SSO gate.
host = {"id": "a1b2c3d4", **rp.HostBody(domain_names=["ai.solardeck.local"], upstream_host="10.0.0.20", upstream_port=3000,
                                         rate_limit_rpm=600, hsts_enabled=True, solardeck_sso_auth=True,
                                         custom_nginx_config="proxy_buffering off;").model_dump()}
acl = {"id": "0000aaaa", "allow": ["192.168.0.0/16"], "deny": [], "satisfy": "all", "users": [{"username": "bob", "hash": "{SSHA}x"}]}
conf = rp.render_host(host, "c0ffee00", acl, "https://192.168.1.230")
for needle in ("limit_req_zone $binary_remote_addr zone=sd_a1b2c3d4:10m rate=600r/m;", "listen 443 ssl http2;",
               f"ssl_certificate {rp.BASE}/certs/c0ffee00.crt;", "return 301 https://$host$request_uri;",
               "proxy_pass http://10.0.0.20:3000;", "proxy_set_header Upgrade $http_upgrade;",
               "Strict-Transport-Security", "allow 192.168.0.0/16;", "deny all;", f"{rp.BASE}/access/0000aaaa.htpasswd",
               "auth_request /__solardeck_auth;", "proxy_pass https://192.168.1.230/api/proxy/auth/verify;",
               "location = /__solardeck_gate", "error_page 401 = @solardeck_login;", "proxy_buffering off;",
               "/.well-known/acme-challenge/", "limit_req zone=sd_a1b2c3d4"):
    assert needle in conf, needle
assert conf.count("{") == conf.count("}")
plain = rp.render_host({**host, "solardeck_sso_auth": False, "rate_limit_rpm": None, "websocket_support": False,
                        "custom_nginx_config": ""}, None, None, "")
assert "listen 443" not in plain and "auth_request" not in plain and "Upgrade" not in plain and "limit_req" not in plain
assert "proxy_pass http://[fd00::5]:80;" in rp.render_host({**host, "upstream_host": "fd00::5", "upstream_port": 80}, None, None, "")

streams = rp.render_streams([{"id": "1", "protocol": "both", "listen_port": 25565, "upstream_host": "10.0.0.9",
                              "upstream_port": 25565, "comment": "game", "enabled": True},
                             {"id": "2", "protocol": "tcp", "listen_port": 2222, "upstream_host": "10.0.0.8", "upstream_port": 22,
                              "enabled": False}])
assert "listen 25565;" in streams and "listen 25565 udp;" in streams and "2222" not in streams

# ---- htpasswd {SSHA}: verifiable the way nginx checks it.
line = rp.htpasswd_line("bob", "s3cret-pass")
user, digest = line.split(":", 1)
raw = base64.b64decode(digest[6:])
assert user == "bob" and digest.startswith("{SSHA}") and hashlib.sha1(b"s3cret-pass" + raw[20:]).digest() == raw[:20]

# ---- Private root CA + leaf: chain, SANs, CA flags.
ca_pem, ca_key = rp.make_root_ca("Test Root", "ecdsa-p384", 5)
ca = x509.load_pem_x509_certificate(ca_pem.encode())
assert ca.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS).value.ca
leaf_pem, leaf_key = rp.issue_leaf(ca_pem, ca_key, ["*.solardeck.local", "solardeck.local"], ["192.168.1.230"], 397)
leaf = x509.load_pem_x509_certificate(leaf_pem.encode())
leaf.verify_directly_issued_by(ca)
sans = leaf.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
assert sans.get_values_for_type(x509.DNSName) == ["*.solardeck.local", "solardeck.local"]
assert [str(i) for i in sans.get_values_for_type(x509.IPAddress)] == ["192.168.1.230"]
rsa_pem, _ = rp.make_root_ca("RSA Root", "rsa-4096", 1)
assert x509.load_pem_x509_certificate(rsa_pem.encode()).public_key().key_size == 4096

# Certificate records keep the key encrypted; the public view never shows it.
rec = rp.cert_record("self_signed", "", leaf_pem, leaf_key, chain=ca_pem)
assert rec["key_pem"].startswith(secrets_vault.PREFIX) and rp.key_of(rec) == leaf_key.strip()
assert "key_pem" not in rp.public_cert(rec) and rp.public_cert(rec)["has_key"] and rec["name"] == "*.solardeck.local"

# ---- Bundle + tarball: every file, secrets mode 600, disabled hosts left out.
state = {**rp.blank(), "hosts": [host, {**host, "id": "deadbeef", "enabled": False, "domain_names": ["off.local"]}],
         "certificates": [{**rec, "id": "c0ffee00"}], "access_lists": [{**acl}], "streams": []}
state["hosts"][0]["certificate_id"], state["hosts"][0]["access_list_id"] = "c0ffee00", "0000aaaa"
files = rp.bundle(state, "https://10.0.0.1")
assert set(files) == {"http/00-common.conf", "stream/streams.conf", "certs/c0ffee00.crt", "certs/c0ffee00.key",
                      "access/0000aaaa.htpasswd", "http/a1b2c3d4.conf"}, set(files)
assert "BEGIN PRIVATE KEY" in files["certs/c0ffee00.key"] and files["certs/c0ffee00.crt"].count("BEGIN CERTIFICATE") == 2
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(rp.tarball(files)))) as tar:
    modes = {m.name: m.mode for m in tar.getmembers()}
assert modes["certs/c0ffee00.key"] == 0o600 and modes["http/a1b2c3d4.conf"] == 0o644
script = rp.apply_script("QUJD")
assert "nginx -t" in script and "mv " + rp.BASE + ".old " + rp.BASE in script and "QUJD" in script

# ---- ACME output: the key never reaches the log text.
log, cert, key = rp.split_acme_output("==> Requesting\nok\n@@CERT@@\n-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n"
                                      "@@KEY@@\n-----BEGIN EC PRIVATE KEY-----\ny\n-----END EC PRIVATE KEY-----\n@@END@@\n")
assert "PRIVATE" not in log and cert.startswith("-----BEGIN CERTIFICATE") and key.endswith("PRIVATE KEY-----")
assert "--webroot" in rp.acme_script(rp.AcmeBody(domains=["a.example.com"], email="a@b.nl"))
dns = rp.acme_script(rp.AcmeBody(domains=["*.example.com"], email="a@b.nl", challenge="dns-01", dns_plugin="dns_cf",
                                 credentials={"CF_Token": "tok-123"}))
assert "--dns dns_cf" in dns and "export CF_Token=tok-123" in dns and "letsencrypt" in dns

# ---- SSO gate tokens: purpose and host are bound.
t = rp._gate_token({"sub": "admin", "sid": "s1", "host": "ai.solardeck.local", "purpose": "gate"}, 60)
assert rp._gate_claims(t, "gate")["host"] == "ai.solardeck.local" and rp._gate_claims(t, "gate-ticket") is None
assert rp._gate_claims("garbage", "gate") is None

# ---- Module orchestrator: profiles and least-privilege isolation rules.
mods = {mid: pm.default_profile(mid) for mid in pm.MODULE_IDS}
assert mods["reverse_proxy"]["recommended_runtime_mode"] == "container" and mods["ups_power"]["recommended_runtime_mode"] == "host_native"
assert "/api/" not in pm.render_isolation_rules(mods, ["192.168.1.0/24"])
assert "dport" not in pm.render_isolation_rules(mods, ["192.168.1.0/24"])  # all on management / off: no rules
mods["reverse_proxy"].update(enabled=True, runtime_mode="container", network_isolation_mode="dmz", bound_bridge="br0",
                             bound_vlan_id=40, service_ip="10.40.0.5")
mods["storage_protocols"].update(enabled=True, network_isolation_mode="vlan", bound_bridge="br1", bound_vlan_id=None)
rules = pm.render_isolation_rules(mods, ["192.168.1.10/24", "fd00::1/64"])
assert 'iifname != "br0.40" tcp dport 443 drop' in rules and 'iifname != "br0.40" tcp dport 80 drop' in rules
assert "ip saddr 10.40.0.5 ip daddr { 192.168.1.0/24 } ct state new drop" in rules
assert 'iifname != "br1" tcp dport 2049 drop' in rules and 'iifname != "br1" udp dport 111 drop' in rules
assert "ct state established,related accept" in rules and rules.count("{") == rules.count("}")
mods["reverse_proxy"]["security_hardening"]["auto_firewall_rules"] = False
assert "br0.40" not in pm.render_isolation_rules(mods, ["192.168.1.0/24"])
assert f"nft delete table inet {pm.NFT_TABLE}" in pm.render_rules_script("x")
assert bad(pm.ProfileBody, enabled=True, runtime_mode="container", bound_bridge="br0; reboot")

# Profiles persist and keep their spec fields current.
pm.STATE = type(pm.STATE)(tempfile.mkdtemp()) / "platform_modules.json"
p = pm.update_profile("reverse_proxy", enabled=True, recommended_runtime_mode="host_native")
assert pm.profile("reverse_proxy")["enabled"] and pm.profile("reverse_proxy")["recommended_runtime_mode"] == "container"
assert oct(pm.STATE.stat().st_mode & 0o777) == "0o600"

print("reverse proxy & module orchestrator: all checks passed")
