import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from .config import settings

COOKIE = "pos_session"
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


def _issue(username: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=settings.jwt_ttl_hours)
    return jwt.encode({"sub": username, "exp": exp}, settings.jwt_secret, algorithm="HS256")


def require_user(request: Request) -> str:
    token = request.cookies.get(COOKIE)
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired session")


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    if not settings.jwt_secret or not settings.admin_password:
        raise HTTPException(500, "Server is not configured (JWT_SECRET / ADMIN_PASSWORD missing)")
    # Evaluate both comparisons to avoid leaking which one failed via timing.
    ok_user = secrets.compare_digest(body.username.encode(), settings.admin_username.encode())
    ok_pass = secrets.compare_digest(body.password.encode(), settings.admin_password.encode())
    if not (ok_user and ok_pass):
        raise HTTPException(401, "Invalid username or password")
    token = _issue(body.username)
    response.set_cookie(
        COOKIE, token, httponly=True, samesite="strict", max_age=settings.jwt_ttl_hours * 3600,
        secure=request.url.scheme == "https",
    )
    return {"username": body.username, "token": token}


@router.get("/me")
def me(user: str = Depends(require_user)):
    return {"username": user}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}
