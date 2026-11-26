"""Built-in Docker Engine self-check (parsers, module gating, container actions, install job).
Run: python -m tests.test_docker_runtime (from backend/)."""
import asyncio
import json
import os
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp()
os.environ.update(STORAGE_ROOT=_tmp, ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32,
                  AUDIT_LOG_FILE=f"{_tmp}/audit.log")

from fastapi.testclient import TestClient  # noqa: E402

from app import auth, docker_runtime as dr, features, platform_modules as pm, task_progress as tp  # noqa: E402
from app.main import app  # noqa: E402

pm.STATE = Path(_tmp) / "platform_modules.json"
features.STATE = Path(_tmp) / "enabled_features.json"
app.dependency_overrides[auth.require_user] = lambda: "admin"

# Parsers
assert dr.parse_status("installed=1\nrunning=1\nversion=28.3.1\ncompose=2.39.1\n") == {
    "installed": True, "running": True, "version": "28.3.1", "compose_version": "2.39.1"}
assert dr.parse_status("installed=0\n")["installed"] is False
ps = "\n".join(json.dumps(c) for c in [
    {"ID": "abc", "Names": "web-1", "Image": "nginx", "State": "running", "Status": "Up 2 hours", "Ports": "80/tcp",
     "Labels": "com.docker.compose.project=web,com.docker.compose.service=web"},
    {"ID": "def", "Names": "solo", "Image": "redis", "State": "exited", "Status": "Exited (0)", "Ports": "", "Labels": ""}])
rows = dr.parse_containers(ps + "\nWARNING: not json\n")
assert [(r["name"], r["stack"]) for r in rows] == [("web-1", "web"), ("solo", None)], rows
assert dr.parse_stacks('[{"Name":"web","Status":"running(1)","ConfigFiles":"/srv/web/compose.yaml"}]') == [
    {"name": "web", "status": "running(1)", "config_files": "/srv/web/compose.yaml"}]
assert dr.parse_stacks("garbage") == []

# Feature registry and module profile
assert "docker_engine" in features.KEYS and "docker_engine" in pm.MODULE_IDS
assert pm.profile("docker_engine")["recommended_runtime_mode"] == "container"

calls: list[str] = []


async def fake_run(module_id, script, timeout=300, log=None):
    calls.append(script)
    if log:
        log("==> Docker Engine ready")
    if "installed=" in script:
        return "installed=1\nrunning=1\nversion=28.3.1\ncompose=2.39.1\n"
    if script.startswith("docker ps"):
        return ps
    return ""


pm.run = fake_run
c = TestClient(app)

# One switch: the docker_engine feature flag is the module's on/off state; the module PUT cannot override it.
assert pm.profile("docker_engine")["enabled"] is True  # features default on
assert c.put("/api/system/features", json={"enabled": {"docker_engine": False}}).status_code == 200
assert pm.profile("docker_engine")["enabled"] is False
body = {**pm.profile("docker_engine"), "enabled": True}
assert c.put("/api/platform/modules/docker_engine", json=body).json()["enabled"] is False

# Off: status answers, everything else is gated.
assert c.get("/api/docker/status").json()["enabled"] is False
assert c.get("/api/docker/containers").status_code == 409

# Host native: enable runs the install job where the module lives.
r = c.post("/api/docker/enable", json={"runtime_mode": "host_native"})
assert r.status_code == 200 and r.json()["runtime_mode"] == "host_native", r.text
assert features.enabled("docker_engine")
job = tp.module_jobs[r.json()["job_id"]]
for _ in range(100):
    if job["status"] != "running":
        break
    asyncio.run(asyncio.sleep(0.01))
assert job["status"] == "completed" and job["result"]["installed"] and "get.docker.com" in calls[0], job
st = c.get("/api/docker/status").json()
assert st["enabled"] and st["installed"] and st["version"] == "28.3.1", st
assert [x["name"] for x in c.get("/api/docker/containers").json()] == ["web-1", "solo"]
assert c.post("/api/docker/containers/abc/remove").json()["ok"] and calls[-1] == "docker rm -f abc >/dev/null"
assert c.post("/api/docker/containers/abc;reboot/stop").status_code in (404, 422)
assert c.post("/api/docker/containers/abc/kill").status_code == 422
print("docker runtime: ok")
