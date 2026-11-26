"""Multi-user roles & permissions: SolarDeck accounts next to the administrator, each with a role and resource scopes.

Roles: admin (everything), operator (day-to-day work, no security / user / update / cluster administration),
seat_user (power, consoles and USB of the assigned Seat VMs only), viewer (read-only). The administrator from first-run
setup is always admin. Accounts live in data/rbac_users.json (scrypt hashes, mode 600).

Enforcement is one request check (authorize) run by the middleware in main.py for every /api call of a signed-in user,
so every route — including future ones — is covered without per-route changes; WebSocket consoles check can_guest.
"""
import json
import re
import time
from pathlib import Path as FsPath
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from . import accounts, audit_log, platform_modules as pm
from .auth import client_ip, require_user
from .config import settings

MODULE = "rbac_users"
router = APIRouter(prefix="/api/rbac", tags=["rbac"], dependencies=[Depends(require_user)])
DATA = FsPath(__file__).resolve().parent.parent / "data"
STATE = DATA / "rbac_users.json"
Role = Literal["admin", "operator", "seat_user", "viewer"]
ROLES = {
    "admin": "Full control, including users, security, updates and clustering",
    "operator": "Manage guests, storage, network and apps; no user, security, update or cluster administration",
    "seat_user": "Power, console and USB ports of the assigned Seat VMs only",
    "viewer": "Read-only access",
}

# Paths only an admin may change (operators may still read the non-sensitive ones).
ADMIN_ONLY = ("/api/rbac/users", "/api/auth/2fa", "/api/auth/sessions", "/api/platform/modules", "/api/system/update",
              "/api/updater", "/api/cluster", "/api/security", "/api/dr", "/api/oob", "/api/proxy/certificates/root-ca",
              "/api/system/services", "/api/automation/channels", "/api/host-ssh",
              "/api/v1/guests/node", "/api/system/features", "/api/onboarding")  # the host's own root terminal
# Reads that hand out secrets (VPN client keys, DR archives, BMC credentials): admin only.
SENSITIVE_GET = (re.compile(r"^/api/net/wg/peers/[^/]+/(conf|qr)$"), re.compile(r"^/api/dr/"), re.compile(r"^/api/oob/"),
                 re.compile(r"^/api/automation/channels"), re.compile(r"^/api/rbac/users"))
ALWAYS = {("GET", "/api/auth/me"), ("GET", "/api/rbac/me"), ("POST", "/api/auth/logout"), ("POST", "/api/auth/step-up"),
          ("GET", "/api/health")}
# Seat users: what the desktop needs to show itself plus their own guests and seats.
SEAT_READ = re.compile(r"^/api/(auth/me|rbac/me|system/(info|preferences|capabilities|branding|themes.*|app-usage|features)|onboarding/state|"
                       r"v1/system/capabilities|telemetry.*|notifications.*|multiseat/(seats|topology)|v1/guests|"
                       r"v1/tasks/.*|tasks.*|ups/status)$")
GUEST_PATH = re.compile(r"^/api/v1/guests/(qemu|lxc)/(\d+)/(action|vnc|terminal)$")
SEAT_PATH = re.compile(r"^/api/multiseat/seats/([A-Za-z0-9_-]+)/(start|stop)$")


def is_admin(user: str | None) -> bool:
    return bool(user) and (user == settings.admin_username or (find(user) or {}).get("role") == "admin")


def load() -> list[dict]:
    try:
        return json.loads(STATE.read_text())["users"]
    except (OSError, ValueError, KeyError):
        return []


def save(users: list[dict]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"users": users}, indent=1))
    tmp.chmod(0o600)
    tmp.replace(STATE)


def find(username: str) -> dict | None:
    return next((u for u in load() if u["username"] == username), None)


def enabled() -> bool:
    return pm.profile(MODULE)["enabled"]


def verify(username: str, password: str) -> bool:
    """Password check for an extra account (only while the module is on and the account is enabled)."""
    u = find(username or "")
    return bool(u and u.get("enabled", True) and enabled() and accounts.verify_hash(password or "", u["password_hash"]))


# ---------------------------------------------------------------- Authorization (pure on the user record, tested)


def decide(u: dict | None, method: str, path: str) -> bool:
    """May account `u` (None = unknown / disabled) make this request? The administrator never reaches this."""
    path = path.rstrip("/") or "/"
    if (method, path) in ALWAYS:
        return True
    if not u or not u.get("enabled", True):
        return False
    role, read = u["role"], method in ("GET", "HEAD", "OPTIONS")
    if role == "admin":
        return True
    if read and any(p.match(path) for p in SENSITIVE_GET):
        return False
    if role == "viewer":
        return read
    if role == "operator":
        return read or not path.startswith(ADMIN_ONLY)
    if role == "seat_user":
        if m := GUEST_PATH.match(path):
            return int(m.group(2)) in u.get("allowed_vm_ids", [])
        if m := SEAT_PATH.match(path):
            return m.group(1) in u.get("allowed_seat_ids", [])
        if path == "/api/multiseat/usb/listen" or path.startswith("/api/multiseat/usb/listen/"):
            return bool(u.get("allowed_seat_ids"))
        return read and bool(SEAT_READ.match(path))
    return False


def authorize(user: str, method: str, path: str) -> bool:
    if user == settings.admin_username:
        return True
    return decide(find(user) if enabled() else None, method, path)  # module off: extra accounts are locked out


def can_guest(user: str, vmid: int) -> bool:
    """WebSocket consoles: the admin, operators, and seat users scoped to this guest."""
    if user == settings.admin_username:
        return True
    u = find(user)
    return bool(u and u.get("enabled", True) and (u["role"] in ("admin", "operator") or vmid in u.get("allowed_vm_ids", [])))


# ---------------------------------------------------------------- Routes


class UserBody(BaseModel):
    role: Role = "viewer"
    password: str | None = Field(None, max_length=128)  # required on create; None keeps the current one
    display_name: str = Field("", max_length=60, pattern=r"^[^\n\r<>]*$")
    allowed_vm_ids: list[int] = Field([], max_length=200)
    allowed_seat_ids: list[str] = Field([], max_length=50)
    allowed_shares: list[str] = Field([], max_length=100)
    enabled: bool = True


class NewUserBody(UserBody):
    username: str = Field(pattern=accounts.USERNAME_RE)


def view(u: dict) -> dict:
    return {k: v for k, v in u.items() if k != "password_hash"}


def _admin(user: str) -> None:
    if not is_admin(user):
        raise HTTPException(403, "Only an administrator manages users")


@router.get("/roles")
async def roles():
    return [{"id": k, "description": v} for k, v in ROLES.items()]


@router.get("/me")
async def me(user: str = Depends(require_user)):
    u = find(user)
    if user == settings.admin_username or not u:
        return {"username": user, "role": "admin", "allowed_vm_ids": [], "allowed_seat_ids": [], "allowed_shares": []}
    return view(u)


@router.get("/users")
async def list_users(user: str = Depends(require_user)):
    _admin(user)
    return {"module": pm.profile(MODULE), "administrator": settings.admin_username, "users": [view(u) for u in load()]}


@router.post("/users", dependencies=[Depends(pm.require_module(MODULE))])
async def create_user(body: NewUserBody, request: Request, user: str = Depends(require_user)):
    _admin(user)
    users = load()
    if body.username == settings.admin_username or any(u["username"] == body.username for u in users):
        raise HTTPException(409, f"{body.username} already exists")
    if not body.password:
        raise HTTPException(422, "Set a password")
    accounts.check_new_credentials(body.username, body.password)
    u = {**body.model_dump(exclude={"password"}), "password_hash": accounts.hash_password(body.password), "created": int(time.time())}
    users.append(u)
    save(users)
    audit_log.record("rbac.user.create", user=user, ip=client_ip(request), target=body.username, role=body.role)
    return view(u)


@router.put("/users/{username}", dependencies=[Depends(pm.require_module(MODULE))])
async def update_user(body: UserBody, request: Request, username: str = Path(pattern=accounts.USERNAME_RE),
                      user: str = Depends(require_user)):
    _admin(user)
    users = load()
    u = next((x for x in users if x["username"] == username), None)
    if not u:
        raise HTTPException(404, "No such user")
    if body.password:
        accounts.check_new_credentials(username, body.password)
        u["password_hash"] = accounts.hash_password(body.password)
    u.update(body.model_dump(exclude={"password"}))
    save(users)
    audit_log.record("rbac.user.update", user=user, ip=client_ip(request), target=username, role=body.role)
    return view(u)


@router.delete("/users/{username}")
async def delete_user(request: Request, username: str = Path(pattern=accounts.USERNAME_RE), user: str = Depends(require_user)):
    from . import sessions
    _admin(user)
    users = load()
    if not any(u["username"] == username for u in users):
        raise HTTPException(404, "No such user")
    save([u for u in users if u["username"] != username])
    for s in sessions.listing():
        if s["user"] == username:
            sessions.revoke(s["id"])
    audit_log.record("rbac.user.delete", user=user, ip=client_ip(request), target=username)
    return {"ok": True}
