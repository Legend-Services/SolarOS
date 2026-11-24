"""In-app bug reporter: anonymized diagnostics and GitHub issue submission (direct with a token, or a pre-filled link)."""
import asyncio
import os
import platform
import re
from typing import Literal
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from . import updater
from .auth import require_user
from .config import settings
from .pve import _safe

router = APIRouter(prefix="/api/system/bug-report", tags=["bug-report"], dependencies=[Depends(require_user)])

CATEGORIES = ("UI & Desktop", "Storage & ZFS", "VMs & Containers", "Network & VPN", "Hardware & GPU", "Installer & Updates")
LABELS = ["bug", "user-reported"]
URL_MAX = 7500  # GitHub rejects issue/new links much longer than ~8 KB

# Order matters: whole key blocks and tokens first, then generic key=value secrets, then addresses.
REDACTIONS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), "[PRIVATE KEY]"),
    (re.compile(r"\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-ssh-\S+) [A-Za-z0-9+/=]{16,}"), r"\1 [SSH KEY]"),
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+"), "[JWT]"),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})"), "[GITHUB TOKEN]"),
    (re.compile(r"PVEAPIToken=\S+"), "PVEAPIToken=[TOKEN]"),
    (re.compile(r"(?i)\bBearer\s+\S+"), "Bearer [TOKEN]"),
    (re.compile(r"(?i)\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization)[\w-]*)([\"']?\s*[:=]\s*[\"']?)[^\s\"',;&]+"),
     r"\1\2[REDACTED]"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "[UUID]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"), "[EMAIL]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP]"),
    # Full IPv6 / MAC (5+ colons) or compressed IPv6 (::); clock times like 12:30:45 are left alone.
    (re.compile(r"\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b|(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4})*::[0-9a-f:]*[0-9a-f]\b", re.I),
     "[IP]"),
]


def redact(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text


def repo_slug(url: str) -> str | None:
    m = re.search(r"github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", url)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


async def _journal() -> list[str]:
    rc, out = await updater._cmd("journalctl", "-u", settings.name("backend"), "-n", "30", "--no-pager", "-o", "cat")
    return redact(out).splitlines() if rc == 0 else [f"(journal unavailable: {redact(out)[:200]})"]


@router.get("/diagnostics")
async def diagnostics():
    src, pve_version, logs = await asyncio.gather(updater.source(), _safe("/version", {}), _journal())
    cpu = re.search(r"^model name\s*:\s*(.+)$", _read("/proc/cpuinfo"), re.M)
    mem = re.search(r"^MemTotal:\s*(\d+)", _read("/proc/meminfo"), re.M)
    return {
        "solardeck_version": src["version"], "solardeck_tag": src["tag"], "commit": (src["commit"] or "")[:12] or None,
        "pve_version": (pve_version or {}).get("version"), "kernel": platform.release(),
        "cpu": f"{cpu.group(1).strip() if cpu else platform.machine()} ({os.cpu_count()} threads)",
        "memory_gb": round(int(mem.group(1)) / 1024 ** 2, 1) if mem else None,
        "user_agent": "(filled in by your browser)", "logs": logs,
    }


class BugReport(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    category: Literal[CATEGORIES]  # type: ignore[valid-type]
    description: str = Field(min_length=1, max_length=10000)
    steps_to_reproduce: str = Field("", max_length=10000)
    include_diagnostics: bool = True
    user_agent: str = Field("", max_length=500)
    github_token: str | None = Field(None, max_length=255)


def format_body(r: BugReport, diag: dict | None) -> str:
    parts = [f"**Category:** {r.category}", "", "### Description", r.description.strip()]
    if r.steps_to_reproduce.strip():
        parts += ["", "### Steps to reproduce", r.steps_to_reproduce.strip()]
    if diag:
        rows = [("SolarDeck", f"{diag['solardeck_version'] or '?'} ({diag['solardeck_tag'] or 'untagged'}, {diag['commit'] or '?'})"),
                ("Proxmox VE", diag["pve_version"]), ("Kernel", diag["kernel"]), ("CPU", diag["cpu"]),
                ("Memory", f"{diag['memory_gb']} GB" if diag["memory_gb"] else None),
                ("Browser", redact(r.user_agent) or diag["user_agent"])]
        parts += ["", "### System diagnostics", "| | |", "|---|---|", *[f"| {k} | {v or '?'} |" for k, v in rows],
                  "", "<details><summary>Backend log (last 30 lines, anonymized)</summary>", "", "```",
                  *diag["logs"], "```", "</details>"]
    parts += ["", "_Reported from the SolarDeck in-app bug reporter._"]
    return "\n".join(parts)


def prefilled_url(slug: str, title: str, body: str) -> str:
    base = f"https://github.com/{slug}/issues/new?"
    note = "\n\n_(Report shortened to fit the link. Use **Copy Report Markdown** in SolarDeck and paste the full report.)_"
    text = body
    while True:
        url = base + urlencode({"title": title, "labels": ",".join(LABELS), "body": text})
        if len(url) <= URL_MAX or len(text) < 200:
            return url
        text = body[: int(len(text) * 0.8)] + note


@router.post("")
async def submit(r: BugReport):
    diag = await diagnostics() if r.include_diagnostics else None
    title = f"[{r.category}] {r.title.strip()}"
    body = format_body(r, diag)
    slug = repo_slug(settings.repo_url)
    out = {"submitted": False, "issue_url": None, "error": None, "markdown_body": body,
           "pre_filled_url": prefilled_url(slug, title, body) if slug else None}
    token = r.github_token or settings.github_token
    if token and slug:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                res = await client.post(f"https://api.github.com/repos/{slug}/issues",
                                        json={"title": title, "body": body, "labels": LABELS},
                                        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                                                 "X-GitHub-Api-Version": "2022-11-28"})
            if res.status_code == 201:
                out.update(submitted=True, issue_url=res.json().get("html_url"))
            else:
                out["error"] = f"GitHub refused the issue ({res.status_code}): {redact(res.text)[:200]}"
        except httpx.HTTPError as e:
            out["error"] = f"Could not reach GitHub: {e}"
    return out
