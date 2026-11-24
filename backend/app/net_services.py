"""Network & Services: DNS + AdBlock, DHCP, WireGuard server/client, router/NAT and certificates."""
from fastapi import APIRouter, Depends

from .auth import require_user

router = APIRouter(tags=["net_services"], dependencies=[Depends(require_user)])
