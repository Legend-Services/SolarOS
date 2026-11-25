"""noVNC / xterm.js console sessions and the SSH bridge shells shared by the drivers.

A driver's ticket route creates a one-time session (_new_session). Host and container shells are a root PTY over the
SSH key bridge (session "ssh" = the command, "" = login shell); other consoles are relayed by the active provider.
"""
import asyncio
import secrets
import time
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, WebSocket

from . import host_ssh
from .auth import COOKIE, decode_token
from providers.registry import get_provider

router = APIRouter(prefix="/api/v1", tags=["console"])


GuestType = Literal["qemu", "lxc"]


# "node" (vmid 0) is the hypervisor host itself (root shell over the SSH bridge).
ShellType = Literal["qemu", "lxc", "node"]


TICKET_TTL = 60  # seconds a console session may wait before the browser connects
_sessions: dict[str, dict] = {}


def _new_session(kind: str, guest_type: str, vmid: int, data: dict) -> str:
    now = time.monotonic()
    for k in [k for k, v in _sessions.items() if v["exp"] < now]:
        del _sessions[k]
    sid = secrets.token_urlsafe(24)
    _sessions[sid] = {"kind": kind, "guest": (guest_type, vmid), "port": data.get("port"), "ticket": data.get("ticket"),
                      "user": data.get("user", ""), "ssh": data.get("ssh"), "exp": now + TICKET_TTL}
    return sid


def _take_session(sid: str, kind: str, guest_type: str, vmid: int) -> dict | None:
    s = _sessions.pop(sid, None)  # single use
    if not s or s["kind"] != kind or s["guest"] != (guest_type, vmid) or s["exp"] < time.monotonic():
        return None
    return s


async def _authed(ws: WebSocket) -> bool:
    try:
        decode_token(ws.query_params.get("token") or ws.cookies.get(COOKIE))
    except HTTPException:
        await ws.close(code=4401, reason="Not authenticated")
        return False
    return True


async def _accept(ws: WebSocket) -> None:
    await ws.accept(subprotocol="binary" if "binary" in ws.scope.get("subprotocols", []) else None)


async def _take(ws: WebSocket, kind: str, guest_type: str, vmid: int) -> dict | None:
    if not await _authed(ws):
        return None
    s = _take_session(ws.query_params.get("session", ""), kind, guest_type, vmid)
    if not s:
        await ws.close(code=4403, reason="Invalid or expired console session")
    return s


@router.websocket("/ws/terminal/{guest_type}/{vmid}")
async def terminal_ws(ws: WebSocket, guest_type: ShellType, vmid: int):
    s = await _take(ws, "terminal", guest_type, vmid)
    if not s:
        return
    if s["ssh"] is not None:
        await _accept(ws)
        return await ssh_relay(ws, s["ssh"] or None)
    await get_provider().relay_console(ws, "terminal", guest_type, vmid, s)


def parse_term_frame(msg: str) -> tuple[str, object]:
    """Decode the terminal framing the xterm.js client speaks: "0:<len>:<data>", "1:<cols>:<rows>:", "2"."""
    if msg.startswith("0:"):
        _, _, data = msg[2:].partition(":")
        return "data", data
    if msg.startswith("1:"):
        try:
            cols, rows = (int(x) for x in msg[2:].split(":")[:2])
        except ValueError:
            return "ping", None  # malformed resize: ignore rather than drop the shell
        return "resize", (max(1, min(cols, 1000)), max(1, min(rows, 500)))
    return "ping", None


async def ssh_relay(ws: WebSocket, command: str | None) -> None:
    """Bridge an accepted browser WebSocket to a root PTY on the hypervisor host."""
    try:
        proc = await host_ssh.open_shell(command)
    except HTTPException as e:
        await ws.send_bytes(f"\r\n\x1b[31m{e.detail}\x1b[0m\r\n".encode())
        await ws.close(code=1011, reason="Host SSH bridge unavailable")
        return

    async def down():
        while data := await proc.stdout.read(65536):
            await ws.send_bytes(data)

    async def up():
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                return
            raw = m.get("text") if m.get("text") is not None else (m.get("bytes") or b"").decode(errors="replace")
            kind, val = parse_term_frame(raw)
            if kind == "data":
                proc.stdin.write(val.encode())
            elif kind == "resize":
                proc.change_terminal_size(*val)

    tasks = [asyncio.create_task(down()), asyncio.create_task(up())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done:
        t.exception()  # consume; exiting the shell or closing the tab both end here
    proc.close()
    try:
        await ws.close()
    except RuntimeError:
        pass


@router.websocket("/ws/host-shell")
async def host_shell_ws(ws: WebSocket):
    """Instant root shell on the host for the signed-in user (TopBar, Dock and Control Panel "Host Shell")."""
    # Cookies ride along on cross-site WebSocket handshakes, so require a same-origin page.
    origin = urlparse(ws.headers.get("origin", "")).hostname
    if origin and origin != (ws.headers.get("host") or "").split(":")[0]:
        await ws.close(code=4403, reason="Cross-origin shell refused")
        return
    if await _authed(ws):
        await _accept(ws)
        await ssh_relay(ws, None)
