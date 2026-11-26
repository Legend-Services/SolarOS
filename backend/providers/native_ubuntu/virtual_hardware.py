"""Virtual Hardware & Lab Forge on SolarOS (contract: app.virtual_hardware).

VM devices are libvirt domain elements tagged with the user alias "ua-vhw-<device id>" (NVMe, which libvirt has no
element for here, is a <qemu:commandline> pair carrying "vhw<device id>"); changes go into the persistent definition
and apply at the next start. Container devices are Incus unix-char devices named "vhw-<device id>-<n>".
"""
import re
import shlex
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path as FsPath

from fastapi import HTTPException

from app.guest_hardware import NetBody

from . import host
from .guest_edit import _xml, delete_net, set_net, vm_devices
from .host import run, run_json

QEMU_NS = "http://libvirt.org/schemas/domain/qemu/1.0"
ET.register_namespace("qemu", QEMU_NS)
SCSI_MODELS = {"lsi53c895a": "lsilogic", "mptsas1068": "lsisas1068", "megasas": "lsisas1078"}
APPARMOR_LOCAL = "/etc/apparmor.d/local/abstractions/libvirt-qemu"


def IMAGE_DIR(vmid: int) -> str:
    return str(host.IMAGES)


# ---------------------------------------------------------------- Pure helpers: domain XML (unit tested)


def _alias(dev_id: str) -> str:
    return f"ua-vhw-{dev_id}"


def device_element(dev: dict, xml: str, extra: dict | None = None) -> ET.Element:
    t, o, extra = dev["type"], dev["options"], extra or {}
    devs = ET.fromstring(xml).find("devices")
    if t == "hd_audio":
        el = ET.Element("sound", model="ich9")
        ET.SubElement(el, "codec", type="duplex")
    elif t == "legacy_audio":
        el = ET.Element("sound", model=o["model"])
    elif t in ("sas_hba", "smartcard"):
        ctype = "scsi" if t == "sas_hba" else "ccid"
        used = {int(c.get("index", 0)) for c in devs.findall("controller") if c.get("type") == ctype}
        el = ET.Element("controller", type=ctype, index=str(next(i for i in range(64) if i not in used)))
        if t == "sas_hba":
            el.set("model", SCSI_MODELS[o["model"]])
    elif t == "vtpm":
        el = ET.Element("tpm", model="tpm-tis")
        ET.SubElement(el, "backend", type="emulator", version="2.0")
    elif t == "watchdog":
        el = ET.Element("watchdog", model="i6300esb", action=o["action"])
    elif t == "virtio_rng":
        el = ET.Element("rng", model="virtio")
        ET.SubElement(el, "backend", model="random").text = "/dev/urandom"
    elif t == "hayes_modem":
        el = ET.Element("serial", type="unix")
        ET.SubElement(el, "source", mode="bind", path=extra["socket"])
        ET.SubElement(el, "target", port=str(len(devs.findall("serial"))))
    else:
        raise HTTPException(422, f"{t} is not a domain device")
    ET.SubElement(el, "alias", name=_alias(dev["id"]))
    return el


def add_element(xml: str, el: ET.Element) -> str:
    d = ET.fromstring(xml)
    d.find("devices").append(el)
    return ET.tostring(d, encoding="unicode")


def add_qemu_args(xml: str, args: list[str]) -> str:
    d = ET.fromstring(xml)
    cl = d.find(f"{{{QEMU_NS}}}commandline")
    if cl is None:
        cl = ET.SubElement(d, f"{{{QEMU_NS}}}commandline")
    for a in args:
        ET.SubElement(cl, f"{{{QEMU_NS}}}arg", value=a)
    return ET.tostring(d, encoding="unicode")


def remove_device(xml: str, dev_id: str) -> str:
    """Domain XML without the elements aliased ua-vhw-<id> and the emulator argument pairs that mention vhw<id>."""
    d = ET.fromstring(xml)
    devs = d.find("devices")
    for el in list(devs):
        a = el.find("alias")
        if a is not None and a.get("name") == _alias(dev_id):
            devs.remove(el)
    cl = d.find(f"{{{QEMU_NS}}}commandline")
    if cl is not None:
        args = list(cl)
        keep = []
        for i in range(0, len(args), 2):
            pair = args[i:i + 2]
            if not any(f"vhw{dev_id}" in (x.get("value") or "") for x in pair):
                keep += pair
        for x in args:
            cl.remove(x)
        cl.extend(keep)
        if not keep:
            d.remove(cl)
    return ET.tostring(d, encoding="unicode")


def set_cpu_xml(xml: str, percent: int, model: str | None) -> str:
    """CPU bandwidth limit (per vCPU, 100 ms period) and, when given, the CPU model."""
    d = ET.fromstring(xml)
    tune = d.find("cputune")
    if tune is None:
        tune = ET.SubElement(d, "cputune")
    for k in ("period", "quota"):
        for el in tune.findall(k):
            tune.remove(el)
    if percent < 100:
        ET.SubElement(tune, "period").text = "100000"
        ET.SubElement(tune, "quota").text = str(percent * 1000)
    if not len(tune):
        d.remove(tune)
    if model:
        old = d.find("cpu")
        pos = list(d).index(old) if old is not None else len(d)
        topo = old.find("topology") if old is not None else None
        if old is not None:
            d.remove(old)
        cpu = ET.Element("cpu", mode="host-passthrough", check="none") if model == "host" else \
            ET.Element("cpu", mode="custom", match="exact", check="none")
        if model != "host":
            ET.SubElement(cpu, "model", fallback="forbid").text = model
        if topo is not None:
            cpu.append(topo)
        d.insert(pos, cpu)
    return ET.tostring(d, encoding="unicode")


def parse_domiflist(out: str) -> dict[str, str]:
    rows = [ln.split() for ln in out.splitlines() if ln.strip() and not ln.lstrip().startswith(("Interface", "---"))]
    return {f"net{i}": r[0] for i, r in enumerate(rows) if r and r[0] != "-"}


# ---------------------------------------------------------------- Contract


async def attach(kind: str, vmid: int, dev: dict) -> dict:
    t, o = dev["type"], dev["options"]
    name = host.name_of(vmid, kind)
    if kind == "lxc":
        paths = dev["state"]["snd"] if t == "hd_audio" else [f"/dev/video{dev['state']['video_nr']}"]
        keys = []
        try:
            for n, p in enumerate(paths):
                k = f"vhw-{dev['id']}-{n}"
                await run("incus", "config", "device", "add", name, k, "unix-char", f"source={p}", f"path={p}", "mode=0666")
                keys.append(k)
        except HTTPException:
            for k in keys:
                await run("incus", "config", "device", "remove", name, k, check=False)
            raise
        return {"keys": keys}
    xml = await _xml(name)
    if t == "legacy_nic":
        idx = len(vm_devices(xml)["net"])
        await set_net("qemu", vmid, NetBody(bridge=o["bridge"], model=o["model"], firewall=False), idx)
        mac = vm_devices(await _xml(name))["net"][idx]["macaddr"]
        return {"mac": mac}
    if t == "vtpm" and not shutil.which("swtpm"):
        raise HTTPException(409, "The virtual TPM needs swtpm on the host: install it with apt install swtpm swtpm-tools")
    if t == "virtual_nvme":
        img = f"{IMAGE_DIR(vmid)}/vhw-{int(vmid)}-{dev['id']}.raw"
        if not FsPath(img).exists():
            await run("truncate", "-s", f"{int(o['size_gb'])}G", img)
        await run("chown", "libvirt-qemu:kvm", img, check=False)
        rule = f"  \"{IMAGE_DIR(vmid)}/vhw-*.raw\" rwk,\n"  # emulator arguments are not covered by libvirt's own labeling
        p = FsPath(APPARMOR_LOCAL)
        if p.parent.is_dir() and rule not in (p.read_text() if p.exists() else ""):
            with p.open("a") as f:
                f.write(rule)
        tag = f"vhw{dev['id']}"
        await host.define(add_qemu_args(xml, ["-drive", f"file={img},if=none,id={tag}d,format=raw",
                                              "-device", f"nvme,drive={tag}d,serial={o['serial']},id={tag}"]))
        return {"image": img}
    extra = {}
    if t == "hayes_modem":
        extra["socket"] = f"/var/lib/libvirt/qemu/vhw-modem-{int(vmid)}-{dev['id']}.sock"
    await host.define(add_element(xml, device_element(dev, xml, extra)))
    return extra


async def detach(kind: str, vmid: int, dev: dict) -> None:
    name = host.name_of(vmid, kind)
    st = dev.get("state") or {}
    if kind == "lxc":
        for k in st.get("keys", []):
            await run("incus", "config", "device", "remove", name, k, check=False)
        return
    if st.get("mac"):
        idx = next((n["index"] for n in vm_devices(await _xml(name))["net"] if n["macaddr"] == st["mac"]), None)
        if idx is not None:
            await delete_net("qemu", vmid, idx)
        return
    await host.define(remove_device(await _xml(name), dev["id"]))


async def set_cpu(kind: str, vmid: int, percent: int, model: str | None) -> None:
    name = host.name_of(vmid, kind)
    if kind == "lxc":
        if percent < 100:
            await run("incus", "config", "set", name, f"limits.cpu.allowance={percent}%")
        else:
            await run("incus", "config", "unset", name, "limits.cpu.allowance", check=False)
        return
    await host.define(set_cpu_xml(await _xml(name), percent, model))
    # The limit also applies to a running VM right away; the CPU model at its next start.
    await run("virsh", "schedinfo", name, "--live", "--set", f"vcpu_quota={percent * 1000 if percent < 100 else -1}",
              check=False)


async def host_ifaces(kind: str, vmid: int) -> dict[str, str]:
    name = host.name_of(vmid, kind)
    if kind == "qemu":
        return parse_domiflist(await run("virsh", "domiflist", name, check=False))
    state = await run_json("incus", "query", f"/1.0/instances/{name}/state") or {}
    out = {}
    for nic, info in (state.get("network") or {}).items():
        m = re.fullmatch(r"eth(\d)", nic)
        if m and (info or {}).get("host_name"):
            out[f"net{m.group(1)}"] = info["host_name"]
    return out


def screenshot_cmd(vmid: int) -> str:
    """Bash that prints one PPM frame of the VM's display."""
    name = shlex.quote(host.name_of(vmid, "qemu"))
    return f"f=$(mktemp --suffix .ppm); virsh screenshot {name} $f >/dev/null 2>&1 && [ -s $f ] && cat $f; r=$?; rm -f $f; exit $r"
