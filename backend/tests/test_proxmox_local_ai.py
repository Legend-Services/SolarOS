"""Local AI Studio on Proxmox: LXC config rewrite and model storage moves. Run: python -m tests.test_proxmox_local_ai"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from pydantic import ValidationError  # noqa: E402

from providers.proxmox.routes import local_ai as ai  # noqa: E402

# LXC config rewrite: idempotent, removes old GPU lines, never touches snapshot sections.
conf = "arch: amd64\ncores: 8\ndev0: /dev/dri/renderD128,mode=0666\nlxc.cgroup2.devices.allow: c 10:200 rwm\n" \
       "\n[before-upgrade]\narch: amd64\nlxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file\n"
lines = ai.nvidia_lxc_lines(0, 195, 505)
assert lines[:2] == ["lxc.cgroup2.devices.allow: c 195:* rwm", "lxc.cgroup2.devices.allow: c 505:* rwm"]
assert "lxc.mount.entry: /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file" in lines
on = ai.set_gpu_lines(conf, lines, {195, 505})
assert ai.set_gpu_lines(on, lines, {195, 505}) == on
main, snap = on.split("\n[", 1)
assert all(x in main for x in lines) and "c 10:200 rwm" in main and snap.endswith("create=file\n"), on
off = ai.set_gpu_lines(on, [], {195, 505})
assert "nvidia" not in off.split("\n[")[0] and "c 10:200 rwm" in off and off.count("/dev/nvidia0") == 1, off
assert ai.dri_devs(conf) == {0: "/dev/dri/renderD128"}

# Model storage location: only below /mnt or /srv, no traversal or shell characters.
for ok in ("/mnt/storage/ai-models", "/srv/models", "/mnt/tank/ai_models.v2"):
    ai.StorageBody(path=ok)
for bad in ("/etc", "/", "/mnt", "/mnt/../etc", "/mnt/a/..", "/mnt/x;rm -rf /", "/mnt/a b", "/root/models", "mnt/x", "/mnt/.hidden"):
    try:
        ai.StorageBody(path=bad)
        raise AssertionError(f"storage path accepted: {bad}")
    except ValidationError:
        pass
mv = ai.storage_script("/mnt/storage/ai-models", "/mnt/tank/models", True)
assert "cp -a --reflink=auto /mnt/storage/ai-models/. /mnt/tank/models/" in mv and "chown 100000:100000 /mnt/tank/models" in mv
assert "cp -a" not in ai.storage_script("/mnt/a", "/mnt/b", False) and "cp -a" not in ai.storage_script(None, "/mnt/b", True)

print("proxmox local ai: ok")
