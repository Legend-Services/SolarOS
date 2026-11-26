"""Virtual Hardware & Lab Forge on Proxmox VE (contract: app.virtual_hardware).

VM devices are native options where PVE has one (audio0, serialN socket, watchdog, rng0, tpmstate0, netN) and `args`
fragments otherwise (SB16, SAS/RAID HBAs, NVMe, USB CCID); every fragment carries the id "vhw<device id>", so it can be
cut out again without touching the rest of a hand-written `args`. Container devices are devN device nodes. CPU limits
use cpulimit (a share of the guest's vCPUs) and the `cpu` model. All writes go through qm / pct set over the SSH bridge.
"""
import re
import shlex

from fastapi import HTTPException

from app import host_ssh
from app.guest_hardware import NetBody, parse_props

from .api import _node, pve
from .routes.guest_hardware import delete_net, set_net
from .routes.provisioning import qm_set

DISK_RE = re.compile(r"^(scsi|virtio|sata|ide)\d+$")


def IMAGE_DIR(vmid: int) -> str:
    return f"/var/lib/vz/images/{int(vmid)}"


# ---------------------------------------------------------------- Pure helpers (unit tested)


def args_add(args: str, frag: str) -> str:
    return f"{args or ''} {frag}".strip()


def args_remove(args: str, tag: str) -> str:
    """`args` without the option groups (-flag value) that mention `tag`."""
    tokens, out, i = shlex.split(args or ""), [], 0
    while i < len(tokens):
        group = tokens[i:i + 2] if tokens[i].startswith("-") and i + 1 < len(tokens) and not tokens[i + 1].startswith("-") \
            else tokens[i:i + 1]
        i += len(group)
        if not any(tag in t for t in group):
            out += group
    return shlex.join(out)


def arg_fragment(dev: dict, image: str = "") -> str:
    t, o, tag = dev["type"], dev["options"], f"vhw{dev['id']}"
    if t == "legacy_audio":
        return f"-device sb16,id={tag}"
    if t == "sas_hba":
        return f"-device {o['model']},id={tag}"
    if t == "virtual_nvme":
        return f"-drive file={image},if=none,id={tag}d,format=raw -device nvme,drive={tag}d,serial={o['serial']},id={tag}"
    if t == "smartcard":
        return f"-device usb-ccid,id={tag}"
    raise HTTPException(422, f"{t} has no emulator arguments")


def boot_storage(cfg: dict) -> str | None:
    """Storage of the VM's first disk (where its TPM state goes), None for a VM without disks."""
    for k in sorted(cfg):
        vol = parse_props(cfg[k]).get("_", "") if DISK_RE.match(k) else ""
        if ":" in vol and "media=cdrom" not in str(cfg[k]) and "cloudinit" not in vol:
            return vol.split(":")[0]
    return None


def audio_driver(cfg: dict) -> str:
    """The host audio backend: SPICE needs a SPICE (qxl) display, otherwise the card has no host output."""
    return "spice" if str(cfg.get("vga", "")).startswith("qxl") else "none"


async def image_storage(cfg: dict) -> str:
    if s := boot_storage(cfg):
        return s
    out = await host_ssh.run("pvesm status --content images --enabled 2>/dev/null | awk 'NR>1{print $1}'", check=False)
    names = out.split()
    if not names:
        raise HTTPException(409, "No storage for VM disks is available for the TPM state")
    return next((n for n in ("local-lvm", "local-zfs") if n in names), names[0])


# ---------------------------------------------------------------- Contract


async def _cfg(kind: str, vmid: int) -> dict:
    return await pve("GET", _node(f"/{kind}/{vmid}/config")) or {}


async def pct_set(vmid: int, opts: dict[str, str]) -> None:
    args = [x for k, v in opts.items() for x in (f"-{k}", v)]
    await host_ssh.run(shlex.join(["pct", "set", str(int(vmid)), *args]))


def _free(cfg: dict, prefix: str, n: int) -> int:
    i = next((i for i in range(n) if f"{prefix}{i}" not in cfg), None)
    if i is None:
        raise HTTPException(409, f"All {prefix}0-{n - 1} slots of this guest are in use")
    return i


async def attach(kind: str, vmid: int, dev: dict) -> dict:
    t, o = dev["type"], dev["options"]
    cfg = await _cfg(kind, vmid)
    if kind == "lxc":
        paths = dev["state"]["snd"] if t == "hd_audio" else [f"/dev/video{dev['state']['video_nr']}"]
        used = {int(k[3:]) for k in cfg if re.fullmatch(r"dev\d+", k)}
        free = [i for i in range(256) if i not in used][:len(paths)]
        await pct_set(vmid, {f"dev{i}": f"{p},mode=0666" for i, p in zip(free, paths)})
        return {"keys": [f"dev{i}" for i in free]}
    native = {"hd_audio": ("audio0", f"device=ich9-intel-hda,driver={audio_driver(cfg)}"),
              "watchdog": ("watchdog", f"model=i6300esb,action={o.get('action')}"),
              "virtio_rng": ("rng0", "source=/dev/urandom")}
    if t == "vtpm":
        native[t] = ("tpmstate0", f"{await image_storage(cfg)}:1,version=v2.0")
    if t == "legacy_audio" and o["model"] == "ac97":
        native[t] = ("audio0", f"device=AC97,driver={audio_driver(cfg)}")
    if t in native:
        key, val = native[t]
        if key in cfg:
            raise HTTPException(409, f"This VM already has {key}: remove it first")
        await qm_set(vmid, {key: val})
        return {"keys": [key]}
    if t == "hayes_modem":
        n = _free(cfg, "serial", 4)
        await qm_set(vmid, {f"serial{n}": "socket"})
        return {"keys": [f"serial{n}"], "socket": f"/var/run/qemu-server/{int(vmid)}.serial{n}", "com": n + 1}
    if t == "legacy_nic":
        idx = _free(cfg, "net", 8)
        await set_net("qemu", vmid, NetBody(bridge=o["bridge"], model=o["model"], firewall=False), idx)
        return {"net": f"net{idx}"}
    if t == "legacy_audio" and "q35" in str(cfg.get("machine", "")):
        raise HTTPException(409, "The SB16 card is an ISA device: it needs the i440fx machine type (or pick AC97)")
    state: dict = {"args": f"vhw{dev['id']}"}
    if t == "virtual_nvme":
        state["image"] = f"{IMAGE_DIR(vmid)}/vhw-{dev['id']}.raw"
        img = shlex.quote(state["image"])
        await host_ssh.run(f"mkdir -p {IMAGE_DIR(vmid)} && [ -e {img} ] || truncate -s {int(o['size_gb'])}G {img}")
    await qm_set(vmid, {"args": args_add(cfg.get("args", ""), arg_fragment(dev, state.get("image", "")))})
    return state


async def detach(kind: str, vmid: int, dev: dict) -> None:
    st = dev.get("state") or {}
    if st.get("net"):
        await delete_net(kind, vmid, int(st["net"][3:]))
    if st.get("keys"):
        cfg = await _cfg(kind, vmid)
        keys = [k for k in st["keys"] if k in cfg]
        if keys:
            await (qm_set if kind == "qemu" else pct_set)(vmid, {"delete": ",".join(keys)})
    if st.get("args"):
        cfg = await _cfg(kind, vmid)
        rest = args_remove(cfg.get("args", ""), st["args"])
        if rest != cfg.get("args", ""):
            await qm_set(vmid, {"args": rest} if rest else {"delete": "args"})


async def set_cpu(kind: str, vmid: int, percent: int, model: str | None) -> None:
    cfg = await _cfg(kind, vmid)
    if kind == "qemu":
        cores = int(cfg.get("cores") or 1) * int(cfg.get("sockets") or 1)
    else:
        cores = int(cfg.get("cores") or 0) or int((await host_ssh.run("nproc")).strip() or 1)
    opts: dict[str, str] = {}
    if percent < 100:
        opts["cpulimit"] = f"{max(cores * percent / 100, 0.01):.2f}"
    elif "cpulimit" in cfg:
        opts["delete"] = "cpulimit"
    if model and kind == "qemu":
        opts["cpu"] = model
    if opts:
        await (qm_set if kind == "qemu" else pct_set)(vmid, opts)


async def host_ifaces(kind: str, vmid: int) -> dict[str, str]:
    cfg = await _cfg(kind, vmid)
    pre = "tap" if kind == "qemu" else "veth"
    return {k: f"{pre}{int(vmid)}i{k[3:]}" for k in cfg if re.fullmatch(r"net\d+", k)}


def screenshot_cmd(vmid: int) -> str:
    """Bash that prints one PPM frame of the VM's display."""
    return (f"f=$(mktemp --suffix .ppm); echo \"screendump $f\" | qm monitor {int(vmid)} >/dev/null 2>&1; "
            "[ -s $f ] && cat $f; r=$?; rm -f $f; exit $r")
