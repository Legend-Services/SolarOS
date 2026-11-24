"""noVNC / xterm.js consoles.

VNC and QEMU serial terminals: get a short-lived PVE ticket over HTTP, then relay a WebSocket to vncwebsocket.
Host and LXC shells: a root PTY over the SSH key bridge (`pct enter <vmid>` for containers), so no second login.
"""
import asyncio
import secrets
import ssl
import time
from typing import Literal
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from websockets.asyncio.client import connect

from . import host_ssh
from .auth import COOKIE, decode_token, require_user
from .config import settings
from .pve import _node, pve

GuestType = Literal["qemu", "lxc"]
# "node" (vmid 0) is the Proxmox host itself (root shell over the SSH bridge).
ShellType = Literal["qemu", "lxc", "node"]
TICKET_TTL = 60  # seconds a console session may wait before the browser connects

router = APIRouter(prefix="/api/v1", tags=["console"])
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


@router.post("/guests/{guest_type}/{vmid}/vnc", dependencies=[Depends(require_user)])
async def vnc_ticket(guest_type: GuestType, vmid: int):
    data = await pve("POST", _node(f"/{guest_type}/{vmid}/vncproxy"), data={"websocket": 1})
    # With websocket=1 the VNC password is the ticket itself; noVNC needs it for RFB auth.
    return {"session": _new_session("vnc", guest_type, vmid, data), "password": data["ticket"]}


@router.post("/guests/{guest_type}/{vmid}/terminal", dependencies=[Depends(require_user)])
async def terminal_ticket(guest_type: ShellType, vmid: int):
    # Containers and the host get an instant root PTY over the SSH bridge ("" = login shell).
    if guest_type in ("lxc", "node"):
        return {"session": _new_session("terminal", guest_type, vmid,
                                        {"ssh": f"pct enter {int(vmid)}" if guest_type == "lxc" else ""})}
    # QEMU guests only get a shell through a serial port (serial0 must be configured on the VM).
    params = {"serial": "serial0"} if guest_type == "qemu" else {}
    data = await pve("POST", _target(guest_type, vmid, "/termproxy"), data=params)
    return {"session": _new_session("terminal", guest_type, vmid, data)}


def _target(guest_type: str, vmid: int, suffix: str) -> str:
    return _node(suffix) if guest_type == "node" else _node(f"/{guest_type}/{vmid}{suffix}")


def _ssl() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not settings.pve_verify_ssl:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


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


async def _open(ws: WebSocket, kind: str, guest_type: str, vmid: int, s: dict | None = None):
    """Authenticate the browser, accept it, and connect upstream. Returns (session, upstream) or None."""
    s = s or await _take(ws, kind, guest_type, vmid)
    if not s:
        return None
    await _accept(ws)
    base = settings.pve_host.rstrip("/").replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    url = (f"{base}/api2/json{_target(guest_type, vmid, '/vncwebsocket')}"
           f"?port={s['port']}&vncticket={quote(s['ticket'], safe='')}")
    try:
        upstream = await connect(
            url, ssl=_ssl() if url.startswith("wss") else None, subprotocols=["binary"], max_size=None,
            additional_headers={"Authorization": f"PVEAPIToken={settings.pve_token_id}={settings.pve_token_secret}"},
        )
    except Exception as e:  # noqa: BLE001 - any upstream failure is reported to the browser
        await ws.close(code=1011, reason=f"Proxmox connection failed: {e}"[:120])
        return None
    return s, upstream


async def _relay(ws: WebSocket, upstream) -> None:
    async def down():
        async for msg in upstream:
            await (ws.send_bytes(msg) if isinstance(msg, bytes) else ws.send_text(msg))

    async def up():
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                return
            await upstream.send(m["bytes"] if m.get("bytes") is not None else m.get("text", ""))

    tasks = [asyncio.create_task(down()), asyncio.create_task(up())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done:
        t.exception()  # consume; a dropped peer is a normal way for a console to end
    await upstream.close()
    try:
        await ws.close()
    except RuntimeError:
        pass  # already closed by the browser


@router.websocket("/ws/vnc/{guest_type}/{vmid}")
async def vnc_ws(ws: WebSocket, guest_type: GuestType, vmid: int):
    opened = await _open(ws, "vnc", guest_type, vmid)
    if opened:
        await _relay(ws, opened[1])


@router.websocket("/ws/terminal/{guest_type}/{vmid}")
async def terminal_ws(ws: WebSocket, guest_type: ShellType, vmid: int):
    s = await _take(ws, "terminal", guest_type, vmid)
    if not s:
        return
    if s["ssh"] is not None:
        await _accept(ws)
        return await ssh_relay(ws, s["ssh"] or None)
    opened = await _open(ws, "terminal", guest_type, vmid, s)
    if not opened:
        return
    s, upstream = opened
    # termproxy expects "<user>:<ticket>\n" first and answers "OK"; done here so the ticket never reaches the browser.
    try:
        await upstream.send(f"{s['user']}:{s['ticket']}\n")
        reply = await asyncio.wait_for(upstream.recv(), 10)
    except Exception:  # noqa: BLE001
        reply = b""
    if (reply.encode() if isinstance(reply, str) else reply)[:2] != b"OK":
        await upstream.close()
        await ws.close(code=1011, reason="Terminal authentication failed")
        return
    await _relay(ws, upstream)


# ---------------------------------------------------------------- SSH bridge shells


def parse_term_frame(msg: str) -> tuple[str, object]:
    """Decode the termproxy framing the xterm.js client speaks: "0:<len>:<data>", "1:<cols>:<rows>:", "2"."""
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
    """Bridge an accepted browser WebSocket to a root PTY on the PVE host."""
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
    """Instant root@pve shell for the signed-in user (TopBar, Dock and Control Panel "Host Shell")."""
    # Cookies ride along on cross-site WebSocket handshakes, so require a same-origin page.
    origin = urlparse(ws.headers.get("origin", "")).hostname
    if origin and origin != (ws.headers.get("host") or "").split(":")[0]:
        await ws.close(code=4403, reason="Cross-origin shell refused")
        return
    if await _authed(ws):
        await _accept(ws)
        await ssh_relay(ws, None)
