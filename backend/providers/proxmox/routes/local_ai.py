"""Proxmox side of Solar AI Studio: the GPU-enabled Ollama LXC, prepared with pct and the root SSH bridge.

Root-only host steps (NVIDIA device bind mounts + cgroup rules in /etc/pve/lxc/<id>.conf, /dev/dri, model storage
bind mount) run before the App Center starts the container (before_start) and when the compute target or the
model folder changes.
"""
import re
import shlex

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import host_ssh
from app.apps import DeployBody
from app.auth import require_user
from app.hardware_admin import split_sections
from app.local_ai import (DATA, HOST_MODELS, MODELS_DIR, NV_EXTRA_DEVS, NV_Q, LocalAiDeployBody, SwitchBody, _env_script,
                          _exec, _installed, _ip, _pending, load_state, ollama_env, parse_majors, parse_nv_list,
                          save_state)

from ..api import _node, _safe, pve
from .apps import deploy
from .tasks import wait_task

router = APIRouter(prefix="/api/ai", tags=["local_ai"], dependencies=[Depends(require_user)])


def nvidia_lxc_lines(index: int, nv_major: int, uvm_major: int) -> list[str]:
    devs = [f"nvidia{index}", *NV_EXTRA_DEVS]
    return [f"lxc.cgroup2.devices.allow: c {nv_major}:* rwm", f"lxc.cgroup2.devices.allow: c {uvm_major}:* rwm",
            *(f"lxc.mount.entry: /dev/{d} dev/{d} none bind,optional,create=file" for d in devs)]


def set_gpu_lines(conf: str, add: list[str], majors: set[int]) -> str:
    """Replace the NVIDIA lxc.* lines in the main section of a /etc/pve/lxc/<id>.conf (snapshot sections untouched)."""
    main, sep, snaps = conf.partition("\n[")
    keep = [x for x in main.splitlines() if not (x.startswith("lxc.mount.entry: /dev/nvidia") or any(
        x.startswith(f"lxc.cgroup2.devices.allow: c {m}:") for m in majors))]
    out = "\n".join([*keep, *add]) + "\n"
    return out + ("\n[" + snaps if sep else "")


def dri_devs(conf: str) -> dict[int, str]:
    """devN entries of the main section that point at /dev/dri → {N: path}."""
    main = conf.partition("\n[")[0]
    return {int(m[1]): m[2] for m in re.finditer(r"^dev(\d+): (/dev/dri/[^,\s]+)", main, flags=re.M)}


# Loads the modules, creates every device node the container binds, and makes both survive a host reboot.
HOST_NV_PREP = f"""set -e
grep -q '^nvidia_uvm ' /proc/modules || modprobe nvidia_uvm
grep -q '^nvidia ' /proc/modules || modprobe nvidia
grep -q '^nvidia_modeset ' /proc/modules || modprobe nvidia_modeset || true
command -v nvidia-modprobe >/dev/null && nvidia-modprobe -u -c=0 || true
printf 'nvidia\\nnvidia_uvm\\nnvidia_modeset\\n' > /etc/modules-load.d/solardeck-nvidia.conf
cat > /etc/udev/rules.d/70-solardeck-nvidia.rules <<'EOF'
KERNEL=="nvidia", RUN+="/bin/sh -c '/usr/bin/nvidia-smi -L >/dev/null'"
KERNEL=="nvidia_uvm", RUN+="/bin/sh -c '/usr/bin/nvidia-modprobe -c0 -u'"
EOF
echo @@nv@@; nvidia-smi --query-gpu={NV_Q} --format=csv,noheader,nounits
echo @@maj@@; stat -c '%n %t' /dev/nvidiactl /dev/nvidia-uvm
"""


def _conf(vmid: int) -> str:
    return f"/etc/pve/lxc/{int(vmid)}.conf"


async def _pct(vmid: int, *args: str) -> str:
    return await host_ssh.run(shlex.join(["pct", "set", str(int(vmid)), *args]))


async def attach_compute(vmid: int, target: str, log) -> dict:
    """Map exactly the devices `target` needs into the stopped container. Returns GPU facts for the state file."""
    info: dict = {"vram_mb": None, "gpu_name": None, "gpu_pci": None, "driver_version": None}
    majors = set(load_state().get("nv_majors", [])) | {195}
    add: list[str] = []
    if target.startswith("nvidia:"):
        log("==> Preparing the NVIDIA host driver (nvidia, nvidia_uvm, device nodes)")
        try:
            out = await host_ssh.run(HOST_NV_PREP, timeout=90)
        except HTTPException as e:
            raise HTTPException(409, f"NVIDIA host driver is not ready ({e.detail}). Use Prepare Host Driver in the "
                                     "hardware picker or Control Panel → Hardware & System → GPU & Drivers.")
        s = split_sections(out)
        maj = parse_majors(s.get("maj", ""))
        key = target.split(":", 1)[1]
        g = next((g for g in parse_nv_list(s.get("nv", "")) if str(g["index"]) == key or g["pci"] == key[-7:]), None)
        if not g or len(maj) < 2:
            raise HTTPException(409, f"NVIDIA GPU {key} is not visible to nvidia-smi on the host")
        nv, uvm = maj["/dev/nvidiactl"], maj["/dev/nvidia-uvm"]
        add, majors = nvidia_lxc_lines(g["index"], nv, uvm), majors | {nv, uvm}
        save_state(nv_majors=sorted(majors))
        info.update(vram_mb=g["vram_total_mb"], gpu_name=g["name"], gpu_pci=g["pci"], driver_version=g["driver_version"])
        log(f"==> Binding {g['name']} (/dev/nvidia{g['index']}, majors {nv}/{uvm}) into container {vmid}")
    conf = await host_ssh.run(f"cat {_conf(vmid)}")
    new = set_gpu_lines(conf, add, majors)
    if new != conf:
        await host_ssh.run(f"cat > {_conf(vmid)}", input=new)  # pmxcfs: write in place (no chmod/rename)
    want = target.split(":", 1)[1] if target.startswith(("intel:", "amd:")) else None
    cur = dri_devs(new)
    for idx, path in cur.items():
        if path != want:
            await _pct(vmid, "-delete", f"dev{idx}")
    if want and want not in cur.values():
        used = {int(m) for m in re.findall(r"^dev(\d+):", new.partition("\n[")[0], flags=re.M)}
        idx = next(i for i in range(256) if i not in used)
        log(f"==> Passing {want} into container {vmid}")
        await _pct(vmid, f"-dev{idx}", f"{want},mode=0666")
    return info


async def before_start(vmid: int, body: DeployBody, log) -> bytes:
    """App Center hook (container created, still stopped). Returns shell to run before local-ai.sh in the container."""
    if body.mount_storage:
        log(f"==> Mounting {HOST_MODELS} at {MODELS_DIR}")
        # A new folder is given to the container's root (uid 100000 on the host) so it can hand it to the ollama
        # user; an existing one (an earlier install) keeps its ownership.
        await host_ssh.run(f"[ -d {HOST_MODELS} ] || {{ mkdir -p {HOST_MODELS} && chown 100000:100000 {HOST_MODELS}; }}")
        await _pct(vmid, "-mp0", f"{HOST_MODELS},mp={MODELS_DIR}")
    info = await attach_compute(vmid, body.compute_target, log)
    _pending[vmid] = info
    env = {"SD_COMPUTE": body.compute_target, "SD_WEBUI": "1" if body.install_open_webui else "0"}
    pre = ""
    if info["driver_version"]:
        if not re.fullmatch(r"[0-9.]+", info["driver_version"]):
            raise HTTPException(502, f"Unexpected NVIDIA driver version {info['driver_version']!r}")
        env["SD_NVIDIA_VERSION"] = info["driver_version"]
        pre = (DATA / "apps/nvidia-userspace.sh").read_text()
    return ("".join(f"export {k}={shlex.quote(v)}\n" for k, v in env.items()) + pre + "\n").encode()


@router.post("/deploy")
async def deploy_ai(body: LocalAiDeployBody):
    return await deploy(DeployBody(app_id="local-ai", memory=body.memory_mb, **body.model_dump(exclude={"memory_mb"})))


@router.post("/hardware/switch")
async def switch(body: SwitchBody):
    s = _installed()
    vmid, log = s["vmid"], (lambda _m: None)
    patch: dict = {}
    if body.compute_target != s.get("compute_target"):
        await _stop(vmid)
        patch = await attach_compute(vmid, body.compute_target, log)
        await wait_task(await pve("POST", _node(f"/lxc/{vmid}/status/start")), 120)
        if patch["driver_version"]:  # first switch to the GPU of a container installed in CPU mode
            pre = f"export SD_NVIDIA_VERSION={patch['driver_version']}\n" + (DATA / "apps/_common.sh").read_text() + \
                  (DATA / "apps/nvidia-userspace.sh").read_text()
            await _exec(vmid, pre, timeout=1800)
        ip = await _ip(vmid) or s.get("ip")
        patch |= {"ip": ip, "ollama_url": f"http://{ip}:11434", "webui_url": f"http://{ip}:3000" if s.get("open_webui") else None}
    await _exec(vmid, _env_script(ollama_env(body.compute_target, body.flash_attention, body.kv_cache_q8)))
    return save_state(**patch, compute_target=body.compute_target, flash_attention=body.flash_attention,
                      kv_cache_q8=body.kv_cache_q8)


async def _stop(vmid: int) -> None:
    if (await _safe(_node(f"/lxc/{vmid}/status/current"), {}) or {}).get("status") == "running":
        await wait_task(await pve("POST", _node(f"/lxc/{vmid}/status/shutdown"), data={"timeout": 60, "forceStop": 1}), 120)


def storage_script(old: str | None, new: str, move: bool) -> str:
    """Host shell that prepares `new` for the container (and moves models from `old`). Paths are pre-validated."""
    o, n = shlex.quote(old or ""), shlex.quote(new)
    lines = ["set -e",
             # A new folder goes to the container's root (host uid 100000) so it can hand it to the ollama user.
             f"[ -d {n} ] || {{ mkdir -p {n} && chown 100000:100000 {n}; }}"]
    if move and old and old != new:
        lines.append(f"if [ -d {o} ]; then cp -a --reflink=auto {o}/. {n}/ && find {o} -mindepth 1 -delete; fi")
    lines.append(f"du -sb {n} | cut -f1")
    return "\n".join(lines) + "\n"


class StorageBody(BaseModel):
    # Only below /mnt or /srv (SolarDeck's storage areas), so a typo can never point Ollama at a system folder.
    path: str = Field(pattern=r"^/(mnt|srv)(/[A-Za-z0-9_][A-Za-z0-9._-]*)+$", max_length=200)
    move: bool = True


@router.post("/storage")
async def set_storage(body: StorageBody):
    """Bind another host folder at Ollama's models folder, optionally moving the downloaded models along."""
    s = _installed()
    vmid, old = s["vmid"], s.get("model_storage")
    if "/.." in body.path or body.path.rstrip("/") == (old or "").rstrip("/"):
        raise HTTPException(422, "Choose a different folder")
    await _stop(vmid)
    try:
        size = (await host_ssh.run(storage_script(old, body.path, body.move), timeout=3600)).strip().splitlines()[-1]
        await _pct(vmid, "-mp0", f"{body.path},mp={MODELS_DIR}")
    finally:  # never leave the AI container stopped, even when the move failed
        await wait_task(await pve("POST", _node(f"/lxc/{vmid}/status/start")), 120)
    await _exec(vmid, f"chown -R ollama:ollama {MODELS_DIR}\nsystemctl restart ollama\n")
    return save_state(model_storage=body.path) | {"models_bytes": int(size) if size.isdigit() else None}
