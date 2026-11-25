"""Root SSH bridge to the hypervisor host: one persistent asyncssh connection with the backend's own ed25519 key.

Used for interactive root shells (host and containers), privileged inspection (lspci, sensors, dmidecode) and host
orchestration (GPU drivers, dnsmasq, WireGuard, nftables). Long-running work goes through `start_job`, which runs the
script in a transient systemd unit on the host so a dropped connection or backend restart cannot interrupt apt/dpkg.
"""
import asyncio
import re
import shlex

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, Path
from collections.abc import Callable

from .auth import require_user
from .config import settings
from providers.registry import get_provider

router = APIRouter(prefix="/api/host", tags=["host"], dependencies=[Depends(require_user)])
_conn: asyncssh.SSHClientConnection | None = None
_lock = asyncio.Lock()
JOB_RE = r"^[a-z0-9][a-z0-9-]{0,39}$"
JOB_DIR = f"/var/lib/{settings.system_prefix}/jobs"
JOB_LOG_DIR = f"/var/log/{settings.system_prefix}/jobs"


def target() -> tuple[str, str]:
    """(user, host) of the hypervisor host: HOST_ROOT_TARGET, else HOST_SSH, else the provider's host address."""
    t = settings.host_root_target or settings.host_ssh or f"root@{get_provider().host_address()}"
    user, _, host = t.rpartition("@")
    return user or "root", host


def ensure_key() -> str:
    """Create the bridge key on first use; returns the OpenSSH public key to authorize on the host."""
    key = settings.host_root_key
    if not key.exists():
        key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        k = asyncssh.generate_private_key("ssh-ed25519", comment=settings.name("root"))
        k.write_private_key(str(key))
        k.write_public_key(str(key) + ".pub")
        key.chmod(0o600)
    return asyncssh.read_private_key(str(key)).export_public_key().decode().strip()


async def _connect() -> asyncssh.SSHClientConnection:
    ensure_key()
    user, host = target()
    # Host key not verified so a reinstalled or newly provisioned host never locks the bridge out.
    return await asyncssh.connect(host, username=user, client_keys=[str(settings.host_root_key)], known_hosts=None,
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
            except (OSError, ValueError, asyncssh.Error) as e:  # ValueError: unreadable key file
                _conn = None
                raise HTTPException(503, f"Host SSH bridge unavailable ({target()[1]}): {e}. Re-run the installer on the "
                                         "host to authorize the SolarDeck key.")
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
    """Run a shell command as root on the host and return stdout+stderr. Quote untrusted values with shlex."""
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


async def run_host_cmd(cmd: str, timeout: int = 10) -> tuple[bool, str, str]:
    """Run a host command without raising: (exit status 0, stdout, stderr or the connection error)."""
    proc = None
    try:
        proc = await _open(cmd, encoding="utf-8", errors="replace")
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.exit_status == 0, out or "", err or ""
    except HTTPException as e:
        return False, "", str(e.detail)
    except asyncio.TimeoutError:
        if proc:
            proc.kill()
        return False, "", f"Host command timed out after {timeout}s"
    except (asyncssh.Error, OSError) as e:
        return False, "", f"Host SSH bridge error: {e}"


def setup_command(public_key: str) -> str:
    """One-liner to paste into the host shell to authorize the bridge key on a manual setup."""
    k = shlex.quote(public_key)
    return (f"mkdir -p /root/.ssh && touch /root/.ssh/authorized_keys && (grep -qxF {k} /root/.ssh/authorized_keys || "
            f"echo {k} >> /root/.ssh/authorized_keys) && chmod 600 /root/.ssh/authorized_keys")


def public_key_or_none() -> str | None:
    try:
        return ensure_key()
    except (OSError, ValueError):
        return None


async def write_file(path: str, content: str, mode: str = "644") -> None:
    """Atomically write a file on the host (parent directories are created)."""
    p = shlex.quote(path)
    await run(f"mkdir -p \"$(dirname {p})\" && cat > {p}.tmp && chmod {mode} {p}.tmp && mv {p}.tmp {p}", input=content)


async def read_file(path: str, default: str = "") -> str:
    p = shlex.quote(path)
    return await run(f"cat {p} 2>/dev/null || true") or default


async def open_shell(command: str | None, cols: int = 80, rows: int = 24) -> asyncssh.SSHClientProcess:
    """Interactive PTY: a root login shell on the host (command=None) or a command such as a container shell. Bytes in/out."""
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
    m = next((re.fullmatch(r"[\w-]+: exit (\d+)", x.strip()) for x in reversed(log) if re.fullmatch(r"[\w-]+: exit (\d+)", x.strip())), None)
    return {"running": state in ("active", "activating"), "exit_code": int(m.group(1)) if m else None, "log": log}


async def start_job(name: str, script: str) -> None:
    """Run a bash script detached on the host as unit <prefix>-job-<name>; follow it with job_status(name)."""
    if not re.fullmatch(JOB_RE, name):
        raise ValueError(name)
    unit, sh, log = settings.name(f"job-{name}"), f"{JOB_DIR}/{name}.sh", f"{JOB_LOG_DIR}/{name}.log"
    if (await run(f"systemctl is-active {unit} || true")).strip() in ("active", "activating"):
        raise HTTPException(409, f"{name} is already running")
    await write_file(sh, "set -uo pipefail\n" + script, "700")
    await run(f"mkdir -p {JOB_LOG_DIR} && systemctl reset-failed {unit} 2>/dev/null; "
              f"systemd-run --quiet --unit={unit} --collect -p StandardOutput=truncate:{log} -p StandardError=inherit "
              f"-E DEBIAN_FRONTEND=noninteractive -E APT_LISTCHANGES_FRONTEND=none "
              f"bash -c 'bash {sh}; echo \"solardeck: exit $?\"'")


async def job_status(name: str) -> dict:
    if not re.fullmatch(JOB_RE, name):
        raise ValueError(name)
    out = await run(f"echo state:$(systemctl is-active {settings.name('job-' + name)} 2>/dev/null || true); "
                    f"tail -n 400 {JOB_LOG_DIR}/{name}.log 2>/dev/null || true")
    return {"name": name, **parse_job_status(out)}


@router.get("/jobs/{name}")
async def get_job(name: str = Path(pattern=JOB_RE)):
    return await job_status(name)


@router.get("/bridge")
async def bridge():
    """Key + connectivity status of the root SSH bridge (shown in Control Panel)."""
    user, host = target()
    pub = public_key_or_none()
    ok, out, err = await run_host_cmd("hostname", timeout=15)
    info = {"target": f"{user}@{host}", "public_key": pub or "", "connected": ok,
            "error": None if ok else (err.strip() or "Host SSH bridge unavailable"),
            "setup_command": setup_command(pub) if pub else None}
    if ok:
        info["hostname"] = out.strip()
    return info
