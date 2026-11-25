import json
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import pyotp
import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import accounts
from .config import settings
from providers.registry import get_provider

COOKIE = "pos_session"
OTP_REQUIRED = "Two-factor code required"
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str
    otp: str | None = Field(None, max_length=10)


def _issue(username: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=settings.jwt_ttl_hours)
    return jwt.encode({"sub": username, "exp": exp}, settings.jwt_secret, algorithm="HS256")


def require_user(request: Request) -> str:
    token = request.cookies.get(COOKIE)
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:]
    return decode_token(token)


def decode_token(token: str | None) -> str:
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired session")


# ---------------------------------------------------------------- TOTP two-factor authentication


def load_security() -> dict:
    try:
        return json.loads(settings.security_file.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def save_security(data: dict) -> None:
    settings.security_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = settings.security_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o600)
    tmp.replace(settings.security_file)


def otp_ok(secret: str | None, code: str | None) -> bool:
    # valid_window=1 accepts the previous/next 30 s step to absorb clock drift.
    return bool(secret and code) and pyotp.TOTP(secret).verify(code.strip().replace(" ", ""), valid_window=1)


def _set_session(request: Request, response: Response, username: str) -> dict:
    token = _issue(username)
    response.set_cookie(
        COOKIE, token, httponly=True, samesite="strict", max_age=settings.jwt_ttl_hours * 3600,
        secure=request.url.scheme == "https",
    )
    return {"username": username, "token": token}


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
    accounts.set_admin(body.username, body.password)
    await get_provider().set_host_admin(body.username, body.password)
    settings.setup_code_file.unlink(missing_ok=True)
    return _set_session(request, response, body.username)


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    if accounts.setup_required():
        raise HTTPException(409, "Create the administrator first (first-run setup)")
    if not settings.jwt_secret:
        raise HTTPException(500, "Server is not configured (JWT_SECRET missing)")
    if not accounts.verify_admin(body.username, body.password):
        raise HTTPException(401, "Invalid username or password")
    sec = load_security()
    if sec.get("totp_enabled"):
        if not body.otp:
            raise HTTPException(401, OTP_REQUIRED)
        if not otp_ok(sec.get("totp_secret"), body.otp):
            raise HTTPException(401, "Invalid two-factor code")
    return _set_session(request, response, body.username)


@router.get("/me")
def me(user: str = Depends(require_user)):
    return {"username": user}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


class CodeBody(BaseModel):
    code: str = Field(min_length=6, max_length=10)


@router.get("/2fa/status")
def twofa_status(_: str = Depends(require_user)):
    return {"enabled": bool(load_security().get("totp_enabled"))}


@router.post("/2fa/setup")
def twofa_setup(user: str = Depends(require_user)):
    sec = load_security()
    if sec.get("totp_enabled"):
        raise HTTPException(409, "Two-factor authentication is already enabled; disable it first")
    secret = pyotp.random_base32()
    save_security({**sec, "pending_secret": secret})
    uri = pyotp.TOTP(secret).provisioning_uri(name=user, issuer_name="SolarDeck")
    svg = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage, border=2).to_string(encoding="unicode")
    return {"secret": secret, "otpauth_uri": uri, "qr_svg": svg}


@router.post("/2fa/enable")
def twofa_enable(body: CodeBody, _: str = Depends(require_user)):
    sec = load_security()
    if not otp_ok(sec.get("pending_secret"), body.code):
        raise HTTPException(400, "Invalid code. Check the time on your phone and try again.")
    save_security({"totp_secret": sec["pending_secret"], "totp_enabled": True})
    return {"enabled": True}


@router.post("/2fa/disable")
def twofa_disable(body: CodeBody, _: str = Depends(require_user)):
    sec = load_security()
    if not sec.get("totp_enabled"):
        return {"enabled": False}
    if not otp_ok(sec.get("totp_secret"), body.code):
        raise HTTPException(400, "Invalid two-factor code")
    save_security({})
    return {"enabled": False}
