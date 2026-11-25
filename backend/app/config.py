import socket
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    # Hypervisor driver behind the provider-neutral API (a package under providers/; see providers.registry).
    hypervisor_driver: str = ""
    # Hypervisor API connection settings live in the driver package (providers/<driver id>/).
    node_name: str = socket.gethostname().split(".")[0]
    admin_username: str = "admin"
    admin_password: str = ""  # plaintext from older installs; replaced by ADMIN_PASSWORD_HASH on the next change
    admin_password_hash: str = ""
    # One-time code for first-run setup, shown on the server's console (written by the installer).
    setup_code_file: Path = Path("/etc/solardeck/setup-code")
    jwt_secret: str = ""
    jwt_ttl_hours: int = 12
    storage_root: Path = Path("/mnt/storage")
    default_bridge: str = "br0"  # bridge preselected for new guests and NICs (installers write DEFAULT_BRIDGE)
    # Prefix of every name SolarDeck creates on a host: helper, units, logs, config files, guest tags.
    system_prefix: str = "solardeck"
    # Root-only host operations (ZFS, bind mounts, /dev/dri) go through <prefix>-helper.
    # Empty HOST_SSH runs the helper locally (backend on the hypervisor host itself).
    host_ssh: str = ""
    host_ssh_key: str = ""  # default: /root/.ssh/<prefix>-helper
    # Unrestricted root key for the asyncssh bridge (host shells, container shells, drivers, network services).
    # The installer authorizes it on the host; the target defaults to HOST_SSH.
    host_root_key: Path = Path(__file__).resolve().parent.parent / ".ssh" / "id_ed25519"
    host_root_target: str = ""
    samba_conf: Path | None = None  # default: /etc/samba/<prefix>-shares.conf
    schedules_file: Path = Path(__file__).resolve().parent.parent / "data" / "schedules.json"
    security_file: Path = Path(__file__).resolve().parent.parent / "data" / "security.json"
    # Desktop layout, per-app views and wizard state, so they survive browser clears (GET/PUT /api/system/preferences).
    preferences_file: Path = Path(__file__).resolve().parent.parent / "data" / "user_preferences.json"
    # App Gallery "Most Used" / "Recently Used" sorting: launch counts per app (GET/POST /api/system/app-usage).
    app_usage_file: Path = Path(__file__).resolve().parent.parent / "data" / "app_usage.json"
    # Theme Studio: custom_themes.json and uploaded wallpapers/ (GET/POST /api/system/themes).
    themes_dir: Path = Path(__file__).resolve().parent.parent / "data" / "themes"
    # Automation & Alerts: notification channels, no-code rules and their execution log (/api/automation).
    alert_channels_file: Path = Path(__file__).resolve().parent.parent / "data" / "alert_channels.json"
    automation_rules_file: Path = Path(__file__).resolve().parent.parent / "data" / "automation_rules.json"
    automation_logs_file: Path = Path(__file__).resolve().parent.parent / "data" / "automation_logs.json"
    # Self-updater source; a deployment without .git is converted to a checkout of this repo on first update.
    repo_url: str = "https://github.com/Legend-Services/SolarOS.git"
    repo_branch: str = "main"
    update_settings_file: Path = Path(__file__).resolve().parent.parent / "data" / "update_settings.json"
    # Optional: lets the in-app bug reporter open GitHub issues directly (needs the "issues: write" scope).
    github_token: str = ""

    @model_validator(mode="after")
    def _prefixed_defaults(self):
        self.host_ssh_key = self.host_ssh_key or f"/root/.ssh/{self.system_prefix}-helper"
        self.samba_conf = self.samba_conf or Path(f"/etc/samba/{self.system_prefix}-shares.conf")
        return self

    def name(self, suffix: str) -> str:
        """A host-side name: <prefix>-<suffix> (solardeck-router, solardeck-guest, ...)."""
        return f"{self.system_prefix}-{suffix}"


settings = Settings()
