"""Image & Template Hub: curated, checksum-verified OS images, Zero-Touch VM provisioning and golden templates.

Catalog entries (data/image_catalog.json) point at a release directory and its checksum file; the newest file matching
the entry's pattern is picked from that checksum file, so point releases never break a link, and the hypervisor's
storage download verifies the checksum.

Zero-Touch provisioning boots a cloud image as the VM's disk with an injected cloud-init seed: host name, admin user,
password and/or SSH keys, DHCP or a static address, and the QEMU guest agent.
  - Proxmox VE: `qm create … --scsi0 <storage>:0,import-from=<image>` plus its cloud-init drive; the guest agent comes
    from a vendor-data snippet on the "local" storage.
  - SolarOS: the driver's VM creation with a cloud-init seed, then the image is written onto the new disk and the seed
    is regenerated with the network config and guest agent.
"""
import asyncio
import ipaddress
import json
import re
import shlex
from pathlib import Path as FsPath
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator, model_validator

from . import platform_modules as pm, task_progress
from .auth import require_user
from .config import settings
from .provisioning import BRIDGE_RE, FILENAME_RE, GUEST_TAG, STORAGE_RE
from providers.registry import get_provider

MODULE = "image_hub"
router = APIRouter(tags=["image_hub"], dependencies=[Depends(require_user)])
gated = [Depends(pm.require_module(MODULE))]
DATA = FsPath(__file__).resolve().parent.parent / "data"
CATALOG: list[dict] = json.loads((DATA / "image_catalog.json").read_text())
TEMPLATES = DATA / "golden_templates.json"
IMG_VOLID_RE = r"^[a-z][a-z0-9_.-]*:iso/[A-Za-z0-9][A-Za-z0-9_.+-]{0,200}\.img$"


# ---------------------------------------------------------------- Catalog (pure parsing, tests/test_core_modules.py)


def parse_sums(text: str) -> dict[str, str]:
    """GNU (`<hash>  [*]<file>`) and BSD (`SHA256 (<file>) = <hash>`) checksum files -> {file: hash}."""
    out = {}
    for line in text.splitlines():
        if m := re.match(r"^([0-9a-fA-F]{32,128})\s+\*?(\S+)$", line.strip()):
            out[m.group(2).lstrip("./")] = m.group(1).lower()
        elif m := re.match(r"^SHA\d+ \((.+)\) = ([0-9a-fA-F]{32,128})$", line.strip()):
            out[m.group(1)] = m.group(2).lower()
    return out


def pick(sums: dict[str, str], pattern: str) -> tuple[str, str] | None:
    """Newest file (natural sort) matching the pattern, with its checksum."""
    hits = [f for f in sums if re.fullmatch(pattern, f)]
    key = lambda s: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)]  # noqa: E731
    return (f := max(hits, key=key), sums[f]) if hits else None


async def resolve(entry: dict) -> dict:
    if entry.get("fixed"):
        return {"url": entry["base_url"] + entry["fixed"], "filename": entry["fixed"], "checksum": None, "algorithm": None}
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as c:
        r = await c.get(entry["base_url"] + entry["sums"])
    if r.status_code != 200:
        raise HTTPException(502, f"Could not read the checksum list of {entry['name']} ({r.status_code})")
    hit = pick(parse_sums(r.text), entry["pattern"])
    if not hit:
        raise HTTPException(502, f"No current file for {entry['name']} in its checksum list")
    return {"url": entry["base_url"] + hit[0], "filename": entry.get("save_as") or hit[0], "checksum": hit[1],
            "algorithm": entry["algorithm"]}


class DownloadBody(BaseModel):
    image_id: str = Field(pattern=r"^[a-z0-9-]{1,40}$")
    storage: str = Field(pattern=STORAGE_RE)


@router.get("/api/images/catalog")
async def catalog():
    return {"module": pm.profile(MODULE), "images": CATALOG}


@router.post("/api/images/download", dependencies=gated)
async def download(body: DownloadBody):
    entry = next((e for e in CATALOG if e["id"] == body.image_id), None)
    if not entry:
        raise HTTPException(404, "Unknown image")
    r = await resolve(entry)
    if not re.fullmatch(FILENAME_RE, r["filename"]):
        raise HTTPException(422, f"{r['filename']} cannot be stored as an ISO / disk image")
    spec = {"url": r["url"], "content": "iso", "filename": r["filename"], "verify_certificates": True}
    if r["checksum"]:
        spec |= {"checksum": r["checksum"], "checksum_algorithm": r["algorithm"]}
    task = await get_provider().download_url_to_storage(body.storage, spec)
    return {"task": task.task, "filename": r["filename"], "url": r["url"], "checksum": r["checksum"],
            "volid": f"{body.storage}:iso/{r['filename']}"}


# ---------------------------------------------------------------- Zero-Touch provisioning


class StaticNet(BaseModel):
    cidr: str
    gateway: str
    dns: list[str] = Field(["1.1.1.1"], max_length=3)

    @field_validator("cidr")
    @classmethod
    def _cidr(cls, v: str) -> str:
        if "/" not in v:
            raise ValueError("Use CIDR notation, e.g. 192.168.1.50/24")
        return str(ipaddress.IPv4Interface(v))

    @field_validator("gateway")
    @classmethod
    def _gw(cls, v: str) -> str:
        return str(ipaddress.IPv4Address(v))

    @field_validator("dns")
    @classmethod
    def _dns(cls, v: list[str]) -> list[str]:
        return [str(ipaddress.ip_address(x)) for x in v]


class ZeroTouchBody(BaseModel):
    image_volume: str = Field(pattern=IMG_VOLID_RE, max_length=300)
    vmid: int = Field(ge=100, le=999_999_999)
    name: str = Field(pattern=r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$")
    cores: int = Field(2, ge=1, le=128)
    memory: int = Field(2048, ge=256, le=1024 * 1024)
    disk_gb: int = Field(20, ge=4, le=65536)
    storage: str = Field(pattern=STORAGE_RE)
    bridge: str = Field(default_factory=lambda: settings.default_bridge, pattern=BRIDGE_RE)
    vlan_tag: int | None = Field(None, ge=1, le=4094)
    admin_user: str = Field("admin", pattern=r"^[a-z_][a-z0-9_-]{0,31}$")
    password: str | None = Field(None, min_length=8, max_length=128, pattern=r"^[^\r\n'\"\\]+$")
    ssh_keys: list[str] = Field([], max_length=20)
    network: Literal["dhcp"] | StaticNet = "dhcp"
    guest_agent: bool = True
    start: bool = True

    @field_validator("ssh_keys")
    @classmethod
    def _keys(cls, v: list[str]) -> list[str]:
        v = [k.strip() for k in v if k.strip()]
        if bad := next((k for k in v if not re.fullmatch(r"(ssh|ecdsa-sha2|sk-)[A-Za-z0-9@.-]+ [A-Za-z0-9+/=]+( [^\r\n]{0,200})?", k)), None):
            raise ValueError(f"Not an SSH public key: {bad[:30]}…")
        return v

    @model_validator(mode="after")
    def _login(self):
        if not self.password and not self.ssh_keys:
            raise ValueError("Set a password or at least one SSH key")
        return self


def user_data(b: ZeroTouchBody) -> str:
    lines = ["#cloud-config", f"hostname: {b.name}", "manage_etc_hosts: true", "users:", f"  - name: {b.admin_user}",
             "    groups: [sudo]", "    shell: /bin/bash", "    sudo: ALL=(ALL) NOPASSWD:ALL", f"    lock_passwd: {str(not b.password).lower()}"]
    if b.ssh_keys:
        lines += ["    ssh_authorized_keys:", *[f"      - {json.dumps(k)}" for k in b.ssh_keys]]
    if b.password:
        lines += ["chpasswd:", "  expire: false", "  users:", f"    - {{name: {b.admin_user}, password: {json.dumps(b.password)}, type: text}}",
                  "ssh_pwauth: true"]
    if b.guest_agent:
        lines += ["packages: [qemu-guest-agent]", "runcmd:", "  - [systemctl, enable, --now, qemu-guest-agent]"]
    return "\n".join(lines) + "\n"


def network_config(b: ZeroTouchBody) -> str:
    if b.network == "dhcp":
        return "version: 2\nethernets:\n  primary:\n    match: {name: \"e*\"}\n    dhcp4: true\n"
    n = b.network
    return ("version: 2\nethernets:\n  primary:\n    match: {name: \"e*\"}\n    dhcp4: false\n"
            f"    addresses: [{n.cidr}]\n    routes: [{{to: default, via: {n.gateway}}}]\n"
            f"    nameservers: {{addresses: [{', '.join(n.dns)}]}}\n")


def proxmox_script(b: ZeroTouchBody) -> str:
    net = f"virtio,bridge={b.bridge}" + (f",tag={b.vlan_tag}" if b.vlan_tag else "")
    ip = "ip=dhcp" if b.network == "dhcp" else f"ip={b.network.cidr},gw={b.network.gateway}"
    snippet = f"/var/lib/vz/snippets/{settings.system_prefix}-agent.yaml"
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
            f"mkdir -p /var/lib/vz/snippets && printf '#cloud-config\\npackages: [qemu-guest-agent]\\nruncmd:\\n  - [systemctl, enable, --now, qemu-guest-agent]\\n' > {snippet}",
            f"qm set {b.vmid} --cicustom vendor=local:snippets/{settings.system_prefix}-agent.yaml",
        ]
    return "\n".join(cmds) + "\n"


async def _wait_task(p, task: str | None) -> None:
    for _ in range(900):
        if not task:
            return
        s = await p.get_task_status(task)
        if not s["running"]:
            if s.get("state") not in ("ok", "done", "completed") and s.get("exitstatus") not in ("OK", "ok", 0, None):
                raise HTTPException(502, f"VM creation failed: {s.get('exitstatus')}")
            return
        await asyncio.sleep(2)


async def _zero_touch(b: ZeroTouchBody, job: dict) -> dict:
    from . import host_ssh
    p, log = get_provider(), job["logs"].append
    job["stage"] = 1
    if settings.hypervisor_driver == "proxmox":
        def on_line(line: str) -> None:  # the script marks the cloud-init stage
            if "@@stage" in line:
                job["stage"] = 2
            else:
                log(line)
        await host_ssh.run("bash -s", input=proxmox_script(b), timeout=1800, on_line=on_line)
    else:
        from providers.native_ubuntu import host as nhost
        from providers.native_ubuntu.provider import _volume_file
        image = _volume_file(b.image_volume)
        task = await p.create_vm({"vmid": b.vmid, "name": b.name, "cores": b.cores, "memory": b.memory, "storage": b.storage,
                                  "disk_gb": b.disk_gb, "bridge": b.bridge, "bios": "ovmf", "ostype": "l26",
                                  "cloudinit": {"user": b.admin_user, "password": b.password, "ssh_keys": b.ssh_keys}})
        await _wait_task(p, task.task)
        job["stage"] = 2
        disk = (await host_ssh.run(f"virsh domblklist {shlex.quote(b.name)} --details | awk '$2==\"disk\"{{print $4; exit}}'")).strip()
        fmt = "raw" if disk.startswith("/dev/") else "qcow2"
        log(f"Writing {image.name} onto {disk}")
        await host_ssh.run(f"qemu-img convert -O {fmt} {shlex.quote(str(image))} {shlex.quote(disk)} && "
                           + (f"qemu-img resize {shlex.quote(disk)} {b.disk_gb}G" if fmt == "qcow2" else "true"), timeout=3600)
        seed = nhost.IMAGES / f"vm-{b.vmid}-cloudinit.iso"
        d = f"/tmp/sd-zt-{b.vmid}"
        await host_ssh.run(f"mkdir -p {d} && cat > {d}/user-data", input=user_data(b))
        await host_ssh.run(f"cat > {d}/network-config", input=network_config(b))
        await host_ssh.run(f"printf 'instance-id: sd-{b.vmid}\\nlocal-hostname: {b.name}\\n' > {d}/meta-data && "
                           f"cloud-localds -N {d}/network-config {shlex.quote(str(seed))} {d}/user-data {d}/meta-data; rm -rf {d}")
        if b.vlan_tag:
            from . import network_switch as nsw
            await nsw.update_guest_vnic(nsw.GuestVnicBody(bridge=b.bridge, vlan_tag=b.vlan_tag), "vm", b.vmid, "net0")
    job["stage"] = 3
    if b.start:
        await p.guest_power_action("qemu", b.vmid, "start")
        log("VM started; cloud-init finishes the setup on first boot (about a minute)")
    return {"vmid": b.vmid, "name": b.name}


@router.post("/api/compute/zero-touch", dependencies=gated)
async def zero_touch(body: ZeroTouchBody):
    rows = await get_provider().guest_rows()
    if any(int(g["vmid"]) == body.vmid for g in rows):
        raise HTTPException(409, f"VMID {body.vmid} is in use")
    job = task_progress.start_job("zerotouch", body.name, lambda j: _zero_touch(body, j))
    return {"job_id": job["id"]}


# ---------------------------------------------------------------- Golden templates


def load_templates() -> list[dict]:
    try:
        return json.loads(TEMPLATES.read_text())
    except (OSError, ValueError):
        return []


class TemplateBody(BaseModel):
    vmid: int = Field(ge=100, le=999_999_999)
    name: str = Field(min_length=1, max_length=60, pattern=r"^[^\n\r<>]*$")
    notes: str = Field("", max_length=500, pattern=r"^[^<>]*$")


class CloneBody(BaseModel):
    new_vmid: int = Field(ge=100, le=999_999_999)
    name: str = Field(pattern=r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$")
    full: bool = True


@router.get("/api/compute/templates")
async def list_templates():
    return {"module": pm.profile(MODULE), "templates": load_templates(), "clone_supported": settings.hypervisor_driver == "proxmox"}


@router.post("/api/compute/templates", dependencies=gated)
async def create_template(body: TemplateBody):
    """Turn a configured, shut-down VM into a golden template (on Proxmox VE this is `qm template`, a one-way step)."""
    from . import host_ssh
    if settings.hypervisor_driver == "proxmox":
        await host_ssh.run(f"qm template {body.vmid}", timeout=300)
    items = [t for t in load_templates() if t["vmid"] != body.vmid] + [body.model_dump()]
    TEMPLATES.write_text(json.dumps(items, indent=1))
    return {"ok": True, "templates": items}


@router.post("/api/compute/templates/{vmid}/clone", dependencies=gated)
async def clone_template(body: CloneBody, vmid: int = Path(ge=100)):
    from . import host_ssh
    if settings.hypervisor_driver != "proxmox":
        raise HTTPException(501, "Cloning templates is not available with this hypervisor driver yet; use Zero-Touch Create")
    await host_ssh.run(f"qm clone {vmid} {body.new_vmid} --name {body.name}" + (" --full 1" if body.full else ""), timeout=3600)
    return {"ok": True, "vmid": body.new_vmid}


@router.delete("/api/compute/templates/{vmid}", dependencies=gated)
async def forget_template(vmid: int = Path(ge=100)):
    """Remove the template from the hub list (the template VM itself stays; delete it in Compute)."""
    items = [t for t in load_templates() if t["vmid"] != vmid]
    TEMPLATES.write_text(json.dumps(items, indent=1))
    return {"ok": True}
