import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import pyotp
import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import accounts, audit_log, secrets_vault, sessions
from .config import settings
from providers.registry import get_provider

COOKIE = "pos_session"
OTP_REQUIRED = "Two-factor code required"
STEP_UP_REQUIRED = "step_up_required"
STEP_UP_HEADER = "x-step-up-token"
STEP_UP_TTL_S = 300
CHALLENGE_TTL_S = 300
RECOVERY_CODES = 8
SECRET_FIELDS = ("totp_secret", "pending_secret")
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)
    otp: str | None = Field(None, max_length=16)  # one-step sign-in for scripts; the UI uses the 2FA challenge


def client_ip(request: Request) -> str:
    # uvicorn --proxy-headers takes X-Forwarded-For from nginx on 127.0.0.1 only, so this is the real client address.
    return request.client.host if request.client else "unknown"


def _jwt(claims: dict, ttl_s: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(seconds=ttl_s)
    return jwt.encode({**claims, "exp": exp}, settings.jwt_secret, algorithm="HS256")


def _decode(token: str | None, purpose: str | None = None) -> dict:
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired session")
    if claims.get("purpose") != purpose:
        raise HTTPException(401, "Invalid or expired session")
    return claims


def session_claims(token: str | None, ip: str | None = None) -> dict:
    """Claims of a session token that is still listed (not revoked, not expired)."""
    claims = _decode(token)
    if not sessions.touch(claims.get("jti"), ip):
        raise HTTPException(401, "Session ended (signed out or revoked)")
    return claims


def _request_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:] if header.lower().startswith("bearer ") else request.cookies.get(COOKIE)


def current_session(request: Request) -> dict:
    if not hasattr(request.state, "session"):
        request.state.session = session_claims(_request_token(request), client_ip(request))
    return request.state.session


def require_user(request: Request) -> str:
    return current_session(request)["sub"]


def decode_token(token: str | None) -> str:
    return session_claims(token)["sub"]


def user_or_none(request: Request) -> str | None:
    """Signed-in user for audit records, without failing the request."""
    try:
        return jwt.decode(_request_token(request) or "", settings.jwt_secret, algorithms=["HS256"]).get("sub")
    except jwt.PyJWTError:
        return None


# ---------------------------------------------------------------- 2FA storage


def load_security() -> dict:
    try:
        return secrets_vault.decrypt_fields(json.loads(settings.security_file.read_text()), SECRET_FIELDS)
    except (FileNotFoundError, ValueError):
        return {}


def save_security(data: dict) -> None:
    settings.security_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.security_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(secrets_vault.encrypt_fields(data, SECRET_FIELDS)))
    tmp.chmod(0o600)
    tmp.replace(settings.security_file)


def otp_ok(secret: str | None, code: str | None) -> bool:
    # valid_window=1 accepts the previous/next 30 s step to absorb clock drift.
    return bool(secret and code) and pyotp.TOTP(secret).verify(code.strip().replace(" ", ""), valid_window=1)


def normalize_recovery(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def hash_recovery(code: str) -> str:
    return hashlib.sha256(normalize_recovery(code).encode()).hexdigest()


def new_recovery_codes(n: int = RECOVERY_CODES) -> list[str]:
    raw = ["".join(secrets.choice(accounts.CODE_ALPHABET) for _ in range(10)) for _ in range(n)]
    return [f"{c[:5]}-{c[5:]}" for c in raw]


def second_factor(sec: dict, code: str | None) -> str | None:
    """'totp' or 'recovery' when the code is valid (a recovery code is used up), else None."""
    code = (code or "").strip()
    if re.fullmatch(r"\d{6}", code.replace(" ", "")):
        return "totp" if otp_ok(sec.get("totp_secret"), code) else None
    digest = hash_recovery(code)
    left = sec.get("recovery_codes") or []
    if len(normalize_recovery(code)) == 10 and any(secrets.compare_digest(digest, h) for h in left):
        save_security({**sec, "recovery_codes": [h for h in left if h != digest]})
        return "recovery"
    return None


# ---------------------------------------------------------------- sign-in


def _throttle(request: Request) -> str:
    ip = client_ip(request)
    if wait := sessions.retry_after(ip):
        audit_log.record("login.locked", ip=ip, ok=False, retry_after=wait)
        raise HTTPException(429, f"Too many failed sign-ins. Try again in {wait} seconds.",
                            headers={"Retry-After": str(wait)})
    return ip


def _fail(ip: str, event: str, user: str | None, detail: str, status: int = 401):
    wait = sessions.failed(ip)
    audit_log.record(event, user=user, ip=ip, ok=False)
    if wait:
        raise HTTPException(429, f"Too many failed sign-ins. Try again in {wait} seconds.",
                            headers={"Retry-After": str(wait)})
    raise HTTPException(status, detail)


def _set_session(request: Request, response: Response, username: str, method: str = "password") -> dict:
    ttl = settings.jwt_ttl_hours * 3600
    ip = client_ip(request)
    try:  # signing in again from this browser (unlock) replaces its previous session instead of piling up
        sessions.revoke(_decode(request.cookies.get(COOKIE)).get("jti", ""))
    except HTTPException:
        pass
    sid = sessions.create(username, ip, request.headers.get("user-agent", ""), ttl)
    token = _jwt({"sub": username, "jti": sid}, ttl)
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=ttl,
                        secure=request.url.scheme == "https")
    sessions.succeeded(ip)
    audit_log.record("login.success", user=username, ip=ip, method=method, session=sid[:8])
    return {"username": username, "token": token}


def _note_password_strength(username: str, password: str) -> None:
    """Remember whether the admin password passes today's rules (only the result is stored; shown in Security Posture)."""
    try:
        accounts.check_new_credentials(username, password)
        weak = False
    except HTTPException:
        weak = True
    sec = load_security()
    if sec.get("weak_password") != weak:
        save_security({**sec, "weak_password": weak})


class SetupBody(BaseModel):
    code: str = Field(max_length=32)
    username: str = Field(max_length=32)
    password: str = Field(max_length=128)


@router.get("/setup")
def setup_status():
    """Public: whether the sign-in screen must show first-run setup instead of the login form."""
    return {"required": accounts.setup_required()}


@router.post("/setup")
async def setup(body: SetupBody, request: Request, response: Response):
    """Create the first administrator. Needs the one-time code from the server's console."""
    if not accounts.setup_required():
        raise HTTPException(409, "The administrator already exists")
    if not settings.jwt_secret:
        raise HTTPException(500, "Server is not configured (JWT_SECRET missing)")
    accounts.check_setup_code(body.code)
    accounts.check_new_credentials(body.username, body.password)
    # Linux account first: if it fails, nothing is saved and setup can simply be retried.
    await get_provider().set_host_admin(body.username, body.password)
    accounts.set_admin(body.username, body.password)
    settings.setup_code_file.unlink(missing_ok=True)
    save_security({**load_security(), "weak_password": False})
    audit_log.record("admin.setup", user=body.username, ip=client_ip(request))
    return _set_session(request, response, body.username)


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    if accounts.setup_required():
        raise HTTPException(409, "Create the administrator first (first-run setup)")
    if not settings.jwt_secret:
        raise HTTPException(500, "Server is not configured (JWT_SECRET missing)")
    ip = _throttle(request)
    if not accounts.verify_admin(body.username, body.password):
        from . import rbac  # lazy: rbac imports this module
        if rbac.verify(body.username, body.password):  # an extra account (Users & Roles); 2FA is the administrator's
            return _set_session(request, response, body.username)
        _fail(ip, "login.failure", body.username, "Invalid username or password")
    _note_password_strength(body.username, body.password)
    sec = load_security()
    if sec.get("totp_enabled"):
        if not body.otp:
            audit_log.record("login.2fa_challenge", user=body.username, ip=ip)
            return {"requires_2fa": True, "challenge_token": _jwt({"sub": body.username, "purpose": "2fa"}, CHALLENGE_TTL_S)}
        if not (method := second_factor(sec, body.otp)):
            _fail(ip, "login.2fa_failure", body.username, "Invalid two-factor code")
        return _set_session(request, response, body.username, method)
    return _set_session(request, response, body.username)


class ChallengeBody(BaseModel):
    challenge_token: str = Field(max_length=1000)
    code: str = Field(min_length=6, max_length=16)


@router.post("/login/2fa")
def login_2fa(body: ChallengeBody, request: Request, response: Response):
    """Second step of a sign-in with 2FA: a 6-digit authenticator code or one single-use recovery code."""
    ip = _throttle(request)
    try:
        user = _decode(body.challenge_token, "2fa")["sub"]
    except HTTPException:
        raise HTTPException(401, "The sign-in expired; enter your password again")
    if not (method := second_factor(load_security(), body.code)):
        _fail(ip, "login.2fa_failure", user, "Invalid two-factor or recovery code")
    return _set_session(request, response, user, method)


@router.get("/me")
def me(user: str = Depends(require_user)):
    return {"username": user}


@router.post("/logout")
def logout(request: Request, response: Response):
    try:
        claims = _decode(_request_token(request))
        sessions.revoke(claims.get("jti", ""))
        audit_log.record("logout", user=claims.get("sub"), ip=client_ip(request))
    except HTTPException:
        pass
    response.delete_cookie(COOKIE)
    return {"ok": True}


# ---------------------------------------------------------------- sessions


@router.get("/sessions")
def list_sessions(request: Request, _: str = Depends(require_user)):
    me_id = current_session(request)["jti"]
    return [{k: s[k] for k in ("id", "user", "ip", "device", "issued", "last_seen", "expires")} | {"current": s["id"] == me_id}
            for s in sessions.listing()]


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: str, request: Request, user: str = Depends(require_user)):
    if not sessions.revoke(session_id):
        raise HTTPException(404, "No such session")
    audit_log.record("session.revoke", user=user, ip=client_ip(request), session=session_id[:8])
    return {"ok": True}


@router.post("/sessions/revoke-all")
def revoke_all_sessions(request: Request, user: str = Depends(require_user)):
    """Ends every session except the one making the request."""
    n = sessions.revoke_all(keep=current_session(request)["jti"])
    audit_log.record("session.revoke_all", user=user, ip=client_ip(request), count=n)
    return {"revoked": n}


# ---------------------------------------------------------------- step-up re-authentication


class StepUpBody(BaseModel):
    password: str | None = Field(None, max_length=256)
    code: str | None = Field(None, max_length=16)


@router.post("/step-up")
def step_up(body: StepUpBody, request: Request, user: str = Depends(require_user)):
    """Confirm the password (or a 2FA code) again; the token unlocks destructive actions for 5 minutes."""
    ip = _throttle(request)
    from . import rbac
    sec = load_security()
    ok = (bool(body.password) and (accounts.verify_admin(user, body.password) or rbac.verify(user, body.password))) or \
         (bool(body.code) and user == settings.admin_username and sec.get("totp_enabled") and second_factor(sec, body.code) is not None)
    if not ok:
        _fail(ip, "stepup.failure", user, "Password or code is incorrect", 403)
    sessions.succeeded(ip)
    audit_log.record("stepup.success", user=user, ip=ip)
    token = _jwt({"sub": user, "purpose": "step-up", "sid": current_session(request)["jti"]}, STEP_UP_TTL_S)
    return {"step_up_token": token, "expires_in": STEP_UP_TTL_S}


def step_up_ok(token: str | None, session: dict) -> bool:
    try:
        claims = _decode(token, "step-up")
    except HTTPException:
        return False
    return claims.get("sid") == session.get("jti") and claims.get("sub") == session.get("sub")


def require_step_up_auth(request: Request) -> str:
    """Dependency for destructive endpoints: a valid X-Step-Up-Token bound to the caller's session, else 403."""
    session = current_session(request)
    if not step_up_ok(request.headers.get(STEP_UP_HEADER), session):
        raise HTTPException(403, STEP_UP_REQUIRED)
    return session["sub"]


# ---------------------------------------------------------------- 2FA enrollment


class CodeBody(BaseModel):
    code: str = Field(min_length=6, max_length=16)


class DisableBody(CodeBody):
    password: str = Field(max_length=256)


@router.get("/2fa/status")
def twofa_status(_: str = Depends(require_user)):
    sec = load_security()
    return {"enabled": bool(sec.get("totp_enabled")), "recovery_codes_left": len(sec.get("recovery_codes") or [])}


@router.post("/2fa/setup")
def twofa_setup(user: str = Depends(require_user)):
    sec = load_security()
    if sec.get("totp_enabled"):
        raise HTTPException(409, "Two-factor authentication is already enabled; disable it first")
    secret = pyotp.random_base32()
    codes = new_recovery_codes()
    save_security({**sec, "pending_secret": secret, "pending_recovery": [hash_recovery(c) for c in codes]})
    uri = pyotp.TOTP(secret).provisioning_uri(name=user, issuer_name="SolarDeck")
    svg = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage, border=2).to_string(encoding="unicode")
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": svg, "recovery_codes": codes}


@router.post("/2fa/verify-setup")
@router.post("/2fa/enable")
def twofa_enable(body: CodeBody, request: Request, user: str = Depends(require_user)):
    sec = load_security()
    if not otp_ok(sec.get("pending_secret"), body.code):
        raise HTTPException(400, "Invalid code. Check the time on your phone and try again.")
    rest = {k: v for k, v in sec.items() if k not in ("pending_secret", "pending_recovery")}
    save_security({**rest, "totp_secret": sec["pending_secret"], "totp_enabled": True,
                   "recovery_codes": sec.get("pending_recovery") or []})
    audit_log.record("2fa.enable", user=user, ip=client_ip(request))
    return {"enabled": True}


@router.post("/2fa/disable")
def twofa_disable(body: DisableBody, request: Request, user: str = Depends(require_user)):
    sec = load_security()
    if not sec.get("totp_enabled"):
        return {"enabled": False}
    ip = _throttle(request)
    if not accounts.verify_admin(user, body.password) or not second_factor(sec, body.code):
        _fail(ip, "2fa.disable_failure", user, "Password or two-factor code is incorrect", 400)
    keep = {k: v for k, v in load_security().items() if k not in ("totp_secret", "totp_enabled", "recovery_codes")}
    save_security(keep)
    audit_log.record("2fa.disable", user=user, ip=ip)
    return {"enabled": False}
