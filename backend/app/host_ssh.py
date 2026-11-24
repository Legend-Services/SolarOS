"""Root SSH bridge to the Proxmox VE host: one persistent asyncssh connection with the backend's own ed25519 key.

Used for interactive root shells (host and `pct enter`), privileged inspection (lspci, sensors, dmidecode) and host
orchestration (GPU drivers, dnsmasq, WireGuard, nftables). Long-running work goes through `start_job`, which runs the
script in a transient systemd unit on the host so a dropped connection or backend restart cannot interrupt apt/dpkg.
"""
import asyncio
import re
import shlex
from urllib.parse import urlparse

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, Path
from collections.abc import Callable

from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/host", tags=["host"], dependencies=[Depends(require_user)])
_conn: asyncssh.SSHClientConnection | None = None
_lock = asyncio.Lock()
JOB_RE = r"^[a-z0-9][a-z0-9-]{0,39}$"
JOB_DIR = "/var/lib/proxmox-os/jobs"
JOB_LOG_DIR = "/var/log/proxmox-os/jobs"


def target() -> tuple[str, str]:
    """(user, host) of the PVE host: HOST_ROOT_TARGET, else HOST_SSH, else the PVE API host name."""
    t = settings.host_root_target or settings.host_ssh or f"root@{urlparse(settings.pve_host).hostname or '127.0.0.1'}"
    user, _, host = t.rpartition("@")
    return user or "root", host


def ensure_key() -> str:
    """Create the bridge key on first use; returns the OpenSSH public key to authorize on the host."""
    key = settings.host_root_key
    if not key.exists():
        key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        k = asyncssh.generate_private_key("ssh-ed25519", comment="proxmox-os-root")
        k.write_private_key(str(key))
        k.write_public_key(str(key) + ".pub")
        key.chmod(0o600)
    return asyncssh.read_private_key(str(key)).export_public_key().decode().strip()


async def _connect() -> asyncssh.SSHClientConnection:
    ensure_key()
    user, host = target()
    known = settings.host_root_key.parent / "known_hosts"
    # install.sh writes known_hosts with the host's key. shortcut: without it the host key is not verified; re-run
    # install.sh to pin it.
    return await asyncssh.connect(host, username=user, client_keys=[str(settings.host_root_key)],
                                  known_hosts=str(known) if known.exists() else None,
                                  keepalive_interval=30, connect_timeout=10)


async def _open(command: str | None, **kw) -> asyncssh.SSHClientProcess:
    """Open a process on the shared connection, reconnecting once if the cached connection went stale."""
    global _conn
    for attempt in (0, 1):
        async with _lock:
            try:
                if _conn is None or _conn.is_closed():
                    _conn = await _connect()
                conn = _conn
            except (OSError, asyncssh.Error) as e:
                _conn = None
                raise HTTPException(503, f"Host SSH bridge unavailable ({target()[1]}): {e}. Re-run install.sh on the "
                                         "Proxmox host to authorize the SolarDeck key.")
        try:
            return await conn.create_process(command, **kw)
        except (OSError, asyncssh.Error) as e:
            async with _lock:
                if _conn is conn:
                    _conn = None
            if attempt:
                raise HTTPException(503, f"Host SSH bridge unavailable: {e}")
    raise AssertionError("unreachable")


async def run(cmd: str, *, input: str | None = None, timeout: float = 120, check: bool = True,
              on_line: Callable[[str], None] | None = None) -> str:
    """Run a shell command as root on the PVE host and return stdout+stderr. Quote untrusted values with shlex."""
    proc = await _open(cmd, stderr=asyncssh.STDOUT, encoding="utf-8", errors="replace")
    out: list[str] = []

    async def pump():
        if input is not None:
            proc.stdin.write(input)
        proc.stdin.write_eof()
        async for line in proc.stdout:
            out.append(line.rstrip("\n"))
            if on_line:
                on_line(out[-1])
        await proc.wait()

    try:
        await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, f"Host command timed out: {cmd.split()[0]}")
    if check and proc.exit_status:
        tail = next((x for x in reversed(out) if x.strip()), "")
        raise HTTPException(502, f"Host command failed (exit {proc.exit_status}): {tail[:300]}")
    return "\n".join(out)


async def write_file(path: str, content: str, mode: str = "644") -> None:
    """Atomically write a file on the host (parent directories are created)."""
    p = shlex.quote(path)
    await run(f"mkdir -p \"$(dirname {p})\" && cat > {p}.tmp && chmod {mode} {p}.tmp && mv {p}.tmp {p}", input=content)


async def read_file(path: str, default: str = "") -> str:
    p = shlex.quote(path)
    return await run(f"cat {p} 2>/dev/null || true") or default


async def open_shell(command: str | None, cols: int = 80, rows: int = 24) -> asyncssh.SSHClientProcess:
    """Interactive PTY: a root login shell on the host (command=None) or e.g. `pct enter 101`. Bytes in/out."""
    return await _open(command, term_type="xterm-256color", term_size=(cols, rows), request_pty="force",
                       encoding=None)


async def close() -> None:
    if _conn is not None:
        _conn.close()


# ---------------------------------------------------------------- Detached host jobs


def parse_job_status(out: str) -> dict:
    lines = out.splitlines()
    state = lines[0].removeprefix("state:") if lines and lines[0].startswith("state:") else "unknown"
    log = lines[1:]
    m = next((re.match(r"proxmox-os: exit (\d+)", x) for x in reversed(log) if x.startswith("proxmox-os: exit")), None)
    return {"running": state in ("active", "activating"), "exit_code": int(m.group(1)) if m else None, "log": log}


async def start_job(name: str, script: str) -> None:
    """Run a bash script detached on the host as unit proxmox-os-job-<name>; follow it with job_status(name)."""
    if not re.fullmatch(JOB_RE, name):
        raise ValueError(name)
    unit, sh, log = f"proxmox-os-job-{name}", f"{JOB_DIR}/{name}.sh", f"{JOB_LOG_DIR}/{name}.log"
    if (await run(f"systemctl is-active {unit} || true")).strip() in ("active", "activating"):
        raise HTTPException(409, f"{name} is already running")
    await write_file(sh, "set -uo pipefail\n" + script, "700")
    await run(f"mkdir -p {JOB_LOG_DIR} && systemctl reset-failed {unit} 2>/dev/null; "
              f"systemd-run --quiet --unit={unit} --collect -p StandardOutput=truncate:{log} -p StandardError=inherit "
              f"-E DEBIAN_FRONTEND=noninteractive -E APT_LISTCHANGES_FRONTEND=none "
              f"bash -c 'bash {sh}; echo \"proxmox-os: exit $?\"'")


async def job_status(name: str) -> dict:
    if not re.fullmatch(JOB_RE, name):
        raise ValueError(name)
    out = await run(f"echo state:$(systemctl is-active proxmox-os-job-{name} 2>/dev/null || true); "
                    f"tail -n 400 {JOB_LOG_DIR}/{name}.log 2>/dev/null || true")
    return {"name": name, **parse_job_status(out)}


@router.get("/jobs/{name}")
async def get_job(name: str = Path(pattern=JOB_RE)):
    return await job_status(name)


@router.get("/bridge")
async def bridge():
    """Key + connectivity status of the root SSH bridge (shown in Control Panel)."""
    user, host = target()
    info = {"target": f"{user}@{host}", "public_key": ensure_key(), "connected": False, "error": None,
            "host_key_pinned": (settings.host_root_key.parent / "known_hosts").exists()}
    try:
        info["hostname"] = (await run("hostname", timeout=15)).strip()
        info["connected"] = True
    except HTTPException as e:
        info["error"] = e.detail
    return info
