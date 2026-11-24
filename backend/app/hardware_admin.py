"""Host hardware inventory and the multi-vendor GPU driver / mode manager."""
from fastapi import APIRouter, Depends

from .auth import require_user

router = APIRouter(tags=["hardware_admin"], dependencies=[Depends(require_user)])
