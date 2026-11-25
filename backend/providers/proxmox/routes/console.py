"""Proxmox consoles: VNC and QEMU serial terminals get a short-lived PVE ticket over HTTP, then a WebSocket relay to
vncwebsocket. LXC shells are `pct enter <vmid>` over the SSH bridge (app.console.ssh_relay), so no second login."""
import asyncio
import ssl
from urllib.parse import quote

from fastapi import APIRouter, Depends, WebSocket
from websockets.asyncio.client import connect

from app.auth import require_user
from app.console import GuestType, ShellType, _accept, _new_session, _take

from ..api import _node, pve, pve_settings

router = APIRouter(prefix="/api/v1", tags=["console"])


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
    if not pve_settings.verify_ssl:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _open(ws: WebSocket, kind: str, guest_type: str, vmid: int, s: dict | None = None):
    """Authenticate the browser, accept it, and connect upstream. Returns (session, upstream) or None."""
    s = s or await _take(ws, kind, guest_type, vmid)
    if not s:
        return None
    await _accept(ws)
    base = pve_settings.host.rstrip("/").replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    url = (f"{base}/api2/json{_target(guest_type, vmid, '/vncwebsocket')}"
           f"?port={s['port']}&vncticket={quote(s['ticket'], safe='')}")
    try:
        upstream = await connect(
            url, ssl=_ssl() if url.startswith("wss") else None, subprotocols=["binary"], max_size=None,
            additional_headers=pve_settings.auth_header,
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


async def relay_terminal(ws: WebSocket, guest_type: str, vmid: int, s: dict) -> None:
    """QEMU serial terminal through termproxy (app.console.terminal_ws hands over non-SSH sessions)."""
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
