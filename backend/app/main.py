import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from . import apps, auth, console, files, notifications, pve, schedules, shares, storage_admin, system, tasks, telemetry
from .config import settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler = asyncio.create_task(schedules.scheduler_loop())
    yield
    scheduler.cancel()
    with suppress(asyncio.CancelledError):
        await scheduler
    await pve.close_client()


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


@app.get("/api/health")
def health():
    return {"status": "ok", "node": settings.pve_node}
