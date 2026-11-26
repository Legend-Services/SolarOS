"""Features & Services flags, service pausing and the Server Setup Wizard job.
Run: python -m tests.test_features_onboarding"""
import asyncio
import tempfile
from pathlib import Path

from fastapi import HTTPException

from app import apps, features, onboarding, rbac, task_progress

tmp = Path(tempfile.mkdtemp())
features.STATE = tmp / "enabled_features.json"
onboarding.STATE = tmp / "onboarding_state.json"
features.DATA = onboarding.DATA = tmp

# Defaults: everything visible, upgrades count as already set up.
v = features.view()
assert all(v["enabled"].values()) and len(v["features"]) == len(features.KEYS) == 28
assert "features-services" in v["protected"] and "users-roles" in v["protected"]
assert onboarding.load()["onboarding_completed"] is True

calls: list[str] = []


async def fake_run(cmd, check=True, timeout=120, **_):
    calls.append(cmd)
    return "wg-quick@wg0.service\n" if "list-units" in cmd and "wg0" in cmd else ""

features.host_ssh.run = fake_run

try:
    asyncio.run(features.apply({"bogus": False}))
    raise AssertionError("unknown feature accepted")
except HTTPException as e:
    assert e.status_code == 422

# Hiding a feature without a service never touches the host.
asyncio.run(features.apply({"network_architect": False}))
assert not calls and features.enabled("network_architect") is False

# Pausing the server tunnel records the unit it stopped; the client's pause skips wg0.
r = asyncio.run(features.apply({"wireguard_server": False}))
assert r["enabled"]["wireguard_server"] is False and "systemctl disable -q --now" in calls[-1]
assert features.load()["paused"]["wireguard_server"] == ["wg-quick@wg0.service"]
assert "wg-quick@wg0.service) continue" in features.pause_script("wireguard_client")
calls.clear()
asyncio.run(features.apply({"wireguard_server": True}))
assert calls == ["systemctl enable -q --now wg-quick@wg0.service || true"]
assert "wireguard_server" not in features.load()["paused"]
assert features.resume_script([]) == "true"

# Seat users read the flags; only the administrator role may change them.
assert rbac.decide({"role": "seat_user"}, "GET", "/api/system/features")
assert rbac.decide({"role": "seat_user"}, "GET", "/api/onboarding/state")
assert not rbac.decide({"role": "operator"}, "PUT", "/api/system/features")
assert not rbac.decide({"role": "operator"}, "POST", "/api/onboarding/apply")

# First run → wizard; the setup job applies features, installs apps in order and finishes.
onboarding.first_run()
assert onboarding.load()["onboarding_completed"] is False
installed: list[str] = []


async def fake_install(app_id, body):
    assert body.cores == apps.BY_ID[app_id]["cores"] and body.memory == apps.BY_ID[app_id]["memory_mb"]
    installed.append(app_id)
    vmid = 500 + len(installed)
    apps._jobs[vmid] = {"phase": "error" if app_id == "samba" else "done", "error": "boom"}
    return {"vmid": vmid}

apps.install = fake_install


async def run():
    body = onboarding.ApplyBody(selected_roles=["storage"], enabled_features={"local_ai": False},
                                selected_app_ids=["jellyfin", "samba", "immich"], skip_tour=False)
    res = await onboarding.apply(body)
    job = task_progress.module_jobs[res["job_id"]]
    while job["status"] == "running":
        await asyncio.sleep(0.01)
    return job

job = asyncio.run(run())
assert job["status"] == "completed", job
assert installed == ["jellyfin", "samba", "immich"]
assert job["result"] == {"installed": ["jellyfin", "immich"], "failed": ["samba"]}
assert task_progress.from_cluster(job)["progress_percent"] == 100
st = onboarding.load()
assert st["onboarding_completed"] and not st["tour_completed"] and st["selected_roles"] == ["storage"]
assert features.enabled("local_ai") is False
assert onboarding.tour_complete()["tour_completed"] is True

try:
    asyncio.run(onboarding.apply(onboarding.ApplyBody(selected_app_ids=["edge-proxy"])))
    raise AssertionError("system app accepted")
except HTTPException as e:
    assert e.status_code == 422
print("features & onboarding: ok")
