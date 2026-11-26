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
assert apps.hostname_for("portainer", "Dev") == "portainer-dev"
assert apps.hostname_for("jellyfin", "  Café / Staging #2 ") == "jellyfin-cafe-staging-2"
assert apps.hostname_for("adguard-home", "!!!") == "adguard-home" and len(apps.hostname_for("immich", "x" * 80)) <= 63
assert apps.display_name("portainer", "Dev") == "Portainer CE — Dev"
b = apps.DeployBody(app_id="portainer", instance_label=" Dev\n\tbox ", cores=1, memory=512, disk_gb=4)
assert b.instance_label == "Dev box" and b.hostname == "portainer-dev-box", b
assert apps.DeployBody(app_id="jellyfin", hostname="nas", cores=1, memory=512, disk_gb=4).hostname == "nas"

# Apps replaced by a built-in feature: gone from the catalog, refused on install, still known for old instances.
ids = {a["id"] for a in apps.CATALOG}
assert ids.isdisjoint({"samba", "nginx-proxy-manager", "docker-portainer", "docker-engine"}) and "portainer" in ids, ids
assert apps.BY_ID["portainer"]["multi_instance"] is True
for legacy in ("samba", "nginx-proxy-manager", "docker-portainer"):
    try:
        apps.DeployBody(app_id=legacy, cores=1, memory=512, disk_gb=4)
        raise AssertionError(f"{legacy} should not be installable")
    except ValueError as e:
        assert "built-in feature" in str(e), e
assert apps.native_badge("samba")["native_feature"] == "smb_shares" and apps.native_badge("jellyfin") == {}


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


tag = f"{apps.TAG};pos-docker-portainer"  # legacy app, replaced by the built-in Docker Engine
fake = Fake([{"vmid": 101, "name": "docker-portainer", "type": "lxc", "status": "running", "tags": tag, "cpus": 2,
              "maxmem": 2 << 30},
             {"vmid": 102, "name": "portainer-dev", "type": "lxc", "status": "stopped", "tags": f"{apps.TAG};pos-portainer"},
             {"vmid": 200, "name": "web", "type": "lxc", "status": "running", "tags": "other"}])
preg.get_provider = lambda: fake


async def main():
    # A fresh install record plus a stale one (container deleted outside SolarDeck); 101 is a legacy install.
    apps.register_instance(102, apps.DeployBody(app_id="portainer", instance_label="Dev", cores=1, memory=512, disk_gb=4))
    apps.save_registry({**apps.load_registry(), "jellyfin-150": apps._record(150, "jellyfin", "")})
    live = await apps.reconcile()
    assert [r["instance_id"] for r in live] == ["docker-portainer-101", "portainer-102"], live
    legacy, dev = live
    assert legacy["instance_label"] == "" and legacy["ip_address"] == "10.0.0.101" and legacy["cores"] == 2
    assert legacy["memory_mb"] == 2048 and legacy["web_url"] == "https://10.0.0.101:9443", legacy
    assert legacy["badge"] == "Built-In Native Feature Available" and legacy["native_feature"] == "docker_engine"
    assert dev["display_name"] == "Portainer CE — Dev" and dev["ip_address"] is None and dev["status"] == "stopped"
    assert "badge" not in dev and set(apps.load_registry()) == {"docker-portainer-101", "portainer-102"}
    assert "badge" not in apps.load_registry()["docker-portainer-101"]  # view-only field, not stored

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
    assert set(apps.load_registry()) == {"portainer-102"}
    assert any(j["job_id"] == "uninstall-101" for j in await tp.feed("uninstall"))

    # Stopped instance with delete_data: no stop call, data folder removed.
    fake.calls = []
    apps.data_dir("portainer-102").mkdir(parents=True)
    await apps.uninstall("portainer-102", delete_data=True)
    for _ in range(500):  # the data folder is removed in a worker thread: wait real time, not event-loop ticks
        if not apps.data_dir("portainer-102").exists():
            break
        await asyncio.sleep(0.01)
    for _ in range(50):
        await asyncio.sleep(0)
    assert fake.calls == ["delete"] and not apps.data_dir("portainer-102").exists()
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
