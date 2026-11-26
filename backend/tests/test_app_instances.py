"""App instance registry & uninstaller self-check. Run: python -m tests.test_app_instances (from backend/)."""
import asyncio
import os
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp())
os.environ.update(STORAGE_ROOT=str(_tmp), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

import providers.registry as preg  # noqa: E402
from app import apps, local_ai, task_progress as tp  # noqa: E402
from providers.base import TaskInfo  # noqa: E402

apps.REGISTRY = _tmp / "installed_apps.json"
local_ai.STATE_FILE = _tmp / "local_ai.json"

# Names: label -> display suffix + RFC 1123 host name.
assert apps.hostname_for("docker-portainer", "Dev") == "docker-portainer-dev"
assert apps.hostname_for("jellyfin", "  Café / Staging #2 ") == "jellyfin-cafe-staging-2"
assert apps.hostname_for("samba", "!!!") == "samba" and len(apps.hostname_for("immich", "x" * 80)) <= 63
assert apps.display_name("docker-portainer", "Dev") == "Docker & Portainer CE — Dev"
b = apps.DeployBody(app_id="docker-portainer", instance_label=" Dev\n\tbox ", cores=1, memory=512, disk_gb=4)
assert b.instance_label == "Dev box" and b.hostname == "docker-portainer-dev-box", b
assert apps.DeployBody(app_id="samba", hostname="nas", cores=1, memory=512, disk_gb=4).hostname == "nas"


class Fake:
    def __init__(self, rows):
        self.rows, self.calls, self.reachable = rows, [], True

    async def guest_rows(self):
        return self.rows

    async def list_guests(self):
        if not self.reachable:
            raise RuntimeError("hypervisor unreachable")
        return []

    async def container_ip(self, vmid):
        return f"10.0.0.{vmid}"

    async def container_status(self, vmid):
        return next((r["status"] for r in self.rows if r["vmid"] == vmid), None)

    async def guest_power_action(self, kind, vmid, action):
        self.calls.append(action)
        return TaskInfo(task=f"t-{action}")

    async def delete_guest(self, kind, vmid, purge=True):
        self.calls.append("delete")
        self.rows = [r for r in self.rows if r["vmid"] != vmid]
        return TaskInfo(task="t-delete")

    async def get_task_status(self, task):
        return {"running": False, "state": "ok", "exitstatus": "OK"}


tag = f"{apps.TAG};pos-docker-portainer"
fake = Fake([{"vmid": 101, "name": "docker-portainer", "type": "lxc", "status": "running", "tags": tag, "cpus": 2,
              "maxmem": 2 << 30},
             {"vmid": 102, "name": "docker-portainer-dev", "type": "lxc", "status": "stopped", "tags": tag},
             {"vmid": 200, "name": "web", "type": "lxc", "status": "running", "tags": "other"}])
preg.get_provider = lambda: fake


async def main():
    # A fresh install record plus a stale one (container deleted outside SolarDeck); 101 is a legacy install.
    apps.register_instance(102, apps.DeployBody(app_id="docker-portainer", instance_label="Dev", cores=1, memory=512, disk_gb=4))
    apps.save_registry({**apps.load_registry(), "jellyfin-150": apps._record(150, "jellyfin", "")})
    live = await apps.reconcile()
    assert [r["instance_id"] for r in live] == ["docker-portainer-101", "docker-portainer-102"], live
    legacy, dev = live
    assert legacy["instance_label"] == "" and legacy["ip_address"] == "10.0.0.101" and legacy["cores"] == 2
    assert legacy["memory_mb"] == 2048 and legacy["web_url"] == "https://10.0.0.101:9443", legacy
    assert dev["display_name"] == "Docker & Portainer CE — Dev" and dev["ip_address"] is None and dev["status"] == "stopped"
    assert set(apps.load_registry()) == {"docker-portainer-101", "docker-portainer-102"}

    # Unreachable hypervisor: guest_rows is [] but nothing is pruned.
    saved, fake.rows, fake.reachable = fake.rows, [], False
    try:
        await apps.reconcile()
        raise AssertionError("expected an error")
    except RuntimeError:
        pass
    assert len(apps.load_registry()) == 2
    fake.rows, fake.reachable = saved, True

    # Uninstall the running one, keeping data; the Task Center sees each stage.
    data = apps.data_dir("docker-portainer-101")
    data.mkdir(parents=True)
    local_ai.save_state(vmid=999)
    r = await apps.uninstall("docker-portainer-101", delete_data=False)
    assert r["job_id"] == "uninstall-101"
    for _ in range(50):
        await asyncio.sleep(0)
    v = await tp.resolve("uninstall-101")
    assert v["status"] == "completed" and v["progress_percent"] == 100 and v["stage_key"] == "uninstall.done", v
    assert fake.calls == ["stop", "delete"] and data.is_dir() and local_ai.load_state() == {"vmid": 999}
    assert set(apps.load_registry()) == {"docker-portainer-102"}
    assert any(j["job_id"] == "uninstall-101" for j in await tp.feed("uninstall"))

    # Stopped instance with delete_data: no stop call, data folder removed.
    fake.calls = []
    apps.data_dir("docker-portainer-102").mkdir(parents=True)
    await apps.uninstall("docker-portainer-102", delete_data=True)
    for _ in range(50):
        await asyncio.sleep(0)
    assert fake.calls == ["delete"] and not apps.data_dir("docker-portainer-102").exists()
    assert apps.load_registry() == {} and await apps.reconcile() == []

    # Failures land in the job, not as an unhandled task error.
    async def boom(*a, **k):
        raise RuntimeError("disk busy")
    fake.rows = [{"vmid": 103, "name": "x", "type": "lxc", "status": "stopped", "tags": tag}]
    fake.delete_guest = boom
    await apps.uninstall("docker-portainer-103")
    for _ in range(50):
        await asyncio.sleep(0)
    v = tp.from_uninstall(apps._removals[103])
    assert v["status"] == "failed" and v["error_message"] == "disk busy" and v["stage_key"] == "uninstall.remove", v


asyncio.run(main())
print("app instances: ok")
