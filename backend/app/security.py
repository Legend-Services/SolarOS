"""Security Posture Center: weighted 0-100 score over application and host controls, 1-click host hardening, and
the tamper-evident audit log (read, filter, verify)."""
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import audit_log, host_ssh
from .auth import client_ip, load_security, require_step_up_auth, require_user
from .config import settings
from providers.registry import get_provider

router = APIRouter(prefix="/api/security", tags=["security"], dependencies=[Depends(require_user)])
SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "host-hardening.sh"
JOB = "hardening"
Part = Literal["sysctl", "ssh", "firewall", "updates", "apparmor"]
WEIGHTS = {"password": 15, "twofa": 15, "https": 10, "ssh": 15, "firewall": 15, "sysctl": 10, "updates": 10, "audit": 10}


def parse_facts(out: str) -> dict:
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def https_configured() -> bool:
    # nginx runs next to the backend in both editions; the TLS snippet is <prefix>-ssl.conf (selfsigned-cert.sh / certificates).
    return any(Path("/etc/nginx").glob("*-ssl.conf"))


def evaluate(sec: dict, facts: dict | None, firewall: dict | None, audit_ok: bool, https: bool, legacy_password: bool) -> dict:
    """Score and checklist from collected facts (pure: unit tested). facts None = host unreachable."""
    host = facts is not None
    f = facts or {}

    def item(cid, title, passed, detail, fix=None, link=None, unknown=False):
        return {"id": cid, "title": title, "weight": WEIGHTS[cid], "status": "unknown" if unknown else "pass" if passed else "warn",
                "detail": detail, "fix": None if passed else fix, "link": None if passed else link}

    weak = sec.get("weak_password") or legacy_password
    ssh_off = f.get("ssh_installed") == "0" or f.get("ssh_active") not in ("active", "activating")
    ssh_ok = ssh_off or f.get("ssh_password") == "no"
    keys = int(f.get("ssh_user_keys") or 0)
    fw_ok = firewall["active"] if firewall else f.get("firewall") == "active"
    items = [
        item("password", "Strong administrator password", not weak,
             "Stored only as a salted scrypt hash and meets the password rules" if not weak else
             "The password is weak or stored in plain text by an older install: change it", link="password"),
        item("twofa", "Two-factor sign-in (TOTP) for the administrator", bool(sec.get("totp_enabled")),
             "A code from an authenticator app is required at sign-in" if sec.get("totp_enabled") else
             "Sign-in needs only a password", link="twofa"),
        item("https", "HTTPS / TLS certificate", https,
             "nginx serves the desktop over HTTPS" if https else "Only plain HTTP is configured", link="certs"),
        item("ssh", "Host SSH: key-only sign-in", ssh_ok,
             "SSH server is off" if host and ssh_off else "Password sign-in over SSH is disabled" if ssh_ok else
             f"SSH accepts passwords{'' if keys else ' (add an SSH key first: passwords stay on until one exists)'}",
             fix="ssh", unknown=not host),
        item("firewall", "Host firewall denies incoming by default", fw_ok,
             firewall["detail"] if firewall else
             f"{f.get('firewall_kind')} active, default deny incoming" if fw_ok else "No default-deny firewall is active",
             fix=None if firewall else "firewall", link="firewall" if firewall else None, unknown=not host and not firewall),
        item("sysctl", "Kernel hardening (sysctl)", f.get("sysctl_active") == "1",
             "ASLR, symlink/hardlink protection, kernel pointer and dmesg restrictions, SYN cookies, no ICMP redirects"
             if f.get("sysctl_active") == "1" else "The hardening values are not active", fix="sysctl", unknown=not host),
        item("updates", "Automatic security updates", f.get("auto_updates") == "1",
             "unattended-upgrades installs security patches daily" if f.get("auto_updates") == "1" else
             "Security patches are only installed by hand", fix="updates", unknown=not host),
        item("audit", "Audit log hash chain intact", audit_ok,
             "Every entry links to the one before it" if audit_ok else "The audit log was modified or truncated"),
    ]
    return {"score": sum(i["weight"] for i in items if i["status"] == "pass"), "items": items,
            "host_reachable": host, "apparmor": f.get("apparmor")}


async def host_facts() -> dict | None:
    ok, out, _ = await host_ssh.run_host_cmd(f"bash -s -- check {settings.system_prefix}", 30, SCRIPT.read_text())
    return parse_facts(out) if ok else None


@router.get("/posture")
async def posture():
    p = get_provider()
    facts, firewall = await host_facts(), await p.host_firewall()
    return evaluate(load_security(), facts, firewall, audit_log.verify()["ok"], https_configured(),
                    bool(settings.admin_password and not settings.admin_password_hash))


class HardenBody(BaseModel):
    parts: list[Part] = Field(min_length=1, max_length=5)


@router.post("/harden")
async def harden(body: HardenBody, request: Request, user: str = Depends(require_step_up_auth)):
    """Apply the selected host hardening parts as a detached host job; follow it with GET /api/host/jobs/hardening."""
    parts = list(dict.fromkeys(body.parts))
    own_firewall = await get_provider().host_firewall() is not None
    env = "NO_UFW=1 " if own_firewall else ""
    await host_ssh.start_job(JOB, f"{env}bash -s -- apply {settings.system_prefix} {' '.join(parts)} <<'SOLARDECK_HARDENING'\n"
                                  f"{SCRIPT.read_text()}\nSOLARDECK_HARDENING\n")
    audit_log.record("host.harden", user=user, ip=client_ip(request), parts=parts)
    return {"job": JOB}


@router.get("/audit-log")
def audit_entries(limit: int = Query(500, ge=1, le=5000), event: str | None = Query(None, max_length=64),
                  user: str | None = Query(None, max_length=64)):
    items = [e for e in audit_log.entries() if (not event or str(e.get("event", "")).startswith(event))
             and (not user or e.get("user") == user)]
    return list(reversed(items[-limit:]))


@router.get("/audit-log/verify")
def audit_verify():
    return audit_log.verify()
