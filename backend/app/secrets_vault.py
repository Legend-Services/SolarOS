"""At-rest encryption of stored secrets (alert channel tokens, SMTP password, TOTP secret).

Fernet with a random machine-local key in backend/data/.vault.key (0600, created on first use). Encrypted values are
stored as "vault:v1:<token>"; a plaintext value from an older file is returned as-is and encrypted on its next save,
so existing JSON files keep working.
"""
import os
import threading

from cryptography.fernet import Fernet, InvalidToken

from .config import settings

PREFIX = "vault:v1:"
_lock = threading.Lock()
_fernet: Fernet | None = None


def _key() -> bytes:
    path = settings.vault_key_file
    try:
        return path.read_bytes().strip()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:  # created by a concurrent first use
            return path.read_bytes().strip()
        with os.fdopen(fd, "wb") as f:
            f.write(key)
        return key


def _f() -> Fernet:
    global _fernet
    with _lock:
        if _fernet is None:
            _fernet = Fernet(_key())
        return _fernet


def encrypt(value: str | None) -> str | None:
    if not value or not isinstance(value, str) or value.startswith(PREFIX):
        return value
    return PREFIX + _f().encrypt(value.encode()).decode()


def decrypt(value):
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return value  # plaintext from before the vault, or not a secret
    try:
        return _f().decrypt(value[len(PREFIX):].encode()).decode()
    except InvalidToken:
        return ""  # the key file was lost or replaced: the secret has to be entered again


def encrypt_fields(data: dict, keys) -> dict:
    return {k: encrypt(v) if k in keys else v for k, v in data.items()}


def decrypt_fields(data: dict, keys) -> dict:
    return {k: decrypt(v) if k in keys else v for k, v in data.items()}
