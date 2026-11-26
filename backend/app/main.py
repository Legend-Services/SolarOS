import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import (apps, audit_log, auth, automation, branding, bug_report, capabilities, console, disk_benchmark, domains, files, hardware_admin, help_center, host_services, host_ssh, hypervisor, local_ai, net_services, network_switch, notifications,
               provisioning, schedules, security, shares, storage_admin, system, system_extra, task_progress,
               telemetry, themes, updater, virtual_hardware)
from .config import settings
from providers import registry
from providers.registry import get_provider


@asynccontextmanager
async def lifespan(_: FastAPI):
    host_ssh.public_key_or_none()  # create the bridge key on first start so install.sh / the UI can authorize it
    loops = [asyncio.create_task(schedules.scheduler_loop()), asyncio.create_task(updater.scheduler_loop()),
             asyncio.create_task(automation.scheduler_loop()), asyncio.create_task(virtual_hardware.shaping_loop())]
    loops += [asyncio.create_task(c) for c in get_provider().scheduler_loops()]
    yield
    for t in loops:
        t.cancel()
        with suppress(asyncio.CancelledError):
            await t
    await get_provider().close()
    await host_ssh.close()


app = FastAPI(title="SolarDeck API", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(auth.router)
# The active driver's routes come first (first match wins), so they shadow shared handlers of the same paths.
for r in registry.routers():
    app.include_router(r)
app.include_router(hypervisor.router)
app.include_router(files.router)
app.include_router(console.router)
app.include_router(apps.router)
app.include_router(shares.router)
app.include_router(telemetry.router)
app.include_router(notifications.router)
app.include_router(schedules.router)
app.include_router(system.router)
app.include_router(storage_admin.router)
app.include_router(provisioning.router)
app.include_router(system_extra.router)
app.include_router(task_progress.router)
for module in (host_ssh, net_services, hardware_admin, help_center, disk_benchmark, updater, bug_report, local_ai, domains,
               themes, branding, automation, security, host_services, network_switch, virtual_hardware):
    app.include_router(module.router)
app.include_router(themes.public)
app.include_router(virtual_hardware.public)
app.include_router(capabilities.router, prefix="/api/system")
app.include_router(capabilities.router, prefix="/api/v1/system")


@app.middleware("http")
async def audit_requests(request: Request, call_next):
    """Security-relevant changes (audit_log.HTTP_EVENTS) go to the hash-chained audit log with their outcome."""
    response = await call_next(request)
    if event := audit_log.http_event(request.method, request.url.path):
        if response.status_code != 403 or request.headers.get(auth.STEP_UP_HEADER):  # not the step-up prompt itself
            audit_log.record(event, user=auth.user_or_none(request), ip=auth.client_ip(request),
                             ok=response.status_code < 400, status=response.status_code, path=request.url.path)
    return response


@app.exception_handler(NotImplementedError)
async def not_implemented(_: Request, exc: NotImplementedError):
    # A driver that does not implement a contract method.
    return JSONResponse({"detail": str(exc) or "Not implemented by this hypervisor driver"}, status_code=501)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "SolarDeck", "node": settings.node_name, "driver": settings.hypervisor_driver}
