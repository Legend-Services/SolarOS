from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import auth, files, pve
from .config import settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await pve.close_client()


app = FastAPI(title="ProxmoxOS API", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(auth.router)
app.include_router(pve.router)
app.include_router(files.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "node": settings.pve_node}
