import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from . import (apps, auth, backups, console, disk_benchmark, files, guest_hardware, hardware_admin, help_center, host_ssh, net_services, notifications,
               provisioning, pve, pve_access, pve_datacenter, schedules, shares, storage_admin, system, system_extra, tasks,
               telemetry)
from .config import settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = asyncio.create_task(schedules.scheduler_loop())
    yield
    scheduler.cancel()
    with suppress(asyncio.CancelledError):
        await scheduler
    await pve.close_client()
    await host_ssh.close()


app = FastAPI(title="ProxmoxOS API", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(auth.router)
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
               disk_benchmark):
    app.include_router(module.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "node": settings.pve_node}
