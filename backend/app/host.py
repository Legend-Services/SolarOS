"""Client for deploy/solardeck-helper.sh, the root-only helper on the host (local, or a forced SSH command)."""
import asyncio
from collections.abc import Callable

from fastapi import HTTPException

from .config import settings


def _argv(args: list[str]) -> list[str]:
    if not settings.host_ssh:
        return [settings.name("helper"), *args]
    return ["ssh", "-i", settings.host_ssh_key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=10", settings.host_ssh, *args]


async def run(args: list[str], stdin: bytes | None = None, on_line: Callable[[str], None] | None = None,
              timeout: float = 120) -> str:
    """Run a helper command; args must already be validated (the helper re-validates them)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *_argv(args), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        raise HTTPException(503, "Host helper not available (re-run install.sh on the Proxmox host)")
    out: list[str] = []

    async def pump():
        if stdin is not None:
            proc.stdin.write(stdin)
            await proc.stdin.drain()
        proc.stdin.close()
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip("\n")
            out.append(line)
            if on_line:
                on_line(line)
        await proc.wait()

    try:
        await asyncio.wait_for(pump(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, f"Host helper timed out: {args[0]}")
    if proc.returncode:
        raise HTTPException(502, f"Host helper failed: {(out[-1] if out else '')[:300]}")
    return "\n".join(out)
