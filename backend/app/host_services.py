"""Settings > System Services: systemd services on the host, plus the nested-virtualization status for Hypervisor Defaults."""
import re
import shlex
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request

from . import audit_log, host_ssh
from .auth import client_ip, require_step_up_auth, require_user

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_user)])
UNIT_RE = r"^[A-Za-z0-9@._:-]{1,128}\.service$"
NESTED_FILES = ("/sys/module/kvm_intel/parameters/nested", "/sys/module/kvm_amd/parameters/nested")


def parse_units(out: str) -> list[dict]:
    """`systemctl list-units --plain --no-legend` lines -> [{unit, load, active, sub, description}]."""
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) >= 4 and re.match(UNIT_RE, parts[0]):
            rows.append({"unit": parts[0], "load": parts[1], "active": parts[2], "sub": parts[3], "description": parts[4] if len(parts) > 4 else ""})
    return rows


@router.get("/services")
async def services():
    out = await host_ssh.run("systemctl list-units --type=service --all --plain --no-legend --no-pager", timeout=30)
    return parse_units(out)


@router.post("/services/{unit}/{action}")
async def service_action(request: Request, unit: str = Path(pattern=UNIT_RE), action: Literal["start", "stop", "restart"] = Path(),
                         user: str = Depends(require_step_up_auth)):
    ok, _, err = await host_ssh.run_host_cmd(f"systemctl {action} {shlex.quote(unit)}", timeout=60)
    audit_log.record(f"service.{action}", user=user, ip=client_ip(request), ok=ok, unit=unit)
    if not ok:
        raise HTTPException(502, f"systemctl {action} {unit} failed: {err.strip()[:300]}")
    return {"ok": True}


@router.get("/nested-virt")
async def nested_virt():
    """kvm module `nested` parameter: Y/1 on, N/0 off, None when no kvm module is loaded."""
    ok, out, _ = await host_ssh.run_host_cmd(f"cat {' '.join(NESTED_FILES)} 2>/dev/null | head -n1")
    v = out.strip() if ok else ""
    return {"nested": v in ("Y", "1") if v else None, "raw": v or None}
