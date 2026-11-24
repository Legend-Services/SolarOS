import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import (apps, auth, automation, backups, bug_report, capabilities, console, disk_benchmark, domains, files, guest_hardware, hardware_admin, help_center, host_ssh, local_ai, net_services, notifications,
               provisioning, pve, pve_access, pve_datacenter, schedules, shares, storage_admin, system, system_extra, tasks,
               telemetry, themes, updater)
from .config import settings
from providers.registry import get_provider

NATIVE = settings.hypervisor_driver.strip().lower() == "native_ubuntu"


@asynccontextmanager
async def lifespan(_: FastAPI):
    host_ssh.public_key_or_none()  # create the bridge key on first start so install.sh / the UI can authorize it
    loops = [asyncio.create_task(schedules.scheduler_loop()), asyncio.create_task(updater.scheduler_loop()),
             asyncio.create_task(automation.scheduler_loop())]
    if NATIVE:
        loops.append(asyncio.create_task(get_provider().backup_scheduler_loop()))
    yield
    for t in loops:
        t.cancel()
        with suppress(asyncio.CancelledError):
            await t
    await pve.close_client()
    await host_ssh.close()


app = FastAPI(title="SolarDeck API", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(auth.router)
if NATIVE:
    # The standalone driver's routes shadow the Proxmox ones (first match wins), so they are mounted first.
    from providers.native_ubuntu import routes as native_routes
    app.include_router(native_routes.router)
    from providers.native_ubuntu import guest_edit as native_guest_edit
    app.include_router(native_guest_edit.router)
    app.include_router(native_routes.ws_router)
app.include_router(pve.router)
app.include_router(files.router)
app.include_router(console.router)
app.include_router(tasks.router)
app.include_router(apps.router)
app.include_router(shares.router)
app.include_router(telemetry.router)
app.include_router(notifications.router)
app.include_router(schedules.router)
app.include_router(system.router)
app.include_router(storage_admin.router)
app.include_router(provisioning.router)
app.include_router(backups.router)
app.include_router(system_extra.router)
for module in (host_ssh, pve_access, pve_datacenter, net_services, hardware_admin, guest_hardware, help_center,
               disk_benchmark, updater, bug_report, local_ai, domains, themes, automation):
    app.include_router(module.router)
app.include_router(themes.public)
app.include_router(automation.topology_router)
app.include_router(capabilities.router, prefix="/api/system")
app.include_router(capabilities.router, prefix="/api/v1/system")





@app.exception_handler(NotImplementedError)
async def not_implemented(_: Request, exc: NotImplementedError):
    # A driver that does not implement a contract method.
    return JSONResponse({"detail": str(exc) or "Not implemented by this hypervisor driver"}, status_code=501)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "SolarDeck", "node": settings.node_name, "driver": settings.hypervisor_driver}
