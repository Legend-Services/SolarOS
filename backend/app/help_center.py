"""Help Center: health diagnostics with one-click fixes, each with a plain-language explainer and do-it-yourself steps.

Every check returns the same shape so the frontend wizard can walk any user through it:
  id, title, status (ok | info | warning | error), summary, details,
  fix: {label, changes[], reboot} or None, manual: [steps], link: {app, intent?}, bios: guide id or None
  (a BIOS/UEFI change only the user can make; see bios_guides.py and GET /api/help/bios).
Evaluators are pure functions (tested in tests/test_help_center.py); collection and fixes reuse existing modules.
"""
import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from . import bios_guides, host, host_ssh, notifications, pci
from .auth import load_security, require_user
from .backups import ScheduleBody, schedule_params
from .pve import _node, _safe, pve
from .system import flatten

router = APIRouter(prefix="/api/help", tags=["help"], dependencies=[Depends(require_user)])
FixId = Literal["repos", "iommu", "time", "updates", "backups"]


def item(id_: str, title: str, status: str, summary: str, details: str = "", fix: dict | None = None,
         manual: list[str] | None = None, link: dict | None = None, bios: str | None = None) -> dict:
    return {"id": id_, "title": title, "status": status, "summary": summary, "details": details, "fix": fix,
            "manual": manual or [], "link": link, "bios": bios}


def check_bridge(error: str | None) -> dict:
    if not error:
        return item("bridge", "Host connection (SSH key bridge)", "ok", "ProxmoxOS can run admin tasks on your Proxmox host.")
    return item("bridge", "Host connection (SSH key bridge)", "error",
                "ProxmoxOS cannot log in to your Proxmox host, so Host Shell, drivers, network services and fixes won't work.",
                error, None,
                ["On your computer, open a terminal in the ProxmoxOS folder and run ./deploy.sh (or run install.sh on the "
                 "Proxmox host as root). It re-creates and authorizes the ProxmoxOS key.",
                 "Make sure the host allows root logins with keys: in /etc/ssh/sshd_config, PermitRootLogin must not be 'no'.",
                 "Come back here and press 'Check again'."],
                {"app": "controlpanel", "intent": "security"})


def check_repos(repos: dict, subscription: dict) -> dict:
    flat = flatten(repos or {})["repositories"]
    has_sub = (subscription or {}).get("status") == "active"
    enterprise = [r for r in flat if r["enabled"] and (r["handle"] or "").endswith("enterprise")]
    no_sub = any(r["enabled"] and r["handle"] == "no-subscription" for r in flat)
    manual = ["Open the System app and go to Repositories.",
              "Switch OFF every repository marked 'enterprise' (Proxmox VE and Ceph).",
              "Click 'Add' next to 'No-Subscription' so updates still arrive.",
              "Go to Updates and press 'Refresh' — the 401 errors are gone."]
    if has_sub or not enterprise:
        status = "ok" if no_sub or has_sub else "warning"
        return item("repos", "Update sources (APT repositories)", status,
                    "Your update sources are set up correctly." if status == "ok" else
                    "No Proxmox update source is enabled, so the host never receives updates.",
                    fix=None if status == "ok" else {"label": "Add the free No-Subscription source",
                                                     "changes": ["Adds the Proxmox 'no-subscription' repository"], "reboot": False},
                    manual=[] if status == "ok" else manual, link={"app": "system"})
    return item("repos", "Update sources (APT repositories)", "warning",
                "The paid 'Enterprise' update source is on, but this server has no subscription. Updates fail with "
                "'401 Unauthorized' and you miss security fixes.",
                f"Enabled enterprise sources: {', '.join(sorted({r['path'] for r in enterprise}))}",
                {"label": "Switch to the free No-Subscription updates",
                 "changes": [f"Turns off {len(enterprise)} enterprise source(s)"] +
                            ([] if no_sub else ["Adds the Proxmox 'no-subscription' repository"]), "reboot": False},
                manual, {"app": "system"})


def check_iommu(enabled: bool, has_gpu: bool, cpu_vendor: str) -> dict:
    if enabled:
        return item("iommu", "Device passthrough (IOMMU / VT-d)", "ok", "Graphics cards and other devices can be passed to VMs.")
    flag = "amd_iommu=on" if cpu_vendor == "amd" else "intel_iommu=on"
    return item("iommu", "Device passthrough (IOMMU / VT-d)", "warning" if has_gpu else "info",
                "IOMMU is off, so you can't give a graphics card, USB controller or other PCI device to a VM.",
                "No IOMMU groups exist on the host. Both the BIOS setting and the kernel option are needed.",
                {"label": "Turn on IOMMU in the boot settings",
                 "changes": [f"Adds '{flag} iommu=pt' to the kernel command line (a backup copy is kept)",
                             "Loads the vfio modules at boot and rebuilds the boot images"], "reboot": True},
                ["Reboot the server and enter the BIOS/UEFI setup (usually Del or F2 while it starts).",
                 "Find 'Intel VT-d' (Intel) or 'AMD-Vi / IOMMU' (AMD), set it to Enabled, save and exit.",
                 f"Open Host Shell. If the host boots with systemd-boot (ZFS on UEFI), add '{flag} iommu=pt' to the end of "
                 "the single line in /etc/kernel/cmdline and run: proxmox-boot-tool refresh",
                 f"Otherwise (GRUB), add '{flag} iommu=pt' inside GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub and "
                 "run: update-grub",
                 "Reboot. Back here, 'Check again' should turn green."],
                {"app": "controlpanel", "intent": "hardware"}, bios="vt-d")


def check_vtx(enabled: bool) -> dict:
    if enabled:
        return item("vtx", "CPU virtualization (VT-x / AMD-V)", "ok", "The processor can run virtual machines.")
    return item("vtx", "CPU virtualization (VT-x / AMD-V)", "error",
                "CPU virtualization is switched off in the BIOS, so virtual machines cannot start (containers still work).",
                manual=["This can only be changed in the BIOS/UEFI setup. Open the BIOS instructions below: scan the QR code "
                        "with your phone so you can read the steps while the server restarts."],
                link={"app": "help"}, bios="vt-x")


def check_time(synced: bool | None) -> dict:
    if synced:
        return item("time", "Clock synchronisation", "ok", "The host clock is synchronised with internet time servers.")
    return item("time", "Clock synchronisation", "warning",
                "The host clock is not synchronised. Wrong time breaks certificates, 2FA codes, backup schedules and clusters.",
                fix={"label": "Turn on automatic time sync", "changes": ["Enables and starts chrony (NTP)"], "reboot": False},
                manual=["Open Host Shell.", "Run: systemctl enable --now chrony", "Run: chronyc tracking — 'Leap status: Normal' "
                        "means it works."],
                link={"app": "terminal"})


def check_twofa(enabled: bool) -> dict:
    if enabled:
        return item("twofa", "Sign-in protection (2FA)", "ok", "Two-factor authentication protects your sign-in.")
    return item("twofa", "Sign-in protection (2FA)", "warning",
                "Anyone who learns your password gets full control of the server (ProxmoxOS includes a root shell). "
                "Turn on 2FA so a code from your phone is also needed.",
                manual=["Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…).",
                        "Open Control Panel → User & Security → Two-Factor Authentication → 'Set up 2FA'.",
                        "Scan the QR code with the app and type the 6-digit code to confirm."],
                link={"app": "controlpanel", "intent": "security"})


def check_updates(updates: list) -> dict:
    n = len(updates or [])
    if not n:
        return item("updates", "Host updates", "ok", "No pending host updates were found (press Refresh in System → Updates "
                    "to check again).", link={"app": "system"})
    security = sum(1 for u in updates if "security" in (u.get("Origin", "") + u.get("Section", "")).lower())
    return item("updates", "Host updates", "warning" if n >= 20 or security else "info",
                f"{n} update(s) are waiting{f', including {security} security update(s)' if security else ''}.",
                fix={"label": "Install all host updates now", "changes": [f"Runs apt dist-upgrade for {n} package(s)",
                                                                          "Keeps your existing configuration files"],
                     "reboot": False},
                manual=["Open the System app → Updates.", "Press 'Refresh', then 'Upgrade'.",
                        "If a new kernel was installed, reboot the host when convenient (Control Panel → System & Power)."],
                link={"app": "system"})


def backup_storage(storages: list) -> str | None:
    return next((s["storage"] for s in storages or [] if s.get("enabled", 1) and s.get("active", 1)
                 and "backup" in (s.get("content") or "")), None)


def check_backups(jobs: list, storages: list) -> dict:
    if any(j.get("enabled", 1) for j in jobs or []):
        return item("backups", "Automatic backups", "ok", "At least one automatic backup job is active.", link={"app": "backup"})
    target = backup_storage(storages)
    return item("backups", "Automatic backups", "warning",
                "No automatic backups are scheduled. If a disk dies or an update goes wrong, your VMs and containers are lost.",
                f"Suggested storage: {target}" if target else "No storage accepts backups yet.",
                {"label": f"Back up every guest each Sunday at 02:00 to '{target}'",
                 "changes": ["Creates a Proxmox backup job for all VMs and containers (snapshot mode, zstd)",
                             "Keeps the last 4 backups of each guest"], "reboot": False} if target else None,
                ["Open Backup Center → Schedules → 'New schedule'.", "Choose 'All guests', a storage and a time (e.g. Sunday 02:00).",
                 "Set 'Keep last' to 4 or more and save.", "Tip: store backups on a different disk than your VMs."],
                {"app": "backup"})


def check_gpu_drivers(devices: list) -> list[dict]:
    out = []
    for d in devices:
        if d["gpu"] and d["vendor"] == "nvidia" and d["driver"] == "nouveau":
            out.append(item(f"gpu:{d['id']}", f"NVIDIA graphics card ({d['id']})", "info",
                            f"{d['name']} uses the basic open-source 'nouveau' driver: no CUDA, no AI/transcoding acceleration "
                            "and no VM passthrough.",
                            manual=["Open Control Panel → Hardware & System → GPU & Drivers.",
                                    "To use the card on the host or in containers: 'Install NVIDIA driver'.",
                                    "To give the card to one VM: 'Switch to VM Passthrough Mode'.",
                                    "Reboot when the log says it is finished."],
                            link={"app": "controlpanel", "intent": "hardware"}))
    return out


def from_alerts(alerts: list) -> list[dict]:
    status = {"critical": "error", "warning": "warning", "info": "info"}
    app = {"zfs": "storage", "capacity": "storage", "disk": "storage", "task": "monitor"}
    return [item(f"alert:{a['id']}", a["title"], status.get(a["severity"], "info"), a["message"],
                 manual=["Open the linked app to see the details.", "Capacity: delete old snapshots/backups or add disks.",
                         "Disk/SMART problems: back up now and replace the disk."], link={"app": app.get(a["category"], "monitor")})
            for a in alerts]


async def _bridge_error() -> str | None:
    try:
        await host_ssh.run("true", timeout=15)
        return None
    except HTTPException as e:
        return str(e.detail)


BIOS_PROBE = ("for k in system-manufacturer baseboard-manufacturer baseboard-product-name bios-vendor bios-version; do "
              "echo \"$k=$(dmidecode -s $k 2>/dev/null | head -1)\"; done; "
              "echo \"virt=$(grep -cE 'vmx|svm' /proc/cpuinfo)\"; echo \"cpu=$(grep -m1 vendor_id /proc/cpuinfo)\"; "
              "echo \"sb=$(mokutil --sb-state 2>/dev/null || od -An -t u1 /sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c 2>/dev/null | awk '{print $NF}')\"")


def parse_bios_facts(out: str) -> dict:
    kv = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    sb = kv.get("sb", "").strip()
    return {"manufacturer": kv.get("system-manufacturer", ""), "board_vendor": kv.get("baseboard-manufacturer", ""),
            "board": kv.get("baseboard-product-name", ""), "bios_vendor": kv.get("bios-vendor", ""),
            "bios_version": kv.get("bios-version", ""), "virtualization": kv.get("virt", "0").strip() not in ("", "0"),
            "cpu": "amd" if "AMD" in kv.get("cpu", "") else "intel",
            "secure_boot": "enabled" in sb.lower() or sb == "1"}


async def _host_facts() -> tuple[bool | None, str]:
    try:
        out = await host_ssh.run("timedatectl show -p NTPSynchronized --value; grep -m1 vendor_id /proc/cpuinfo", timeout=15)
    except HTTPException:
        return None, "intel"
    lines = out.splitlines() + ["", ""]
    return lines[0].strip() == "yes", "amd" if "AMD" in lines[1] else "intel"


async def _probe() -> dict | None:
    try:
        return await pci.probe()
    except HTTPException:
        return None


@router.get("/diagnostics")
async def diagnostics():
    bridge_err, (synced, vendor), probe, repos, sub, updates, jobs, stores, alerts = await asyncio.gather(
        _bridge_error(), _host_facts(), _probe(), _safe(_node("/apt/repositories")), _safe(_node("/subscription"), {}),
        _safe(_node("/apt/update")), _safe("/cluster/backup"), _safe(_node("/storage"), [], params={"content": "backup"}),
        notifications.notifications(),
    )
    # A None result means the Proxmox API call failed: skip that check instead of reporting a false problem.
    items = [check_bridge(bridge_err), check_twofa(bool(load_security().get("totp_enabled")))]
    items += [check_repos(repos, sub)] if repos is not None else []
    items += [check_updates(updates)] if updates is not None else []
    items += [check_backups(jobs, stores)] if jobs is not None else []
    if synced is not None:
        items.append(check_time(synced))
    if probe:
        devs = probe["devices"]
        items.append(check_iommu(probe["iommu_enabled"], any(d["gpu"] for d in devs), vendor))
        try:
            items.append(check_vtx(parse_bios_facts(await host_ssh.run(BIOS_PROBE, timeout=20))["virtualization"]))
        except HTTPException:
            pass
        items += check_gpu_drivers(devs)
    items += from_alerts(alerts["alerts"])
    rank = {"error": 0, "warning": 1, "info": 2, "ok": 3}
    return sorted(items, key=lambda i: rank[i["status"]])


@router.get("/bios")
async def bios(vendor: str | None = Query(None, pattern=r"^[a-z]{2,12}$")):
    """BIOS/UEFI guides for this board (or `vendor` override), marking the ones this host needs, with text QR codes."""
    try:
        facts = parse_bios_facts(await host_ssh.run(BIOS_PROBE, timeout=20))
    except HTTPException:  # host unreachable: still show the guides, with generic menus and nothing marked "needed"
        facts = parse_bios_facts("virt=1")
    probe = await _probe()
    detected = bios_guides.detect_vendor(facts["board_vendor"], facts["manufacturer"], facts["bios_vendor"])
    v = vendor if vendor in bios_guides.VENDORS else detected
    nvidia = any(d["gpu"] and d["vendor"] == "nvidia" for d in (probe or {}).get("devices", []))
    needed = {"vt-x": not facts["virtualization"], "vt-d": not (probe or {}).get("iommu_enabled", True),
              "above4g": None if nvidia else False, "primary-display": None if nvidia else False,
              "secure-boot": facts["secure_boot"] and nvidia}
    board = " ".join(dict.fromkeys(x for x in (facts["board_vendor"], facts["board"]) if x)).strip()
    guides = [bios_guides.build_guide(t, v, facts["cpu"], needed[t], board) for t in bios_guides.TOPICS]
    return {"facts": facts, "detected_vendor": detected, "vendor": v,
            "vendors": [{"id": k, "name": n} for k, (n, _, _) in bios_guides.VENDORS.items()],
            # needed first, then recommended (None), then the rest
            "guides": sorted(guides, key=lambda g: {True: 0, None: 1, False: 2}[g["needed"]])}


IOMMU_SCRIPT = r"""
P="__FLAG__ iommu=pt"
# Never pipe into grep -q here: jobs run with pipefail and its early exit SIGPIPEs the writer, failing the test.
if [ -d /sys/firmware/efi ] && [ -f /etc/kernel/cmdline ] && [[ "$(proxmox-boot-tool status 2>/dev/null)" == *uefi* ]]; then
  echo "==> systemd-boot detected: editing /etc/kernel/cmdline (backup: /etc/kernel/cmdline.proxmox-os.bak)"
  cp -n /etc/kernel/cmdline /etc/kernel/cmdline.proxmox-os.bak
  for p in $P; do grep -qw -- "$p" /etc/kernel/cmdline || sed -i "1 s/[[:space:]]*\$/ $p/" /etc/kernel/cmdline; done
  cat /etc/kernel/cmdline
  proxmox-boot-tool refresh
else
  echo "==> GRUB detected: editing /etc/default/grub (backup: /etc/default/grub.proxmox-os.bak)"
  cp -n /etc/default/grub /etc/default/grub.proxmox-os.bak
  for p in $P; do
    grep -q "^GRUB_CMDLINE_LINUX_DEFAULT=.*$p" /etc/default/grub \
      || sed -i "s/^GRUB_CMDLINE_LINUX_DEFAULT=\"\(.*\)\"/GRUB_CMDLINE_LINUX_DEFAULT=\"\1 $p\"/" /etc/default/grub
  done
  grep ^GRUB_CMDLINE_LINUX_DEFAULT /etc/default/grub
  update-grub
fi
printf 'vfio\nvfio_iommu_type1\nvfio_pci\n' > /etc/modules-load.d/proxmox-os-iommu.conf
update-initramfs -u -k all
echo "==> Done. Reboot the host. If IOMMU is still off afterwards, enable VT-d / AMD-Vi in the BIOS/UEFI setup."
"""


@router.post("/fix/{fix_id}")
async def fix(fix_id: FixId):
    """Apply a fix. Returns {message, job?}; a job streams its log at /api/host/jobs/{job}."""
    if fix_id == "repos":
        data = await pve("GET", _node("/apt/repositories")) or {}
        flat = flatten(data)
        for r in flat["repositories"]:
            if r["enabled"] and (r["handle"] or "").endswith("enterprise"):
                await pve("POST", _node("/apt/repositories"), data={"path": r["path"], "index": r["index"], "enabled": 0})
        if not any(r["enabled"] and r["handle"] == "no-subscription" for r in flat["repositories"]):
            await pve("PUT", _node("/apt/repositories"), data={"handle": "no-subscription"})
        await pve("POST", _node("/apt/update"))
        return {"message": "Enterprise sources are off and the free No-Subscription source is on. The update list is refreshing."}
    if fix_id == "iommu":
        _, vendor = await _host_facts()
        await host_ssh.start_job("help-iommu", IOMMU_SCRIPT.replace("__FLAG__", "amd_iommu=on" if vendor == "amd" else "intel_iommu=on"))
        return {"message": "Updating the boot settings…", "job": "help-iommu"}
    if fix_id == "time":
        await host_ssh.run("systemctl enable --now chrony 2>/dev/null || timedatectl set-ntp true; chronyc makestep >/dev/null 2>&1 || true")
        return {"message": "Automatic time synchronisation is on."}
    if fix_id == "updates":
        await host.run(["apt-upgrade"])
        return {"message": "Updates are installing in the background. Follow the progress in System → Updates."}
    stores = await _safe(_node("/storage"), [], params={"content": "backup"})
    target = backup_storage(stores)
    if not target:
        raise HTTPException(409, "No storage accepts backups. Add one in Storage & ZFS → Storage backends first.")
    await pve("POST", "/cluster/backup", data=schedule_params(ScheduleBody(
        schedule="sun 02:00", storage=target, keep_last=4, comment="Created by the ProxmoxOS Help Center")))
    return {"message": f"Every VM and container is now backed up each Sunday at 02:00 to '{target}' (last 4 kept)."}
