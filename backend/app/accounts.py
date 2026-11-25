"""The administrator account: scrypt-hashed password in backend/.env, and first-run setup.

A fresh install has no administrator. Until one is created, the sign-in screen shows the setup form, which needs the
one-time setup code from the server's own console (setup_code_file, shown on tty1), so nobody else on the network can
claim the server first. The password is stored only as a hash (ADMIN_PASSWORD_HASH); an older install's plaintext
ADMIN_PASSWORD keeps working until the password is changed.
"""
import hashlib
import re
import secrets
import string
import time

from fastapi import HTTPException

from . import config
from .config import settings

USERNAME_RE = r"^[a-z_][a-z0-9_-]{0,31}$"  # also a valid Linux user name
RESERVED_USERS = {"root", "daemon", "bin", "sys", "nobody", "www-data", "sshd", "libvirt-qemu", "incus"}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
MAX_CODE_FAILURES = 10
LOCKOUT_SECONDS = 600
_failures: list[float] = []


# ---------------------------------------------------------------- hashing (pure, unit tested)


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    return f"scrypt${salt.hex()}${hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1).hex()}"


def verify_hash(pw: str, stored: str) -> bool:
    try:
        kind, salt, digest = stored.split("$")
        calc = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1).hex()
    except (ValueError, TypeError):
        return False
    return kind == "scrypt" and secrets.compare_digest(calc, digest)


def new_setup_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_code(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def check_new_credentials(username: str, password: str) -> None:
    if not re.fullmatch(USERNAME_RE, username or "") or username in RESERVED_USERS:
        raise HTTPException(422, "Use a lowercase user name (letters, digits, - or _) that is not a system account")
    if len(password or "") < 10 or len(password) > 128 or any(c in password for c in "\r\n'\\"):
        raise HTTPException(422, "Use a password of 10 to 128 characters (no quotes, backslashes or line breaks)")
    if len(set(password)) < 5 or password.lower() in {username, "password12", "solaros123", "solardeck1"}:
        raise HTTPException(422, "This password is too easy to guess")
    if not (any(c in string.ascii_letters for c in password) and any(not c.isalpha() for c in password)):
        raise HTTPException(422, "Use letters and at least one digit or symbol")


# ---------------------------------------------------------------- state


def setup_required() -> bool:
    return not (settings.admin_password_hash or settings.admin_password)


def verify_admin(username: str, password: str) -> bool:
    # Evaluate both comparisons to avoid leaking which one failed via timing.
    ok_user = secrets.compare_digest((username or "").encode(), settings.admin_username.encode())
    if settings.admin_password_hash:
        ok_pass = verify_hash(password or "", settings.admin_password_hash)
    else:
        ok_pass = bool(settings.admin_password) and secrets.compare_digest((password or "").encode(),
                                                                          settings.admin_password.encode())
    return ok_user and ok_pass


def set_admin(username: str, password: str) -> None:
    """Store the administrator (hash only) in backend/.env and apply it to the running backend."""
    from .system import write_env  # local import: system imports this module's users

    digest = hash_password(password)
    write_env(config.ENV_FILE, "ADMIN_USERNAME", username)
    write_env(config.ENV_FILE, "ADMIN_PASSWORD_HASH", digest)
    write_env(config.ENV_FILE, "ADMIN_PASSWORD", "")
    settings.admin_username, settings.admin_password_hash, settings.admin_password = username, digest, ""


def check_setup_code(code: str) -> None:
    now = time.monotonic()
    _failures[:] = [t for t in _failures if now - t < LOCKOUT_SECONDS]
    if len(_failures) >= MAX_CODE_FAILURES:
        raise HTTPException(429, "Too many wrong setup codes; try again in 10 minutes")
    try:
        expected = normalize_code(settings.setup_code_file.read_text())
    except OSError:
        raise HTTPException(409, "No setup code on this server: run the installer again or reset the administrator "
                                 "on the server's console")
    if not expected or not secrets.compare_digest(normalize_code(code).encode(), expected.encode()):
        _failures.append(now)
        raise HTTPException(403, "Wrong setup code: use the code shown on the server's screen")
