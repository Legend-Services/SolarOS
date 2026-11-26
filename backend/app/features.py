"""Features & Services: which optional parts of the interface are shown (data/enabled_features.json).

Every flag defaults to on, so an existing installation keeps everything visible until an administrator hides it.
The frontend hides Settings modules, inner tabs, search results and apps of disabled features; the core screens
(General & Appearance, Users & Security, System Services & Repositories, Features & Services) have no flag at all.

Turning off a feature with a background service pauses it: units of that feature that are running are recorded,
then disabled and stopped; turning it back on starts exactly those units again. Configuration files stay untouched.
"""
import json
import shlex
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import host_ssh
from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/system/features", tags=["features"], dependencies=[Depends(require_user)])

DATA = Path(__file__).resolve().parent.parent / "data"
STATE = DATA / "enabled_features.json"

# (key, domain, parent): a parent is another feature (the child only shows while it is on) or a heading id.
CATALOG: list[tuple[str, str, str | None]] = [
    ("virtual_switch", "network", None),
    ("vlan_dhcp", "network", "virtual_switch"),
    ("wireguard_server", "network", "wireguard"),
    ("wireguard_client", "network", "wireguard"),
    ("reverse_proxy", "network", None),
    ("vlan_firewall", "network", None),
    ("network_architect", "network", None),
    ("compute_vms", "compute", None),
    ("compute_containers", "compute", None),
    ("docker_engine", "compute", None),
    ("virtual_hardware", "compute", None),
    ("multiseat", "compute", None),
    ("clustering", "compute", None),
    ("image_hub", "compute", None),
    ("zfs_storage", "storage", None),
    ("smb_shares", "storage", None),
    ("nfs_webdav", "storage", None),
    ("backups_snapshots", "storage", None),
    ("offsite_dr", "storage", None),
    ("live_telemetry", "system", None),
    ("gpu_management", "system", None),
    ("bios_manager", "system", None),
    ("ups_power", "system", None),
    ("oob_bmc", "system", None),
    ("automation", "system", None),
    ("rbac_users", "system", None),
    ("api_keys", "system", None),
    ("app_center", "apps", None),
    ("local_ai", "apps", None),
]
KEYS = [k for k, _, _ in CATALOG]
PROTECTED = ["general-appearance", "users-roles", "software-updates", "features-services"]

# Host units paused while a feature is off (systemd globs). The reverse proxy is left alone on purpose: on a
# single-host install the same web server may also serve this interface, and stopping it would lock everyone out.
UNITS: dict[str, list[str]] = {
    "wireguard_server": ["wg-quick@wg0.service"],
    "wireguard_client": ["wg-quick@*.service"],
    "vlan_dhcp": [f"{settings.name('vlan-dhcp')}@*.service"],
    "ups_power": ["nut-monitor.service", "nut-server.service", "nut-client.service"],
}
EXCLUDE = {"wireguard_client": {"wg-quick@wg0.service"}}  # the server tunnel is not a client


def load() -> dict:
    try:
        saved = json.loads(STATE.read_text())
    except (OSError, ValueError):
        saved = {}
    flags = saved.get("enabled", {}) if isinstance(saved, dict) else {}
    return {"enabled": {k: bool(flags.get(k, True)) for k in KEYS}, "paused": saved.get("paused", {}) if isinstance(saved, dict) else {}}


def save(st: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=1))
    tmp.replace(STATE)


def view(st: dict | None = None, warnings: list[str] | None = None) -> dict:
    st = st or load()
    return {"features": [{"key": k, "domain": d, "parent": p, "enabled": st["enabled"][k],
                          "has_service": k in UNITS} for k, d, p in CATALOG],
            "enabled": st["enabled"], "protected": PROTECTED, "warnings": warnings or []}


def pause_script(feature: str) -> str:
    """Print, then disable and stop, the running units of `feature`."""
    pats = " ".join(shlex.quote(u) for u in UNITS[feature])
    skip = "|".join(sorted(EXCLUDE.get(feature, ()))) or "-"
    return (f"for u in $(systemctl list-units --state=active --plain --no-legend {pats} | awk '{{print $1}}'); do "
            f"case \"$u\" in {skip}) continue;; esac; echo \"$u\"; systemctl disable -q --now \"$u\" || true; done")


def resume_script(units: list[str]) -> str:
    return " ; ".join(f"systemctl enable -q --now {shlex.quote(u)} || true" for u in units) or "true"


async def apply(changes: dict[str, bool]) -> dict:
    """Store new flags and pause/resume background services of the features that changed. Returns view()."""
    unknown = sorted(set(changes) - set(KEYS))
    if unknown:
        raise HTTPException(422, f"Unknown feature: {', '.join(unknown)}")
    st = load()
    before = dict(st["enabled"])
    st["enabled"].update({k: bool(v) for k, v in changes.items()})
    save(st)  # the visibility change never waits on the host
    warnings = []
    for k in UNITS:
        if before[k] == st["enabled"][k]:
            continue
        try:
            if not st["enabled"][k]:
                out = await host_ssh.run(pause_script(k), check=False, timeout=90)
                st["paused"][k] = sorted(set(st["paused"].get(k, [])) | {u for u in out.split() if u.endswith(".service")})
            else:
                await host_ssh.run(resume_script(st["paused"].pop(k, [])), check=False, timeout=90)
        except Exception as e:  # noqa: BLE001 - host unreachable: the flag is saved, the service is left as it was
            warnings.append(f"{k}: {getattr(e, 'detail', None) or e}")
    save(st)
    return view(st, warnings)


def enabled(key: str) -> bool:
    return load()["enabled"].get(key, True)


class FeaturesBody(BaseModel):
    enabled: dict[str, bool] = Field(max_length=len(KEYS))


@router.get("")
def get_features():
    return view()


@router.put("")
async def put_features(body: FeaturesBody):
    return await apply(body.enabled)
