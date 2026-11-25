"""First-run setup self-check: setup code from the console, hashed administrator, host account hook.
Run: python -m tests.test_setup_wizard"""
import asyncio
import os
import tempfile
from pathlib import Path

tmp = Path(tempfile.mkdtemp())
os.environ.update(STORAGE_ROOT=str(tmp), JWT_SECRET="x" * 32, ADMIN_PASSWORD="", ADMIN_USERNAME="admin",
                  SETUP_CODE_FILE=str(tmp / "setup-code"))

from fastapi.testclient import TestClient  # noqa: E402

from app import accounts, config  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from providers.registry import get_provider  # noqa: E402

config.ENV_FILE = tmp / ".env"
config.ENV_FILE.write_text("JWT_SECRET=x\n")
calls = []


async def fake_host_admin(username, password):
    calls.append((username, password))


get_provider().set_host_admin = fake_host_admin
c = TestClient(app)

# ---- pure helpers
h = accounts.hash_password("Correct horse 7")
assert h.startswith("scrypt$") and accounts.verify_hash("Correct horse 7", h) and not accounts.verify_hash("nope", h)
assert not accounts.verify_hash("x", "garbage")
code = accounts.new_setup_code()
assert len(code) == 9 and code[4] == "-" and not set(code) & set("01OI")
assert accounts.normalize_code(" ab cd-ef12 ") == "ABCDEF12"

# ---- before setup: the sign-in screen must show setup; login is refused
assert c.get("/api/auth/setup").json() == {"required": True}
assert c.post("/api/auth/login", json={"username": "admin", "password": ""}).status_code == 409
good = {"code": "", "username": "ty", "password": "Solar-Panel 42"}
assert c.post("/api/auth/setup", json={**good, "code": "AAAA-BBBB"}).status_code == 409  # no code file yet
settings.setup_code_file.write_text(code + "\n")
assert c.post("/api/auth/setup", json={**good, "code": "WRNG-CODE"}).status_code == 403
for bad in ({"username": "root"}, {"username": "Ty"}, {"password": "short1"}, {"password": "aaaaaaaaaaaa1"},
            {"password": "onlyletterspass"}, {"password": "with'quote 123"}):
    assert c.post("/api/auth/setup", json={**good, "code": code, **bad}).status_code == 422, bad

# ---- brute force: 10 wrong codes lock the form for a while
accounts._failures.clear()
for _ in range(accounts.MAX_CODE_FAILURES):
    c.post("/api/auth/setup", json={**good, "code": "ZZZZ-ZZZZ"})
assert c.post("/api/auth/setup", json={**good, "code": code}).status_code == 429
accounts._failures.clear()

# ---- the right code (any case, with or without dash) creates the administrator
r = c.post("/api/auth/setup", json={**good, "code": code.lower().replace("-", "")})
assert r.status_code == 200 and r.json()["username"] == "ty" and r.json()["token"], r.text
assert calls == [("ty", "Solar-Panel 42")]
assert not settings.setup_code_file.exists()
assert c.get("/api/auth/setup").json() == {"required": False}
env = config.ENV_FILE.read_text()
assert "Solar-Panel 42" not in env and "ADMIN_PASSWORD_HASH='scrypt$" in env and "ADMIN_USERNAME='ty'" in env, env
assert c.post("/api/auth/setup", json={**good, "code": code}).status_code == 409  # only once

# ---- normal sign-in afterwards; password change keeps the host account in sync
anon = TestClient(app)
assert anon.post("/api/auth/login", json={"username": "ty", "password": "Solar-Panel 42"}).status_code == 200
assert anon.post("/api/auth/login", json={"username": "ty", "password": "wrong"}).status_code == 401
tok = anon.post("/api/auth/login", json={"username": "ty", "password": "Solar-Panel 42"}).json()["token"]
hdr = {"Authorization": f"Bearer {tok}"}
assert anon.post("/api/system/password", json={"current_password": "Solar-Panel 42", "new_password": "Moon Rover 2027"},
                 headers=hdr).status_code == 200
assert calls[-1] == ("ty", "Moon Rover 2027")
assert anon.post("/api/auth/login", json={"username": "ty", "password": "Moon Rover 2027"}).status_code == 200

# ---- older installs: a plaintext ADMIN_PASSWORD still signs in until it is changed
settings.admin_password_hash, settings.admin_password, settings.admin_username = "", "legacy-pass-1", "admin"
assert accounts.verify_admin("admin", "legacy-pass-1") and not accounts.setup_required()
# ---- the real SolarOS hook: builds the commands (regression: await inside a generator broke ",".join)
from providers.native_ubuntu import provider as nu  # noqa: E402

cmds = []


async def fake_ok(*args, **kw):
    if args[:2] == ("getent", "group"):
        return "" if args[2] in ("sudo", "libvirt") else None  # empty output still means success
    return "1000" if args == ("id", "-u", nu.BOOTSTRAP_USER) else None


async def fake_run(*args, **kw):
    cmds.append((args, kw.get("input")))
    return ""


nu.ok, nu.run = fake_ok, fake_run
asyncio.run(nu.NativeUbuntuProvider.set_host_admin(object.__new__(nu.NativeUbuntuProvider), "ty", "Solar-Panel 42"))
assert cmds[0][0] == ("useradd", "-m", "-s", "/bin/bash", "-c", "SolarOS administrator", "-G", "sudo,libvirt", "ty"), cmds
assert cmds[1] == (("chpasswd",), "ty:Solar-Panel 42\n") and cmds[2][0] == ("usermod", "-L", "-e", "1", nu.BOOTSTRAP_USER)

# ---- a failing host hook saves nothing, so setup can be retried
settings.admin_password_hash = settings.admin_password = ""
(tmp / "setup-code").write_text("WXYZ-2345\n")


async def broken_host_admin(username, password):
    raise RuntimeError("useradd failed")


get_provider().set_host_admin = broken_host_admin
try:
    TestClient(app, raise_server_exceptions=True).post(
        "/api/auth/setup", json={"code": "WXYZ-2345", "username": "ty", "password": "Solar-Panel 42"})
except RuntimeError:
    pass
assert accounts.setup_required() and (tmp / "setup-code").exists()
print("setup wizard self-check OK")
