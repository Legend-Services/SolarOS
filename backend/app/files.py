import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .auth import require_user
from .config import settings

router = APIRouter(prefix="/api/files", tags=["files"], dependencies=[Depends(require_user)])


def root() -> Path:
    return settings.storage_root.resolve()


def safe_path(rel: str) -> Path:
    """Resolve a client path inside STORAGE_ROOT; symlinks and '..' that escape it are rejected."""
    base = root()
    target = (base / rel.lstrip("/")).resolve()
    if not target.is_relative_to(base):
        raise HTTPException(403, "Path escapes storage root")
    return target


def safe_name(name: str) -> str:
    if not name or name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
        raise HTTPException(400, f"Invalid name: {name!r}")
    return name


def rel(p: Path) -> str:
    r = p.relative_to(root())
    return "/" if r == Path(".") else "/" + r.as_posix()


def entry(p: Path) -> dict:
    st = p.stat()
    return {"name": p.name, "path": rel(p), "is_dir": p.is_dir(), "size": st.st_size, "mtime": st.st_mtime}


@router.get("/list")
def list_dir(path: str = "/"):
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(404, "Directory not found")
    items = []
    for p in d.iterdir():
        try:
            items.append(entry(p))
        except OSError:  # broken symlink or permission issue: skip rather than fail the listing
            continue
    items.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"path": rel(d), "items": items}


class MkdirBody(BaseModel):
    path: str
    name: str


@router.post("/mkdir")
def mkdir(body: MkdirBody):
    target = safe_path(body.path) / safe_name(body.name)
    if target.exists():
        raise HTTPException(409, "Already exists")
    target.mkdir()
    return entry(target)


@router.post("/upload")
def upload(path: str = Form("/"), files: list[UploadFile] = File(...)):
    d = safe_path(path)
    if not d.is_dir():
        raise HTTPException(404, "Directory not found")
    saved = []
    for f in files:
        target = d / safe_name(Path(f.filename or "").name)
        tmp = target.with_name(f".{target.name}.part")
        try:
            with tmp.open("wb") as out:
                shutil.copyfileobj(f.file, out, 1024 * 1024)
            tmp.replace(target)
        finally:
            tmp.unlink(missing_ok=True)
        saved.append(entry(target))
    return {"saved": saved}


@router.get("/download")
def download(path: str):
    p = safe_path(path)
    if not p.is_file():
        # shortcut: folders are not zipped on the fly; add a streaming zip if users ask for folder downloads.
        raise HTTPException(400, "Only files can be downloaded")
    return FileResponse(p, filename=p.name)


class RenameBody(BaseModel):
    path: str
    new_name: str


@router.patch("/rename")
def rename(body: RenameBody):
    src = safe_path(body.path)
    if src == root() or not src.exists():
        raise HTTPException(404, "Not found")
    dst = src.with_name(safe_name(body.new_name))
    if dst.exists():
        raise HTTPException(409, "Target already exists")
    src.rename(dst)
    return entry(dst)


@router.delete("/delete")
def delete(path: str):
    p = safe_path(path)
    if p == root():
        raise HTTPException(403, "Cannot delete storage root")
    if p.is_symlink() or p.is_file():
        p.unlink()
    elif p.is_dir():
        shutil.rmtree(p)
    else:
        raise HTTPException(404, "Not found")
    return {"ok": True}
