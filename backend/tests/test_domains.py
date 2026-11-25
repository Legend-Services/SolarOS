"""Domains + Let's Encrypt self-check. Run: python -m tests.test_domains (from backend/)."""
import asyncio
import datetime as dt
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import domains as d, host_ssh, net_services as ns  # noqa: E402


def bad(model, **kw):
    try:
        model(**kw)
    except ValidationError:
        return True
    raise AssertionError(f"{model.__name__} accepted {kw}")


# Host names → dnsmasq records.
state = {"domains": [{"name": "legendhosting.nl", "hosts": [{"name": "solardeck", "ip": "192.168.68.230"},
                                                            {"name": "@", "ip": "192.168.68.220"},
                                                            {"name": "nas.lan", "ip": "fd00::5"}]}]}
assert d.domain_records(state) == [
    {"type": "A", "name": "solardeck.legendhosting.nl", "value": "192.168.68.230"},
    {"type": "A", "name": "legendhosting.nl", "value": "192.168.68.220"},
    {"type": "AAAA", "name": "nas.lan.legendhosting.nl", "value": "fd00::5"},
], d.domain_records(state)
conf = ns.render_dnsmasq_dns({**ns.DNS_DEFAULT, "enabled": True, "interfaces": ["br0"], "records": d.domain_records(state)})
assert "host-record=solardeck.legendhosting.nl,192.168.68.230" in conf and "host-record=legendhosting.nl,192.168.68.220" in conf

# Validation of everything that reaches dnsmasq, a shell or acme.sh.
d.HostsBody(hosts=[{"name": "solardeck", "ip": "192.168.68.230"}, {"name": "@", "ip": "10.0.0.1"}])
assert bad(d.HostsBody, hosts=[{"name": "a", "ip": "10.0.0.1"}, {"name": "a", "ip": "10.0.0.2"}])  # duplicate
for name in ("Solar Deck", "-x", "a;b", "x,y", "a..b"):
    assert bad(d.HostEntry, name=name, ip="10.0.0.1")
assert bad(d.HostEntry, name="ok", ip="999.1.1.1")
d.DomainBody(name="legendhosting.nl")
for name in ("legendhosting", "LegendHosting.nl", "a b.nl", "x.nl;rm", "-a.nl"):
    assert bad(d.DomainBody, name=name)
good = {"fqdn": "solardeck.legendhosting.nl", "email": "me@example.com", "plugin": "dns_cf", "credentials": {"CF_Token": "  abc123token  "}}
assert d.CertBody(**good).credentials == {"CF_Token": "abc123token"}
assert bad(d.CertBody, **{**good, "plugin": "cf; rm -rf /"})
assert bad(d.CertBody, **{**good, "credentials": {"cf_token": "x"}})  # env names must be upper case
assert bad(d.CertBody, **{**good, "credentials": {"CF_Token": "a\nb"}})
assert bad(d.CertBody, **{**good, "credentials": {}})
assert bad(d.CertBody, **{**good, "email": "not-an-email"})

# Secrets never reach the log.
assert d.mask("Using CF_Token=abc123token for zone", ["abc123token"]) == "Using CF_Token=•••••• for zone"
assert d.mask("short x", ["x"]) == "short x"  # 1-3 character values are not masked (would garble the log)


# Certificate facts.
def make_cert(subject: str, issuer: str, issuer_org: str | None, days: int) -> bytes:
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    iss = [x509.NameAttribute(NameOID.COMMON_NAME, issuer)] + ([x509.NameAttribute(NameOID.ORGANIZATION_NAME, issuer_org)] if issuer_org else [])
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)]))
            .issuer_name(x509.Name(iss)).public_key(key.public_key()).serial_number(1)
            .not_valid_before(now).not_valid_after(now + dt.timedelta(days=days))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(subject)]), critical=False).sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM)


le = d.cert_info(make_cert("solardeck.legendhosting.nl", "E6", "Let's Encrypt", 90))
assert le["lets_encrypt"] and not le["self_signed"] and le["names"] == ["solardeck.legendhosting.nl"] and le["issuer"] == "Let's Encrypt", le
ss = d.cert_info(make_cert("SolarDeck self-signed", "SolarDeck self-signed", None, 825))
assert ss["self_signed"] and not ss["lets_encrypt"] and ss["expires"] > le["expires"], ss

# Integration: changing host names re-renders dnsmasq with them (host SSH faked).
files: dict[str, str] = {f"{ns.STATE_DIR}/dns.json": '{"enabled": true, "interfaces": ["br0"]}'}


async def fake_read(path, default=""):
    return files.get(path, default)


async def fake_write(path, content, mode="644"):
    files[path] = content


async def fake_run(cmd, **kw):
    return "dnsmasq: syntax check OK." if "dnsmasq --test" in cmd else ""


async def fake_cmd(cmd, timeout=10):
    return True, "installed\n", ""


host_ssh.read_file, host_ssh.write_file, host_ssh.run, host_ssh.run_host_cmd = fake_read, fake_write, fake_run, fake_cmd
asyncio.run(d.add_domain(d.DomainBody(name="legendhosting.nl")))
r = asyncio.run(d.set_hosts(d.HostsBody(hosts=[{"name": "solardeck", "ip": "192.168.68.230"}]), "legendhosting.nl"))
assert r["dns_applied"] is True and "host-record=solardeck.legendhosting.nl,192.168.68.230" in files[ns.DNS_CONF], files.get(ns.DNS_CONF)
try:
    asyncio.run(d.add_domain(d.DomainBody(name="legendhosting.nl")))
    raise AssertionError("duplicate domain accepted")
except Exception as e:  # noqa: BLE001
    assert getattr(e, "status_code", None) == 409
try:
    asyncio.run(d.request_certificate(d.CertBody(**{**good, "fqdn": "example.org"})))
    raise AssertionError("certificate for a foreign domain accepted")
except Exception as e:  # noqa: BLE001
    assert getattr(e, "status_code", None) == 400
r = asyncio.run(d.delete_domain("legendhosting.nl"))
assert r["domains"] == [] and "legendhosting" not in files[ns.DNS_CONF]
print("domains: ok")
