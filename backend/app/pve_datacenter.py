"""Datacenter parity: firewall, logs and storage backends."""
from fastapi import APIRouter, Depends

from .auth import require_user

router = APIRouter(tags=["pve_datacenter"], dependencies=[Depends(require_user)])
