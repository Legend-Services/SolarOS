"""Active hypervisor driver, chosen by HYPERVISOR_DRIVER in backend/.env.

Each driver is the package providers/<driver id>/ and is imported by name only when it is the active one, so a
distribution can ship without the packages of the other drivers. The package exposes create_provider() (the
HypervisorProvider), routers() (its HTTP routers, mounted ahead of the shared ones) and its platform constants.
"""
import importlib
import pkgutil
from pathlib import Path
from functools import cache
from types import ModuleType

import providers
from app.config import settings
from providers.base import HypervisorProvider


def drivers() -> list[str]:
    """Driver ids shipped in this distribution (the packages under providers/)."""
    return sorted(m.name for m in pkgutil.iter_modules(providers.__path__) if m.ispkg)


# Installs from before HYPERVISOR_DRIVER existed: the distribution that has them ships this defaults file.
LEGACY_DEFAULTS = Path(__file__).resolve().parents[2] / "deploy" / "env-defaults-legacy"


def default_driver() -> str:
    """The only driver of this distribution, else the legacy default shipped with it ("" when there is none)."""
    if len(drivers()) == 1:
        return drivers()[0]
    try:
        return next((line.split("=", 1)[1].strip() for line in LEGACY_DEFAULTS.read_text().splitlines()
                     if line.startswith("HYPERVISOR_DRIVER=")), "")
    except OSError:
        return ""


def driver_id() -> str:
    driver = settings.hypervisor_driver.strip().lower() or default_driver()
    if driver not in drivers():
        raise RuntimeError(f"Unknown HYPERVISOR_DRIVER {driver!r}; expected one of {', '.join(drivers())}")
    return driver


def driver_package() -> ModuleType:
    return importlib.import_module(f"providers.{driver_id()}")


@cache
def get_provider() -> HypervisorProvider:
    return driver_package().create_provider()


def routers() -> list:
    return driver_package().routers()
