"""Guest hardware: device passthrough (PCI/GPU/USB), NICs, cloud-init, snapshots and options."""
from fastapi import APIRouter, Depends

from .auth import require_user

router = APIRouter(tags=["guest_hardware"], dependencies=[Depends(require_user)])
