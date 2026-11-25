"""Domains: your own domain names, their host names on the local network, and Let's Encrypt for SolarDeck.

- Domains and host names live with the other network state on the host (/etc/<prefix>/net/domains.json). Host names
  become local DNS records in the DNS service (dnsmasq) whenever it is installed and on (see net_services.apply_dnsmasq).
- Let's Encrypt runs in this container with acme.sh and a DNS-01 challenge, so SolarDeck never has to be reachable from
  the internet. The DNS provider credentials are handed to acme.sh as environment variables and kept only in its
  root-only account file for renewals; acme.sh's cron job renews and reloads nginx. The certificate goes to the paths
  net_services.apply_nginx_cert and deploy/selfsigned-cert.sh use, and that script never replaces a non-self-signed one.
"""
import asyncio
import ipaddress
import re
import shlex
import time
from pathlib import Path as FsPath
from typing import Annotated

from cryptography import x509
from cryptography.x509.oid import ExtensionOID, NameOID
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import AfterValidator, BaseModel, Field, field_validator

from . import host_ssh, net_services as ns
from .auth import require_user

router = APIRouter(prefix="/api/domains", tags=["domains"], dependencies=[Depends(require_user)])

DOMAIN_RE = r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$"
LABEL_RE = r"^(@|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$"  # "@" = the domain itself
PLUGIN_RE = r"^dns_[a-z0-9_]{1,30}$"
ENV_KEY_RE = re.compile(r"^[A-Z][A-Za-z0-9_]{1,40}$")  # acme.sh names are mixed case, e.g. CF_Token, CF_Zone_ID
EMAIL_RE = r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$"
ACME_VERSION = "3.1.7"
ACME_HOME = "/root/.acme.sh"
ACME = f"{ACME_HOME}/acme.sh"
CRT = ns.NGINX_SSL_DIR / f"{ns.P}.crt"
KEY = ns.NGINX_SSL_DIR / f"{ns.P}.key"
SELFSIGNED_SCRIPT = FsPath(__file__).resolve().parents[2] / "deploy" / "selfsigned-cert.sh"
DEFAULT: dict = {"domains": [], "certificate": None}


# ---------------------------------------------------------------- Pure helpers (tests/test_domains.py)


def fqdn(host: str, domain: str) -> str:
    return domain if host == "@" else f"{host}.{domain}"


def domain_records(state: dict) -> list[dict]:
    """Host names of every domain as dnsmasq records (A for IPv4, AAAA for IPv6)."""
    return [{"type": "AAAA" if ":" in h["ip"] else "A", "name": fqdn(h["name"], d["name"]), "value": h["ip"]}
            for d in state.get("domains", []) for h in d.get("hosts", [])]


def mask(line: str, secrets: list[str]) -> str:
    """Hide credential values in installer output."""
    for s in sorted((s for s in secrets if len(s) >= 4), key=len, reverse=True):
        line = line.replace(s, "••••••")
    return line


def cert_info(pem: bytes) -> dict:
    """Facts about the first certificate in a PEM file, for the UI."""
    c = x509.load_pem_x509_certificates(pem)[0]
    attr = lambda name, oid: (name.get_attributes_for_oid(oid) or [None])[0]  # noqa: E731
    try:
        names = c.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        sans = [*names.get_values_for_type(x509.DNSName), *map(str, names.get_values_for_type(x509.IPAddress))]
    except x509.ExtensionNotFound:
        sans = []
    cn = attr(c.subject, NameOID.COMMON_NAME)
    issuer_attr = attr(c.issuer, NameOID.ORGANIZATION_NAME) or attr(c.issuer, NameOID.COMMON_NAME)
    issuer = str(issuer_attr.value) if issuer_attr else ""
    return {"subject": cn.value if cn else "", "issuer": issuer, "names": sans, "self_signed": c.issuer == c.subject,
            "lets_encrypt": "let's encrypt" in issuer.lower(), "expires": int(c.not_valid_after_utc.timestamp())}


# ---------------------------------------------------------------- Models


def _ip(v: str) -> str:
    return str(ipaddress.ip_address(v))


class HostEntry(BaseModel):
    name: str = Field(pattern=LABEL_RE, max_length=200)
    ip: Annotated[str, AfterValidator(_ip)]


class HostsBody(BaseModel):
    hosts: list[HostEntry] = Field(max_length=200)

    @field_validator("hosts")
    @classmethod
    def _unique(cls, v: list[HostEntry]) -> list[HostEntry]:
        names = [h.name for h in v]
        if len(names) != len(set(names)):
            raise ValueError("Each host name can only appear once")
        return v


class DomainBody(BaseModel):
    name: str = Field(pattern=DOMAIN_RE, max_length=253)


class CertBody(BaseModel):
    fqdn: str = Field(pattern=DOMAIN_RE, max_length=253)
    email: str = Field(pattern=EMAIL_RE, max_length=200)
    plugin: str = Field(pattern=PLUGIN_RE)
    credentials: dict[str, str] = Field(max_length=6)

    @field_validator("credentials")
    @classmethod
    def _creds(cls, v: dict[str, str]) -> dict[str, str]:
        out = {}
        for k, val in v.items():
            if not ENV_KEY_RE.fullmatch(k):
                raise ValueError(f"Invalid setting name {k!r}")
            val = val.strip()
            if not val or len(val) > 500 or "\n" in val or "\r" in val:
                raise ValueError(f"Invalid value for {k}")
            out[k] = val
        if not out:
            raise ValueError("Enter the DNS provider credentials")
        return out


# ---------------------------------------------------------------- State & DNS service


async def load() -> dict:
    return await ns.load("domains", DEFAULT)


async def _dns_service() -> dict:
    ok, out, _ = await host_ssh.run_host_cmd("command -v dnsmasq >/dev/null && echo installed", timeout=15)
    dns = await ns.load("dns", ns.DNS_DEFAULT)
    return {"installed": ok and "installed" in out, "enabled": bool(dns.get("enabled"))}


async def _apply_dns() -> bool:
    """Re-render dnsmasq so host-name changes take effect; a no-op until the DNS service is installed and on."""
    svc = await _dns_service()
    if not (svc["installed"] and svc["enabled"]):
        return False
    await ns.apply_dnsmasq(await ns.load("dns", ns.DNS_DEFAULT), await ns.load("dhcp", ns.DHCP_DEFAULT))
    return True


def _https() -> dict | None:
    try:
        return cert_info(CRT.read_bytes())
    except (OSError, ValueError, IndexError):
        return None


@router.get("")
async def get_domains():
    state, svc = await asyncio.gather(load(), _dns_service())
    return {**state, "dns_service": svc, "https": _https(), "job": _job}


@router.post("")
async def add_domain(body: DomainBody):
    state = await load()
    if any(d["name"] == body.name for d in state["domains"]):
        raise HTTPException(409, f"{body.name} is already added")
    state["domains"].append({"name": body.name, "hosts": [], "added": int(time.time())})
    await ns.save("domains", state)
    return state


@router.delete("/{name}")
async def delete_domain(name: str = Path(pattern=DOMAIN_RE, max_length=253)):
    state = await load()
    if not any(d["name"] == name for d in state["domains"]):
        raise HTTPException(404, "Domain not found")
    state["domains"] = [d for d in state["domains"] if d["name"] != name]
    await ns.save("domains", state)
    applied = await _apply_dns()
    return {**state, "dns_applied": applied}


@router.put("/{name}/hosts")
async def set_hosts(body: HostsBody, name: str = Path(pattern=DOMAIN_RE, max_length=253)):
    state = await load()
    dom = next((d for d in state["domains"] if d["name"] == name), None)
    if not dom:
        raise HTTPException(404, "Domain not found")
    old = dom["hosts"]
    dom["hosts"] = [h.model_dump() for h in body.hosts]
    await ns.save("domains", state)
    try:
        applied = await _apply_dns()
    except HTTPException:
        dom["hosts"] = old  # dnsmasq rejected it: keep the previous, working set
        await ns.save("domains", state)
        raise
    return {**state, "dns_applied": applied}


# ---------------------------------------------------------------- Let's Encrypt (acme.sh, DNS-01)

# shortcut: one certificate job at a time, kept in memory (acme.sh itself keeps the certificate and renewal config).
_job: dict | None = None
_bg: set[asyncio.Task] = set()


async def _run(args: list[str], env: dict[str, str], log, secrets: list[str], timeout: float = 600) -> int:
    proc = await asyncio.create_subprocess_exec(*args, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", **env},
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)

    async def pump():
        async for raw in proc.stdout:
            log(mask(raw.decode(errors="replace").rstrip(), secrets))
        return await proc.wait()

    try:
        return await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        log("!! timed out")
        return 124


async def _issue(body: CertBody) -> None:
    job = _job
    log = job["log"].append
    secrets = list(body.credentials.values())
    try:
        if not FsPath(ACME).exists():
            job["step"] = "Installing acme.sh"
            src = f"/opt/acme.sh-{ACME_VERSION}"
            script = (f"rm -rf {src} && git clone -q --depth 1 --branch {ACME_VERSION} https://github.com/acmesh-official/acme.sh.git {src} "
                      f"&& cd {src} && ./acme.sh --install --noprofile --home {ACME_HOME} --accountemail {shlex.quote(body.email)}")
            if await _run(["bash", "-c", script], {}, log, secrets):
                raise RuntimeError("acme.sh could not be installed")
        job["step"] = "Requesting the certificate (DNS check, about a minute)"
        await _run([ACME, "--set-default-ca", "--server", "letsencrypt"], {}, log, secrets)
        code = await _run([ACME, "--issue", "--dns", body.plugin, "-d", body.fqdn, "--keylength", "ec-256",
                           "--server", "letsencrypt", "--accountemail", body.email, "--force"], body.credentials, log, secrets)
        if code not in (0, 2):  # 2 = certificate still valid, nothing to renew
            raise RuntimeError("Let's Encrypt did not issue the certificate; see the log above")
        job["step"] = "Installing the certificate in SolarDeck"
        ns.NGINX_SSL_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        code = await _run([ACME, "--install-cert", "-d", body.fqdn, "--ecc", "--key-file", str(KEY), "--fullchain-file", str(CRT),
                           "--reloadcmd", "nginx -t -q && systemctl reload nginx"], {}, log, secrets)
        if code:
            raise RuntimeError("The certificate could not be installed in nginx")
        if not ns.NGINX_SNIPPET.exists():
            ns.NGINX_SNIPPET.write_text(f"listen 443 ssl;\nlisten [::]:443 ssl;\nssl_certificate {CRT};\nssl_certificate_key {KEY};\n")
            await _run(["bash", "-c", "nginx -t -q && systemctl reload nginx"], {}, log, secrets)
        state = await load()
        state["certificate"] = {"fqdn": body.fqdn, "plugin": body.plugin, "email": body.email, "issued": int(time.time())}
        await ns.save("domains", state)
        job.update(state="done", step="Installed", https=_https())
        log(f"==> https://{body.fqdn} now uses the Let's Encrypt certificate; acme.sh renews it automatically.")
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        job.update(state="error", error=str(e) or type(e).__name__)
        log(f"!! {job['error']}")


@router.post("/certificate")
async def request_certificate(body: CertBody):
    global _job
    state = await load()
    if not any(body.fqdn == d["name"] or body.fqdn.endswith("." + d["name"]) for d in state["domains"]):
        raise HTTPException(400, "Add the domain first; certificates are only requested for your own domains")
    if _job and _job["state"] == "running":
        raise HTTPException(409, "A certificate request is already running")
    _job = {"fqdn": body.fqdn, "state": "running", "step": "Starting", "error": None, "log": [], "started": int(time.time())}
    t = asyncio.create_task(_issue(body))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return _job


@router.get("/certificate/job")
async def certificate_job():
    if not _job:
        raise HTTPException(404, "No certificate request yet")
    return {**_job, "log": _job["log"][-300:]}


@router.delete("/certificate")
async def remove_certificate():
    """Stop renewing the Let's Encrypt certificate and go back to SolarDeck's self-signed one."""
    state = await load()
    cert = state.get("certificate")
    log: list[str] = []
    if cert and FsPath(ACME).exists():
        await _run([ACME, "--remove", "-d", cert["fqdn"], "--ecc"], {}, log.append, [])
    for p in (CRT, KEY, ns.NGINX_SSL_DIR / f"{ns.P}.san"):
        p.unlink(missing_ok=True)
    code = await _run(["bash", "-c", f"bash {SELFSIGNED_SCRIPT} && nginx -t -q && systemctl reload nginx"], {}, log.append, [])
    if code:
        raise HTTPException(500, f"Could not restore the self-signed certificate: {log[-1] if log else ''}")
    state["certificate"] = None
    await ns.save("domains", state)
    return {"ok": True, "https": _https()}
