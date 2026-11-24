from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

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
    pve_bridge: str = "vmbr0"
    # Root-only host operations (ZFS, bind mounts, /dev/dri, pct exec) go through proxmox-os-helper.
    # Empty HOST_SSH runs the helper locally (backend on the PVE host itself).
    host_ssh: str = ""
    host_ssh_key: str = "/root/.ssh/proxmox-os-helper"
    samba_conf: Path = Path("/etc/samba/proxmox-os-shares.conf")
    schedules_file: Path = Path(__file__).resolve().parent.parent / "data" / "schedules.json"


settings = Settings()
