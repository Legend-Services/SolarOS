"""Proxmox side of Automation & Alerts: rule power actions and the live network topology from the API."""
import asyncio

from fastapi import APIRouter, Depends

from app import host_ssh, net_services
from app.auth import require_user
from app.automation import build_topology, guest_ips, parse_guest_nets, parse_ip_links

from ..api import _node, _safe, pve

router = APIRouter(prefix="/api/v1/network", tags=["automation"], dependencies=[Depends(require_user)])


async def guest_rule_power(kind: str, vmid: int, action: str) -> str:
    """Automation rule power action (stop = shutdown with forceStop, restart = reboot when running)."""
    base = _node(f"/{kind}/{vmid}/status")
    cur = (await pve("GET", f"{base}/current")).get("status")
    if action == "stop_guest":
        if cur == "stopped":
            return "Already stopped"
        await pve("POST", f"{base}/shutdown", data={"forceStop": 1})
        return "Shutdown sent"
    verb = "reboot" if action == "restart_guest" and cur == "running" else "start"
    if verb == "start" and cur == "running":
        return "Already running"
    await pve("POST", f"{base}/{verb}")
    return "Restart sent" if verb == "reboot" else "Start sent"


@router.get("/topology")
async def topology():
    network, qemu, lxc, links, wg, wg_live, router_cfg = await asyncio.gather(
        _safe(_node("/network"), []), _safe(_node("/qemu"), []), _safe(_node("/lxc"), []),
        host_ssh.run("ip -j link show", check=False, timeout=15),
        net_services.load("wg", net_services.WG_DEFAULT), net_services.wg_dump(),
        net_services.load("router", net_services.ROUTER_DEFAULT), return_exceptions=True)
    ok = lambda v, d: d if isinstance(v, BaseException) else (v or d)  # noqa: E731 - host bridge down: still show API data
    items = [(k, g) for k, lst in (("qemu", ok(qemu, [])), ("lxc", ok(lxc, []))) for g in lst]
    cfgs = await asyncio.gather(*[_safe(_node(f"/{k}/{g['vmid']}/config"), {}) for k, g in items])

    async def live(k, g):
        if g.get("status") != "running":
            return None
        path = f"/lxc/{g['vmid']}/interfaces" if k == "lxc" else f"/qemu/{g['vmid']}/agent/network-get-interfaces"
        return await _safe(_node(path), None)

    lives = await asyncio.gather(*[live(k, g) for k, g in items])
    guests = [{"type": k, "vmid": int(g["vmid"]), "name": g.get("name"), "status": g.get("status"),
               "nets": parse_guest_nets(k, c or {}), "ips": guest_ips(k, lv)} for (k, g), c, lv in zip(items, cfgs, lives)]
    return build_topology(ok(network, []), parse_ip_links(ok(links, "")), sorted(guests, key=lambda g: g["vmid"]),
                          ok(wg, {}), ok(wg_live, {}), ok(router_cfg, {}))
