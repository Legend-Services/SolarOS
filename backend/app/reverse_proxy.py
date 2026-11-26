"""Built-in reverse proxy & SSL/TLS manager: proxy hosts, TCP/UDP streams, access lists, certificates and a private CA.

State (data/reverse_proxy.json, mode 600; private keys and ACME credentials encrypted with the secrets vault) is
rendered by the pure functions below into one config bundle, which is shipped as a tarball to the module's runtime:
  - container mode: the hardened `solardeck-edge-proxy` worker container (App Center system app "edge-proxy"),
    put on the module's bridge / VLAN by platform_modules;
  - host native: dedicated files under /etc/nginx/<prefix>-proxy.d/ on the host, included next to (never instead of)
    any other server, including SolarDeck's own default_server listener.
The bundle is swapped in atomically, checked with `nginx -t` and reloaded (`systemctl reload` = `nginx -s reload`, no
dropped connections); a rejected bundle restores the previous one.

SolarDeck SSO gate: a protected host asks SolarDeck (auth_request) whether the visitor's gate cookie belongs to a live
SolarDeck session (password + 2FA). Without one the visitor is sent to SolarDeck, which hands a one-time ticket back to
the proxied host; the host trades it for its own HttpOnly cookie bound to that host and session. Signing out of
SolarDeck or revoking the session ends access to every protected app at once.
"""
import asyncio
import base64
import datetime as dt
import hashlib
import io
import ipaddress
import json
import re
import secrets
import shlex
import socket
import tarfile
import time
from pathlib import Path as FsPath
from typing import Literal
from urllib.parse import quote, urlparse

import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization as ser
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from . import audit_log, platform_modules as pm, secrets_vault, sessions
from .auth import COOKIE, client_ip, require_user, session_claims
from .config import settings
from .domains import ACME_VERSION, ENV_KEY_RE, PLUGIN_RE, cert_info, mask
from .net_services import check_pem

MODULE = "reverse_proxy"
router = APIRouter(prefix="/api/proxy", tags=["reverse_proxy"], dependencies=[Depends(require_user)])
gated = [Depends(pm.require_module(MODULE))]
public = APIRouter(prefix="/api/proxy/auth", tags=["reverse_proxy_gate"])  # called by the proxy itself, no session

DATA = FsPath(__file__).resolve().parent.parent / "data"
STATE = DATA / "reverse_proxy.json"
P = settings.system_prefix
BASE = f"/etc/nginx/{P}-proxy.d"
ACME_ROOT = f"/var/lib/{P}-proxy/acme"
ACME_HOME = f"/root/.acme-{P}"
GATE_COOKIE = "sd_gate"
TICKET_TTL = 60
KEY_FIELDS = ("key_pem",)

ID_RE = r"^[0-9a-f]{8}$"
DOMAIN_RE = r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$"
HOST_RE = r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
USER_RE = r"^[A-Za-z0-9._-]{1,32}$"
SIZE_RE = r"^[0-9]{1,5}[kmgKMG]?$"
# Directives a custom snippet may never use: other files, code, or serving host paths.
FORBIDDEN = re.compile(r"\b(include|load_module|root|alias|lua\w*|perl\w*|js_\w+|ssl_certificate\w*|auth_request|"
                       r"access_by\w*|content_by\w*|client_body_temp_path|proxy_temp_path|error_log|access_log)\b")


def new_id() -> str:
    return secrets.token_hex(4)


def blank() -> dict:
    return {"hosts": [], "streams": [], "access_lists": [], "certificates": [], "root_ca": None,
            "settings": {"solardeck_url": "", "acme_email": ""}, "applied": None}


def load() -> dict:
    try:
        return {**blank(), **json.loads(STATE.read_text())}
    except (OSError, ValueError):
        return blank()


def save(state: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.chmod(0o600)
    tmp.replace(STATE)


def key_of(item: dict) -> str:
    return secrets_vault.decrypt(item.get("key_pem")) or ""


# ---------------------------------------------------------------- Models


def _host(v: str) -> str:
    try:
        return str(ipaddress.ip_address(v))
    except ValueError:
        if not re.fullmatch(HOST_RE, v):
            raise ValueError("Enter an IP address or host name")
        return v


def check_snippet(text: str) -> str:
    """A custom advanced snippet: plain `directive args;` lines (no blocks), none of the FORBIDDEN directives."""
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "{" in line or "}" in line or not line.endswith(";") or "`" in line or "$(" in line:
            raise ValueError(f"Only simple directives ending in ';' are allowed: {line[:60]}")
        if m := FORBIDDEN.search(line):
            raise ValueError(f"The directive '{m.group(1)}' is not allowed in a custom snippet")
        out.append(line)
    return "\n".join(out)


class HostBody(BaseModel):
    domain_names: list[str] = Field(min_length=1, max_length=20)
    upstream_scheme: Literal["http", "https"] = "http"
    upstream_host: str = Field(max_length=253)
    upstream_port: int = Field(ge=1, le=65535)
    websocket_support: bool = True
    http2_enabled: bool = True
    force_ssl: bool = True
    hsts_enabled: bool = False
    client_max_body_size: str = Field("512m", pattern=SIZE_RE)
    rate_limit_rpm: int | None = Field(None, ge=1, le=100_000)
    solardeck_sso_auth: bool = False
    access_list_id: str | None = Field(None, pattern=ID_RE)
    certificate_id: str | None = Field(None, pattern=ID_RE)
    custom_nginx_config: str = Field("", max_length=4000)
    enabled: bool = True

    @field_validator("domain_names")
    @classmethod
    def _domains(cls, v: list[str]) -> list[str]:
        v = [d.strip().lower() for d in v]
        bad = [d for d in v if not re.fullmatch(DOMAIN_RE, d)]
        if bad:
            raise ValueError(f"Invalid domain name: {bad[0]}")
        if len(set(v)) != len(v):
            raise ValueError("Each domain can only be listed once")
        return v

    @field_validator("upstream_host")
    @classmethod
    def _upstream(cls, v: str) -> str:
        return _host(v.strip().lower())

    @field_validator("custom_nginx_config")
    @classmethod
    def _snippet(cls, v: str) -> str:
        return check_snippet(v)


class StreamBody(BaseModel):
    protocol: Literal["tcp", "udp", "both"] = "tcp"
    listen_port: int = Field(ge=1, le=65535)
    upstream_host: str = Field(max_length=253)
    upstream_port: int = Field(ge=1, le=65535)
    comment: str = Field("", max_length=60, pattern=r"^[^\n\r\"'`$\\;{}]*$")
    enabled: bool = True

    @field_validator("upstream_host")
    @classmethod
    def _upstream(cls, v: str) -> str:
        return _host(v.strip().lower())

    @field_validator("listen_port")
    @classmethod
    def _reserved(cls, v: int) -> int:
        if v in (80, 443):
            raise ValueError("Ports 80 and 443 belong to the proxy hosts")
        return v


class BasicUser(BaseModel):
    username: str = Field(pattern=USER_RE)
    password: str | None = Field(None, min_length=8, max_length=128, pattern=r"^[^\r\n:]*$")  # None keeps the current one


class AccessListBody(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern=r"^[^\n\r\"'`$\\;{}]*$")
    allow: list[str] = Field([], max_length=100)
    deny: list[str] = Field([], max_length=100)
    satisfy: Literal["any", "all"] = "all"
    basic_auth_users: list[BasicUser] = Field([], max_length=50)

    @field_validator("allow", "deny")
    @classmethod
    def _nets(cls, v: list[str]) -> list[str]:
        return [str(ipaddress.ip_network(x.strip(), strict=False)) for x in v if x.strip()]


class RootCaBody(BaseModel):
    common_name: str = Field("SolarDeck Private Root CA", min_length=1, max_length=64, pattern=r"^[^\n\r/\\]*$")
    key_type: Literal["ecdsa-p384", "rsa-4096"] = "ecdsa-p384"
    valid_years: int = Field(10, ge=1, le=25)


class SelfSignedBody(BaseModel):
    name: str = Field("", max_length=60, pattern=r"^[^\n\r]*$")
    domains: list[str] = Field(min_length=1, max_length=50)
    ip_addresses: list[str] = Field([], max_length=20)
    valid_days: int = Field(397, ge=1, le=3650)

    @field_validator("domains")
    @classmethod
    def _domains(cls, v: list[str]) -> list[str]:
        return HostBody._domains(v)

    @field_validator("ip_addresses")
    @classmethod
    def _ips(cls, v: list[str]) -> list[str]:
        return [str(ipaddress.ip_address(x.strip())) for x in v if x.strip()]


class AcmeBody(BaseModel):
    domains: list[str] = Field(min_length=1, max_length=20)
    email: str = Field(pattern=r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$", max_length=200)
    challenge: Literal["http-01", "dns-01"] = "http-01"
    dns_plugin: str | None = Field(None, pattern=PLUGIN_RE)
    credentials: dict[str, str] = Field({}, max_length=6)
    staging: bool = False

    @field_validator("domains")
    @classmethod
    def _domains(cls, v: list[str]) -> list[str]:
        return HostBody._domains(v)

    @model_validator(mode="after")
    def _check(self):
        if self.challenge == "http-01" and any(d.startswith("*.") for d in self.domains):
            raise ValueError("Wildcard certificates need the DNS-01 challenge")
        if self.challenge == "dns-01":
            if not self.dns_plugin or not self.credentials:
                raise ValueError("DNS-01 needs a DNS provider plugin and its credentials")
            for k, val in self.credentials.items():
                if not ENV_KEY_RE.fullmatch(k) or not val.strip() or "\n" in val or "'" in val or len(val) > 500:
                    raise ValueError(f"Invalid credential {k}")
        return self


class UploadBody(BaseModel):
    name: str = Field("", max_length=60, pattern=r"^[^\n\r]*$")
    certificate: str = Field(max_length=64000)
    private_key: str = Field(max_length=16000)
    chain: str = Field("", max_length=64000)


class SettingsBody(BaseModel):
    solardeck_url: str = Field("", max_length=200, pattern=r"^(https?://[A-Za-z0-9.:\[\]-]+)?$")
    acme_email: str = Field("", max_length=200)


# ---------------------------------------------------------------- Rendering (pure, tests/test_reverse_proxy.py)


def htpasswd_line(user: str, password: str) -> str:
    """nginx auth_basic_user_file entry in {SSHA} format (salted SHA-1, the strongest scheme every nginx build reads)."""
    salt = secrets.token_bytes(8)
    return f"{user}:{{SSHA}}{base64.b64encode(hashlib.sha1(password.encode() + salt).digest() + salt).decode()}"


def is_ip(v: str) -> bool:
    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


def upstream(h: dict) -> str:
    host = f"[{h['upstream_host']}]" if ":" in h["upstream_host"] else h["upstream_host"]
    return f"{h['upstream_scheme']}://{host}:{h['upstream_port']}"


def pass_lines(target: str, var: str, by_name: bool) -> list[str]:
    """proxy_pass; a host name goes through a variable so it resolves per request (00-resolver.conf) and an
    unresolvable name fails only its own requests instead of the whole configuration."""
    return [f'    set ${var} "{target}";', f"    proxy_pass ${var};"] if by_name else [f"    proxy_pass {target};"]


def render_host(h: dict, cert_id: str | None, acl: dict | None, gate_url: str) -> str:
    names = " ".join(h["domain_names"])
    zone = f"sd_{h['id']}"
    acme = f"  location ^~ /.well-known/acme-challenge/ {{ root {ACME_ROOT}; default_type text/plain; }}\n"
    out = [f"# {names}\n"]
    if h.get("rate_limit_rpm"):
        out.append(f"limit_req_zone $binary_remote_addr zone={zone}:10m rate={h['rate_limit_rpm']}r/m;\n")
    loc = [*pass_lines(upstream(h), f"sd_up_{h['id']}", not is_ip(h["upstream_host"])), "    proxy_http_version 1.1;",
           "    proxy_set_header Host $host;", "    proxy_set_header X-Real-IP $remote_addr;",
           "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
           "    proxy_set_header X-Forwarded-Proto $scheme;", "    proxy_read_timeout 3600s;"]
    if h["upstream_scheme"] == "https":
        loc += ["    proxy_ssl_server_name on;", "    proxy_ssl_verify off;"]
    if h.get("websocket_support", True):
        loc += ["    proxy_set_header Upgrade $http_upgrade;", "    proxy_set_header Connection $sd_connection_upgrade;"]
    if h.get("rate_limit_rpm"):
        loc.append(f"    limit_req zone={zone} burst={max(5, h['rate_limit_rpm'] // 6)} nodelay;")
    if acl:
        loc += [f"    allow {n};" for n in acl["allow"]] + [f"    deny {n};" for n in acl["deny"]]
        if acl["allow"]:
            loc.append("    deny all;")
        if acl.get("users"):
            loc += ['    auth_basic "Restricted";', f"    auth_basic_user_file {BASE}/access/{acl['id']}.htpasswd;"]
        loc.append(f"    satisfy {acl.get('satisfy', 'all')};")
    gate = []
    if h.get("solardeck_sso_auth") and gate_url:
        loc[:0] = ["    auth_request /__solardeck_auth;", "    error_page 401 = @solardeck_login;"]
        gate = [f"  location = /__solardeck_auth {{\n    internal;\n    proxy_pass {gate_url}/api/proxy/auth/verify;\n"
                "    proxy_pass_request_body off;\n    proxy_set_header Content-Length \"\";\n"
                "    proxy_set_header X-Original-Host $host;\n    proxy_set_header Cookie $http_cookie;\n"
                "    proxy_ssl_verify off;\n  }\n",
                f"  location = /__solardeck_gate {{\n    proxy_pass {gate_url}/api/proxy/auth/callback$is_args$args;\n"
                "    proxy_set_header X-Original-Host $host;\n    proxy_ssl_verify off;\n  }\n",
                f"  location @solardeck_login {{ return 302 {gate_url}/api/proxy/auth/start?rd=$scheme://$host$request_uri; }}\n"]
    if h.get("custom_nginx_config"):
        loc += ["    " + x for x in h["custom_nginx_config"].splitlines()]
    body = (f"  client_max_body_size {h.get('client_max_body_size', '512m')};\n" + acme + "".join(gate) +
            "  location / {\n" + "".join(x + "\n" for x in loc) + "  }\n")
    if cert_id:
        http = (f"server {{\n  listen 80;\n  listen [::]:80;\n  server_name {names};\n{acme}"
                "  location / { return 301 https://$host$request_uri; }\n}\n") if h.get("force_ssl", True) else \
            f"server {{\n  listen 80;\n  listen [::]:80;\n  server_name {names};\n{body}}}\n"
        h2 = " http2" if h.get("http2_enabled", True) else ""
        hsts = '  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\n' if h.get("hsts_enabled") else ""
        out.append(http + f"server {{\n  listen 443 ssl{h2};\n  listen [::]:443 ssl{h2};\n  server_name {names};\n"
                   f"  ssl_certificate {BASE}/certs/{cert_id}.crt;\n  ssl_certificate_key {BASE}/certs/{cert_id}.key;\n"
                   "  ssl_protocols TLSv1.2 TLSv1.3;\n  ssl_session_cache shared:sd_ssl:10m;\n" + hsts + body + "}\n")
    else:
        out.append(f"server {{\n  listen 80;\n  listen [::]:80;\n  server_name {names};\n{body}}}\n")
    return "".join(out)


def render_streams(streams: list[dict]) -> str:
    out = ["# TCP / UDP stream forwarding\n"]
    for s in streams:
        if not s.get("enabled", True):
            continue
        host = f"[{s['upstream_host']}]" if ":" in s["upstream_host"] else s["upstream_host"]
        listens = ([f"  listen {s['listen_port']};"] if s["protocol"] in ("tcp", "both") else []) + \
                  ([f"  listen {s['listen_port']} udp;"] if s["protocol"] in ("udp", "both") else [])
        out.append(f"server {{  # {s.get('comment') or s['id']}\n" + "\n".join(listens) +
                   "\n" + "\n".join(x[2:] for x in pass_lines(f"{host}:{s['upstream_port']}", f"sd_st_{s['id']}",
                                                                 not is_ip(s["upstream_host"]))) +
                   "\n  proxy_connect_timeout 10s;\n}\n")
    return "".join(out)


COMMON_HTTP = ("# Shared by every SolarDeck proxy host\n"
               "map $http_upgrade $sd_connection_upgrade { default upgrade; '' close; }\n")


def bundle(state: dict, gate_url: str) -> dict[str, str]:
    """Every file of the proxy, relative to BASE."""
    certs = {c["id"]: c for c in state["certificates"]}
    acls = {a["id"]: a for a in state["access_lists"]}
    files = {"http/00-common.conf": COMMON_HTTP, "stream/streams.conf": render_streams(state["streams"])}
    for c in certs.values():
        files[f"certs/{c['id']}.crt"] = c["cert_pem"].strip() + "\n" + (c.get("chain") or "").strip() + "\n"
        files[f"certs/{c['id']}.key"] = key_of(c).strip() + "\n"
    for a in acls.values():
        if a.get("users"):
            files[f"access/{a['id']}.htpasswd"] = "".join(f"{u['username']}:{u['hash']}\n" for u in a["users"])
    for h in state["hosts"]:
        if h.get("enabled", True):
            cid = h.get("certificate_id") if h.get("certificate_id") in certs else None
            files[f"http/{h['id']}.conf"] = render_host(h, cid, acls.get(h.get("access_list_id") or ""), gate_url)
    return files


def tarball(files: dict[str, str]) -> str:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, text in sorted(files.items()):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o600 if name.startswith(("certs/", "access/")) else 0o644, int(time.time())
            tar.addfile(info, io.BytesIO(data))
    return base64.b64encode(buf.getvalue()).decode()


def apply_script(b64: str) -> str:
    """Install nginx when missing, swap the bundle in, `nginx -t`, reload; restore the previous bundle on failure."""
    return f"""set -e
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null && [ -e /usr/lib/nginx/modules/ngx_stream_module.so ] || {{
  echo '==> Installing nginx'; apt-get update -qq && apt-get install -y -qq nginx libnginx-mod-stream >/dev/null; }}
mkdir -p {BASE} {ACME_ROOT}
rm -rf {BASE}.next {BASE}.old && mkdir -p {BASE}.next
base64 -d <<'B64' | tar -xz -C {BASE}.next
{b64}
B64
chmod 700 {BASE}.next; mkdir -p {BASE}.next/certs {BASE}.next/access; chmod 750 {BASE}.next/certs {BASE}.next/access
chgrp www-data {BASE}.next/access {BASE}.next/access/* 2>/dev/null || true; chmod 640 {BASE}.next/access/* 2>/dev/null || true
mv {BASE} {BASE}.old && mv {BASE}.next {BASE}
ns=$(awk '/^nameserver/ {{print ($2 ~ /:/ ? "[" $2 "]" : $2)}}' /etc/resolv.conf | head -n 3 | tr '\n' ' ')
for d in http stream; do echo "resolver ${{ns:-127.0.0.53}} valid=30s;" > {BASE}/$d/00-resolver.conf; done
echo 'include {BASE}/http/*.conf;' > /etc/nginx/conf.d/{P}-proxy.conf
mkdir -p /etc/nginx/modules-enabled
echo 'stream {{ include {BASE}/stream/*.conf; }}' > /etc/nginx/modules-enabled/99-{P}-proxy-stream.conf
if nginx -t 2>&1; then
  systemctl enable -q nginx 2>/dev/null || true
  if systemctl is-active -q nginx; then systemctl reload nginx || nginx -s reload; else systemctl start nginx; fi
  rm -rf {BASE}.old; echo '==> proxy configuration applied'
else
  rm -rf {BASE} && mv {BASE}.old {BASE}; echo '!! nginx rejected the configuration; the previous one is still active'; exit 1
fi
"""


REMOVE_SCRIPT = f"""rm -rf {BASE} {BASE}.old {BASE}.next /etc/nginx/conf.d/{P}-proxy.conf /etc/nginx/modules-enabled/99-{P}-proxy-stream.conf
command -v nginx >/dev/null && nginx -t 2>/dev/null && (systemctl reload nginx 2>/dev/null || nginx -s reload) || true
echo '==> proxy configuration removed'
"""


# ---------------------------------------------------------------- Certificates (pure helpers)


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SolarDeck")])


def pem_key(key) -> str:
    return key.private_bytes(ser.Encoding.PEM, ser.PrivateFormat.PKCS8, ser.NoEncryption()).decode()


def make_root_ca(common_name: str, key_type: str, years: int) -> tuple[str, str]:
    key = ec.generate_private_key(ec.SECP384R1()) if key_type == "ecdsa-p384" else rsa.generate_private_key(65537, 4096)
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(_name(common_name)).issuer_name(_name(common_name))
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=365 * years))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
                                         key_encipherment=False, data_encipherment=False, key_agreement=False,
                                         encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA384()))
    return cert.public_bytes(ser.Encoding.PEM).decode(), pem_key(key)


def issue_leaf(ca_cert_pem: str, ca_key_pem: str, domains: list[str], ips: list[str], days: int) -> tuple[str, str]:
    ca = x509.load_pem_x509_certificate(ca_cert_pem.encode())
    ca_key = ser.load_pem_private_key(ca_key_pem.encode(), password=None)
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    sans = [x509.DNSName(d) for d in domains] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (x509.CertificateBuilder().subject_name(_name(domains[0])).issuer_name(ca.subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(min(now + dt.timedelta(days=days), ca.not_valid_after_utc))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA384() if isinstance(ca_key, ec.EllipticCurvePrivateKey) else hashes.SHA256()))
    return cert.public_bytes(ser.Encoding.PEM).decode(), pem_key(key)


def cert_record(source: str, name: str, cert_pem: str, key_pem: str, chain: str = "", **extra) -> dict:
    info = cert_info(cert_pem.encode())
    return {"id": new_id(), "name": name or info["subject"], "source": source, "cert_pem": cert_pem.strip(),
            "key_pem": secrets_vault.encrypt(key_pem.strip()), "chain": chain.strip(), "domains": info["names"] or [info["subject"]],
            "issuer": info["issuer"], "expires": info["expires"], "created": int(time.time()), **extra}


def public_cert(c: dict) -> dict:
    return {k: v for k, v in c.items() if k not in ("key_pem", "acme_credentials")} | {"has_key": bool(c.get("key_pem"))}


# ---------------------------------------------------------------- Apply


def local_ip() -> str:
    """This backend's address as seen from the network (the SSO gate's default URL)."""
    from providers.registry import get_provider
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((get_provider().host_address() or "192.0.2.1", 9))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def gate_url(state: dict) -> str:
    return (state["settings"].get("solardeck_url") or f"https://{local_ip()}").rstrip("/")


_apply_lock = asyncio.Lock()


async def apply(state: dict | None = None, log=None) -> str:
    state = state or load()
    if not pm.profile(MODULE)["enabled"]:
        return "module off"
    async with _apply_lock:
        out = await pm.run(MODULE, apply_script(tarball(bundle(state, gate_url(state)))), timeout=600, log=log)
    state["applied"] = int(time.time())
    save(state)
    return out


async def migrate(before: dict, after: dict) -> None:
    """platform_modules hook: move the configuration when the runtime changes, remove it when switched off."""
    if before["enabled"] and (not after["enabled"] or before["runtime_mode"] != after["runtime_mode"]):
        try:
            if before["runtime_mode"] == "container":
                from providers.registry import get_provider
                if vmid := before.get("worker_vmid"):
                    await get_provider().container_exec(vmid, REMOVE_SCRIPT, timeout=60)
            else:
                from . import host_ssh
                await host_ssh.run("bash -s", input=REMOVE_SCRIPT, timeout=60)
        except HTTPException:
            pass  # the old runtime is gone or unreachable: nothing left to remove there
    if after["enabled"]:
        await apply()


pm.HOOKS[MODULE] = migrate


async def _save_apply(state: dict) -> dict:
    save(state)
    try:
        out = await apply(state)
    except HTTPException as e:
        return {"ok": False, "error": e.detail}
    return {"ok": True, "output": out[-2000:]}


def _find(items: list[dict], item_id: str) -> dict:
    hit = next((x for x in items if x["id"] == item_id), None)
    if not hit:
        raise HTTPException(404, "Not found")
    return hit


# ---------------------------------------------------------------- Routes: overview & settings


@router.get("")
async def overview():
    s = load()
    return {"module": pm.profile(MODULE), "settings": s["settings"], "gate_url": gate_url(s), "applied": s["applied"],
            "counts": {k: len(s[k]) for k in ("hosts", "streams", "access_lists", "certificates")},
            "root_ca": public_cert(s["root_ca"]) if s["root_ca"] else None}


@router.put("/settings", dependencies=gated)
async def put_settings(body: SettingsBody):
    s = load()
    s["settings"] = body.model_dump()
    return await _save_apply(s)


@router.post("/apply", dependencies=gated)
async def apply_now():
    return await _save_apply(load())


@router.get("/upstreams")
async def upstreams():
    """Quick-pick targets: App Center instances (with their address) plus every VM and container."""
    from . import apps
    from providers.registry import get_provider
    out = [{"kind": "app", "name": a["display_name"], "host": a.get("ip_address"),
            "port": apps.BY_ID.get(a["app_id"], {}).get("web_port"), "guest_id": a["guest_id"]}
           for a in await apps.reconcile()]
    for g in await get_provider().guest_rows():
        if g.get("type") in ("qemu", "lxc"):
            out.append({"kind": "vm" if g["type"] == "qemu" else "container", "name": g.get("name") or str(g["vmid"]),
                        "host": None, "port": None, "guest_id": int(g["vmid"])})
    return out


# ---------------------------------------------------------------- Proxy hosts


def _check_host(s: dict, body: HostBody, own: str | None) -> None:
    taken = {d for h in s["hosts"] if h["id"] != own for d in h["domain_names"]}
    if clash := next((d for d in body.domain_names if d in taken), None):
        raise HTTPException(409, f"{clash} is already used by another proxy host")
    if body.access_list_id and not any(a["id"] == body.access_list_id for a in s["access_lists"]):
        raise HTTPException(404, "Access list not found")
    if body.certificate_id and not any(c["id"] == body.certificate_id for c in s["certificates"]):
        raise HTTPException(404, "Certificate not found")


@router.get("/hosts")
async def list_hosts():
    return load()["hosts"]


@router.post("/hosts", dependencies=gated)
async def create_host(body: HostBody):
    s = load()
    _check_host(s, body, None)
    h = {"id": new_id(), **body.model_dump(), "created": int(time.time())}
    s["hosts"].append(h)
    return {**await _save_apply(s), "host": h}


@router.put("/hosts/{host_id}", dependencies=gated)
async def update_host(body: HostBody, host_id: str = Path(pattern=ID_RE)):
    s = load()
    h = _find(s["hosts"], host_id)
    _check_host(s, body, host_id)
    h.update(body.model_dump())
    return {**await _save_apply(s), "host": h}


@router.delete("/hosts/{host_id}", dependencies=gated)
async def delete_host(host_id: str = Path(pattern=ID_RE)):
    s = load()
    _find(s["hosts"], host_id)
    s["hosts"] = [h for h in s["hosts"] if h["id"] != host_id]
    return await _save_apply(s)


# ---------------------------------------------------------------- Streams


@router.get("/streams")
async def list_streams():
    return load()["streams"]


def _check_stream(s: dict, body: StreamBody, own: str | None) -> None:
    protos = lambda p: {"tcp", "udp"} if p == "both" else {p}  # noqa: E731
    if any(x["id"] != own and x["listen_port"] == body.listen_port and protos(x["protocol"]) & protos(body.protocol) for x in s["streams"]):
        raise HTTPException(409, f"Port {body.listen_port} is already forwarded")


@router.post("/streams", dependencies=gated)
async def create_stream(body: StreamBody):
    s = load()
    _check_stream(s, body, None)
    st = {"id": new_id(), **body.model_dump()}
    s["streams"].append(st)
    return {**await _save_apply(s), "stream": st}


@router.put("/streams/{stream_id}", dependencies=gated)
async def update_stream(body: StreamBody, stream_id: str = Path(pattern=ID_RE)):
    s = load()
    st = _find(s["streams"], stream_id)
    _check_stream(s, body, stream_id)
    st.update(body.model_dump())
    return {**await _save_apply(s), "stream": st}


@router.delete("/streams/{stream_id}", dependencies=gated)
async def delete_stream(stream_id: str = Path(pattern=ID_RE)):
    s = load()
    _find(s["streams"], stream_id)
    s["streams"] = [x for x in s["streams"] if x["id"] != stream_id]
    return await _save_apply(s)


# ---------------------------------------------------------------- Access lists


def _acl_view(a: dict) -> dict:
    return {**{k: v for k, v in a.items() if k != "users"}, "basic_auth_users": [u["username"] for u in a.get("users", [])]}


@router.get("/access-lists")
async def list_acls():
    return [_acl_view(a) for a in load()["access_lists"]]


def _users(body: AccessListBody, old: list[dict]) -> list[dict]:
    prev = {u["username"]: u["hash"] for u in old}
    out = []
    for u in body.basic_auth_users:
        if u.password:
            out.append({"username": u.username, "hash": htpasswd_line(u.username, u.password).split(":", 1)[1]})
        elif u.username in prev:
            out.append({"username": u.username, "hash": prev[u.username]})
        else:
            raise HTTPException(422, f"Set a password for {u.username}")
    return out


@router.post("/access-lists", dependencies=gated)
async def create_acl(body: AccessListBody):
    s = load()
    a = {"id": new_id(), **body.model_dump(exclude={"basic_auth_users"}), "users": _users(body, [])}
    s["access_lists"].append(a)
    return {**await _save_apply(s), "access_list": _acl_view(a)}


@router.put("/access-lists/{acl_id}", dependencies=gated)
async def update_acl(body: AccessListBody, acl_id: str = Path(pattern=ID_RE)):
    s = load()
    a = _find(s["access_lists"], acl_id)
    a.update(**body.model_dump(exclude={"basic_auth_users"}), users=_users(body, a.get("users", [])))
    return {**await _save_apply(s), "access_list": _acl_view(a)}


@router.delete("/access-lists/{acl_id}", dependencies=gated)
async def delete_acl(acl_id: str = Path(pattern=ID_RE)):
    s = load()
    _find(s["access_lists"], acl_id)
    if any(h.get("access_list_id") == acl_id for h in s["hosts"]):
        raise HTTPException(409, "A proxy host still uses this access list")
    s["access_lists"] = [a for a in s["access_lists"] if a["id"] != acl_id]
    return await _save_apply(s)


# ---------------------------------------------------------------- Certificates & private root CA


@router.get("/certificates")
async def list_certs():
    s = load()
    return {"certificates": [public_cert(c) for c in s["certificates"]],
            "root_ca": public_cert(s["root_ca"]) if s["root_ca"] else None, "acme_job": _acme_job}


@router.post("/certificates/root-ca", dependencies=gated)
async def create_root_ca(body: RootCaBody, request: Request, user: str = Depends(require_user)):
    s = load()
    if s["root_ca"]:
        raise HTTPException(409, "A private root CA already exists; delete it first to create a new one")
    cert, key = await asyncio.to_thread(make_root_ca, body.common_name, body.key_type, body.valid_years)
    s["root_ca"] = cert_record("root_ca", body.common_name, cert, key, key_type=body.key_type)
    save(s)
    audit_log.record("proxy.root_ca.create", user=user, ip=client_ip(request), key_type=body.key_type)
    return public_cert(s["root_ca"])


@router.get("/certificates/root-ca/download")
async def download_root_ca():
    ca = load()["root_ca"]
    if not ca:
        raise HTTPException(404, "No private root CA yet")
    return PlainTextResponse(ca["cert_pem"] + "\n", media_type="application/x-x509-ca-cert",
                             headers={"Content-Disposition": 'attachment; filename="solardeck-root-ca.crt"'})


@router.delete("/certificates/root-ca", dependencies=gated)
async def delete_root_ca(request: Request, user: str = Depends(require_user)):
    s = load()
    s["root_ca"] = None
    save(s)
    audit_log.record("proxy.root_ca.delete", user=user, ip=client_ip(request))
    return {"ok": True}


@router.post("/certificates/self-signed", dependencies=gated)
async def self_signed(body: SelfSignedBody):
    """One-click leaf / wildcard certificate signed by the private root CA (created first when there is none)."""
    s = load()
    if not s["root_ca"]:
        cert, key = await asyncio.to_thread(make_root_ca, "SolarDeck Private Root CA", "ecdsa-p384", 10)
        s["root_ca"] = cert_record("root_ca", "SolarDeck Private Root CA", cert, key, key_type="ecdsa-p384")
    ca = s["root_ca"]
    cert, key = issue_leaf(ca["cert_pem"], key_of(ca), body.domains, body.ip_addresses, body.valid_days)
    c = cert_record("self_signed", body.name, cert, key, chain=ca["cert_pem"])
    s["certificates"].append(c)
    return {**await _save_apply(s), "certificate": public_cert(c)}


@router.post("/certificates/upload", dependencies=gated)
async def upload(body: UploadBody):
    check_pem(body.certificate, body.private_key)
    s = load()
    c = cert_record("upload", body.name, body.certificate, body.private_key, chain=body.chain)
    s["certificates"].append(c)
    return {**await _save_apply(s), "certificate": public_cert(c)}


@router.delete("/certificates/{cert_id}", dependencies=gated)
async def delete_cert(cert_id: str = Path(pattern=ID_RE)):
    s = load()
    _find(s["certificates"], cert_id)
    if any(h.get("certificate_id") == cert_id for h in s["hosts"]):
        raise HTTPException(409, "A proxy host still uses this certificate")
    s["certificates"] = [c for c in s["certificates"] if c["id"] != cert_id]
    return await _save_apply(s)


# ---------------------------------------------------------------- ACME / Let's Encrypt (acme.sh in the runtime)

# shortcut: one ACME job at a time, kept in memory; the issued certificate itself is stored in the state file.
_acme_job: dict | None = None
_bg: set[asyncio.Task] = set()


def acme_script(body: AcmeBody) -> str:
    dom = " ".join(f"-d {shlex.quote(d)}" for d in body.domains)
    how = f"--webroot {ACME_ROOT}" if body.challenge == "http-01" else f"--dns {body.dns_plugin}"
    env = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in body.credentials.items())
    server = "letsencrypt_test" if body.staging else "letsencrypt"
    first = body.domains[0]
    return f"""set -e
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git curl socat >/dev/null)
if [ ! -x {ACME_HOME}/acme.sh ]; then
  echo '==> Installing acme.sh'
  rm -rf /opt/acme.sh-src && git clone -q --depth 1 --branch {ACME_VERSION} https://github.com/acmesh-official/acme.sh.git /opt/acme.sh-src
  (cd /opt/acme.sh-src && ./acme.sh --install --noprofile --nocron --home {ACME_HOME} --accountemail {shlex.quote(body.email)} >/dev/null)
fi
mkdir -p {ACME_ROOT}
{env}echo '==> Requesting the certificate'
set +e
{ACME_HOME}/acme.sh --home {ACME_HOME} --issue {dom} {how} --keylength ec-256 --server {server} --accountemail {shlex.quote(body.email)} --force
rc=$?
set -e
[ $rc -eq 0 ] || [ $rc -eq 2 ] || {{ echo '!! the certificate was not issued'; exit 1; }}
d={ACME_HOME}/{shlex.quote(first)}_ecc
echo '@@CERT@@'; cat "$d/fullchain.cer"; echo '@@KEY@@'; cat "$d/{first.replace("'", "")}.key"; echo '@@END@@'
"""


def split_acme_output(out: str) -> tuple[str, str, str]:
    """(log, fullchain PEM, key PEM) from acme_script output; the key never reaches the log."""
    log, _, rest = out.partition("@@CERT@@")
    cert, _, rest = rest.partition("@@KEY@@")
    key, _, _ = rest.partition("@@END@@")
    return log, cert.strip(), key.strip()


async def _acme(body: AcmeBody, replace: str | None = None) -> None:
    job = _acme_job
    secrets_list = list(body.credentials.values())
    quiet = False

    def log(line: str):  # the certificate and key between the markers stay out of the job log
        nonlocal quiet
        if line in ("@@CERT@@", "@@END@@"):
            quiet = line == "@@CERT@@"
        elif not quiet:
            job["log"].append(mask(line, secrets_list))

    try:
        out = await pm.run(MODULE, acme_script(body), timeout=900, log=log)
        _, cert, key = split_acme_output(out)
        if not cert or not key:
            raise RuntimeError("acme.sh finished without a certificate")
        s = load()
        extra = {"acme": {"challenge": body.challenge, "dns_plugin": body.dns_plugin, "email": body.email,
                          "staging": body.staging, "domains": body.domains},
                 "acme_credentials": secrets_vault.encrypt(json.dumps(body.credentials)) if body.credentials else None}
        first, _, chain = cert.partition("-----END CERTIFICATE-----")
        c = cert_record("acme", ", ".join(body.domains), first + "-----END CERTIFICATE-----", key, chain=chain, **extra)
        if replace and (old := next((x for x in s["certificates"] if x["id"] == replace), None)):
            c["id"], c["name"] = old["id"], old["name"]
            s["certificates"] = [c if x["id"] == replace else x for x in s["certificates"]]
        else:
            s["certificates"].append(c)
        save(s)
        await apply(s)
        job.update(state="done", certificate=public_cert(c))
        job["log"].append(f"==> Issued for {', '.join(body.domains)}; renewed automatically 30 days before expiry")
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        job.update(state="error", error=e.detail if isinstance(e, HTTPException) else str(e))
        job["log"].append(f"!! {job['error']}")


def _start_acme(body: AcmeBody, replace: str | None = None) -> dict:
    global _acme_job
    if _acme_job and _acme_job["state"] == "running":
        raise HTTPException(409, "A certificate request is already running")
    _acme_job = {"domains": body.domains, "state": "running", "error": None, "log": [], "started": int(time.time())}
    t = asyncio.create_task(_acme(body, replace))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return _acme_job


@router.post("/certificates/acme", dependencies=gated)
async def request_acme(body: AcmeBody):
    s = load()
    if body.challenge == "http-01" and not any(set(body.domains) & set(h["domain_names"]) for h in s["hosts"]):
        raise HTTPException(400, "Add a proxy host for this domain first: HTTP-01 is answered on its port 80")
    return _start_acme(body)


@router.get("/certificates/acme/job")
async def acme_job():
    if not _acme_job:
        raise HTTPException(404, "No certificate request yet")
    return {**_acme_job, "log": _acme_job["log"][-300:]}


async def renew_due() -> list[str]:
    """Re-issue ACME certificates that expire within 30 days (called daily by renew_loop)."""
    started = []
    for c in load()["certificates"]:
        if c["source"] == "acme" and c["expires"] - time.time() < 30 * 86400 and not (_acme_job and _acme_job["state"] == "running"):
            a = c["acme"]
            creds = json.loads(secrets_vault.decrypt(c.get("acme_credentials")) or "{}") if c.get("acme_credentials") else {}
            _start_acme(AcmeBody(domains=a["domains"], email=a["email"], challenge=a["challenge"], dns_plugin=a.get("dns_plugin"),
                                 credentials=creds, staging=a.get("staging", False)), replace=c["id"])
            started.append(c["id"])
            while _acme_job and _acme_job["state"] == "running":
                await asyncio.sleep(10)
    return started


async def renew_loop() -> None:
    await asyncio.sleep(300)
    while True:
        if pm.profile(MODULE)["enabled"]:
            try:
                await renew_due()
            except Exception:  # noqa: BLE001 - retried tomorrow
                pass
        await asyncio.sleep(86400)


# ---------------------------------------------------------------- SolarDeck SSO gate (no session dependency)


def _proxied(host: str) -> dict | None:
    host = host.split(":")[0].lower()
    for h in load()["hosts"]:
        if h.get("solardeck_sso_auth") and any(d == host or (d.startswith("*.") and host.endswith(d[1:])) for d in h["domain_names"]):
            return h
    return None


def _gate_token(claims: dict, ttl: int) -> str:
    return jwt.encode({**claims, "exp": dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=ttl)}, settings.jwt_secret, algorithm="HS256")


def _gate_claims(token: str | None, purpose: str) -> dict | None:
    try:
        c = jwt.decode(token or "", settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return c if c.get("purpose") == purpose else None


@public.get("/verify")
async def gate_verify(request: Request):
    """auth_request target: 200 when the gate cookie belongs to a live SolarDeck session for this host, else 401."""
    host = request.headers.get("x-original-host", "").lower()
    c = _gate_claims(request.cookies.get(GATE_COOKIE), "gate")
    if c and c.get("host") == host and _proxied(host) and sessions.touch(c.get("sid"), None):
        return Response(status_code=200, headers={"X-SolarDeck-User": c["sub"]})
    return Response(status_code=401)


@public.get("/start")
async def gate_start(rd: str, request: Request, retry: int = 0):
    """Visitor without a gate cookie: needs a SolarDeck session, then gets a one-time ticket for the proxied host."""
    target = urlparse(rd)
    if target.scheme not in ("http", "https") or not target.hostname or not _proxied(target.hostname):
        raise HTTPException(400, "This address is not protected by the SolarDeck gate")
    try:
        claims = session_claims(request.cookies.get(COOKIE), client_ip(request))
    except HTTPException:
        if not retry:  # a cross-site navigation leaves the SameSite=Strict cookie out; a same-site reload sends it
            again = f"/api/proxy/auth/start?rd={quote(rd, safe='')}&retry=1"
            return HTMLResponse(f'<!doctype html><meta charset="utf-8"><script>location.replace({json.dumps(again)})</script>')
        return RedirectResponse("/", status_code=302)
    ticket = _gate_token({"sub": claims["sub"], "sid": claims["jti"], "host": target.hostname.lower(), "purpose": "gate-ticket",
                          "nonce": secrets.token_hex(8)}, TICKET_TTL)
    back = f"{target.scheme}://{target.netloc}/__solardeck_gate?ticket={quote(ticket)}&rd={quote(rd, safe='')}"
    return RedirectResponse(back, status_code=302)


_used_tickets: dict[str, float] = {}


@public.get("/callback")
async def gate_callback(ticket: str, rd: str, request: Request):
    """Reached through the proxied host: trades the ticket for an HttpOnly cookie on that host."""
    host = request.headers.get("x-original-host", "").lower()
    c = _gate_claims(ticket, "gate-ticket")
    now = time.time()
    for k in [k for k, t in _used_tickets.items() if t < now]:
        del _used_tickets[k]
    if not c or c["host"] != host or c["nonce"] in _used_tickets or urlparse(rd).hostname != host or not _proxied(host):
        raise HTTPException(401, "Invalid or expired sign-in ticket")
    _used_tickets[c["nonce"]] = now + TICKET_TTL
    ttl = settings.jwt_ttl_hours * 3600
    resp = RedirectResponse(rd, status_code=302)
    resp.set_cookie(GATE_COOKIE, _gate_token({"sub": c["sub"], "sid": c["sid"], "host": host, "purpose": "gate"}, ttl),
                    httponly=True, secure=urlparse(rd).scheme == "https", samesite="lax", max_age=ttl, path="/")
    audit_log.record("proxy.gate.login", user=c["sub"], ip=request.headers.get("x-real-ip") or client_ip(request), host=host)
    return resp
