from fastapi import APIRouter

from providers.base import ProviderCapabilities
from providers.registry import get_provider

# Mounted at /api/system and /api/v1/system (main.py). Public on purpose: the sign-in screen shows the platform label,
# and the object only names the driver and its feature flags (no host data).
router = APIRouter(tags=["capabilities"])


@router.get("/capabilities", response_model=ProviderCapabilities)
def capabilities():
    return get_provider().get_capabilities()
