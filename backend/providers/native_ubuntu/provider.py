"""Standalone hypervisor driver (HYPERVISOR_DRIVER=native_ubuntu): SolarDeck is the management layer of the host.

QEMU/KVM guests through libvirt (`virsh`), containers through Incus (`incus`), storage through zfsutils-linux,
disks through smartctl/hdparm/nvme-cli/fio. The backend runs as root on the host (see hypervisor/), so:

* handlers that only use the root helper or the SSH bridge (datasets, pool members, disk settings and scans,
  benchmarks, hardware inventory, GPU driver modes, ZFS dataset snapshots) are reused unchanged: the installer
  points the bridge at root@127.0.0.1 and installs the helper locally;
* everything that used the Proxmox REST API is implemented here with local commands, returning the same shapes.
"""
import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from app import (apps, automation, backups, disk_benchmark, guest_hardware, hardware_admin, local_ai, net_services, pci,
                 provisioning, pve_access, storage_admin)
from app import pve as api
from app.config import settings
from providers.base import (AccessAclInfo, AccessGroupInfo, AccessRoleInfo, AccessUserInfo, BackupArchiveInfo,
                            BackupScheduleInfo, BenchmarkResult, BiosReadinessStatus, ConsoleTicket, DiskSettings,
                            FirewallRuleInfo, GpuDeviceInfo, GuestConfigUpdate, GuestInfo, GuestKind,
                            HardwareInventory, HypervisorProvider, NetworkInterfaceInfo, NetworkTopologyGraph,
                            NodeMetrics, PciDeviceInfo, PhysicalDiskInfo, ProviderCapabilities, ResourcePoolInfo,
                            SmartReport, SnapshotScope, StorageContentItem, TaskInfo, UsbDeviceInfo, ZfsDatasetInfo)

from . import host, rbac
from .host import run, run_json, ok, start_job

LOCAL = "local"  # directory storage below STORAGE_ROOT: isos/, templates/, backups/
IMAGES_STORE = "images"  # Incus image server (container templates)
CONTENT_DIRS = {"iso": "isos", "vztmpl": "templates", "backup": "backups"}
# Container templates offered by the "images" storage (Incus image server aliases).
# shortcut: fixed list (checked against images: on 2026-11-24); the image server drops old releases, so re-check it
# when a template fails with "image couldn't be found".
INCUS_IMAGES = ("debian/12", "debian/13", "ubuntu/24.04", "ubuntu/22.04", "alpine/3.22", "rockylinux/9",
                "almalinux/9", "fedora/43", "archlinux")
ARCHIVE_RE = re.compile(r"^solardeck-(qemu|lxc)-(\d+)-(\d{4}_\d\d_\d\d-\d\d_\d\d_\d\d)\.tar\.(zst|gz)$")
SCHEDULES_FILE = host.DATA / "native_backup_jobs.json"
POWER = {"qemu": {"start": ["virsh", "start"], "shutdown": ["virsh", "shutdown"], "stop": ["virsh", "destroy"],
                  "reboot": ["virsh", "reboot"]},
         "lxc": {"start": ["incus", "start"], "shutdown": ["incus", "stop"], "stop": ["incus", "stop", "--force"],
                 "reboot": ["incus", "restart"]}}
PROC, SYS_NET = Path("/proc"), Path("/sys/class/net")  # roots overridable by tests
_cpu_prev: dict[tuple[str, str], tuple[float, int]] = {}
_host_prev: dict[str, tuple[float, float]] = {}


def _task(upid: str) -> TaskInfo:
    return TaskInfo(task=upid, upid=upid)


def _many(model, items) -> list:
    return [model.model_validate(i) for i in items or []]


def _store_dir(content: str) -> Path:
    d = settings.storage_root / CONTENT_DIRS[content]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _bridge(b: str) -> str:
    # No bridge given: the host's default bridge (DEFAULT_BRIDGE, br0 on SolarOS).
    return b or settings.default_bridge


def _cpu_pct(key: tuple[str, str], ns: int, cpus: int) -> float:
    now = time.monotonic()
    prev = _cpu_prev.get(key)
    _cpu_prev[key] = (now, ns)
    if not prev or now <= prev[0] or ns < prev[1]:
        return 0.0
    return round(min(1.0, (ns - prev[1]) / 1e9 / (now - prev[0]) / max(cpus, 1)), 4)


def _iso_ts(s: str | None) -> float:
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _volume_file(volid: str) -> Path:
    """local:iso/x.iso -> /mnt/storage/isos/x.iso (no path traversal)."""
    store, _, rest = volid.partition(":")
    content, _, fname = rest.partition("/")
    if store != LOCAL or content not in CONTENT_DIRS or not fname or "/" in fname or fname.startswith("."):
        raise HTTPException(422, f"Invalid volume {volid}")
    return _store_dir(content) / fname


def parse_calendar_next(out: str) -> int | None:
    """`systemd-analyze calendar` output -> next elapse as unix time."""
    m = re.search(r"\(in UTC\):\s*\w+\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)", out) or \
        re.search(r"Next elapse:\s*\w+\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+UTC", out)
    if not m:
        return None
    return int(datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp())


class NativeUbuntuProvider(HypervisorProvider):
    # ============================================================ Capabilities & host telemetry
    def get_capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            driver="native_ubuntu", platform_label="SolarOS", supports_clustering=False,
            supports_lxc=True, supports_qemu=True, supports_zfs=True, supports_gpu_passthrough=True,
            supports_bios_manager=True, supports_rbac_realms=False, supports_apt_repos=True, supports_host_shell=True,
            default_bridge=settings.default_bridge)

    async def get_node_metrics(self) -> NodeMetrics:
        proc = PROC
        stat = (proc / "stat").read_text().splitlines()[0].split()[1:]
        vals = [int(x) for x in stat]
        idle, total = vals[3] + vals[4], sum(vals[:8])
        prev = _host_prev.get("cpu")
        _host_prev["cpu"] = (idle, total)
        cpu = 0.0 if not prev or total <= prev[1] else (1 - (idle - prev[0]) / (total - prev[1])) * 100
        mem = {k: int(v.split()[0]) * 1024 for k, v in (line.split(":", 1) for line in
                                                       (proc / "meminfo").read_text().splitlines())}
        arc = 0
        arcstats = proc / "spl/kstat/zfs/arcstats"
        if arcstats.exists():
            arc = next((int(line.split()[2]) for line in arcstats.read_text().splitlines() if line.startswith("size ")), 0)
        cpuinfo = (proc / "cpuinfo").read_text()
        model = next(iter(re.findall(r"^model name\s*:\s*(.+)$", cpuinfo, re.M)), "")
        blocks = [dict(re.findall(r"^(physical id|core id)\s*:\s*(\d+)", b, re.M)) for b in cpuinfo.split("\n\n")]
        sockets = len({b.get("physical id") for b in blocks if b}) or 1
        cores = len({(b.get("physical id"), b.get("core id")) for b in blocks if b}) or os.cpu_count() or 1
        rx = tx = 0
        for n in (SYS_NET.iterdir() if SYS_NET.exists() else []):
            if (n / "device").exists():  # physical NICs only; bridges and guest taps would double count
                rx += int((n / "statistics/rx_bytes").read_text())
                tx += int((n / "statistics/tx_bytes").read_text())
        now = time.monotonic()
        pn = _host_prev.get("net")
        _host_prev["net"] = (now, rx, tx)
        net = {"in": 0.0, "out": 0.0}
        if pn and now > pn[0]:
            net = {"in": max(0.0, (rx - pn[1]) / (now - pn[0])), "out": max(0.0, (tx - pn[2]) / (now - pn[0]))}
        guests = await self.list_guests()
        count = lambda kind, state: sum(1 for g in guests if g.type == kind and g.status == state)  # noqa: E731
        return NodeMetrics(
            node=host.node(), cpu=round(cpu, 2),
            loadavg=[float(x) for x in (proc / "loadavg").read_text().split()[:3]],
            memory={"used": mem["MemTotal"] - mem["MemAvailable"], "total": mem["MemTotal"], "free": mem["MemAvailable"],
                    "arc": arc},
            swap={"used": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0), "total": mem.get("SwapTotal", 0)},
            uptime=int(float((proc / "uptime").read_text().split()[0])), kernel=os.uname().release,
            pveversion="SolarOS",
            cpuinfo={"model": model, "cpus": os.cpu_count() or 0, "sockets": sockets, "cores": cores},
            net=net,
            vms={"running": count("qemu", "running"), "stopped": count("qemu", "stopped"),
                 "total": sum(1 for g in guests if g.type == "qemu")},
            containers={"running": count("lxc", "running"), "stopped": count("lxc", "stopped"),
                        "total": sum(1 for g in guests if g.type == "lxc")})

    async def get_hardware_inventory(self) -> HardwareInventory:
        return HardwareInventory.model_validate(await hardware_admin.inventory())

    async def get_bios_status(self) -> BiosReadinessStatus:
        return BiosReadinessStatus.model_validate(await hardware_admin.bios_status())

    async def set_gpu_driver_mode(self, action: str, gpu: str) -> TaskInfo:
        # vfio-pci binding via /etc/modprobe.d + update-initramfs -u; the same host job as on Proxmox VE.
        res = await hardware_admin.gpu_driver_action(action, hardware_admin.GpuBody(gpu=gpu))
        return TaskInfo.model_validate(res if isinstance(res, dict) else {"result": res})

    # ============================================================ Compute: inventory
    async def _live(self) -> tuple[dict[str, dict], dict[str, dict]]:
        """(libvirt domstats by domain, Incus containers by name)."""
        stats_txt, cts = await asyncio.gather(ok("virsh", "domstats", "--raw", "--state", "--cpu-total", "--balloon",
                                                 "--vcpu", "--interface", "--block"),
                                              self._incus_instances())
        return host.parse_kv_blocks(stats_txt or "", "Domain:"), {c["name"]: c for c in cts}

    async def _incus_instances(self) -> list[dict]:
        try:
            items = await run_json("incus", "query", "/1.0/instances?recursion=2")
        except (HTTPException, ValueError):
            return []
        return [i for i in items or [] if i.get("type", "container") == "container"]

    async def _registry(self) -> tuple[dict[int, dict], dict[str, dict], dict[str, dict]]:
        doms, cts = await self._live()
        reg = host.load_guests()
        new = host.reconcile(reg, [("qemu", n) for n in doms] + [("lxc", n) for n in cts])
        if new != reg:
            host.save_guests(new)
        return new, doms, cts

    async def list_guests(self) -> list[GuestInfo]:
        reg, doms, cts = await self._registry()
        out = []
        for vmid, g in sorted(reg.items()):
            if g["type"] == "qemu":
                s = doms.get(g["name"], {})
                state = int(s.get("state.state", 5))
                cpus = int(s.get("vcpu.maximum") or s.get("vcpu.current") or 0)
                netin = sum(int(v) for k, v in s.items() if re.fullmatch(r"net\.\d+\.rx\.bytes", k))
                netout = sum(int(v) for k, v in s.items() if re.fullmatch(r"net\.\d+\.tx\.bytes", k))
                disk = sum(int(v) for k, v in s.items() if re.fullmatch(r"block\.\d+\.allocation", k))
                maxdisk = sum(int(v) for k, v in s.items() if re.fullmatch(r"block\.\d+\.capacity", k))
                out.append({"vmid": vmid, "name": g["name"], "type": "qemu",
                            "status": {1: "running", 3: "paused"}.get(state, "stopped"),
                            "cpu": _cpu_pct(("qemu", g["name"]), int(s.get("cpu.time", 0)), cpus) if state == 1 else 0,
                            "maxcpu": cpus, "mem": int(s.get("balloon.rss", s.get("balloon.current", 0))) * 1024,
                            "maxmem": int(s.get("balloon.maximum", 0)) * 1024, "disk": disk, "maxdisk": maxdisk,
                            "uptime": 0, "netin": netin, "netout": netout, "tags": g.get("tags", "")})
            else:
                c = cts.get(g["name"], {})
                st, cfg = c.get("state") or {}, c.get("expanded_config") or c.get("config") or {}
                running = c.get("status") == "Running"
                cpus = int(cfg.get("limits.cpu", "0") or 0) if str(cfg.get("limits.cpu", "")).isdigit() else (os.cpu_count() or 1)
                nets = (st.get("network") or {}).values()
                out.append({"vmid": vmid, "name": g["name"], "type": "lxc", "status": "running" if running else "stopped",
                            "cpu": _cpu_pct(("lxc", g["name"]), int((st.get("cpu") or {}).get("usage", 0)), cpus) if running else 0,
                            "maxcpu": cpus, "mem": int((st.get("memory") or {}).get("usage", 0)),
                            "maxmem": host.size_bytes(cfg.get("limits.memory", "")) or
                            int((st.get("memory") or {}).get("total", 0)),
                            "disk": int(((st.get("disk") or {}).get("root") or {}).get("usage", 0)),
                            "maxdisk": host.size_bytes(((c.get("expanded_devices") or {}).get("root") or {}).get("size", "")),
                            "uptime": int(time.time() - _iso_ts(c.get("last_used_at"))) if running else 0,
                            "netin": sum(int((n.get("counters") or {}).get("bytes_received", 0)) for n in nets),
                            "netout": sum(int((n.get("counters") or {}).get("bytes_sent", 0)) for n in nets),
                            "tags": g.get("tags", "")})
        return [GuestInfo.model_validate(g) for g in out]

    async def container(self, vmid: int) -> dict:
        return await run_json("incus", "query", f"/1.0/instances/{host.name_of(vmid, 'lxc')}?recursion=1")

    async def container_ip(self, vmid: int) -> str | None:
        """First IPv4 on eth0 of a running container (Local AI, App Center)."""
        try:
            st = await run_json("incus", "query", f"/1.0/instances/{host.name_of(vmid, 'lxc')}/state")
        except (HTTPException, ValueError):
            return None
        for name in ("eth0", *((st or {}).get("network") or {})):
            for a in (((st or {}).get("network") or {}).get(name) or {}).get("addresses", []):
                if a.get("family") == "inet" and a.get("scope") == "global":
                    return a["address"]
        return None

    async def container_status(self, vmid: int) -> str | None:
        try:
            st = await run_json("incus", "query", f"/1.0/instances/{host.name_of(vmid, 'lxc')}/state")
        except (HTTPException, ValueError):
            return None
        return "running" if (st or {}).get("status") == "Running" else "stopped"

    async def container_exec(self, vmid: int, script: str, timeout: float = 120, log=None) -> str:
        return await run("incus", "exec", host.name_of(vmid, "lxc"), "--", "env", "DEBIAN_FRONTEND=noninteractive",
                         "bash", "-s", input=script, timeout=timeout, log=log)

    async def next_id(self) -> int:
        reg, _, _ = await self._registry()
        return host.next_vmid(reg)

    # ============================================================ Compute: configuration
    async def get_guest_config(self, kind: GuestKind, vmid: int) -> dict:
        g = host.guest(vmid, kind)
        if kind == "qemu":
            dom = host.parse_domain(await run("virsh", "dumpxml", "--inactive", g["name"]))
            info = await ok("virsh", "dominfo", g["name"]) or ""
            disks = []
            for d in dom["disks"]:
                if d["device"] != "disk":
                    continue
                cap = re.search(r"Capacity:\s+(\d+)", await ok("virsh", "domblkinfo", g["name"], d["target"]) or "")
                disks.append({"key": host.disk_key(d["target"], d["bus"]), "volume": d["path"],
                              "size": f"{int(cap.group(1)) // 2**30}G" if cap else None, "resizable": bool(cap)})
            return {"name": g["name"], "cores": dom["cores"], "sockets": dom["sockets"], "memory": dom["memory_mb"],
                    "swap": None, "onboot": bool(re.search(r"Autostart:\s+enable", info)),
                    "description": dom["description"], "tags": g.get("tags", ""), "disks": disks}
        c = await self.container(vmid)
        cfg, root = c.get("config") or {}, (c.get("expanded_devices") or {}).get("root") or {}
        exp = c.get("expanded_config") or cfg
        return {"name": g["name"], "cores": int(exp["limits.cpu"]) if str(exp.get("limits.cpu", "")).isdigit() else 1,
                "sockets": 1, "memory": host.size_bytes(exp.get("limits.memory", "")) // 2**20 or 512,
                "swap": 0 if exp.get("limits.memory.swap") == "false" else None,
                "onboot": exp.get("boot.autostart") == "true", "description": c.get("description") or "",
                "tags": g.get("tags", ""),
                "disks": [{"key": "rootfs", "volume": f"{root.get('pool', '')}:{g['name']}", "size": root.get("size"),
                           "resizable": True}]}

    async def update_guest_config(self, kind: GuestKind, vmid: int, update: GuestConfigUpdate) -> dict:
        body = api.GuestConfigBody(**update.model_dump(include=set(api.GuestConfigBody.model_fields)))
        if body.swap is not None and kind != "lxc":
            raise HTTPException(400, "Swap is a container setting")
        if bool(body.resize_disk) != bool(body.resize_to):
            raise HTTPException(400, "resize_disk and resize_to go together")
        g = host.guest(vmid, kind)
        name = g["name"]
        if body.tags is not None:
            host.register(vmid, kind, name, body.tags.strip())
        if kind == "qemu":
            if body.cores:
                # vcpu count and topology must change together (libvirt rejects a mismatch), so edit the XML.
                await host.define(host.set_vcpus(await run("virsh", "dumpxml", "--inactive", name), body.cores))
            if body.memory:
                await run("virsh", "setmaxmem", name, f"{body.memory}M", "--config")
                await run("virsh", "setmem", name, f"{body.memory}M", "--config")
            if body.onboot is not None:
                await run("virsh", "autostart", name, *([] if body.onboot else ["--disable"]))
            if body.description is not None:
                await run("virsh", "desc", name, "--config", "--new-desc", body.description)
            if body.resize_disk:
                await self._resize_vm_disk(name, body.resize_disk, body.resize_to)
            return {"ok": True, "task": None}
        sets = {}
        if body.cores:
            sets["limits.cpu"] = str(body.cores)
        if body.memory:
            sets["limits.memory"] = f"{body.memory}MiB"
        if body.swap is not None:
            sets["limits.memory.swap"] = "true" if body.swap else "false"
        if body.onboot is not None:
            sets["boot.autostart"] = "true" if body.onboot else "false"
        if sets:
            await run("incus", "config", "set", name, *[f"{k}={v}" for k, v in sets.items()])
        if body.description is not None:
            await run("incus", "query", "-X", "PATCH", f"/1.0/instances/{name}",
                      "--data", json.dumps({"description": body.description}))
        if body.resize_disk:
            cur = host.size_bytes((await self.get_guest_config("lxc", vmid))["disks"][0]["size"] or "0")
            want = cur + host.size_bytes(body.resize_to) if body.resize_to.startswith("+") else host.size_bytes(body.resize_to)
            size = f"{want // 2**20}MiB"
            # A root disk inherited from a profile must be overridden; a local one is set.
            # ok() returns the (empty) output on success, so only None means the set failed.
            if await ok("incus", "config", "device", "set", name, "root", f"size={size}") is None:
                await run("incus", "config", "device", "override", name, "root", f"size={size}")
        return {"ok": True, "task": None}

    async def _resize_vm_disk(self, name: str, key: str, to: str) -> None:
        dom = host.parse_domain(await run("virsh", "dumpxml", name))
        disk = next((d for d in dom["disks"] if d["device"] == "disk" and host.disk_key(d["target"], d["bus"]) == key), None)
        if not disk:
            raise HTTPException(404, f"Disk {key} not found")
        cap = re.search(r"Capacity:\s+(\d+)", await run("virsh", "domblkinfo", name, disk["target"]))
        cur = int(cap.group(1)) if cap else 0
        want = cur + host.size_bytes(to) if to.startswith("+") else host.size_bytes(to)
        if want <= cur:
            raise HTTPException(400, "Disks can only grow")
        running = "running" in (await ok("virsh", "domstate", name) or "")
        if disk["path"].startswith("/dev/zvol/"):
            await run("zfs", "set", f"volsize={want}", disk["path"].removeprefix("/dev/zvol/"))
        elif not running:
            await run("qemu-img", "resize", disk["path"], str(want))
        if running:
            await run("virsh", "blockresize", name, disk["target"], f"{want}B")

    async def guest_power_action(self, kind: GuestKind, vmid: int, action: str) -> TaskInfo:
        api.ActionBody(action=action)  # validates start/shutdown/stop/reboot
        name = host.name_of(vmid, kind)
        argv = [*POWER[kind][action], name]

        async def job(log):
            log(f"{' '.join(argv)}")
            log(await run(*argv, timeout=180))
        return _task(start_job(f"{kind}{action}", vmid, job))

    # ============================================================ Compute: create & delete
    async def _disk_target(self, storage: str, vmid: int, idx: int, size_gb: int, log) -> dict:
        """Create a disk on `storage` (a ZFS pool/dataset -> sparse ZVOL, "local" -> QCOW2). Returns the XML disk spec."""
        if storage == LOCAL:
            host.IMAGES.mkdir(parents=True, exist_ok=True)
            path = host.IMAGES / f"vm-{vmid}-disk-{idx}.qcow2"
            if path.exists():
                raise HTTPException(409, f"{path} already exists")
            await run("qemu-img", "create", "-q", "-f", "qcow2", str(path), f"{size_gb}G")
            log(f"created {path}")
            return {"path": str(path), "type": "file", "format": "qcow2"}
        if not await ok("zfs", "list", "-H", "-o", "name", storage):
            raise HTTPException(400, f"Storage {storage} is neither 'local' nor a ZFS pool/dataset")
        vol = f"{storage}/vm-{vmid}-disk-{idx}"
        await run("zfs", "create", "-s", "-V", f"{size_gb}G", "-o", "volblocksize=16k", vol)
        log(f"created ZVOL {vol}")
        await ok("udevadm", "settle", "--timeout=15")  # udev creates /dev/zvol/... asynchronously
        return {"path": f"/dev/zvol/{vol}", "type": "block", "format": "raw"}

    async def _drop_disk(self, disk: dict, log) -> None:
        """Remove a disk made by _disk_target (QCOW2 file or ZVOL); never raises."""
        try:
            if disk["type"] == "file":
                Path(disk["path"]).unlink(missing_ok=True)
            else:
                await run("zfs", "destroy", disk["path"].removeprefix("/dev/zvol/"), check=False)
            log(f"removed {disk['path']}")
        except Exception as e:  # noqa: BLE001 - the original error is what the user needs to see
            log(f"could not remove {disk['path']}: {e}")

    async def create_vm(self, spec: dict) -> TaskInfo:
        body = NativeQemuBody(**spec)
        reg, doms, _ = await self._registry()
        if body.vmid in reg:
            raise HTTPException(409, f"VMID {body.vmid} is in use")
        if body.name in doms:
            raise HTTPException(409, f"A VM named {body.name} already exists")
        cdroms = [str(_volume_file(body.iso_volume))] if body.iso_volume else []

        async def job(log):
            disk = await self._disk_target(body.storage, body.vmid, 0, body.disk_gb, log)
            try:
                await define_vm(disk, log)
            except BaseException:
                # Roll back the new disk so a retry with the same VMID does not stop at "already exists".
                await self._drop_disk(disk, log)
                raise

        async def define_vm(disk, log):
            if body.cloudinit:
                cdroms.append(await self._cloudinit_seed(body, log))
            uefi = body.bios == "ovmf"
            xml = host.domain_xml(
                name=body.name, vmid=body.vmid, cores=body.cores, sockets=body.sockets, memory_mb=body.memory,
                uefi=uefi, secure_boot=uefi and body.ostype == "win11", disks=[disk], cdroms=cdroms,
                bridge=_bridge(body.bridge), ostype=body.ostype, tpm=body.ostype == "win11",
                hostpci=[(p.id.rsplit(".", 1)[0] + ".0") if p.include_audio else p.id for p in body.hostpci] +
                [f"{p.id.rsplit('.', 1)[0]}.1" for p in body.hostpci if p.include_audio and "." in p.id],
                usb=[u.host for u in body.usb if ":" in u.host])
            host.NVRAM.mkdir(parents=True, exist_ok=True)
            log(await host.define(xml))
            host.register(body.vmid, "qemu", body.name)
            if body.start_on_boot:
                await run("virsh", "autostart", body.name)
            log(f"VM {body.vmid} ({body.name}) defined")
        upid = start_job("qmcreate", body.vmid, job)
        return TaskInfo(task=upid, upid=upid, vmid=body.vmid)

    async def _cloudinit_seed(self, body: "NativeQemuBody", log) -> str:
        ci = body.cloudinit
        lines = ["#cloud-config", f"hostname: {body.name}", f"user: {ci.user}", "ssh_pwauth: true"]
        if ci.password:
            lines += [f"password: {json.dumps(ci.password)}", "chpasswd: {expire: false}"]
        if ci.ssh_keys:
            lines += ["ssh_authorized_keys:", *[f"  - {json.dumps(k)}" for k in ci.ssh_keys]]
        d = Path(tempfile.mkdtemp(prefix="sd-ci-"))
        (d / "user-data").write_text("\n".join(lines) + "\n")
        (d / "meta-data").write_text(f"instance-id: sd-{body.vmid}\nlocal-hostname: {body.name}\n")
        seed = host.IMAGES / f"vm-{body.vmid}-cloudinit.iso"
        host.IMAGES.mkdir(parents=True, exist_ok=True)
        await run("cloud-localds", str(seed), str(d / "user-data"), str(d / "meta-data"))
        shutil.rmtree(d, ignore_errors=True)
        log(f"Cloud-Init seed {seed}")
        return str(seed)

    async def create_container(self, spec: dict) -> TaskInfo:
        body = provisioning.LxcBody(**spec)
        reg, _, cts = await self._registry()
        if body.vmid in reg:
            raise HTTPException(409, f"VMID {body.vmid} is in use")
        if body.hostname in cts:
            raise HTTPException(409, f"A container named {body.hostname} already exists")
        image = self._image(body.ostemplate, static=body.ip_config != "dhcp")

        async def job(log):
            await self._incus_create(
                body.vmid, body.hostname, image, storage=body.storage, cores=body.cores, memory_mb=body.memory,
                disk_gb=body.disk_gb, bridge=_bridge(body.bridge), ip_config=body.ip_config, nesting=body.nesting,
                tags=host.GUEST_TAG, log=log)
            if body.bind_dataset:
                mnt = (await run("zfs", "get", "-H", "-o", "value", "mountpoint", body.bind_dataset)).strip()
                await run("incus", "config", "device", "add", body.hostname, "data", "disk", f"source={mnt}",
                          f"path=/mnt/storage/{body.bind_dataset}", "shift=true")
            await run("incus", "start", body.hostname, log=log)
            await run("incus", "exec", body.hostname, "--", "chpasswd", input=f"root:{body.password}\n")
            log(f"Container {body.vmid} ({body.hostname}) started")
        upid = start_job("vzcreate", body.vmid, job)
        return TaskInfo(task=upid, upid=upid, vmid=body.vmid)

    @staticmethod
    def _image(volid: str, static: bool = False) -> str:
        store, _, rest = volid.partition(":")
        alias = rest.removeprefix("vztmpl/")
        if store != IMAGES_STORE or alias not in INCUS_IMAGES:
            raise HTTPException(422, f"Unknown container template {volid}; pick one from the '{IMAGES_STORE}' storage")
        # Static addresses are applied by cloud-init, which only the /cloud image variants contain.
        return f"images:{alias}{'/cloud' if static else ''}"

    async def _incus_create(self, vmid: int, name: str, image: str, *, storage: str, cores: int, memory_mb: int,
                            disk_gb: int, bridge: str, ip_config, nesting: bool, tags: str, log,
                            autostart: bool = False, description: str = "") -> None:
        pools = {p["name"] for p in await run_json("incus", "storage", "list", "--format", "json") or []}
        pool = storage if storage in pools else next(iter(sorted(pools)), None)
        if not pool:
            raise HTTPException(400, "No Incus storage pool exists (run `incus admin init` or re-run the installer)")
        cfg = {"limits.cpu": str(cores), "limits.memory": f"{memory_mb}MiB", "security.nesting": str(nesting).lower(),
               "user.solardeck.vmid": str(vmid), "boot.autostart": str(autostart).lower()}
        if ip_config != "dhcp":
            net = {"version": 2, "ethernets": {"eth0": {"addresses": [ip_config.cidr], "routes": [
                {"to": "default", "via": ip_config.gateway}], "nameservers": {"addresses": [ip_config.gateway]}}}}
            cfg["cloud-init.network-config"] = json.dumps(net)
        log(f"incus init {image} {name} (pool {pool})")
        await run("incus", "init", image, name, "-s", pool, *[x for k, v in cfg.items() for x in ("-c", f"{k}={v}")],
                  timeout=1800, log=log)
        host.register(vmid, "lxc", name, tags)
        await run("incus", "config", "device", "add", name, "eth0", "nic", "nictype=bridged", f"parent={bridge}",
                  "name=eth0")
        if await ok("incus", "config", "device", "set", name, "root", f"size={disk_gb}GiB") is None:
            await run("incus", "config", "device", "override", name, "root", f"size={disk_gb}GiB")
        if description:
            await run("incus", "query", "-X", "PATCH", f"/1.0/instances/{name}", "--data",
                      json.dumps({"description": description}))

    async def delete_guest(self, kind: GuestKind, vmid: int, purge: bool = True) -> TaskInfo:
        name = host.name_of(vmid, kind)

        async def job(log):
            if kind == "lxc":
                await run("incus", "delete", "--force", name, log=log)
            else:
                dom = host.parse_domain(await run("virsh", "dumpxml", name))
                await ok("virsh", "destroy", name)
                await run("virsh", "undefine", name, "--nvram", "--managed-save", "--snapshots-metadata", log=log)
                for d in dom["disks"] if purge else []:
                    p = d["path"] or ""
                    if d["device"] != "disk" and not p.endswith("-cloudinit.iso"):
                        continue
                    if p.startswith("/dev/zvol/"):
                        await run("zfs", "destroy", "-r", p.removeprefix("/dev/zvol/"), log=log)
                    elif p.startswith(str(host.IMAGES) + "/"):
                        Path(p).unlink(missing_ok=True)
                        log(f"removed {p}")
            reg = host.load_guests()
            reg.pop(int(vmid), None)
            host.save_guests(reg)
        return _task(start_job(f"{kind}destroy", vmid, job))

    async def list_pci_devices(self) -> list[PciDeviceInfo]:
        out = []
        for d in (await pci.probe())["devices"]:
            out.append({"id": d["id"], "iommugroup": d["iommu_group"] if d["iommu_group"] is not None else -1,
                        "vendor": f"0x{d['vendor_id']}", "device": f"0x{d['device_id']}", "vendor_name": d["vendor"],
                        "device_name": d["name"], "class": f"0x{d['class']}00", "gpu": d["gpu"], "mdev": False,
                        "category": provisioning.pci_category(d["class"]), "driver": d["driver"],
                        "iommu_shared_with": d["iommu_shared_with"], "warnings": d["warnings"],
                        "audio_function": d["audio_function"]})
        return _many(PciDeviceInfo, out)

    async def list_usb_devices(self) -> list[UsbDeviceInfo]:
        return _many(UsbDeviceInfo, usb_sysfs(Path("/sys/bus/usb/devices"))["devices"])

    async def list_gpus(self) -> list[GpuDeviceInfo]:
        return _many(GpuDeviceInfo, await provisioning.gpus())

    # ============================================================ App Center & Local AI (Incus)
    async def app_catalog(self) -> list[dict]:
        reg, _, cts = await self._registry()
        lxc = [{"vmid": k, "name": v["name"], "tags": v.get("tags", ""),
                "status": "running" if cts.get(v["name"], {}).get("status") == "Running" else "stopped"}
               for k, v in reg.items() if v["type"] == "lxc"]
        installed = apps.installed_map(lxc)
        return [{**a, "installed": installed.get(a["id"], [])} for a in apps.CATALOG]

    async def deploy_app(self, body: apps.DeployBody) -> dict:
        app = apps.BY_ID.get(body.app_id)
        if not app:
            raise HTTPException(404, "Unknown app")
        vmid = await self.next_id()
        host.register(vmid, "lxc", body.hostname, f"{apps.TAG};pos-{app['id']}")  # reserve the id
        is_ai = app["id"] == "local-ai"
        job = {"vmid": vmid, "app_id": app["id"], "upid": "", "phase": "creating", "error": None, "ip": None,
               "web_port": 11434 if is_ai and not body.install_open_webui else app["web_port"],
               "web_scheme": app["web_scheme"], "log": []}
        apps._jobs[vmid] = job

        async def work(log):
            name = body.hostname
            try:
                await self._incus_create(
                    vmid, name, self._image(f"{IMAGES_STORE}:vztmpl/debian/12", static=body.ip_config != "dhcp"),
                    storage="", cores=body.cores, memory_mb=body.memory, disk_gb=body.disk_gb,
                    bridge=settings.default_bridge, ip_config=body.ip_config, nesting=True,
                    tags=f"{apps.TAG};pos-{app['id']}", log=log, autostart=True,
                    description=f"Installed by SolarDeck App Center: {app['name']}")
                job["phase"] = "configuring"
                pre = ""
                if body.mount_storage and app["supports_storage_mount"] and not is_ai:
                    await run("incus", "config", "device", "add", name, "storage", "disk",
                              f"source={settings.storage_root}", "path=/mnt/storage", "shift=true")
                if body.enable_igpu and app["supports_igpu"]:
                    await run("incus", "config", "device", "add", name, "igpu", "gpu", "gputype=physical")
                info: dict = {}
                if is_ai:
                    if body.mount_storage:
                        Path(local_ai.HOST_MODELS).mkdir(parents=True, exist_ok=True)
                        await run("incus", "config", "device", "add", name, "models", "disk",
                                  f"source={local_ai.HOST_MODELS}", f"path={local_ai.MODELS_DIR}", "shift=true")
                    info = await self.attach_ai_compute(name, body.compute_target, log)
                    env = {"SD_COMPUTE": body.compute_target, "SD_WEBUI": "1" if body.install_open_webui else "0"}
                    if info.get("driver_version"):
                        env["SD_NVIDIA_VERSION"] = info["driver_version"]
                        pre = (local_ai.DATA / "apps/nvidia-userspace.sh").read_text()
                    pre = "".join(f"export {k}={v}\n" for k, v in env.items()) + pre + "\n"
                    local_ai._pending[vmid] = info
                job["phase"] = "starting"
                log("==> Starting container")
                await run("incus", "start", name)
                job["phase"] = "installing"
                script = (apps.DATA / "apps/_common.sh").read_text() + "\n" + pre + \
                    (apps.DATA / f"apps/{app['id']}.sh").read_text()
                await self.container_exec(vmid, script, timeout=3600, log=log)
                job["ip"] = await self.container_ip(vmid)
                if is_ai:
                    await local_ai.after_install(vmid, body, job["ip"], log)
                job["phase"] = "done"
                log("==> Installation complete")
            except Exception as e:
                job["phase"] = "error"
                job["error"] = e.detail if isinstance(e, HTTPException) else str(e)
                raise
        upid = start_job("appdeploy", vmid, work)
        job["upid"] = upid
        job["log"] = host.JOBS[upid]["log"]  # one log for the App Center panel and the Task Center
        return {"vmid": vmid, "upid": upid}

    async def attach_ai_compute(self, name: str, target: str, log) -> dict:
        """Give the (stopped) container exactly the device `target` needs. Returns GPU facts for local_ai.json."""
        info: dict = {"vram_mb": None, "gpu_name": None, "gpu_pci": None, "driver_version": None}
        for dev in ("sd-gpu", "sd-dri"):
            await ok("incus", "config", "device", "remove", name, dev)
        if target.startswith("nvidia:"):
            out = await ok("nvidia-smi", f"--query-gpu={local_ai.NV_Q}", "--format=csv,noheader,nounits")
            key = target.split(":", 1)[1]
            g = next((g for g in local_ai.parse_nv_list(out or "") if str(g["index"]) == key or g["pci"] == key[-7:]), None)
            if not g:
                raise HTTPException(409, f"NVIDIA GPU {key} is not visible to nvidia-smi on the host. Install the host "
                                         "driver in Control Panel -> Hardware & System -> GPU & Drivers first.")
            log(f"==> Passing {g['name']} ({g['pci']}) into {name}")
            await run("incus", "config", "device", "add", name, "sd-gpu", "gpu", "gputype=physical", f"pci={g['pci']}")
            info.update(vram_mb=g["vram_total_mb"], gpu_name=g["name"], gpu_pci=g["pci"], driver_version=g["driver_version"])
        elif target.startswith(("intel:", "amd:")):
            node = target.split(":", 1)[1]
            log(f"==> Passing {node} into {name}")
            await run("incus", "config", "device", "add", name, "sd-dri", "unix-char", f"source={node}", f"path={node}",
                      "mode=0666")
        return info

    async def provision_ai_container(self, spec: dict) -> TaskInfo:
        body = local_ai.LocalAiDeployBody(**spec)
        res = await self.deploy_app(apps.DeployBody(app_id="local-ai", memory=body.memory_mb,
                                                    **body.model_dump(exclude={"memory_mb"})))
        return TaskInfo(task=res["upid"], **res)

    async def configure_ai_gpu_passthrough(self, spec: dict) -> dict:
        body = local_ai.SwitchBody(**spec)
        s = local_ai._installed()
        vmid = s["vmid"]
        name = host.name_of(vmid, "lxc")
        patch: dict = {}
        if body.compute_target != s.get("compute_target"):
            await ok("incus", "stop", name, "--timeout", "60")
            patch = await self.attach_ai_compute(name, body.compute_target, lambda _m: None)
            await run("incus", "start", name)
            if patch["driver_version"]:  # first switch to the GPU of a container installed in CPU mode
                pre = f"export SD_NVIDIA_VERSION={patch['driver_version']}\n" + \
                    (local_ai.DATA / "apps/_common.sh").read_text() + (local_ai.DATA / "apps/nvidia-userspace.sh").read_text()
                await self.container_exec(vmid, pre, timeout=1800)
            ip = await self.container_ip(vmid) or s.get("ip")
            patch |= {"ip": ip, "ollama_url": f"http://{ip}:11434",
                      "webui_url": f"http://{ip}:3000" if s.get("open_webui") else None}
        await self.container_exec(vmid, local_ai._env_script(
            local_ai.ollama_env(body.compute_target, body.flash_attention, body.kv_cache_q8)))
        return local_ai.save_state(**patch, compute_target=body.compute_target, flash_attention=body.flash_attention,
                                   kv_cache_q8=body.kv_cache_q8)

    # ============================================================ Storage, ZFS & disks
    async def list_storage_pools(self) -> dict:
        listing, status, incus_pools, disks = await asyncio.gather(
            ok("zpool", "list", "-Hp", "-o", "name,size,alloc,free,frag,dedup,health"), ok("zpool", "status", "-P"),
            self._incus_pools(), self._raw_disks())
        trees = storage_admin.parse_zpool_status(status or "")
        pools = []
        for line in (listing or "").splitlines():
            c = line.split("\t")
            if len(c) != 7:
                continue
            num = lambda v: int(v) if v.isdigit() else 0  # noqa: E731
            pools.append({"name": c[0], "size": num(c[1]), "alloc": num(c[2]), "free": num(c[3]),
                          "frag": num(c[4].rstrip("%")), "dedup": float(c[5].rstrip("x") or 1), "health": c[6],
                          "detail": {"name": c[0], "state": c[6], "children": zpool_tree(trees.get(c[0], []), c[0]),
                                     **zpool_status_fields(status or "", c[0])}})
        st = os.statvfs(settings.storage_root) if settings.storage_root.exists() else None
        targets = [{"storage": LOCAL, "type": "dir", "content": "iso,vztmpl,backup,images", "active": 1, "enabled": 1,
                    "shared": 0, "path": str(settings.storage_root),
                    "total": st.f_blocks * st.f_frsize if st else 0, "avail": st.f_bavail * st.f_frsize if st else 0,
                    "used": (st.f_blocks - st.f_bfree) * st.f_frsize if st else 0},
                   {"storage": IMAGES_STORE, "type": "incus-images", "content": "vztmpl", "active": 1, "enabled": 1,
                    "shared": 1, "total": 0, "avail": 0, "used": 0}]
        for p in pools:
            content = "images,rootdir" if p["name"] in incus_pools else "images"
            targets.append({"storage": p["name"], "type": "zfspool", "content": content, "active": 1, "enabled": 1,
                            "shared": 0, "pool": p["name"], "total": p["size"], "used": p["alloc"], "avail": p["free"]})
        for name, ip in incus_pools.items():
            if name not in {p["name"] for p in pools}:
                targets.append({"storage": name, "type": f"incus-{ip.get('driver', 'dir')}", "content": "rootdir",
                                "active": 1, "enabled": 1, "shared": 0, "total": 0, "avail": 0, "used": 0})
        return {"pools": pools, "targets": targets, "disks": disks, "zfs_available": bool(pools)}

    async def _incus_pools(self) -> dict[str, dict]:
        try:
            return {p["name"]: p for p in await run_json("incus", "storage", "list", "--format", "json") or []}
        except (HTTPException, ValueError):
            return {}

    async def create_zfs_pool(self, spec: dict) -> TaskInfo:
        body = storage_admin.PoolBody(**spec)
        devs = storage_admin.validate_pool(body)
        layout = zpool_layout(body.raidlevel, devs)

        async def job(log):
            await run("zpool", "create", "-f", "-o", f"ashift={body.ashift}", "-O", f"compression={body.compression}",
                      "-O", "atime=off", "-O", "xattr=sa", "-O", "acltype=posixacl", "-m", f"/{body.name}", body.name,
                      *layout, log=log, timeout=600)
            log(f"pool {body.name} created")
            if body.add_storage:
                # Guests can use the pool right away: ZVOLs for VMs, an Incus storage pool for containers.
                await run("zfs", "create", f"{body.name}/incus")
                await run("incus", "storage", "create", body.name, "zfs", f"source={body.name}/incus", log=log)
        return _task(start_job("zfscreate", body.name, job))

    async def destroy_zfs_pool(self, name: str, confirm: str) -> TaskInfo:
        if not re.fullmatch(storage_admin.POOL_RE, name):
            raise HTTPException(422, "Invalid pool name")
        if confirm != name:
            raise HTTPException(400, "Confirmation does not match the pool name")
        rows = storage_admin.parse_zpool_status(await run("zpool", "status", "-P", name)).get(name, [])
        members = [r["name"] for r in rows if r["name"].startswith("/dev/")]

        async def job(log):
            if name in await self._incus_pools():
                await run("incus", "storage", "delete", name, log=log)
            await run("zpool", "destroy", "-f", name, log=log)
            for m in members:  # like PVE cleanup-disks: the disks show up as free again
                await ok("zpool", "labelclear", "-f", m)
                await ok("wipefs", "-a", m)
            log(f"pool {name} destroyed")
        return _task(start_job("zfsremove", name, job))

    async def manage_pool_member(self, pool, action, spec: dict) -> TaskInfo:
        if action == "replace":
            res = await storage_admin.member_replace(pool, storage_admin.ReplaceBody(**spec))
        else:
            fn = {"offline": storage_admin.member_offline, "online": storage_admin.member_online,
                  "detach": storage_admin.member_detach}[action]
            res = await fn(pool, storage_admin.MemberBody(**spec))
        return TaskInfo.model_validate(res if isinstance(res, dict) else {"result": res})

    async def list_datasets(self) -> list[ZfsDatasetInfo]:
        return _many(ZfsDatasetInfo, await storage_admin.datasets())

    async def create_dataset(self, spec: dict) -> dict:
        return await storage_admin.dataset_create(storage_admin.DatasetCreate(**spec))

    async def update_dataset(self, spec: dict) -> dict:
        return await storage_admin.dataset_update(storage_admin.DatasetPatch(**spec))

    async def delete_dataset(self, name: str, confirm: str, recursive: bool = False) -> dict:
        return await storage_admin.dataset_destroy(name, confirm, recursive)

    async def _raw_disks(self) -> list[dict]:
        """Whole disks in the shape of the PVE /disks/list API (storage_admin.normalize_disk reads that)."""
        try:
            data = await run_json("lsblk", "-J", "-b", "-o",
                                  "NAME,PATH,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE,VENDOR,PTTYPE,FSTYPE,MOUNTPOINT")
        except (HTTPException, ValueError):
            return []
        by_id = {}
        idd = Path("/dev/disk/by-id")
        if idd.exists():
            for link in sorted(idd.iterdir()):
                if not re.search(r"-part\d+$", link.name) and not link.name.startswith(("wwn-", "nvme-eui", "nvme-nvme")):
                    by_id.setdefault(str(link.resolve()), str(link))
        disks = [d for d in data.get("blockdevices", []) if d.get("type") == "disk" and not d["name"].startswith(("zd", "loop"))]
        healths = await asyncio.gather(*[ok("smartctl", "-H", "-j", d["path"], timeout=20) for d in disks])
        out = []
        for d, h in zip(disks, healths):
            parts = d.get("children") or []
            fs = {d.get("fstype")} | {p.get("fstype") for p in parts}
            used = "ZFS" if "zfs_member" in fs else "LVM" if "LVM2_member" in fs else \
                "mounted" if d.get("mountpoint") or any(p.get("mountpoint") for p in parts) else \
                "partitions" if parts else ""
            try:
                passed = (json.loads(h or "{}").get("smart_status") or {}).get("passed")
            except ValueError:
                passed = None
            tran = (d.get("tran") or "").lower()
            kind = "nvme" if tran == "nvme" else "usb" if tran == "usb" else "hdd" if d.get("rota") in (True, "1", 1) else "ssd"
            out.append({"devpath": d["path"], "model": (d.get("model") or "").strip(), "serial": d.get("serial") or "",
                        "vendor": (d.get("vendor") or "").strip(), "size": int(d.get("size") or 0), "type": kind,
                        "rpm": -1 if kind == "hdd" else 0, "used": used, "gpt": int(d.get("pttype") == "gpt"),
                        "health": "PASSED" if passed else "FAILED" if passed is False else "UNKNOWN",
                        "wearout": "N/A", "by_id_link": by_id.get(d["path"], "")})
        return out

    async def list_physical_disks(self) -> list[PhysicalDiskInfo]:
        items, (members, rpms) = await asyncio.gather(self._raw_disks(), storage_admin.probe_host_disks())
        return _many(PhysicalDiskInfo, [storage_admin.normalize_disk(d, members.get(d["devpath"]),
                                                                     rpms.get(d["devpath"].removeprefix("/dev/")))
                                        for d in items])

    async def get_disk_smart(self, disk: str) -> SmartReport:
        path = disk if disk.startswith("/dev/") else f"/dev/{disk.removeprefix('dev/').lstrip('/')}"
        path = storage_admin._dev(path)
        raw = await run("smartctl", "-a", "-j", path, check=False, timeout=60)
        try:
            j = json.loads(raw or "{}")
        except ValueError:
            j = {}
        passed = (j.get("smart_status") or {}).get("passed")
        table = (j.get("ata_smart_attributes") or {}).get("table") or []
        s = {"health": "PASSED" if passed else "FAILED" if passed is False else "UNKNOWN",
             "type": "ata" if table else "text",
             "attributes": [{"id": a.get("id"), "name": a.get("name"), "value": a.get("value"), "worst": a.get("worst"),
                             "threshold": a.get("thresh"), "raw": (a.get("raw") or {}).get("string", ""),
                             "flags": (a.get("flags") or {}).get("string", ""), "fail": a.get("when_failed") or "-"}
                            for a in table]}
        if not table:  # NVMe / SAS: PVE shows the text report, which parse_smart reads
            s["text"] = await run("smartctl", "-a", path, check=False, timeout=60)
        return SmartReport.model_validate(storage_admin.parse_smart(s))

    async def get_disk_settings(self, disk: str) -> DiskSettings:
        return DiskSettings.model_validate(await storage_admin.disk_settings(disk))

    async def update_disk_settings(self, disk: str, spec: dict) -> DiskSettings:
        return DiskSettings.model_validate(
            await storage_admin.disk_settings_update(disk, storage_admin.DiskSettings(**spec)))

    async def start_disk_scan(self, disk: str, spec: dict) -> dict:
        return await storage_admin.disk_scan_start(disk, storage_admin.ScanBody(**spec))

    async def get_disk_scan_status(self, disk: str) -> dict:
        return await storage_admin.disk_scan_status(disk)

    async def abort_disk_scan(self, disk: str) -> dict:
        return await storage_admin.disk_scan_abort(disk)

    async def run_disk_benchmark(self, spec: dict) -> BenchmarkResult:
        return BenchmarkResult.model_validate(await disk_benchmark.start(disk_benchmark.BenchBody(**spec)))

    async def wipe_disk(self, disk: str) -> TaskInfo:
        path = storage_admin._dev(disk)

        async def job(log):
            await run("wipefs", "-a", path, log=log)
            await run("sgdisk", "--zap-all", path, log=log)
        return _task(start_job("wipedisk", path.removeprefix("/dev/"), job))

    async def init_gpt(self, disk: str) -> TaskInfo:
        path = storage_admin._dev(disk)

        async def job(log):
            await run("sgdisk", "-o", path, log=log)
        return _task(start_job("diskinit", path.removeprefix("/dev/"), job))

    # ============================================================ Snapshots
    async def list_snapshots(self, scope: SnapshotScope, target=None) -> list[dict]:
        if scope == "zfs":
            snaps = (await api.zfs_snapshots())["snapshots"]
            return [s for s in snaps if target is None or s["dataset"] == target]
        name = host.name_of(int(target), scope)
        if scope == "lxc":
            items = await run_json("incus", "query", f"/1.0/instances/{name}/snapshots?recursion=1") or []
            out = [{"name": s["name"], "description": "", "parent": None, "snaptime": int(_iso_ts(s.get("created_at"))),
                    "vmstate": bool(s.get("stateful")), "current": False} for s in items]
        else:
            txt = await run("virsh", "snapshot-list", name, "--parent")
            out = []
            for line in txt.splitlines()[2:]:
                m = re.match(r"\s*(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+)\s+(\S+)\s*(\S*)", line)
                if m:
                    ts = datetime.strptime(m.group(2), "%Y-%m-%d %H:%M:%S %z").timestamp()
                    out.append({"name": m.group(1), "description": "", "parent": m.group(4) or None,
                                "snaptime": int(ts), "vmstate": m.group(3) == "running", "current": False})
        out.sort(key=lambda s: s["snaptime"])
        return out + [{"name": "current", "description": "You are here", "parent": out[-1]["name"] if out else None,
                       "snaptime": None, "vmstate": False, "current": True}]

    async def create_snapshot(self, scope: SnapshotScope, target, name: str, description: str = "",
                              vmstate: bool = False) -> TaskInfo:
        if scope == "zfs":
            return TaskInfo.model_validate(await api.zfs_snapshot_create(api.SnapshotBody(dataset=str(target), name=name)))
        guest_hardware.SnapshotBody(name=name, description=description)  # validates the name
        g = host.name_of(int(target), scope)
        argv = (["incus", "snapshot", "create", g, name, *(["--stateful"] if vmstate else [])] if scope == "lxc" else
                # Internal snapshots need QCOW2 disks; ZVOL-backed VMs are snapshotted with their dataset instead.
                ["virsh", "snapshot-create-as", g, name, *(["--description", description] if description else []),
                 "--atomic"])

        async def job(log):
            log(await run(*argv, timeout=900))
        return _task(start_job(f"{scope}snapshot", target, job))

    async def rollback_snapshot(self, scope: SnapshotScope, target, name: str) -> TaskInfo:
        if scope == "zfs":
            return TaskInfo.model_validate(await api.zfs_snapshot_rollback(api.RollbackBody(snapshot=f"{target}@{name}")))
        g = host.name_of(int(target), scope)
        argv = ["incus", "snapshot", "restore", g, name] if scope == "lxc" else ["virsh", "snapshot-revert", g, name]

        async def job(log):
            log(await run(*argv, timeout=900))
        return _task(start_job(f"{scope}rollback", target, job))

    async def delete_snapshot(self, scope: SnapshotScope, target, name: str) -> TaskInfo:
        if scope == "zfs":
            return TaskInfo.model_validate(await api.zfs_snapshot_delete(f"{target}@{name}"))
        g = host.name_of(int(target), scope)
        argv = ["incus", "snapshot", "delete", g, name] if scope == "lxc" else ["virsh", "snapshot-delete", g, name]

        async def job(log):
            log(await run(*argv, timeout=900))
        return _task(start_job(f"{scope}delsnapshot", target, job))

    # ============================================================ ISO / template library
    async def list_storage_content(self, storage: str, content: str | None = None) -> list[StorageContentItem]:
        if storage == IMAGES_STORE:
            items = [{"volid": f"{IMAGES_STORE}:vztmpl/{a}", "content": "vztmpl", "format": "incus", "size": 0,
                      "ctime": 0} for a in INCUS_IMAGES] if content in (None, "vztmpl") else []
            return _many(StorageContentItem, [provisioning.volume(v, storage) for v in items])
        if storage != LOCAL:
            return []
        out = []
        for kind in [content] if content else list(CONTENT_DIRS):
            for f in sorted(_store_dir(kind).iterdir()):
                if not f.is_file() or f.name.startswith("."):
                    continue
                st = f.stat()
                m = ARCHIVE_RE.match(f.name)
                v = {"volid": f"{LOCAL}:{kind}/{f.name}", "content": kind, "size": st.st_size, "ctime": int(st.st_mtime),
                     "format": f.suffix.lstrip("."), **({"vmid": m.group(2), "subtype": m.group(1)} if m else {})}
                out.append(provisioning.volume(v, LOCAL))
        return _many(StorageContentItem, sorted(out, key=lambda v: v["ctime"], reverse=True))

    async def download_url_to_storage(self, storage: str, spec: dict) -> TaskInfo:
        if storage != LOCAL:
            raise HTTPException(400, f"Downloads go to the '{LOCAL}' storage")
        body = provisioning.DownloadBody(**spec)
        p = provisioning.download_params(body)
        dest = _store_dir(p["content"]) / p["filename"]
        if dest.exists():
            raise HTTPException(409, f"{dest.name} already exists")

        async def job(log):
            part = dest.with_name(f".{dest.name}.part")
            try:
                log(f"downloading {body.url}")
                await run("curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3",
                          *([] if body.verify_certificates else ["--insecure"]), "--output", str(part), body.url,
                          timeout=6 * 3600)
                if body.checksum:
                    h = hashlib.new(body.checksum_algorithm)
                    with part.open("rb") as f:
                        for chunk in iter(lambda: f.read(1 << 20), b""):
                            h.update(chunk)
                    if h.hexdigest() != body.checksum.lower():
                        raise HTTPException(422, f"Checksum mismatch ({body.checksum_algorithm})")
                    log("checksum OK")
                part.replace(dest)
                log(f"saved {dest} ({dest.stat().st_size} bytes)")
            finally:
                part.unlink(missing_ok=True)
        return _task(start_job("download", p["filename"], job))

    async def upload_to_storage(self, storage: str, content: str, filename: str, chunks, size: int | None) -> dict:
        """Stream an uploaded file (ISO image) into the storage; the partial file is removed on any error."""
        if storage != LOCAL:
            raise HTTPException(400, f"Uploads go to the '{LOCAL}' storage")
        if content == "iso" and not filename.lower().endswith((".iso", ".img")):
            raise HTTPException(400, "ISO uploads must be .iso or .img files")
        folder = _store_dir(content)
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / filename
        if dest.exists():
            raise HTTPException(409, f"{dest.name} already exists")
        if size and size > shutil.disk_usage(folder).free - 2**30:
            raise HTTPException(507, f"Not enough free space in {folder} for {size / 2**30:.1f} GiB")
        part = dest.with_name(f".{dest.name}.part")
        try:
            with part.open("wb") as f:
                async for chunk in chunks:
                    await asyncio.to_thread(f.write, chunk)
            if not part.stat().st_size:
                raise HTTPException(400, "The uploaded file is empty")
            part.replace(dest)
        finally:
            part.unlink(missing_ok=True)
        return {"ok": True, "volid": f"{LOCAL}:{content}/{filename}", "size": dest.stat().st_size}

    async def delete_storage_content(self, storage: str, volume: str) -> TaskInfo:
        if volume.split(":", 1)[0] != storage:
            raise HTTPException(400, "Volume does not belong to this storage")
        f = _volume_file(volume)
        if not f.exists():
            raise HTTPException(404, f"{volume} not found")
        f.unlink()
        return _task(start_job("imgdel", f.name, lambda log: asyncio.sleep(0)))

    # ============================================================ Backups
    async def list_backups(self) -> list[BackupArchiveInfo]:
        reg = host.load_guests()
        out = []
        for v in await self.list_storage_content(LOCAL, "backup"):
            d = v.model_dump()
            if d.get("subtype") in ("qemu", "lxc"):
                out.append({**d, "type": d["subtype"], "name": reg.get(d["vmid"] or -1, {}).get("name", "")})
        return _many(BackupArchiveInfo, out)

    async def run_backup(self, spec: dict) -> TaskInfo:
        body = backups.RunBody(**spec)
        reg, _, _ = await self._registry()
        ids = sorted(reg) if body.vmid == "all" else [body.vmid]
        if any(i not in reg for i in ids):
            raise HTTPException(404, f"Guest {body.vmid} not found")

        async def job(log):
            for vmid in ids:
                await self.backup_guest(vmid, reg[vmid], body.mode, body.compress, log)
        return _task(start_job("vzdump", "all" if body.vmid == "all" else body.vmid, job))

    async def backup_guest(self, vmid: int, g: dict, mode: str, compress: str, log) -> Path:
        stamp = datetime.now().strftime("%Y_%m_%d-%H_%M_%S")
        ext = "gz" if compress == "gzip" else "zst"
        archive = _store_dir("backup") / f"solardeck-{g['type']}-{vmid}-{stamp}.tar.{ext}"
        log(f"==> Backing up {g['type']} {vmid} ({g['name']}) to {archive}")
        if g["type"] == "lxc":
            stopped = mode == "stop" and await self.container_status(vmid) == "running"
            if stopped:
                await run("incus", "stop", g["name"], "--timeout", "120", log=log)
            try:
                await run("incus", "export", g["name"], str(archive), "--instance-only", "--compression",
                          "gzip" if ext == "gz" else "zstd", timeout=6 * 3600, log=log)
            finally:
                if stopped:
                    await run("incus", "start", g["name"])
            return archive
        work = Path(tempfile.mkdtemp(prefix=f".sd-backup-{vmid}-", dir=archive.parent))
        name = g["name"]
        running = "running" in (await ok("virsh", "domstate", name) or "")
        paused = stopped = False
        try:
            xml = await run("virsh", "dumpxml", "--inactive", name)
            (work / "domain.xml").write_text(xml)
            dom = host.parse_domain(xml)
            if running and mode == "stop":
                await run("virsh", "shutdown", name)
                for _ in range(120):
                    if "running" not in (await ok("virsh", "domstate", name) or ""):
                        break
                    await asyncio.sleep(2)
                else:
                    await run("virsh", "destroy", name)
                stopped = True
            meta = {"type": "qemu", "vmid": vmid, "name": name, "disks": []}
            snaps = []
            files = [d for d in dom["disks"] if d["device"] == "disk" and d["path"] and not d["path"].startswith("/dev/zvol/")]
            if running and not stopped and files:
                await run("virsh", "suspend", name)  # QCOW2 copies are consistent only while the guest is paused
                paused = True
            for d in dom["disks"]:
                if d["device"] != "disk" or not d["path"]:
                    continue
                if d["path"].startswith("/dev/zvol/"):
                    vol = d["path"].removeprefix("/dev/zvol/")
                    snap = f"{vol}@solardeck-backup-{stamp}"
                    await run("zfs", "snapshot", snap)
                    snaps.append(snap)
                    out = work / f"disk-{d['target']}.zfs"
                    await run("zfs", "send", "-c", snap, stdout_path=str(out), timeout=6 * 3600)
                    meta["disks"].append({"target": d["target"], "kind": "zvol", "file": out.name,
                                          "volsize": (await run("zfs", "get", "-Hp", "-o", "value", "volsize", vol)).strip()})
                else:
                    out = work / f"disk-{d['target']}.qcow2"
                    await run("qemu-img", "convert", "-U", "-O", "qcow2", d["path"], str(out), timeout=6 * 3600, log=log)
                    meta["disks"].append({"target": d["target"], "kind": "file", "file": out.name})
                log(f"    disk {d['target']} saved")
            if paused:
                await run("virsh", "resume", name)
                paused = False
            for snap in snaps:
                await ok("zfs", "destroy", snap)
            (work / "meta.json").write_text(json.dumps(meta, indent=2))
            await run("tar", "--zstd" if ext == "zst" else "--gzip", "-cf", str(archive), "-C", str(work), ".",
                      timeout=6 * 3600)
            log(f"==> {archive.name}: {archive.stat().st_size} bytes")
            return archive
        finally:
            if paused:
                await ok("virsh", "resume", name)
            if stopped and running:
                await ok("virsh", "start", name)
            shutil.rmtree(work, ignore_errors=True)

    async def restore_backup(self, spec: dict) -> TaskInfo:
        body = backups.RestoreBody(**spec)
        f = _volume_file(body.volid)
        m = ARCHIVE_RE.match(f.name)
        if not f.exists() or not m or m.group(1) != body.type:
            raise HTTPException(404, f"{body.volid} is not a {body.type} backup on this host")
        reg, _, _ = await self._registry()
        existing = reg.get(body.vmid)
        if existing and not body.force:
            raise HTTPException(409, f"VMID {body.vmid} exists; enable overwrite to replace it")

        async def job(log):
            if existing:
                log(f"==> Removing existing guest {body.vmid}")
                await host.wait_job((await self.delete_guest(existing["type"], body.vmid)).task)
            if body.type == "lxc":
                name = existing["name"] if existing else f"ct{body.vmid}"
                pools = await self._incus_pools()
                await run("incus", "import", str(f), name, *(["-s", body.storage] if body.storage in pools else []),
                          timeout=6 * 3600, log=log)
                await run("incus", "config", "set", name, f"user.solardeck.vmid={body.vmid}")
                host.register(body.vmid, "lxc", name)
                return
            await self._restore_vm(f, body, existing["name"] if existing else None, log)
        return _task(start_job("qmrestore", body.vmid, job))

    async def _restore_vm(self, archive: Path, body, keep_name: str | None, log) -> None:
        work = Path(tempfile.mkdtemp(prefix=".sd-restore-", dir=archive.parent))
        try:
            await run("tar", "--gzip" if archive.suffix == ".gz" else "--zstd", "-xf", str(archive), "-C", str(work),
                      timeout=6 * 3600)
            meta = json.loads((work / "meta.json").read_text())
            d = ET.fromstring((work / "domain.xml").read_text())
            name = keep_name or f"{meta['name']}-restored-{body.vmid}"
            d.find("name").text = name
            for tag in ("uuid",):
                el = d.find(tag)
                if el is not None:
                    d.remove(el)
            for iface in d.findall("devices/interface"):
                el = iface.find("mac")
                if el is not None:
                    iface.remove(el)  # libvirt assigns a fresh MAC
            nv = d.find("os/nvram")
            if nv is not None:
                nv.text = str(host.NVRAM / f"{name}_VARS.fd")
            disks = {e.find("target").get("dev"): e for e in d.findall("devices/disk") if e.get("device") == "disk"}
            for i, disk in enumerate(meta["disks"]):
                el = disks[disk["target"]]
                src = el.find("source")
                if disk["kind"] == "zvol":
                    if body.storage == LOCAL:
                        raise HTTPException(400, "This VM was backed by ZFS volumes; restore it onto a ZFS storage")
                    vol = f"{body.storage}/vm-{body.vmid}-disk-{i}"
                    await run("zfs", "receive", "-F", vol, stdin_path=str(work / disk["file"]), timeout=6 * 3600)
                    path, kind, fmt = f"/dev/zvol/{vol}", "block", "raw"
                elif body.storage == LOCAL:
                    host.IMAGES.mkdir(parents=True, exist_ok=True)
                    path, kind, fmt = str(host.IMAGES / f"vm-{body.vmid}-disk-{i}.qcow2"), "file", "qcow2"
                    shutil.move(work / disk["file"], path)
                else:
                    info = json.loads(await run("qemu-img", "info", "--output=json", str(work / disk["file"])))
                    vol = f"{body.storage}/vm-{body.vmid}-disk-{i}"
                    await run("zfs", "create", "-s", "-V", str(info["virtual-size"]), vol)
                    await ok("udevadm", "settle", "--timeout=15")
                    path, kind, fmt = f"/dev/zvol/{vol}", "block", "raw"
                    await run("qemu-img", "convert", "-O", "raw", str(work / disk["file"]), path, timeout=6 * 3600)
                el.set("type", kind)
                el.find("driver").set("type", fmt)
                src.attrib.clear()
                src.set("file" if kind == "file" else "dev", path)
                log(f"    disk {disk['target']} -> {path}")
            host.NVRAM.mkdir(parents=True, exist_ok=True)
            await host.define(ET.tostring(d, encoding="unicode"))
            host.register(body.vmid, "qemu", name)
            log(f"==> VM {body.vmid} ({name}) restored")
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _schedules(self) -> list[dict]:
        try:
            return json.loads(SCHEDULES_FILE.read_text())
        except (OSError, ValueError):
            return []

    def _save_schedules(self, jobs: list[dict]) -> None:
        SCHEDULES_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SCHEDULES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(jobs, indent=2))
        tmp.replace(SCHEDULES_FILE)

    async def list_backup_schedules(self) -> list[BackupScheduleInfo]:
        return _many(BackupScheduleInfo, self._schedules())

    async def create_backup_schedule(self, spec: dict) -> dict:
        body = backups.ScheduleBody(**spec)
        backups.schedule_params(body)  # same validation as the Proxmox driver
        nxt = await next_elapse(body.schedule)
        if nxt is None:
            raise HTTPException(422, f"Invalid schedule {body.schedule!r} (use e.g. daily, sun 01:00, mon..fri 02:30)")
        jobs = self._schedules()
        jobs.append({"id": f"backup-{secrets.token_hex(4)}", "enabled": body.enabled, "schedule": body.schedule,
                     "storage": body.storage, "all": body.vmids == "all",
                     "vmid": "" if body.vmids == "all" else ",".join(map(str, body.vmids)), "mode": body.mode,
                     "compress": body.compress, "comment": body.comment, "keep_last": body.keep_last, "next_run": nxt})
        self._save_schedules(jobs)
        return {"ok": True}

    async def toggle_backup_schedule(self, job_id: str, enabled: bool) -> dict:
        jobs = self._schedules()
        j = next((j for j in jobs if j["id"] == job_id), None)
        if not j:
            raise HTTPException(404, "Backup job not found")
        j["enabled"] = enabled
        j["next_run"] = await next_elapse(j["schedule"])
        self._save_schedules(jobs)
        return {"ok": True}

    async def delete_backup_schedule(self, job_id: str) -> dict:
        jobs = self._schedules()
        if not any(j["id"] == job_id for j in jobs):
            raise HTTPException(404, "Backup job not found")
        self._save_schedules([j for j in jobs if j["id"] != job_id])
        return {"ok": True}

    async def backup_scheduler_loop(self) -> None:
        """Runs due backup jobs (started from app.main lifespan on this driver)."""
        while True:
            try:
                await self._run_due_backups()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - a broken job must not stop the scheduler
                pass
            await asyncio.sleep(60)

    async def _run_due_backups(self) -> None:
        jobs, now = self._schedules(), time.time()
        for j in jobs:
            if not j["enabled"] or not j.get("next_run") or j["next_run"] > now:
                continue
            j["next_run"] = await next_elapse(j["schedule"])
            self._save_schedules(jobs)
            reg, _, _ = await self._registry()
            ids = sorted(reg) if j["all"] else [int(x) for x in str(j["vmid"]).split(",") if x.isdigit() and int(x) in reg]

            async def work(log, ids=ids, j=j, reg=reg):
                for vmid in ids:
                    await self.backup_guest(vmid, reg[vmid], j["mode"], j["compress"], log)
                    prune(_store_dir("backup"), reg[vmid]["type"], vmid, j["keep_last"], log)
            start_job("vzdump", j["id"], work)

    # ============================================================ Access control (local RBAC)
    async def list_users(self) -> list[AccessUserInfo]:
        return _many(AccessUserInfo, rbac.users())

    async def create_user(self, spec: dict) -> dict:
        return rbac.create_user(pve_access.UserCreate(**spec))

    async def update_user(self, userid: str, spec: dict) -> dict:
        return rbac.update_user(userid, pve_access.UserFields(**spec))

    async def delete_user(self, userid: str) -> dict:
        return rbac.delete_user(userid)

    async def list_groups(self) -> list[AccessGroupInfo]:
        return _many(AccessGroupInfo, rbac.groups())

    async def create_group(self, spec: dict) -> dict:
        return rbac.create_group(pve_access.GroupBody(**spec))

    async def delete_group(self, groupid: str) -> dict:
        return rbac.delete_group(groupid)

    async def list_roles(self) -> list[AccessRoleInfo]:
        return _many(AccessRoleInfo, rbac.roles())

    async def create_role(self, spec: dict) -> dict:
        body = pve_access.RoleCreate(**spec)
        body.joined()
        return rbac.save_role(body.roleid, body.privs, create=True)

    async def update_role(self, roleid: str, spec: dict) -> dict:
        body = pve_access.RoleBody(**spec)
        body.joined()
        return rbac.save_role(roleid, body.privs, create=False)

    async def delete_role(self, roleid: str) -> dict:
        return rbac.delete_role(roleid)

    async def list_acls(self) -> list[AccessAclInfo]:
        return _many(AccessAclInfo, rbac.acl())

    async def update_acl(self, spec: dict, delete: bool = False) -> dict:
        return rbac.update_acl(pve_access.AclBody(**spec), delete)

    async def list_pools(self) -> list[ResourcePoolInfo]:
        return _many(ResourcePoolInfo, rbac.pools())

    async def create_pool(self, spec: dict) -> dict:
        return rbac.create_pool(pve_access.PoolBody(**spec))

    async def delete_pool(self, poolid: str) -> dict:
        return rbac.delete_pool(poolid)

    # ============================================================ Firewall, logs & tasks
    async def list_firewall_rules(self, scope: str, vmid: int | None = None) -> list[FirewallRuleInfo]:
        try:
            data = json.loads(await run("nft", "-j", "list", "table", "inet", "solardeck") or "{}")
        except (HTTPException, ValueError):
            return []  # no SolarDeck table yet
        return _many(FirewallRuleInfo, parse_nft_rules(data))

    async def list_tasks(self) -> list[TaskInfo]:
        jobs = sorted(host.JOBS.values(), key=lambda j: j["starttime"], reverse=True)[:30]
        return _many(TaskInfo, [host.job_view(j) for j in jobs])

    def _job(self, task: str) -> dict:
        j = host.JOBS.get(task)
        if not j:
            raise HTTPException(404, "Unknown task (the backend may have restarted)")
        return j

    async def get_task_status(self, task: str) -> dict:
        v = host.job_view(self._job(task))
        return {"upid": task, "running": v["state"] == "running",
                "exitstatus": None if v["state"] == "running" else v["status"], "state": v["state"]}

    async def get_task_log(self, task: str, start: int = 0) -> dict:
        return {"start": start, "lines": self._job(task)["log"][start:start + 1000]}

    async def get_syslog(self, limit: int = 500, start: int = 0, since: str | None = None,
                         until: str | None = None) -> dict:
        argv = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(limit + start)]
        argv += [*(["--since", since] if since else []), *(["--until", until] if until else [])]
        lines = (await run(*argv, timeout=30)).splitlines()
        return {"lines": lines[:len(lines) - start] if start else lines}

    # ============================================================ Networking & consoles
    async def list_network_interfaces(self) -> list[NetworkInterfaceInfo]:
        addrs, routes = await asyncio.gather(run_json("ip", "-j", "-d", "addr"), ok("ip", "-j", "route", "show", "default"))
        gw = {}
        try:
            gw = {r["dev"]: r["gateway"] for r in json.loads(routes or "[]") if r.get("gateway")}
        except ValueError:
            pass
        return _many(NetworkInterfaceInfo, parse_ip_addr(addrs or [], gw, netplan_methods()))

    async def get_network_topology(self) -> NetworkTopologyGraph:
        network = [i.model_dump() for i in await self.list_network_interfaces()]
        links_txt = await ok("ip", "-j", "link", "show")
        reg, doms, cts = await self._registry()
        guests = []
        for vmid, g in sorted(reg.items()):
            if g["type"] == "qemu":
                xml = await ok("virsh", "dumpxml", g["name"])
                nets = host.parse_domain(xml)["nets"] if xml else []
                status = "running" if doms.get(g["name"], {}).get("state.state") == "1" else "stopped"
                ips: dict = {}
            else:
                c = cts.get(g["name"], {})
                dev = c.get("expanded_devices") or {}
                st = (c.get("state") or {}).get("network") or {}
                nets = [{"key": k, "bridge": v.get("parent") or v.get("network"),
                         "mac": ((st.get(k) or {}).get("hwaddr") or "").upper() or None}
                        for k, v in dev.items() if v.get("type") == "nic"]
                ips = {(n.get("hwaddr") or "").upper(): [a["address"] for a in n.get("addresses", [])
                                                        if a.get("family") == "inet" and a.get("scope") == "global"]
                       for n in st.values() if n.get("hwaddr")}
                status = "running" if c.get("status") == "Running" else "stopped"
            guests.append({"type": g["type"], "vmid": vmid, "name": g["name"], "status": status,
                           "nets": [{"tag": None, "ip": None, "name": n["key"], "firewall": False, **n} for n in nets],
                           "ips": ips})
        wg, wg_live, router_cfg = await asyncio.gather(
            net_services.load("wg", net_services.WG_DEFAULT), net_services.wg_dump(),
            net_services.load("router", net_services.ROUTER_DEFAULT), return_exceptions=True)
        okv = lambda v, d: d if isinstance(v, BaseException) else (v or d)  # noqa: E731
        return NetworkTopologyGraph.model_validate(automation.build_topology(
            network, automation.parse_ip_links(links_txt or ""), guests, okv(wg, {}), okv(wg_live, {}), okv(router_cfg, {})))

    async def open_vnc_console(self, kind: GuestKind, vmid: int) -> ConsoleTicket:
        from app import console
        if kind != "qemu":
            raise HTTPException(400, "Containers have a terminal console, not VNC")
        disp = (await run("virsh", "vncdisplay", host.name_of(vmid, "qemu"))).strip()
        m = re.search(r":(\d+)$", disp)
        if not m:
            raise HTTPException(409, "The VM is not running or has no VNC display")
        port = 5900 + int(m.group(1))
        sid = console._new_session("vnc", kind, vmid, {"port": port})
        return ConsoleTicket(session=sid, password=None, ws_path=f"/api/v1/ws/vnc/{kind}/{vmid}")

    async def open_terminal_console(self, kind: GuestKind, vmid: int) -> ConsoleTicket:
        from app import console
        if kind == "node":
            cmd = ""
        else:
            name = host.name_of(vmid, kind)
            # Same PTY relay as the host shell: a root login in the container, or the VM's serial console.
            cmd = f"incus exec {name} -- login -f root" if kind == "lxc" else f"virsh console --force {name}"
        sid = console._new_session("terminal", kind, vmid, {"ssh": cmd})
        return ConsoleTicket(session=sid, ws_path=f"/api/v1/ws/terminal/{kind}/{vmid}")

    async def open_host_shell(self) -> ConsoleTicket:
        return ConsoleTicket(ws_path="/api/v1/ws/host-shell")


# ---------------------------------------------------------------- Request models & pure helpers (unit tested)
from pydantic import BaseModel, Field  # noqa: E402


class CloudInit(BaseModel):
    user: str = Field("solardeck", pattern=r"^[a-z_][a-z0-9_-]{0,31}$")
    password: str | None = Field(None, min_length=5, max_length=128, pattern=r"^[^\r\n]+$")
    ssh_keys: list[str] = Field([], max_length=20)


class NativeQemuBody(provisioning.QemuBody):
    cloudinit: CloudInit | None = None


def zpool_layout(raid: str, devs: list[str]) -> list[str]:
    if raid == "single":
        return devs
    if raid == "mirror":
        return ["mirror", *devs]
    if raid == "raid10":
        return [x for i in range(0, len(devs), 2) for x in ("mirror", devs[i], devs[i + 1])]
    return [raid, *devs]


def zpool_tree(rows: list[dict], pool: str) -> list[dict]:
    """parse_zpool_status rows -> the nested children list of PVE /disks/zfs/{name}."""
    nodes = {}
    roots = []
    for r in rows:
        n = {"name": r["name"], "state": r["state"], "read": r["read"], "write": r["write"], "cksum": r["cksum"],
             "msg": r["msg"], "children": []}
        key = (r["depth"], r["name"])
        nodes[key] = n
        if r["depth"] == 0:
            roots.append(n)
        else:
            parent = next((nodes[k] for k in reversed(list(nodes)) if k[0] == r["depth"] - 1), None)
            (parent["children"] if parent else roots).append(n)
    for n in roots:
        if not n["children"]:
            n.pop("children")
    return roots


def zpool_status_fields(text: str, pool: str) -> dict:
    block = re.split(r"^\s*pool:\s*", text, flags=re.M)
    body = next((b for b in block if b.split("\n", 1)[0].strip() == pool), "")
    get = lambda k: (re.search(rf"^\s*{k}:\s*(.+(?:\n\t.+)*)", body, re.M) or [None, ""])[1].strip()  # noqa: E731
    return {"status": get("status"), "action": get("action"), "scan": get("scan"), "errors": get("errors")}


def usb_sysfs(root: Path) -> dict:
    devices = []
    if root.exists():
        for d in sorted(root.iterdir()):
            vid = d / "idVendor"
            if not vid.exists() or ":" in d.name:
                continue
            rd = lambda f: (d / f).read_text().strip() if (d / f).exists() else ""  # noqa: E731
            if rd("bDeviceClass") == "09":  # hubs and root controllers
                continue
            speed = rd("speed")
            devices.append({"host": f"{rd('idVendor')}:{rd('idProduct')}", "port": d.name if "-" in d.name else None,
                            "product": rd("product"), "manufacturer": rd("manufacturer"), "speed": speed,
                            "usb3": float(speed or 0) >= 5000})
    return {"devices": devices, "ports": sorted({x["port"] for x in devices if x["port"]})}


def parse_ip_addr(addrs: list[dict], gateways: dict[str, str], methods: dict[str, str]) -> list[dict]:
    """`ip -j -d addr` -> PVE /network rows (eth, bridge, bond, vlan). Guest taps/veths are skipped."""
    ports: dict[str, list[str]] = {}
    for a in addrs:
        if a.get("master"):
            ports.setdefault(a["master"], []).append(a["ifname"])
    out = []
    for a in addrs:
        name = a.get("ifname", "")
        kind = (a.get("linkinfo") or {}).get("info_kind")
        if name == "lo" or kind in ("veth", "tun", "dummy", "wireguard") or name.startswith(("vnet", "tap", "veth")):
            continue
        typ = {"bridge": "bridge", "bond": "bond", "vlan": "vlan"}.get(kind or "", "eth" if not kind else None)
        if not typ:
            continue
        v4 = next((i for i in a.get("addr_info", []) if i.get("family") == "inet"), None)
        row = {"iface": name, "type": typ, "active": int("UP" in a.get("flags", [])), "autostart": 1,
               "method": methods.get(name, "static" if v4 and not v4.get("dynamic") else "dhcp" if v4 else "manual"),
               "families": ["inet"] if v4 else [], "cidr": f"{v4['local']}/{v4['prefixlen']}" if v4 else None,
               "address": v4["local"] if v4 else None, "gateway": gateways.get(name)}
        if typ == "bridge":
            row["bridge_ports"] = " ".join(sorted(ports.get(name, [])))
        if typ == "bond":
            row["slaves"] = " ".join(sorted(ports.get(name, [])))
        if typ == "vlan":
            info = (a.get("linkinfo") or {}).get("info_data") or {}
            row["vlan-id"] = info.get("id")
            row["vlan-raw-device"] = a.get("link")
        out.append(row)
    return sorted(out, key=lambda r: (r["type"] != "bridge", r["iface"]))


def netplan_methods(root: Path = Path("/etc/netplan")) -> dict[str, str]:
    """{iface: "dhcp"|"static"} from the Netplan YAML files (best effort; PyYAML ships with uvicorn[standard])."""
    try:
        import yaml
    except ImportError:
        return {}
    out = {}
    for f in sorted(root.glob("*.yaml")) if root.exists() else []:
        try:
            net = (yaml.safe_load(f.read_text()) or {}).get("network") or {}
        except (OSError, yaml.YAMLError):
            continue
        for section in ("ethernets", "bridges", "bonds", "vlans"):
            for name, cfg in (net.get(section) or {}).items():
                cfg = cfg or {}
                out[name] = "dhcp" if cfg.get("dhcp4") in (True, "true", "yes") else "static" if cfg.get("addresses") else "manual"
    return out


def parse_nft_rules(data: dict) -> list[dict]:
    """`nft -j list table inet solardeck` -> PVE-style firewall rule rows (best effort)."""
    rules = []
    for item in data.get("nftables", []):
        r = item.get("rule")
        if not r:
            continue
        row = {"pos": len(rules), "type": "out" if "output" in r.get("chain", "") else "in", "action": "ACCEPT",
               "enable": 1, "proto": None, "dport": None, "source": None, "dest": None, "comment": r.get("comment", ""),
               "chain": r.get("chain"), "handle": r.get("handle")}
        for e in r.get("expr", []):
            if "accept" in e:
                row["action"] = "ACCEPT"
            elif "drop" in e:
                row["action"] = "DROP"
            elif "reject" in e:
                row["action"] = "REJECT"
            m = e.get("match")
            if not m:
                continue
            left, right = m.get("left", {}), m.get("right")
            p = left.get("payload") or {}
            val = right if not isinstance(right, dict) else ",".join(map(str, (right.get("set") or [])))
            if p.get("field") == "dport":
                row["proto"], row["dport"] = p.get("protocol"), str(val)
            elif p.get("field") == "saddr":
                row["source"] = val if isinstance(val, str) else str((right or {}).get("prefix", {}).get("addr", val))
            elif p.get("field") == "daddr":
                row["dest"] = val if isinstance(val, str) else str(val)
        rules.append(row)
    return rules


def prune(folder: Path, kind: str, vmid: int, keep: int, log=None) -> list[str]:
    """Delete the oldest archives of one guest beyond `keep`; returns the removed names."""
    mine = sorted((f for f in folder.iterdir() if (m := ARCHIVE_RE.match(f.name)) and m.group(1) == kind
                   and int(m.group(2)) == vmid), key=lambda f: f.name)
    gone = mine[:-keep] if keep else mine
    for f in gone:
        f.unlink(missing_ok=True)
        if log:
            log(f"    pruned {f.name}")
    return [f.name for f in gone]


async def next_elapse(spec: str) -> int | None:
    out = await ok("systemd-analyze", "calendar", "--iterations=1", spec, timeout=10)
    return parse_calendar_next(out or "")
