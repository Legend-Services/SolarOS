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
    # Unrestricted root key for the asyncssh bridge (host shells, pct enter, drivers, network services).
    # install.sh authorizes it in root@PVE_HOST:/root/.ssh/authorized_keys; the target defaults to HOST_SSH.
    host_root_key: Path = Path(__file__).resolve().parent.parent / ".ssh" / "id_ed25519"
    host_root_target: str = ""
    samba_conf: Path = Path("/etc/samba/proxmox-os-shares.conf")
    schedules_file: Path = Path(__file__).resolve().parent.parent / "data" / "schedules.json"
    security_file: Path = Path(__file__).resolve().parent.parent / "data" / "security.json"
    # Self-updater source; a deployment without .git is converted to a checkout of this repo on first update.
    repo_url: str = "https://github.com/Legend-Services/SolarOS.git"
    repo_branch: str = "main"


settings = Settings()
