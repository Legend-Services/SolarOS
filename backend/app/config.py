from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    pve_host: str = "https://127.0.0.1:8006"
    pve_node: str = "pve"
    pve_token_id: str = ""
    pve_token_secret: str = ""
    pve_verify_ssl: bool = False
    admin_username: str = "admin"
    admin_password: str = ""
    jwt_secret: str = ""
    jwt_ttl_hours: int = 12
    storage_root: Path = Path("/mnt/storage")


settings = Settings()
