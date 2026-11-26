"""Security-by-Design module orchestrator: which optional modules are on, where they run and which network they live on.

Every toggleable module has a profile in data/platform_modules.json:
  enabled, runtime_mode ("container" = an isolated worker container deployed through App Center, "host_native" = on the
  hypervisor host over the SSH bridge), network_isolation_mode ("management" | "vlan" | "dmz" | "isolated_lab"),
  bound_bridge, bound_vlan_id, service_ip and security_hardening flags.

A module pinned to a VLAN or DMZ gets least-privilege firewall rules (render_isolation_rules): its service ports are
only reachable on its own network, and a container module's address may not open connections into the management
network (replies to connections made from there still pass). The rules live in their own nftables table, applied by a
oneshot unit so they survive reboots; the hypervisor firewall and other tables are never touched.

Module routers gate themselves with Depends(require_module("<id>")): a disabled module answers 409.
"""
import asyncio
import ipaddress
import json
import shlex
from pathlib import Path as FsPath
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from . import audit_log, host_ssh
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/platform/modules", tags=["platform_modules"], dependencies=[Depends(require_user)])

DATA = FsPath(__file__).resolve().parent.parent / "data"
STATE = DATA / "platform_modules.json"
P = settings.system_prefix
NFT_TABLE = f"{P.replace('-', '_')}_modules"
UNIT = f"{P}-module-isolation"
RULES_SH = f"/etc/{P}/net/module-isolation.sh"
HEADER = "# Managed by SolarDeck (Security-by-Design module isolation). Changes here are overwritten.\n"

ModuleId = Literal["reverse_proxy", "offsite_backup", "image_hub", "ups_power", "oob_bmc", "vlan_firewall",
                   "storage_protocols", "rbac_users"]
Runtime = Literal["container", "host_native"]
Isolation = Literal["management", "vlan", "dmz", "isolated_lab"]

# modes: runtimes the module really supports; worker: App Center system app used in container mode;
# ports: the service ports the isolation rules open on the module's own network.
SPECS: dict[str, dict] = {
    "reverse_proxy": {"modes": ["container", "host_native"], "recommended": "container", "worker": "edge-proxy",
                      "ports": [("tcp", "80"), ("tcp", "443")]},
    "offsite_backup": {"modes": ["container", "host_native"], "recommended": "container", "worker": "backup-worker",
                       "ports": []},
    # Downloads land in the hypervisor's own storage, so the hub always runs there.
    "image_hub": {"modes": ["host_native"], "recommended": "host_native", "ports": []},
    "ups_power": {"modes": ["host_native"], "recommended": "host_native", "ports": [("tcp", "3493")]},
    "oob_bmc": {"modes": ["host_native"], "recommended": "host_native", "ports": []},
    "vlan_firewall": {"modes": ["host_native"], "recommended": "host_native", "ports": []},
    "storage_protocols": {"modes": ["host_native"], "recommended": "host_native",
                          "ports": [("tcp", "2049"), ("udp", "2049"), ("tcp", "111"), ("udp", "111"), ("tcp", "8090")]},
    "rbac_users": {"modes": ["host_native"], "recommended": "host_native", "ports": []},
}
MODULE_IDS = tuple(SPECS)


class Hardening(BaseModel):
    read_only_rootfs: bool = True
    drop_capabilities: bool = True
    non_root_user: bool = True
    auto_firewall_rules: bool = True
    audit_logging: bool = True


def default_profile(module_id: str) -> dict:
    spec = SPECS[module_id]
    return {"module_id": module_id, "enabled": False, "runtime_mode": spec["recommended"],
            "recommended_runtime_mode": spec["recommended"], "supported_runtime_modes": spec["modes"],
            "network_isolation_mode": "management", "bound_bridge": settings.default_bridge, "bound_vlan_id": None,
            "service_ip": None, "security_hardening": Hardening().model_dump(), "worker_vmid": None}


def load() -> dict[str, dict]:
    try:
        saved = json.loads(STATE.read_text())
    except (OSError, ValueError):
        saved = {}
    out = {}
    for mid in MODULE_IDS:
        p = {**default_profile(mid), **saved.get(mid, {})}
        p["recommended_runtime_mode"], p["supported_runtime_modes"] = SPECS[mid]["recommended"], SPECS[mid]["modes"]
        out[mid] = p
    return out


def save(state: dict[str, dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.chmod(0o600)
    tmp.replace(STATE)


def profile(module_id: str) -> dict:
    return load()[module_id]


def update_profile(module_id: str, **changes) -> dict:
    state = load()
    state[module_id].update(changes)
    save(state)
    return state[module_id]


def require_module(module_id: str):
    """Route dependency: 409 while the module is switched off in Security-by-Design module settings."""
    def dep() -> None:
        if not profile(module_id)["enabled"]:
            raise HTTPException(409, f"The {module_id.replace('_', ' ')} module is turned off; enable it first")
    return dep


# ---------------------------------------------------------------- Least-privilege isolation rules (pure, tested)


def iface_of(p: dict) -> str:
    """Host interface a module's network is on: the bridge, or its VLAN sub-interface."""
    return f"{p['bound_bridge']}.{p['bound_vlan_id']}" if p.get("bound_vlan_id") else p["bound_bridge"]


def render_isolation_rules(state: dict[str, dict], management_cidrs: list[str]) -> str:
    """nftables table for every enabled module pinned to a VLAN, DMZ or lab with auto_firewall_rules on."""
    inp, fwd = [], []
    mgmt = ", ".join(str(ipaddress.ip_network(c, strict=False)) for c in management_cidrs if ":" not in c)
    for mid, p in state.items():
        if not p["enabled"] or p["network_isolation_mode"] == "management" or not p["security_hardening"]["auto_firewall_rules"]:
            continue
        iface = iface_of(p)
        for proto, port in SPECS[mid]["ports"]:
            # Service port only on the module's own network; dropped on every other interface of the host.
            inp.append(f'    iifname != "{iface}" {proto} dport {port} drop comment "{mid}"')
        if p["runtime_mode"] == "container" and p.get("service_ip") and mgmt:
            ip = str(ipaddress.ip_address(p["service_ip"]))
            fwd.append(f'    ip saddr {ip} ip daddr {{ {mgmt} }} ct state new drop comment "{mid} lateral"')
    return (f"table inet {NFT_TABLE} {{\n"
            "  chain input {\n    type filter hook input priority -5; policy accept;\n"
            "    ct state established,related accept\n" + "".join(x + "\n" for x in inp) + "  }\n"
            "  chain forward {\n    type filter hook forward priority -5; policy accept;\n"
            "    ct state established,related accept\n" + "".join(x + "\n" for x in fwd) + "  }\n}\n")


def render_rules_script(rules: str) -> str:
    return (f"#!/bin/bash\n{HEADER}nft delete table inet {NFT_TABLE} 2>/dev/null || true\n"
            f"nft -f - <<'NFT'\n{rules}NFT\n")


RULES_UNIT = f"""[Unit]
Description=SolarDeck module isolation firewall
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash {RULES_SH}
ExecStop=/usr/sbin/nft delete table inet {NFT_TABLE}

[Install]
WantedBy=multi-user.target
"""


async def management_cidrs() -> list[str]:
    out = await host_ssh.run(f"ip -4 -o addr show dev {shlex.quote(settings.default_bridge)} | awk '{{print $4}}'", check=False)
    return [c for c in out.split() if "/" in c]


async def apply_isolation() -> str:
    rules = render_isolation_rules(load(), await management_cidrs())
    await host_ssh.write_file(RULES_SH, render_rules_script(rules), "700")
    await host_ssh.write_file(f"/etc/systemd/system/{UNIT}.service", RULES_UNIT)
    await host_ssh.run(f"systemctl daemon-reload && systemctl enable -q {UNIT} && systemctl restart {UNIT}", timeout=60)
    return rules


def driver():
    """The active hypervisor driver's part of the core modules (providers/<driver>/modules.py)."""
    from providers.registry import get_provider
    d = get_provider().module_driver()
    if d is None:
        raise get_provider().not_available()
    return d


# ---------------------------------------------------------------- Runtime: host or isolated worker container


async def worker(module_id: str) -> int | None:
    """VMID of the module's worker container when it exists."""
    from . import apps
    app_id = SPECS[module_id].get("worker")
    rows = [r for r in await apps.reconcile() if r["app_id"] == app_id]
    vmid = rows[0]["guest_id"] if rows else None
    if vmid != profile(module_id).get("worker_vmid"):
        update_profile(module_id, worker_vmid=vmid)
    return vmid


async def ensure_worker(module_id: str) -> dict:
    """Deploy the module's worker container (App Center system app) unless it is there; returns {vmid, job_id}."""
    from . import apps
    from providers.registry import get_provider
    if vmid := await worker(module_id):
        return {"vmid": vmid, "job_id": None}
    app = apps.BY_ID[SPECS[module_id]["worker"]]
    res = await get_provider().deploy_app(apps.DeployBody(
        app_id=app["id"], instance_label="", cores=app["cores"], memory=app["memory_mb"], disk_gb=app["disk_gb"],
        mount_storage=bool(app.get("supports_storage_mount"))))
    vmid = res.get("vmid") or int(str(res.get("job_id", "app-0")).split("-")[-1])
    update_profile(module_id, worker_vmid=vmid)
    return {"vmid": vmid, "job_id": res.get("job_id") or f"app-{vmid}"}


async def run(module_id: str, script: str, timeout: float = 300, log=None) -> str:
    """Run a bash script where the module lives: in its worker container, or as root on the host."""
    p = profile(module_id)
    if p["runtime_mode"] == "container":
        from providers.registry import get_provider
        vmid = await worker(module_id)
        if not vmid:
            raise HTTPException(409, "The isolated container for this module is not deployed yet")
        return await get_provider().container_exec(vmid, script, timeout=timeout, log=log)
    return await host_ssh.run("bash -s", input=script, timeout=timeout, on_line=log)


async def place_worker(module_id: str) -> dict:
    """Move the worker container's first NIC onto the module's bridge / VLAN and record its address."""
    from . import network_switch as nsw
    from providers.registry import get_provider
    p = profile(module_id)
    vmid = await worker(module_id)
    if not vmid:
        return p
    with_ip = {}
    try:
        await nsw.update_guest_vnic(nsw.GuestVnicBody(bridge=p["bound_bridge"], vlan_tag=p["bound_vlan_id"]), "lxc", vmid, "net0")
    except HTTPException as e:
        if e.status_code not in (404, 501):
            raise
    for _ in range(10):  # the container takes a new DHCP lease on its new network
        if ip := await get_provider().container_ip(vmid):
            with_ip = {"service_ip": ip}
            break
        await asyncio.sleep(2)
    return update_profile(module_id, **with_ip)


# ---------------------------------------------------------------- Routes


class ProfileBody(BaseModel):
    enabled: bool
    runtime_mode: Runtime
    network_isolation_mode: Isolation = "management"
    bound_bridge: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,14}$")
    bound_vlan_id: int | None = Field(None, ge=1, le=4094)
    service_ip: str | None = None
    security_hardening: Hardening = Hardening()

    @field_validator("service_ip")
    @classmethod
    def _ip(cls, v: str | None) -> str | None:
        return str(ipaddress.ip_address(v)) if v else None


@router.get("")
async def list_modules():
    return {"modules": list(load().values())}


@router.get("/{module_id}")
async def get_module(module_id: ModuleId = Path()):
    return profile(module_id)


@router.put("/{module_id}")
async def put_module(body: ProfileBody, module_id: ModuleId = Path(), user: str = Depends(require_user)):
    if body.runtime_mode not in SPECS[module_id]["modes"]:
        raise HTTPException(422, f"{module_id} cannot run in {body.runtime_mode} mode")
    if body.network_isolation_mode == "vlan" and not body.bound_vlan_id:
        raise HTTPException(422, "Pick the VLAN this module is pinned to")
    if body.network_isolation_mode == "management":
        body.bound_vlan_id = None
    before = profile(module_id)
    p = update_profile(module_id, **body.model_dump())
    audit_log.record("module.update", user=user, module=module_id, enabled=body.enabled, runtime=body.runtime_mode,
                     network=body.network_isolation_mode)
    job = None
    if p["enabled"] and p["runtime_mode"] == "container":
        job = (await ensure_worker(module_id))["job_id"]
        if not job and (before["bound_bridge"], before["bound_vlan_id"]) != (p["bound_bridge"], p["bound_vlan_id"]):
            p = await place_worker(module_id)
    hook = HOOKS.get(module_id)
    if hook and not job:
        await hook(before, p)
    rules = await apply_isolation() if (p["network_isolation_mode"] != "management" or
                                        before["network_isolation_mode"] != "management") else None
    return {**p, "job_id": job, "ruleset": rules}


@router.post("/{module_id}/place")
async def place(module_id: ModuleId = Path()):
    """After a worker container finished deploying: put it on its network, then re-apply rules and the module."""
    p = await place_worker(module_id)
    if hook := HOOKS.get(module_id):
        await hook(p, p)
    await apply_isolation()
    return p


@router.get("/{module_id}/ruleset")
async def ruleset(module_id: ModuleId = Path()):
    return {"rules": render_isolation_rules({module_id: profile(module_id)}, await management_cidrs()),
            "live": await host_ssh.run(f"nft list table inet {NFT_TABLE} 2>/dev/null || true", check=False)}


# Modules register a coroutine (before, after) that migrates them when their runtime or network changes.
HOOKS: dict[str, object] = {}
