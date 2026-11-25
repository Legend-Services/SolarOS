"""HTTP routes of the standalone driver. Mounted ahead of the app.* routers only when HYPERVISOR_DRIVER=native_ubuntu.

Same paths, parameters and request models as the Proxmox routes they shadow, so the desktop calls the same API on
both editions. Each handler delegates to the active provider. Routes not shadowed here keep their shared handler
(helper / SSH bridge based) or answer 501 for Proxmox-only features (app.pve.pve).
"""
import asyncio
import re
from pathlib import Path as FsPath
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, WebSocket

from app import apps, backups, console, local_ai, provisioning, pve_access, pve_datacenter, storage_admin, system
from app import pve as api
from app.auth import require_user
from app.config import settings
from app.guest_hardware import SNAP_RE, VMID, SnapshotBody
from providers.registry import get_provider

from . import host, rbac
from .host import run, start_job
from .provider import NativeQemuBody, usb_sysfs

router = APIRouter(dependencies=[Depends(require_user)], tags=["native_ubuntu"])
ws_router = APIRouter(tags=["native_ubuntu"])
GuestType = Literal["qemu", "lxc"]
P = get_provider


def _upid(t) -> dict:
    return {"upid": t.task, "task": t.task, "ok": True, **({"vmid": t.vmid} if getattr(t, "vmid", None) else {})}


# ---------------------------------------------------------------- Storage, ZFS & disks
@router.get("/api/v1/storage")
async def storage():
    return await P().list_storage_pools()


@router.get("/api/v1/disks")
async def disks():
    return await P().list_physical_disks()


@router.get("/api/v1/disks/{disk:path}/smart")
async def disk_smart(disk: str):
    return await P().get_disk_smart(disk)


@router.post("/api/v1/disks/wipe")
async def disk_wipe(body: storage_admin.DeviceConfirm):
    if body.confirm_device != body.disk:
        raise HTTPException(400, "Confirmation does not match the device path")
    return {"task": (await P().wipe_disk(body.disk)).task}


@router.post("/api/v1/disks/initgpt")
async def disk_initgpt(body: storage_admin.DeviceBody):
    return {"task": (await P().init_gpt(body.disk)).task}


@router.post("/api/v1/zfs/pools")
async def pool_create(body: storage_admin.PoolBody):
    return {"task": (await P().create_zfs_pool(body.model_dump())).task}


@router.delete("/api/v1/zfs/pools/{name}")
async def pool_destroy(name: str, confirm: str = Query(max_length=64)):
    return {"task": (await P().destroy_zfs_pool(name, confirm)).task}


# ---------------------------------------------------------------- Compute
@router.get("/api/v1/guests/{guest_type}/{vmid}/config")
async def guest_config(guest_type: GuestType, vmid: int):
    return await P().get_guest_config(guest_type, vmid)


@router.patch("/api/v1/guests/{guest_type}/{vmid}/config")
async def guest_config_update(guest_type: GuestType, vmid: int, body: api.GuestConfigBody):
    from providers.base import GuestConfigUpdate
    return await P().update_guest_config(guest_type, vmid, GuestConfigUpdate(**body.model_dump()))


@router.get("/api/v1/nextid")
async def next_id():
    return {"vmid": await P().next_id()}


@router.post("/api/v1/guests/qemu")
async def create_qemu(body: NativeQemuBody):
    t = await P().create_vm(body.model_dump())
    return {"vmid": t.vmid, "upid": t.task}


@router.post("/api/v1/guests/lxc")
async def create_lxc(body: provisioning.LxcBody):
    t = await P().create_container(body.model_dump())
    return {"vmid": t.vmid, "upid": t.task}


@router.get("/api/v1/hardware/pci")
async def pci_devices():
    return await P().list_pci_devices()


@router.get("/api/v1/hardware/usb")
async def usb_devices():
    return usb_sysfs(FsPath("/sys/bus/usb/devices"))


# ---------------------------------------------------------------- Snapshots
@router.get("/api/v1/guests/{guest_type}/{vmid}/snapshots")
async def snapshots(guest_type: GuestType, vmid: VMID):
    return await P().list_snapshots(guest_type, vmid)


@router.post("/api/v1/guests/{guest_type}/{vmid}/snapshots")
async def create_snapshot(guest_type: GuestType, vmid: VMID, body: SnapshotBody):
    return _upid(await P().create_snapshot(guest_type, vmid, body.name, body.description, body.vmstate))


@router.delete("/api/v1/guests/{guest_type}/{vmid}/snapshots/{name}")
async def delete_snapshot(guest_type: GuestType, vmid: VMID, name: str = Path(pattern=SNAP_RE)):
    return _upid(await P().delete_snapshot(guest_type, vmid, name))


@router.post("/api/v1/guests/{guest_type}/{vmid}/snapshots/{name}/rollback")
async def rollback_snapshot(guest_type: GuestType, vmid: VMID, name: str = Path(pattern=SNAP_RE)):
    return _upid(await P().rollback_snapshot(guest_type, vmid, name))


# ---------------------------------------------------------------- ISO / template library & backups
@router.get("/api/v1/storage/{storage}/content")
async def storage_content(storage: str = Path(pattern=storage_admin.STORAGE_RE),
                          content: Literal["iso", "vztmpl", "backup"] | None = None):
    return await P().list_storage_content(storage, content)


@router.post("/api/v1/storage/{storage}/download-url")
async def download_url(body: provisioning.DownloadBody, storage: str = Path(pattern=storage_admin.STORAGE_RE)):
    return _upid(await P().download_url_to_storage(storage, body.model_dump()))


@router.post("/api/v1/storage/{storage}/upload")
async def upload(request: Request, storage: str = Path(pattern=storage_admin.STORAGE_RE),
                 filename: str = Query(pattern=provisioning.FILENAME_RE), content: Literal["iso"] = "iso"):
    """Raw request body = the file (streamed; nginx passes it through unbuffered)."""
    size = int(request.headers.get("content-length") or 0) or None
    return await P().upload_to_storage(storage, content, filename, request.stream(), size)


@router.delete("/api/v1/storage/{storage}/content")
async def delete_content(storage: str = Path(pattern=storage_admin.STORAGE_RE),
                         volume: str = Query(pattern=provisioning.VOLID_RE, max_length=500)):
    return _upid(await P().delete_storage_content(storage, volume))


@router.get("/api/v1/backups")
async def list_backups():
    archives, schedules = await asyncio.gather(P().list_backups(), P().list_backup_schedules())
    return {"storages": ["local"], "archives": archives, "schedules": schedules}


@router.post("/api/v1/backups/run")
async def run_backup(body: backups.RunBody):
    return _upid(await P().run_backup(body.model_dump()))


@router.post("/api/v1/backups/restore")
async def restore(body: backups.RestoreBody):
    return _upid(await P().restore_backup(body.model_dump()))


@router.post("/api/v1/backups/schedules")
async def create_schedule(body: backups.ScheduleBody):
    return await P().create_backup_schedule(body.model_dump())


@router.put("/api/v1/backups/schedules/{job_id}")
async def toggle_schedule(body: backups.ScheduleToggle, job_id: str = Path(pattern=backups.JOB_ID_RE)):
    return await P().toggle_backup_schedule(job_id, body.enabled)


@router.delete("/api/v1/backups/schedules/{job_id}")
async def delete_schedule(job_id: str = Path(pattern=backups.JOB_ID_RE)):
    return await P().delete_backup_schedule(job_id)


# ---------------------------------------------------------------- Tasks & logs
@router.get("/api/v1/tasks")
async def tasks():
    return await P().list_tasks()


@router.get("/api/v1/tasks/{upid}/status")
async def task_status(upid: str):
    return await P().get_task_status(upid)


@router.get("/api/v1/tasks/{upid}/log")
async def task_log(upid: str, start: int = 0):
    return await P().get_task_log(upid, start)


@router.get("/api/v1/logs/syslog")
async def syslog(limit: int = Query(500, ge=1, le=5000), start: int = Query(0, ge=0),
                 since: str | None = Query(None, pattern=pve_datacenter.DATE_RE),
                 until: str | None = Query(None, pattern=pve_datacenter.DATE_RE)):
    return await P().get_syslog(limit, start, since, until)


@router.get("/api/v1/logs/journal")
async def journal(lastentries: int = Query(500, ge=1, le=5000)):
    return {"lines": (await run("journalctl", "--no-pager", "-n", str(lastentries), timeout=30)).splitlines()}


@router.get("/api/v1/logs/cluster")
async def cluster_log():
    return []  # a standalone host has no cluster


@router.get("/api/v1/firewall/{scope}/rules")
async def fw_rules(scope: pve_datacenter.Scope, vmid: int | None = None):
    return await P().list_firewall_rules(scope, vmid)


# ---------------------------------------------------------------- Access control (local RBAC)
@router.get("/api/v1/access/users")
async def users():
    return await P().list_users()


@router.post("/api/v1/access/users")
async def create_user(body: pve_access.UserCreate):
    return await P().create_user(body.model_dump())


@router.put("/api/v1/access/users/{userid}")
async def update_user(body: pve_access.UserFields, userid: str = Path(pattern=pve_access.USERID_RE)):
    return await P().update_user(userid, body.model_dump(exclude_none=True))


@router.delete("/api/v1/access/users/{userid}")
async def delete_user(userid: str = Path(pattern=pve_access.USERID_RE)):
    return await P().delete_user(userid)


@router.put("/api/v1/access/users/{userid}/password")
async def set_password(body: pve_access.PasswordBody, userid: str = Path(pattern=pve_access.USERID_RE)):
    return rbac.set_password(userid, body.password)


@router.get("/api/v1/access/groups")
async def groups():
    return await P().list_groups()


@router.post("/api/v1/access/groups")
async def create_group(body: pve_access.GroupBody):
    return await P().create_group(body.model_dump())


@router.delete("/api/v1/access/groups/{groupid}")
async def delete_group(groupid: str = Path(pattern=pve_access.ID_RE)):
    return await P().delete_group(groupid)


@router.get("/api/v1/access/roles")
async def roles():
    return await P().list_roles()


@router.get("/api/v1/access/privileges")
async def privileges():
    return rbac.ADMIN_PRIVS


@router.post("/api/v1/access/roles")
async def create_role(body: pve_access.RoleCreate):
    return await P().create_role(body.model_dump())


@router.put("/api/v1/access/roles/{roleid}")
async def update_role(body: pve_access.RoleBody, roleid: str = Path(pattern=pve_access.ID_RE)):
    return await P().update_role(roleid, body.model_dump())


@router.delete("/api/v1/access/roles/{roleid}")
async def delete_role(roleid: str = Path(pattern=pve_access.ID_RE)):
    return await P().delete_role(roleid)


@router.get("/api/v1/access/acl")
async def acl():
    return await P().list_acls()


@router.post("/api/v1/access/acl")
async def add_acl(body: pve_access.AclBody):
    return await P().update_acl(body.model_dump())


@router.delete("/api/v1/access/acl")
async def delete_acl(path: str = Query(pattern=pve_access.ACL_PATH_RE, max_length=300),
                     roleid: str = Query(pattern=pve_access.ID_RE), type: str = Query(pattern=r"^(user|group|token)$"),
                     ugid: str = Query(max_length=200)):
    return await P().update_acl({"path": path, "roleid": roleid, "type": type, "ugid": ugid}, delete=True)


@router.get("/api/v1/pools")
async def pools():
    return await P().list_pools()


@router.get("/api/v1/pools/{poolid}")
async def pool(poolid: str = Path(pattern=pve_access.ID_RE)):
    return next((p for p in rbac.pools() if p["poolid"] == poolid), {"poolid": poolid, "members": []})


@router.post("/api/v1/pools")
async def create_pool(body: pve_access.PoolBody):
    return await P().create_pool(body.model_dump())


@router.put("/api/v1/pools/{poolid}/members")
async def pool_members(body: pve_access.PoolMembers, poolid: str = Path(pattern=pve_access.ID_RE)):
    return rbac.pool_members(poolid, body, host.load_guests())


@router.delete("/api/v1/pools/{poolid}")
async def delete_pool(poolid: str = Path(pattern=pve_access.ID_RE)):
    return await P().delete_pool(poolid)


@router.get("/api/v1/access/tokens")
async def tokens():
    return []  # SolarOS has no hypervisor API tokens: the backend is the API


@router.get("/api/v1/access/domains")
async def domains():
    return [{"realm": rbac.REALM, "type": "solardeck", "comment": "SolarDeck local users", "default": 1}]


# ---------------------------------------------------------------- App Center & Local AI
@router.get("/api/apps/catalog")
async def catalog():
    return await P().app_catalog()


@router.post("/api/apps/deploy")
async def deploy(body: apps.DeployBody):
    return await P().deploy_app(body)


@router.post("/api/ai/deploy")
async def deploy_ai(body: local_ai.LocalAiDeployBody):
    t = await P().provision_ai_container(body.model_dump())
    return {"vmid": t.vmid, "upid": t.task}


@router.post("/api/ai/hardware/switch")
async def ai_switch(body: local_ai.SwitchBody):
    return await P().configure_ai_gpu_passthrough(body.model_dump())


@router.get("/api/v1/network/topology")
async def topology():
    return await P().get_network_topology()


# ---------------------------------------------------------------- System (Control Panel)
@router.get("/api/system/info")
async def info():
    m, net = await asyncio.gather(P().get_node_metrics(), P().list_network_interfaces())
    os_release = dict(re.findall(r'^(\w+)="?([^"\n]*)"?$', FsPath("/etc/os-release").read_text(), re.M)) \
        if FsPath("/etc/os-release").exists() else {}
    dns = dict(re.findall(r"^(nameserver|search)\s+(\S+)", FsPath("/etc/resolv.conf").read_text(), re.M)) \
        if FsPath("/etc/resolv.conf").exists() else {}
    return {
        "node": settings.node_name, "version": {"release": os_release.get("VERSION_ID", ""), "version": "SolarOS"},
        "platform_version": f"SolarOS ({os_release.get('PRETTY_NAME', 'Linux')})", "kernel": m.kernel,
        "uptime": m.uptime, "cpu_model": m.cpuinfo.get("model", ""), "cpus": m.cpuinfo.get("cpus", 0),
        "boot_mode": "efi" if FsPath("/sys/firmware/efi").exists() else "bios",
        "network": [n.model_dump() for n in net], "dns": {"dns1": dns.get("nameserver"), "search": dns.get("search")},
        "api": {"host": "local", "token_id": "", "connected": True, "verify_ssl": True, "driver": "native_ubuntu"},
        "admin_username": settings.admin_username, "storage_root": str(settings.storage_root), "helper": "local",
    }


@router.post("/api/system/power")
async def power(body: system.PowerBody):
    async def later(log):
        await asyncio.sleep(2)  # let the HTTP response reach the browser first
        await run("systemctl", "reboot" if body.command == "reboot" else "poweroff")
    start_job(f"sr{body.command}", host.node(), later)
    return {"ok": True}


def parse_apt_upgradable(out: str) -> list[dict]:
    """`apt list --upgradable` -> rows shaped like PVE /apt/update."""
    rows = []
    for line in out.splitlines():
        m = re.match(r"^([^/\s]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]", line)
        if m:
            rows.append({"Package": m.group(1), "Origin": m.group(2).split(",")[0], "Version": m.group(3),
                         "OldVersion": m.group(4), "Title": "", "Priority": "", "Section": ""})
    return rows


@router.get("/api/system/updates")
async def updates():
    return parse_apt_upgradable(await run("apt", "list", "--upgradable", timeout=60, check=False))


@router.post("/api/system/updates/refresh")
async def refresh_updates():
    async def job(log):
        await run("apt-get", "update", log=log, timeout=600)
    return {"task": start_job("aptupdate", host.node(), job)}


def parse_sources(files: dict[str, str]) -> list[dict]:
    """deb822 *.sources and one-line *.list files -> Control Panel repository rows (read-only on this driver)."""
    repos = []
    for path, text in sorted(files.items()):
        if path.endswith(".sources"):
            for i, block in enumerate(b for b in re.split(r"\n\s*\n", text) if b.strip()):
                f = {k.lower(): v.strip() for k, v in re.findall(r"^([A-Za-z-]+):\s*(.*)$", block, re.M)}
                repos.append({"path": path, "index": i, "enabled": f.get("enabled", "yes") != "no",
                              "types": f.get("types", "").split(), "uris": f.get("uris", "").split(),
                              "suites": f.get("suites", "").split(), "components": f.get("components", "").split(),
                              "handle": None})
        else:
            for i, line in enumerate(x for x in text.splitlines() if re.match(r"^#?\s*deb(-src)?\s", x)):
                enabled = not line.lstrip().startswith("#")
                parts = re.sub(r"\[[^\]]*\]", "", line.lstrip("# ")).split()
                if len(parts) >= 3:
                    repos.append({"path": path, "index": i, "enabled": enabled, "types": [parts[0]], "uris": [parts[1]],
                                  "suites": [parts[2]], "components": parts[3:], "handle": None})
    return repos


@router.get("/api/system/repositories")
async def repositories():
    root = FsPath("/etc/apt")
    files = {str(f): f.read_text(errors="replace") for f in [root / "sources.list", *sorted((root / "sources.list.d").glob("*"))]
             if f.is_file() and f.suffix in (".list", ".sources")} if root.exists() else {}
    return {"digest": None, "repositories": parse_sources(files), "names": {}, "available": [], "errors": []}


# ---------------------------------------------------------------- Consoles
@router.post("/api/v1/guests/{guest_type}/{vmid}/vnc")
async def vnc_ticket(guest_type: GuestType, vmid: int):
    t = await P().open_vnc_console(guest_type, vmid)
    return {"session": t.session, "password": t.password}


@router.post("/api/v1/guests/{guest_type}/{vmid}/terminal")
async def terminal_ticket(guest_type: console.ShellType, vmid: int):
    return {"session": (await P().open_terminal_console(guest_type, vmid)).session}


@ws_router.websocket("/api/v1/ws/vnc/{guest_type}/{vmid}")
async def vnc_ws(ws: WebSocket, guest_type: GuestType, vmid: int):
    """noVNC <-> the VM's local VNC port (libvirt listens on 127.0.0.1 only): the websockify bridge, in-process."""
    s = await console._take(ws, "vnc", guest_type, vmid)
    if not s:
        return
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", int(s["port"]))
    except OSError as e:
        await ws.close(code=1011, reason=f"VNC connection failed: {e}"[:120])
        return
    await console._accept(ws)

    async def down():
        while data := await reader.read(65536):
            await ws.send_bytes(data)

    async def up():
        while True:
            m = await ws.receive()
            if m["type"] == "websocket.disconnect":
                return
            writer.write(m["bytes"] if m.get("bytes") is not None else (m.get("text") or "").encode())
            await writer.drain()

    tasks = [asyncio.create_task(down()), asyncio.create_task(up())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done:
        t.exception()
    writer.close()
    try:
        await ws.close()
    except RuntimeError:
        pass

