"""Clustering on SolarOS (contract: app.cluster).

The SolarOS Cluster Control Plane (app.cluster) does membership, quorum and failover itself (NATIVE_HA). Here:
- Live migration: VMs move with `virsh migrate --live --persistent --undefinesource --copy-storage-all` after their
  disks were pre-created on the target (zvols with the same volsize, qcow2 files with the same virtual size); stopped
  VMs are copied (ZFS send / rsync) and defined there. Containers move with `incus export` → `incus import` (restart).
- Replication: zvol disks are sent incrementally (`zfs send -i | ssh <standby> zfs receive -F`), qcow2 files with
  `rsync --inplace`, the domain XML and NVRAM land in HA_DIR on the standby; containers as an uncompressed
  `incus export` in HA_DIR (rsync only ships changed blocks).
- Promote defines and starts the replica on its host; fence stops a local copy; demote undefines a stale local VM
  (its disks stay as the replica target) or renames a stale container to <name>-pre-failover.
"""
import json
import posixpath
import shlex
import time

from fastapi import HTTPException

from app import cluster as c

from . import host

NATIVE_HA = True
q = shlex.quote


def disks_of(xml: str) -> list[dict]:
    """[{kind: zvol|file, path, cdrom}] of a domain (network / empty drives skipped)."""
    out = []
    for d in host.parse_domain(xml)["disks"]:
        p = d["path"]
        if not p:
            continue
        out.append({"kind": "zvol" if p.startswith("/dev/zvol/") else "file", "path": p, "cdrom": d["device"] == "cdrom",
                    "format": d["format"]})
    return out


def ssh_to(dst: dict) -> str:
    return f"{c.SSH} root@{q(dst['address'])}"


async def _precreate(src: dict, dst: dict, disk: dict) -> None:
    if disk["kind"] == "zvol":
        ds = disk["path"].removeprefix("/dev/zvol/")
        size = (await c.on(src, f"zfs get -Hp -o value volsize {q(ds)}")).strip()
        await c.on(dst, f"zfs list -H {q(ds)} >/dev/null 2>&1 || zfs create -p -s -V {q(size)} {q(ds)}; "
                        f"udevadm settle --timeout=15 || true")
    else:
        info = json.loads(await c.on(src, f"qemu-img info --output=json -U {q(disk['path'])}"))
        await c.on(dst, f"mkdir -p {q(posixpath.dirname(disk['path']))}; [ -e {q(disk['path'])} ] || "
                        f"qemu-img create -q -f {q(disk['format'] or 'qcow2')} {q(disk['path'])} {int(info['virtual-size'])}")


def copy_disk_script(disk: dict, dst: dict, guard: str = "") -> str:
    if disk["kind"] == "zvol":
        return c.zfs_sync_script(disk["path"].removeprefix("/dev/zvol/"), dst["address"], guard)
    p = q(disk["path"])
    return (f"{ssh_to(dst)} {q('mkdir -p ' + q(posixpath.dirname(disk['path'])))} && "
            f"rsync -a --inplace -e {q(c.SSH)} {p} root@{q(dst['address'])}:{p}")


async def _copy_files(src: dict, dst: dict, paths: list[str]) -> None:
    for p in paths:
        await c.on(src, f"[ -e {q(p)} ] || exit 0; {ssh_to(dst)} {q('mkdir -p ' + q(posixpath.dirname(p)))} && "
                        f"rsync -a --ignore-existing -e {q(c.SSH)} {q(p)} root@{q(dst['address'])}:{q(p)}", timeout=3600)


async def migrate(kind: str, vmid: int, name: str, src: dict, dst: dict, online: bool, job: dict) -> None:
    logs = job["logs"].append
    if kind == "lxc":
        await _move_container(name, src, dst, job)
        return
    xml = await c.on(src, f"virsh dumpxml --inactive {q(name)}")
    disks = disks_of(xml)
    nvram = host.parse_domain(xml)["nvram"]
    running = (await c.on(src, f"virsh domstate {q(name)}")).strip() == "running"
    c.stage(job, 1)
    await _copy_files(src, dst, [d["path"] for d in disks if d["cdrom"]] + ([nvram] if nvram else []))
    data = [d for d in disks if not d["cdrom"]]
    if running and online:
        for d in data:
            logs(f"Preparing {d['path']} on {dst['name']}")
            await _precreate(src, dst, d)
        c.stage(job, 2, 30)

        def on_line(line: str) -> None:
            if "%" in line and "Migration" in line:
                try:
                    pct = int(line.split("[", 1)[1].split("%")[0])
                    c.stage(job, 2, 30 + 0.6 * pct)
                except (IndexError, ValueError):
                    pass
            elif line.strip():
                logs(line)
        await c.on(src, f"virsh migrate --live --persistent --undefinesource --copy-storage-all --verbose {q(name)} "
                        f"qemu+ssh://root@{dst['address']}/system", timeout=6 * 3600, on_line=on_line)
    else:
        if running:
            raise HTTPException(409, f"{name} is running; use live migration or shut it down first")
        for i, d in enumerate(data):
            c.stage(job, 2, 30 + 60 * i / max(1, len(data)))
            logs(f"Copying {d['path']} to {dst['name']}")
            await c.on(src, copy_disk_script(d, dst), timeout=6 * 3600, on_line=logs)
        await c.on(src, f"virsh dumpxml --inactive --security-info {q(name)} | {ssh_to(dst)} "
                        f"{q(f'cat > /tmp/sd-{vmid}.xml && virsh define /tmp/sd-{vmid}.xml; rm -f /tmp/sd-{vmid}.xml')}")
        await c.on(src, f"virsh undefine --keep-nvram {q(name)}")
    c.stage(job, 3)
    state = (await c.on(dst, f"virsh domstate {q(name)}")).strip()
    logs(f"{name} on {dst['name']}: {state}")
    for d in data:  # the target holds the guest now; free the source copy
        await c.on(src, f"zfs destroy -r {q(d['path'].removeprefix('/dev/zvol/'))}" if d["kind"] == "zvol"
                   else f"rm -f {q(d['path'])}", check=False)


async def _move_container(name: str, src: dict, dst: dict, job: dict) -> None:
    logs = job["logs"].append
    f = f"{c.HA_DIR}/migrate-{name}.tar"
    running = '"status": "Running"' in (await c.on(src, f"incus query /1.0/instances/{q(name)}"))
    c.stage(job, 1)
    if running:
        logs(f"Stopping {name} (containers move with a restart)")
        await c.on(src, f"incus stop {q(name)}", timeout=300)
    c.stage(job, 2, 30)
    try:
        await c.on(src, f"mkdir -p {c.HA_DIR} && rm -f {q(f)} && incus export {q(name)} {q(f)} --instance-only "
                        f"--compression none", timeout=6 * 3600)
        c.stage(job, 2, 60)
        await c.on(src, f"{ssh_to(dst)} mkdir -p {c.HA_DIR} && rsync -a -e {q(c.SSH)} {q(f)} root@{q(dst['address'])}:{q(f)}",
                   timeout=6 * 3600)
        c.stage(job, 2, 80)
        await c.on(dst, f"incus import {q(f)} && rm -f {q(f)}" + (f" && incus start {q(name)}" if running else ""),
                   timeout=3600)
    except HTTPException:
        if running:
            await c.on(src, f"incus start {q(name)}", check=False)
        raise
    c.stage(job, 3)
    await c.on(src, f"incus delete --force {q(name)}; rm -f {q(f)}")


async def replicate(kind: str, vmid: int, name: str, dst: dict, log) -> None:
    me = {"name": c.settings.node_name, "address": "127.0.0.1"}
    if kind == "lxc":
        f = f"{c.HA_DIR}/{name}.tar"
        guard = f"incus query /1.0/instances/{q(name)} 2>/dev/null | grep -q '\"status\": \"Running\"' && exit 1; true"
        await c.on(me, f"set -e; {ssh_to(dst)} {q(guard)} || {{ echo '!! running on the standby'; exit 3; }}; "
                       f"mkdir -p {c.HA_DIR}; rm -f {q(f)}.new; incus export {q(name)} {q(f)}.new --instance-only "
                       f"--compression none; mv {q(f)}.new {q(f)}; {ssh_to(dst)} mkdir -p {c.HA_DIR}; "
                       f"rsync -a --inplace -e {q(c.SSH)} {q(f)} root@{q(dst['address'])}:{q(f)}", timeout=6 * 3600,
                   on_line=log)
        return
    xml = await c.on(me, f"virsh dumpxml --inactive --security-info {q(name)}")
    guard = f"! virsh domstate {q(name)} 2>/dev/null | grep -qx running"
    for d in disks_of(xml):
        if not d["cdrom"]:
            await c.on(me, copy_disk_script(d, dst, guard), timeout=6 * 3600, on_line=log)
    nvram = host.parse_domain(xml)["nvram"]
    await c.on(me, f"{ssh_to(dst)} mkdir -p {c.HA_DIR} && virsh dumpxml --inactive --security-info {q(name)} | "
                   f"{ssh_to(dst)} {q('cat > ' + q(f'{c.HA_DIR}/{name}.xml'))}")
    await _copy_files(me, dst, [d["path"] for d in disks_of(xml) if d["cdrom"]])
    if nvram:
        await c.on(me, f"[ -e {q(nvram)} ] && rsync -a -e {q(c.SSH)} {q(nvram)} root@{q(dst['address'])}:{q(nvram)}; true")


async def promote(kind: str, vmid: int, name: str, h: dict) -> None:
    if kind == "lxc":
        await c.on(h, f"incus info {q(name)} >/dev/null 2>&1 || incus import {c.HA_DIR}/{q(name)}.tar; "
                      f"incus start {q(name)}", timeout=1800)
    else:
        await c.on(h, f"virsh dominfo {q(name)} >/dev/null 2>&1 || virsh define {c.HA_DIR}/{q(name)}.xml; "
                      f"virsh start {q(name)}", timeout=300)


async def local_guest_state(kind: str, name: str) -> str | None:
    me = {"name": c.settings.node_name, "address": "127.0.0.1"}
    if kind == "lxc":
        out = await c.on(me, f"incus query /1.0/instances/{q(name)} 2>/dev/null || true")
        return None if not out.strip() else "running" if '"status": "Running"' in out else "stopped"
    out = (await c.on(me, f"virsh domstate {q(name)} 2>/dev/null || true")).strip()
    return out or None


async def fence(kind: str, vmid: int, name: str) -> None:
    me = {"name": c.settings.node_name, "address": "127.0.0.1"}
    await c.on(me, f"incus stop --force {q(name)}" if kind == "lxc" else
               f"virsh destroy {q(name)}; virsh autostart --disable {q(name)}; true", check=False)


async def demote(kind: str, vmid: int, name: str) -> None:
    me = {"name": c.settings.node_name, "address": "127.0.0.1"}
    if kind == "lxc":
        await c.on(me, f"incus rename {q(name)} {q(name + '-pre-failover')}", check=False)
    else:
        await c.on(me, f"virsh undefine --keep-nvram {q(name)}", check=False)


async def adopt(kind: str, vmid: int, name: str, tags: str) -> int:
    """Keep the guest's ID when it arrives on this host (a different guest already holding it gets a new one)."""
    reg = host.load_guests()
    reg = {k: v for k, v in reg.items() if not (v["type"] == kind and v["name"] == name)}
    if vmid in reg:
        vmid = host.next_vmid(reg)
    reg[vmid] = {"type": kind, "name": name, "tags": tags or reg.get(vmid, {}).get("tags", "")}
    host.save_guests(reg)
    return vmid


async def create(name: str, addr: str, log) -> None:
    log(f"SolarOS Cluster Control Plane initialized on {addr}; running guests keep running")


async def join(info: dict, log) -> None:
    log(f"Registered with {info['coordinator']} ({info['coordinator_address']}); guests stay where they are")


async def leave(me: dict, peers: list[dict], log) -> None:
    log("Leaving the SolarOS cluster; guests on this host keep running")


async def members():
    return None


async def inventory():
    return None


async def host_metrics():
    return None


async def sync_status():
    return None


async def maintenance(host_id: str, enabled: bool) -> None:
    return None


async def witness(address, hosts, log) -> None:
    return None
