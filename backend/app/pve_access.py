"""Proxmox users, groups, roles, ACLs, pools, API tokens and realms (Datacenter → Permissions)."""
from fastapi import APIRouter, Depends

from .auth import require_user

router = APIRouter(tags=["pve_access"], dependencies=[Depends(require_user)])
