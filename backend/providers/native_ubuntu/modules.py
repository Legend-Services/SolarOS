"""SolarOS side of the Security-by-Design core modules (contract: HypervisorProvider.module_driver)."""
import shlex

from fastapi import HTTPException

from app import host_ssh
from app.config import settings
from . import host

BACKUP_DIR = f"{settings.storage_root}/backups/dump"
CLONE_TEMPLATES = False


def serial_command(guest_type: str, vmid: int) -> str:
    name = shlex.quote(host.name_of(vmid, guest_type))
    return f"virsh console --force {name}" if guest_type == "qemu" else f"incus console {name}"


async def enable_serial(vmid: int) -> bool:
    return False  # VMs get a serial console when they are created


def heartbeat_command(kind: str, vmid: int) -> str:
    name = shlex.quote(host.name_of(vmid, kind))
    return f"virsh qemu-agent-command {name} '{{\"execute\":\"guest-ping\"}}'" if kind == "qemu" else f"incus exec {name} -- true"


async def usb_attach(device: str, vmid: int) -> str:
    name = shlex.quote(host.name_of(vmid, "qemu"))
    xml = await host_ssh.run(f"virsh dumpxml {name}", timeout=30)
    slot = next((f"vd{c}" for c in "bcdefghijklmnop" if f"dev='vd{c}'" not in xml), None)
    if not slot:
        raise HTTPException(409, "This VM has no free disk slot")
    live = "--live " if "running" in await host_ssh.run(f"virsh domstate {name}", check=False) else ""
    await host_ssh.run(f"virsh attach-disk {name} {shlex.quote(device)} {slot} {live}--persistent", timeout=60)
    return slot


async def make_template(vmid: int) -> None:
    return None  # listed in the hub only; the VM stays as it is


async def clone_template(vmid: int, new_vmid: int, name: str, full: bool) -> None:
    raise HTTPException(501, "Cloning templates is not available with this hypervisor yet; use Zero-Touch Create")


async def zero_touch(b, job: dict, user_data: str, network_config: str) -> None:
    """Create the VM with the driver, write the cloud image onto its disk, then regenerate its cloud-init seed."""
    from app.apps import _wait
    from providers.registry import get_provider
    from .provider import _volume_file
    p, log = get_provider(), job["logs"].append
    image = _volume_file(b.image_volume)
    await _wait(p, await p.create_vm({"vmid": b.vmid, "name": b.name, "cores": b.cores, "memory": b.memory, "storage": b.storage,
                                      "disk_gb": b.disk_gb, "bridge": b.bridge, "bios": "ovmf", "ostype": "l26",
                                      "cloudinit": {"user": b.admin_user, "password": b.password, "ssh_keys": b.ssh_keys}}))
    job["stage"] = 2
    disk = (await host_ssh.run(f"virsh domblklist {shlex.quote(b.name)} --details | awk '$2==\"disk\"{{print $4; exit}}'")).strip()
    fmt = "raw" if disk.startswith("/dev/") else "qcow2"
    log(f"Writing {image.name} onto {disk}")
    await host_ssh.run(f"qemu-img convert -O {fmt} {shlex.quote(str(image))} {shlex.quote(disk)}"
                       + (f" && qemu-img resize {shlex.quote(disk)} {b.disk_gb}G" if fmt == "qcow2" else ""), timeout=3600)
    seed, d = host.IMAGES / f"vm-{b.vmid}-cloudinit.iso", f"/tmp/sd-zt-{b.vmid}"
    await host_ssh.run(f"mkdir -p {d} && cat > {d}/user-data", input=user_data)
    await host_ssh.run(f"cat > {d}/network-config", input=network_config)
    await host_ssh.run(f"printf 'instance-id: sd-{b.vmid}\\nlocal-hostname: {b.name}\\n' > {d}/meta-data && "
                       f"cloud-localds -N {d}/network-config {shlex.quote(str(seed))} {d}/user-data {d}/meta-data; rm -rf {d}")
    if b.vlan_tag:
        from app import network_switch as nsw
        await nsw.update_guest_vnic(nsw.GuestVnicBody(bridge=b.bridge, vlan_tag=b.vlan_tag), "vm", b.vmid, "net0")
