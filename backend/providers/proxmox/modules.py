"""Proxmox VE side of the Security-by-Design core modules (contract: HypervisorProvider.module_driver)."""
import shlex

from fastapi import HTTPException

from app import host_ssh
from app.config import settings
from app.provisioning import GUEST_TAG

BACKUP_DIR = "/var/lib/vz/dump"
CLONE_TEMPLATES = True


def serial_command(guest_type: str, vmid: int) -> str:
    return f"qm terminal {vmid}" if guest_type == "qemu" else f"pct console {vmid}"


async def enable_serial(vmid: int) -> bool:
    """`qm terminal` needs a serial port; returns True when the VM must restart to get it."""
    await host_ssh.run(f"qm set {vmid} -serial0 socket", timeout=30)
    return True


def heartbeat_command(kind: str, vmid: int) -> str:
    return f"qm agent {vmid} ping" if kind == "qemu" else f"pct exec {vmid} -- true"


async def usb_attach(device: str, vmid: int) -> str:
    cfg = await host_ssh.run(f"qm config {vmid}", timeout=30)
    slot = next((f"scsi{i}" for i in range(1, 30) if f"scsi{i}:" not in cfg), None)
    if not slot:
        raise HTTPException(409, "This VM has no free SCSI slot")
    await host_ssh.run(f"qm set {vmid} -{slot} {shlex.quote(device)},backup=0", timeout=60)
    return slot


async def make_template(vmid: int) -> None:
    await host_ssh.run(f"qm template {vmid}", timeout=300)


async def clone_template(vmid: int, new_vmid: int, name: str, full: bool) -> None:
    await host_ssh.run(f"qm clone {vmid} {new_vmid} --name {name}" + (" --full 1" if full else ""), timeout=3600)


def zero_touch_script(b) -> str:
    """One `qm create` with the cloud image imported as scsi0, a cloud-init drive and the guest agent vendor-data."""
    net = f"virtio,bridge={b.bridge}" + (f",tag={b.vlan_tag}" if b.vlan_tag else "")
    ip = "ip=dhcp" if b.network == "dhcp" else f"ip={b.network.cidr},gw={b.network.gateway}"
    snippet = f"{settings.system_prefix}-agent.yaml"
    cmds = [
        "set -e",
        f"IMG=$(pvesm path {shlex.quote(b.image_volume)})",
        f"qm create {b.vmid} --name {b.name} --cores {b.cores} --memory {b.memory} --cpu host --ostype l26 "
        f"--net0 {net} --scsihw virtio-scsi-single --scsi0 {b.storage}:0,import-from=$IMG,discard=on "
        f"--ide2 {b.storage}:cloudinit --boot order=scsi0 --serial0 socket --agent enabled=1 --tags {GUEST_TAG}",
        "echo '@@stage zerotouch 2@@'",
        f"qm resize {b.vmid} scsi0 {b.disk_gb}G",
        f"qm set {b.vmid} --ciuser {b.admin_user} --ipconfig0 {ip}"
        + (f" --nameserver '{' '.join(b.network.dns)}'" if b.network != "dhcp" else ""),
    ]
    if b.password:
        cmds.append(f"qm set {b.vmid} --cipassword {shlex.quote(b.password)}")
    if b.ssh_keys:
        cmds.append(f"printf '%s\\n' {' '.join(shlex.quote(k) for k in b.ssh_keys)} > /tmp/sd-keys-{b.vmid} && "
                    f"qm set {b.vmid} --sshkeys /tmp/sd-keys-{b.vmid}; rm -f /tmp/sd-keys-{b.vmid}")
    if b.guest_agent:
        cmds += [
            # The guest agent is a package: install it from a vendor-data snippet (needs "snippets" on the local storage).
            "c=$(pvesh get /storage/local --output-format json | python3 -c 'import json,sys;print(json.load(sys.stdin).get(\"content\",\"\"))')",
            "case \",$c,\" in *,snippets,*) ;; *) pvesm set local --content \"$c,snippets\" ;; esac",
            f"mkdir -p /var/lib/vz/snippets && printf '#cloud-config\\npackages: [qemu-guest-agent]\\nruncmd:\\n  - [systemctl, enable, --now, qemu-guest-agent]\\n' > /var/lib/vz/snippets/{snippet}",
            f"qm set {b.vmid} --cicustom vendor=local:snippets/{snippet}",
        ]
    return "\n".join(cmds) + "\n"


async def zero_touch(b, job: dict, user_data: str, network_config: str) -> None:
    def on_line(line: str) -> None:  # the script marks the cloud-init stage
        if "@@stage" in line:
            job["stage"] = 2
        else:
            job["logs"].append(line)

    await host_ssh.run("bash -s", input=zero_touch_script(b), timeout=1800, on_line=on_line)
