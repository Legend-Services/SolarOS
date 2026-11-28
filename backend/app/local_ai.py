"""Solar AI Studio (app id "local-ai"): compute discovery, model library, pulls and chat proxy, plus the install hooks shared by the drivers.

The AI container is created by the driver's App Center (app id "local-ai"), which also maps the GPU into it. This
module keeps the active container in data/local_ai.json and talks to Ollama on <container ip>:11434; commands inside
the container go through the active provider (container_exec).
"""
import asyncio
import base64
import binascii
import hashlib
import html
import json
import math
import re
import time
import uuid
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, StringConstraints

from . import host_ssh, pci
from .apps import MODEL_RE, TARGET_RE, DeployBody, StaticIP
from .auth import require_user
from .hardware_admin import NVIDIA_CMD, parse_lscpu, parse_meminfo, parse_nvidia, split_sections
from providers.registry import get_provider

router = APIRouter(prefix="/api/ai", tags=["local_ai"], dependencies=[Depends(require_user)])


DATA = Path(__file__).resolve().parent.parent / "data"
STATE_FILE = DATA / "local_ai.json"
HOST_MODELS = "/mnt/storage/ai-models"
MODELS_DIR = "/usr/share/ollama/.ollama/models"
NV_EXTRA_DEVS = ("nvidiactl", "nvidia-uvm", "nvidia-uvm-tools", "nvidia-modeset")
NV_Q = "index,pci.bus_id,name,memory.total,memory.free,driver_version"
GB_PER_B = 0.6  # Q4_K_M weights ≈ 0.57 GB per billion parameters, rounded up
OVERHEAD_GB = 1.5  # KV cache for a 4–8K context + CUDA runtime
CACHE_TTL = 900


# Ollama defaults to a 32K context, whose KV cache pushes a 32B model past 24 GB (CPU offload). The VRAM estimates
# above assume this smaller window.
CONTEXT_LENGTH = 8192


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(**patch) -> dict:
    s = {**load_state(), **patch}
    STATE_FILE.write_text(json.dumps(s, indent=2))
    return s


def _installed() -> dict:
    s = load_state()
    if not s.get("vmid"):
        raise HTTPException(404, "Solar AI Studio is not installed yet. Install it from App Center → AI & Compute.")
    return s


def _int(v: str) -> int | None:
    return int(float(v)) if re.fullmatch(r"[\d.]+", v.strip()) else None


def parse_nv_list(text: str) -> list[dict]:
    """nvidia-smi --query-gpu=NV_Q csv → [{index, pci "01:00.0", name, vram_total_mb, vram_free_mb, driver_version}]."""
    out = []
    for line in text.splitlines():
        c = [x.strip() for x in line.split(",")]
        if len(c) == 6 and c[0].isdigit():
            out.append({"index": int(c[0]), "pci": c[1].lower()[-7:], "name": c[2], "vram_total_mb": _int(c[3]),
                        "vram_free_mb": _int(c[4]), "driver_version": c[5]})
    return out


def parse_majors(text: str) -> dict[str, int]:
    """`stat -c '%n %t'` lines (hex major) → {"/dev/nvidia0": 195, ...}."""
    return {m[1]: int(m[2], 16) for m in re.finditer(r"^(/dev/\S+) ([0-9a-f]+)$", text, flags=re.M)}


def params_b(size: str) -> float | None:
    """Library size badge → billions of parameters: "32b" 32, "0.5b" 0.5, "137m" 0.137, "8x7b" 56, "e4b" 4."""
    m = re.fullmatch(r"(?:(\d+)x)?e?(\d+(?:\.\d+)?)([bm])", size.strip().lower())
    if not m:
        return None
    n = float(m[2]) * (int(m[1]) if m[1] else 1)
    return round(n / 1000, 3) if m[3] == "m" else n


def vram_required_gb(p: float) -> float:
    return round(p * GB_PER_B + OVERHEAD_GB, 1)


def vram_fit(need_gb: float, vram_gb: float) -> str:
    if not vram_gb:
        return "cpu_only"
    return "optimal_gpu" if need_gb <= vram_gb * 0.9 else "tight_gpu" if need_gb <= vram_gb else "cpu_offload"


def max_params_b(mem_gb: float) -> int:
    return max(0, math.floor((mem_gb * 0.95 - OVERHEAD_GB) / GB_PER_B))


def recommendation(vram_gb: float | None, ram_gb: float, shared: bool = False) -> str:
    if vram_gb:
        return f"{vram_gb:.0f} GB VRAM → up to ~{max_params_b(vram_gb)}B Q4 models at 100% GPU speed"
    if shared:
        return f"Shared system memory → best with 3B–8B Q4 models (up to ~{max_params_b(ram_gb * 0.5)}B fits)"
    return f"CPU only, {ram_gb:.0f} GB RAM → up to ~{max_params_b(ram_gb * 0.5)}B Q4 models at reduced speed"


def category(name: str, caps: list[str]) -> str:
    if "embedding" in caps:
        return "Embeddings"
    if "vision" in caps:
        return "Vision"
    if re.search(r"cod(e|er|estral)|starcoder|devstral", name):
        return "Coding"
    if "thinking" in caps or re.search(r"(^|-)r1|qwq|reason", name):
        return "Reasoning"
    return "General"


# Model names and Ollama families that take images; used when Ollama does not report capabilities (pre-0.6).
VISION_HINTS = ("vision", "clip", "mllama", "llava", "minicpm-v", "gemma3", "qwen2.5vl", "qwen2-vl", "qwen2vl", "bakllava",
                "moondream", "granite3.2-vision")


def supports_vision(name: str, families: list[str] | None = None, caps: list[str] | None = None) -> bool:
    """Ollama's own capability list wins (it knows gemma3:1b is text-only); otherwise match the name and families."""
    if caps:
        return "vision" in caps
    hay = " ".join([name, *(families or [])]).lower()
    return any(h in hay for h in VISION_HINTS)


def parse_library(page: str) -> list[dict]:
    """ollama.com/library HTML → [{name, description, sizes, capabilities, pulls}]. Cloud-only models are skipped."""
    out = []
    for li in re.split(r"<li\s", page)[1:]:
        m = re.search(r'href="/library/([^"/?#]+)"', li)
        if not m:
            continue
        desc = re.search(r'<p class="max-w-lg[^"]*">(.*?)</p>', li, re.S)
        badges = [html.unescape(b).strip() for b in re.findall(r'<span\s+class="inline-flex[^"]*">([^<]+)</span>', li)]
        sizes = [b for b in badges if params_b(b) is not None]
        caps = [b.lower() for b in badges if b not in sizes]
        pulls = re.search(r"<span\s*>([\d.]+[KMB]?)</span>\s*<span[^>]*>&nbsp;Pulls", li)
        if "cloud" in caps and not sizes:
            continue
        out.append({"name": html.unescape(m[1]), "description": html.unescape(re.sub(r"\s+", " ", desc[1])).strip()
                    if desc else "", "sizes": sizes, "capabilities": caps, "pulls": pulls[1] if pulls else None})
    return out


def annotate(model: dict, vram_gb: float) -> dict:
    tags = []
    for size in model["sizes"] or ["latest"]:
        p = params_b(size)
        need = vram_required_gb(p) if p is not None else None
        tags.append({"tag": f"{model['name']}:{size}", "size": size, "params_b": p,
                     "download_gb": round(p * GB_PER_B * 0.95, 1) if p is not None else None,
                     "vram_required_gb": need, "vram_fit": vram_fit(need, vram_gb) if need is not None
                     else ("optimal_gpu" if vram_gb else "cpu_only")})
    return {**model, "category": model.get("category") or category(model["name"], model["capabilities"]), "tags": tags,
            "supports_vision": supports_vision(model["name"], caps=model["capabilities"] or None)}


def ollama_env(target: str, flash: bool, kv_q8: bool) -> str:
    env = {"OLLAMA_HOST": "0.0.0.0:11434", "OLLAMA_CONTEXT_LENGTH": str(CONTEXT_LENGTH)}
    if target == "cpu":
        env["CUDA_VISIBLE_DEVICES"] = "-1"
    elif target.startswith(("intel:", "amd:")):
        env["OLLAMA_VULKAN"] = "1"
    if flash:
        env["OLLAMA_FLASH_ATTENTION"] = "1"
        if kv_q8:  # quantized KV cache requires flash attention
            env["OLLAMA_KV_CACHE_TYPE"] = "q8_0"
    return "# Managed by SolarDeck Solar AI Studio\n[Service]\n" + "".join(f'Environment="{k}={v}"\n' for k, v in env.items())


FALLBACK: list[dict] = [
    {"name": "qwen2.5-coder", "category": "Coding", "sizes": ["7b", "14b", "32b"], "capabilities": ["tools"],
     "description": "Code-specific Qwen 2.5 models for code generation, reasoning and fixing. The 32B rivals frontier coding models."},
    {"name": "deepseek-r1", "category": "Reasoning", "sizes": ["7b", "8b", "14b", "32b", "70b"], "capabilities": ["thinking"],
     "description": "Open reasoning models that think step by step before answering, strong at math and logic."},
    {"name": "gemma3", "category": "Vision", "sizes": ["4b", "12b", "27b"], "capabilities": ["vision"],
     "description": "Google's capable single-GPU model family with image understanding and a 128K context window."},
    {"name": "llama3.3", "category": "General", "sizes": ["70b"], "capabilities": ["tools"],
     "description": "Meta's 70B model with performance similar to much larger models. Needs CPU offload on a 24 GB GPU."},
    {"name": "llama3.1", "category": "General", "sizes": ["8b", "70b"], "capabilities": ["tools"],
     "description": "Meta's versatile model family with tool calling; the 8B is a fast everyday assistant."},
    {"name": "mistral-small", "category": "General", "sizes": ["22b", "24b"], "capabilities": ["tools"],
     "description": "Mistral's best model under 70B: fast, multilingual, with function calling."},
    {"name": "qwen2.5", "category": "General", "sizes": ["7b", "14b", "32b"], "capabilities": ["tools"],
     "description": "Multilingual general-purpose models with a 128K context and strong instruction following."},
    {"name": "qwen3", "category": "Reasoning", "sizes": ["8b", "14b", "30b", "32b"], "capabilities": ["tools", "thinking"],
     "description": "Latest Qwen generation with switchable thinking mode for hard problems."},
    {"name": "phi4", "category": "General", "sizes": ["14b"], "capabilities": [],
     "description": "Microsoft's 14B model, strong at reasoning for its size."},
    {"name": "codestral", "category": "Coding", "sizes": ["22b"], "capabilities": [],
     "description": "Mistral's coding model trained on 80+ programming languages."},
    {"name": "llama3.2-vision", "category": "Vision", "sizes": ["11b", "90b"], "capabilities": ["vision"],
     "description": "Llama 3.2 Vision reads photos, screenshots, charts and documents and answers questions about them."},
    {"name": "llava", "category": "Vision", "sizes": ["7b", "13b", "34b"], "capabilities": ["vision"],
     "description": "Vision-language model that describes and answers questions about images."},
    {"name": "nomic-embed-text", "category": "Embeddings", "sizes": ["137m"], "capabilities": ["embedding"],
     "description": "High-quality text embeddings for search and retrieval (RAG) in Open WebUI."},
]
_cache: dict[str, tuple[float, list[dict]]] = {}


async def library(q: str) -> tuple[list[dict], str]:
    """(models, source) from ollama.com/library, cached 15 minutes; the built-in list when the site is unreachable."""
    key = q.strip().lower()
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1], "ollama.com"
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers={"User-Agent": "SolarDeck"}) as c:
            r = await c.get("https://ollama.com/library", params={"q": key} if key else None)
            r.raise_for_status()
        models = parse_library(r.text)
        if models:
            _cache[key] = (time.monotonic(), models)
            return models, "ollama.com"
    except httpx.HTTPError:
        pass
    return [m for m in FALLBACK if key in f"{m['name']} {m['description']}".lower()], "built-in"


def _base() -> str:
    return _installed()["ollama_url"]


async def ollama(method: str, path: str, timeout: float = 30, **kw) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.request(method, _base() + path, **kw)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama API unreachable at {_base()}: {e or type(e).__name__}")
    if r.status_code >= 400:
        try:
            msg = r.json().get("error") or r.text
        except ValueError:
            msg = r.text
        raise HTTPException(r.status_code if r.status_code < 500 else 502, f"Ollama: {msg[:300]}")
    return r.json() if r.content else {}


HW_PROBE = f"""
echo @@nv@@; command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu={NV_Q} --format=csv,noheader,nounits 2>/dev/null
echo @@mods@@; grep -oE '^nvidia(_uvm|_modeset|_drm)? ' /proc/modules
echo @@devs@@; ls /dev/nvidia[0-9]* /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia-uvm-tools /dev/nvidia-modeset 2>/dev/null
echo @@dri@@
for r in /dev/dri/renderD*; do [ -e "$r" ] || continue; d=/sys/class/drm/$(basename $r)/device
  echo "$r $(basename $(readlink -f $d)) $(cat $d/vendor 2>/dev/null)"; done
echo @@lscpu@@; lscpu -J 2>/dev/null
echo @@meminfo@@; cat /proc/meminfo
"""


async def _exec(vmid: int, script: str, timeout: float = 120, on_line=None) -> str:
    """Run a bash script as root inside the (running) container."""
    return await get_provider().container_exec(vmid, script, timeout=timeout, log=on_line)


_pending: dict[int, dict] = {}


async def after_install(vmid: int, body: DeployBody, ip: str | None, log) -> None:
    """App Center hook (install script finished): Ollama settings, state file, starter model downloads."""
    info = _pending.pop(vmid, {})
    log("==> Applying Ollama settings (flash attention on)")
    await _exec(vmid, _env_script(ollama_env(body.compute_target, True, False)))
    save_state(vmid=vmid, hostname=body.hostname, ip=ip, ollama_url=f"http://{ip}:11434" if ip else None,
               webui_url=f"http://{ip}:3000" if ip and body.install_open_webui else None,
               open_webui=body.install_open_webui, compute_target=body.compute_target, flash_attention=True,
               kv_cache_q8=False, model_storage=HOST_MODELS if body.mount_storage else None, installed_at=int(time.time()),
               **info)
    for m in body.starter_models:
        log(f"==> Downloading starter model {m} in the background (Solar AI Studio → Installed Models)")
        start_pull(m)


def _env_script(dropin: str) -> str:
    d = "/etc/systemd/system/ollama.service.d"
    return (f"mkdir -p {d}\ncat > {d}/solardeck.conf <<'SOLARDECK_EOF'\n{dropin}SOLARDECK_EOF\n"
            "systemctl daemon-reload\nsystemctl restart ollama\n"
            "for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && exit 0; sleep 1; done\n"
            "echo 'Ollama did not come back up'; exit 1\n")


async def _ip(vmid: int) -> str | None:
    return await get_provider().container_ip(vmid)


@router.get("/hardware")
async def hardware():
    async def lspci() -> list[dict]:
        try:
            return (await pci.probe())["devices"]
        except HTTPException:
            return []

    (ok, out, err), devices = await asyncio.gather(host_ssh.run_host_cmd(HW_PROBE + "\ntrue", timeout=30), lspci())
    s = split_sections(out)
    mods, nodes = s.get("mods", "").split(), s.get("devs", "").split()
    cpu, mem = parse_lscpu(s.get("lscpu", "")), parse_meminfo(s.get("meminfo", ""))
    ram_gb = mem.get("MemTotal", 0) / 2**30
    by_pci = {d["id"]: d for d in devices}
    targets = []
    nv = parse_nv_list(s.get("nv", ""))
    for g in nv:
        vram = (g["vram_total_mb"] or 0) / 1024
        targets.append({"id": f"nvidia:{g['pci']}", "kind": "nvidia", "name": g["name"], "pci": g["pci"],
                        "vram_total_mb": g["vram_total_mb"], "vram_free_mb": g["vram_free_mb"],
                        "driver_version": g["driver_version"], "driver_ready": True, "uvm_loaded": "nvidia_uvm" in mods,
                        "device_nodes": [n for n in nodes if n in (f"/dev/nvidia{g['index']}", *(f"/dev/{d}" for d in NV_EXTRA_DEVS))],
                        "backend": "CUDA", "recommendation": recommendation(vram, ram_gb), "prepare": None})
    seen = {g["pci"] for g in nv}
    for d in devices:  # NVIDIA cards on the bus without a working host driver (missing, nouveau or vfio-pci)
        if d["gpu"] and d["vendor"] == "nvidia" and d["id"] not in seen:
            targets.append({"id": f"nvidia:{d['id']}", "kind": "nvidia", "name": d["name"], "pci": d["id"],
                            "vram_total_mb": None, "vram_free_mb": None, "driver_version": None, "driver_ready": False,
                            "driver": d["driver"], "device_nodes": [], "backend": "CUDA",
                            "recommendation": "Install the NVIDIA host driver to use this GPU for AI",
                            "prepare": {"action": "mode-host" if d["driver"] == "vfio-pci" else "nvidia-install",
                                        "gpu": d["id"]}})
    for line in s.get("dri", "").splitlines():
        parts = line.split()
        if len(parts) != 3 or parts[2] not in ("0x8086", "0x1002"):
            continue  # NVIDIA render nodes are covered by the CUDA target above
        node, slot, vid = parts
        d = by_pci.get(slot[5:], {})
        kind = "intel" if vid == "0x8086" else "amd"
        ready = d.get("driver") in ("i915", "xe", "amdgpu") or not d
        targets.append({"id": f"{kind}:{node}", "kind": kind, "name": d.get("name") or f"{kind.upper()} GPU ({node})",
                        "pci": slot[5:], "vram_total_mb": None, "vram_free_mb": None, "driver_version": d.get("driver"),
                        "driver_ready": ready, "device_nodes": [node],
                        "backend": "Vulkan / SYCL" if kind == "intel" else "ROCm / Vulkan",
                        "recommendation": recommendation(None, ram_gb, shared=True), "prepare": None})
    targets.append({"id": "cpu", "kind": "cpu", "name": cpu.get("Model name") or "Host CPU",
                    "cores": ((_int(cpu.get("Core(s) per socket", "")) or 0) * (_int(cpu.get("Socket(s)", "")) or 1)) or None,
                    "threads": _int(cpu.get("CPU(s)", "")), "ram_total_mb": mem.get("MemTotal", 0) // 2**20,
                    "ram_available_mb": mem.get("MemAvailable", 0) // 2**20, "vram_total_mb": None, "driver_ready": True,
                    "device_nodes": [], "backend": "CPU (AVX2/AVX-512)", "recommendation": recommendation(None, ram_gb),
                    "prepare": None})
    default = next((t["id"] for t in targets if t["kind"] == "nvidia" and t["driver_ready"]), "cpu")
    return {"targets": targets, "default": default, "ssh_bridge_connected": ok or bool(out.strip()),
            "message": None if ok or out.strip() else (err.strip() or "Host SSH bridge unavailable")}


class LocalAiDeployBody(BaseModel):
    hostname: str = Field("local-ai", pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    compute_target: str = Field("cpu", pattern=TARGET_RE)
    cores: int = Field(8, ge=1, le=64)
    memory_mb: int = Field(16384, ge=2048, le=262144)
    disk_gb: int = Field(64, ge=16, le=4096)
    ip_config: Literal["dhcp"] | StaticIP = "dhcp"
    mount_storage: bool = True
    install_open_webui: bool = True
    starter_models: list[str] = Field([], max_length=5)


class SwitchBody(BaseModel):
    compute_target: str = Field(pattern=TARGET_RE)
    flash_attention: bool = True
    kv_cache_q8: bool = False


CHATS_FILE = DATA / "ai_chats.json"
MAX_CHATS = 200  # the oldest conversations beyond this are dropped
CHAT_ID_RE = r"^[0-9a-f]{12}$"
_chats_lock = asyncio.Lock()


def load_chats() -> dict[str, dict]:
    try:
        data = json.loads(CHATS_FILE.read_text())
    except (OSError, ValueError):  # missing or hand-damaged file: start empty
        return {}
    return data if isinstance(data, dict) else {}


def save_chats(chats: dict[str, dict]) -> None:
    newest = sorted(chats.items(), key=lambda kv: kv[1].get("updated", 0), reverse=True)[:MAX_CHATS]
    tmp = CHATS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(dict(newest)))
    tmp.replace(CHATS_FILE)  # atomic: a crash never leaves a half-written history
    # Drop image files no saved conversation points at any more (deleted or trimmed chats).
    used = {ref for _, c in newest for m in c.get("messages", []) for ref in m.get("images") or []}
    for f in IMAGES_DIR.glob("*") if IMAGES_DIR.is_dir() else []:
        if f.name not in used:
            f.unlink(missing_ok=True)


# Chat images: the browser sends data URLs (already scaled to ≤2048 px); saved conversations keep them as
# content-addressed files so ai_chats.json stays small, and the chat endpoint accepts those names back.
IMAGES_DIR = DATA / "ai_chat_images"
MAX_IMAGES = 5
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
IMAGE_REF = re.compile(r"^[0-9a-f]{64}\.(png|jpg|webp|gif)$")
DATA_URL = re.compile(r"^data:([\w/+.-]+);base64,")


def image_kind(raw: bytes) -> str | None:
    """File extension from the magic bytes, so a renamed or mislabelled file is never forwarded."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return None


def decode_image(item: str) -> tuple[bytes, str]:
    """A data URL, bare base64 or saved image name → (bytes, extension). HTTP 400 for anything else."""
    if IMAGE_REF.match(item):
        try:
            return (IMAGES_DIR / item).read_bytes(), item.rsplit(".", 1)[1]
        except OSError:
            raise HTTPException(400, "An image in this conversation is no longer stored. Attach it again.")
    m = DATA_URL.match(item)
    if m and m[1] not in IMAGE_TYPES:
        raise HTTPException(400, f"Unsupported image type {m[1]}. Use PNG, JPEG, WebP or GIF.")
    b64 = item[m.end():] if m else item
    if len(b64) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise HTTPException(400, f"Image is larger than {MAX_IMAGE_BYTES // 2**20} MB.")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "Image is not valid base64 data.")
    kind = image_kind(raw)
    if not kind:
        raise HTTPException(400, "Unsupported image format. Use PNG, JPEG, WebP or GIF.")
    return raw, kind


def check_images(items: list[str] | None) -> list[tuple[bytes, str]]:
    if items and len(items) > MAX_IMAGES:
        raise HTTPException(400, f"At most {MAX_IMAGES} images per message.")
    return [decode_image(i) for i in items or []]


def store_image(raw: bytes, kind: str) -> str:
    name = f"{hashlib.sha256(raw).hexdigest()}.{kind}"
    path = IMAGES_DIR / name
    if not path.exists():
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    return name


class StoredMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=200_000)
    images: list[str] | None = None  # data URLs on the way in, saved image names on the way out
    thinking: str | None = Field(None, max_length=200_000)
    tps: float | None = None
    tokens: int | None = None
    stopped: bool | None = None


class ChatDoc(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    model: str = Field(pattern=MODEL_RE)
    messages: list[StoredMessage] = Field(min_length=1, max_length=500)


def snippet(text: str, needle: str, width: int = 70) -> str:
    """About `width` characters of `text` around the first case-insensitive match of `needle`, on one line."""
    i = text.lower().find(needle)
    start = max(0, i - width // 3)
    if start and (sp := text.find(" ", start, i)) != -1:
        start = sp + 1  # begin at a word boundary, never past the match
    s = " ".join(text[start:start + width].split())
    return ("…" if start else "") + s + ("…" if start + width < len(text) else "")


def chat_match(chat: dict, needle: str) -> tuple[bool, str | None]:
    """(matches, snippet): a title match needs no snippet; otherwise the first message that contains the text."""
    if not needle or needle in chat.get("title", "").lower():
        return True, None
    m = next((m["content"] for m in chat.get("messages", []) if needle in m.get("content", "").lower()), None)
    return (m is not None), (snippet(m, needle) if m is not None else None)


@router.get("/chats")
async def list_chats(q: Annotated[str, Query(max_length=100)] = ""):
    """Conversation summaries, newest first; `q` searches titles and message text (case-insensitive)."""
    needle, out = q.strip().lower(), []
    for k, v in load_chats().items():
        ok, snip = chat_match(v, needle)
        if ok:
            out.append({"id": k, "title": v.get("title", ""), "model": v.get("model", ""), "updated": v.get("updated", 0),
                        "messages": len(v.get("messages", [])), "snippet": snip})
    return sorted(out, key=lambda c: c["updated"], reverse=True)


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: str = PathParam(pattern=CHAT_ID_RE)):
    chat = load_chats().get(chat_id)
    if not chat:
        raise HTTPException(404, "Conversation not found")
    return {"id": chat_id, **chat}


@router.put("/chats/{chat_id}")
async def put_chat(body: ChatDoc, chat_id: str = PathParam(pattern=CHAT_ID_RE)):
    decoded = [check_images(m.images) for m in body.messages]
    async with _chats_lock:  # stored under the lock so another save's clean-up cannot remove them first
        for m, imgs in zip(body.messages, decoded):
            m.images = [store_image(*img) for img in imgs] or None
        chats = load_chats()
        now = int(time.time())
        old = chats.get(chat_id, {})
        chats[chat_id] = {**body.model_dump(exclude_none=True), "created": old.get("created", now), "updated": now}
        if old.get("renamed"):  # autosave sends the first question as title; a name the user chose wins
            chats[chat_id].update(title=old["title"], renamed=True)
        save_chats(chats)
    return {"id": chat_id, "updated": now}


class RenameBody(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


@router.patch("/chats/{chat_id}")
async def rename_chat(body: RenameBody, chat_id: str = PathParam(pattern=CHAT_ID_RE)):
    """Rename without touching `updated`, so the conversation keeps its place in the list."""
    async with _chats_lock:
        chats = load_chats()
        if chat_id not in chats:
            raise HTTPException(404, "Conversation not found")
        chats[chat_id].update(title=body.title, renamed=True)
        save_chats(chats)
    return {"id": chat_id, "title": body.title}


@router.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str = PathParam(pattern=CHAT_ID_RE)):
    async with _chats_lock:
        chats = load_chats()
        if chats.pop(chat_id, None) is None:
            raise HTTPException(404, "Conversation not found")
        save_chats(chats)
    return {"ok": True}


@router.get("/chat-images/{name}")
async def chat_image(name: str = PathParam(pattern=IMAGE_REF.pattern)):
    path = IMAGES_DIR / name
    if not path.is_file():
        raise HTTPException(404, "Image not found")
    media = next(t for t, ext in IMAGE_TYPES.items() if name.endswith("." + ext))
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.get("/status")
async def status():
    s = load_state()
    if not s.get("vmid"):
        return {"installed": False}
    vmid = s["vmid"]
    try:
        st = await get_provider().container_status(vmid)
    except HTTPException:  # no longer in the guest registry
        st = None
    cur = {"status": st} if st else None
    if not cur:
        return {"installed": False, "missing_vmid": vmid}
    running = cur.get("status") == "running"
    if running and (ip := await _ip(vmid)) and ip != s.get("ip"):  # DHCP lease changed
        s = save_state(ip=ip, ollama_url=f"http://{ip}:11434", webui_url=f"http://{ip}:3000" if s.get("open_webui") else None)
    version, gpu = None, None
    if running:
        try:
            version = (await ollama("GET", "/api/version", timeout=4)).get("version")
        except HTTPException:
            pass
    if str(s.get("compute_target", "")).startswith("nvidia:"):
        _, out, _ = await host_ssh.run_host_cmd(NVIDIA_CMD, timeout=10)
        gpu = parse_nvidia(out).get(s.get("gpu_pci") or "")
    return {**{k: v for k, v in s.items() if k != "nv_majors"}, "installed": True, "running": running,
            "status": cur.get("status"), "ollama_version": version, "ollama_reachable": version is not None,
            "openai_url": f"{s['ollama_url']}/v1" if s.get("ollama_url") else None, "gpu": gpu}


@router.get("/models/online")
async def models_online(q: str = Query("", max_length=80), category: str = Query("All", max_length=20),
                        vram_gb: float | None = Query(None, ge=0, le=1024)):
    s = load_state()
    if vram_gb is None:
        vram_gb = (s.get("vram_mb") or 0) / 1024 if str(s.get("compute_target", "")).startswith("nvidia:") else 0
    models, source = await library(q)
    out = [annotate(m, vram_gb) for m in models]
    if category != "All":
        out = [m for m in out if m["category"] == category]
    return {"models": out, "source": source, "vram_gb": vram_gb}


_caps: dict[str, list[str]] = {}  # model digest → Ollama's capability list (a digest never changes)


async def _model_caps(m: dict) -> None:
    try:
        _caps[m.get("digest")] = (await ollama("POST", "/api/show", json={"model": m["name"]})).get("capabilities") or []
    except HTTPException:
        pass  # older Ollama or a model being deleted: supports_vision falls back to the name and families


@router.get("/models/local")
async def models_local():
    tags, ps = await asyncio.gather(ollama("GET", "/api/tags"), ollama("GET", "/api/ps"))
    loaded = {m["name"]: m for m in ps.get("models", [])}
    models = tags.get("models", [])
    await asyncio.gather(*(_model_caps(m) for m in models if m.get("digest") not in _caps))
    return [{"name": m["name"], "size": m.get("size", 0), "modified_at": m.get("modified_at"),
             "supports_vision": supports_vision(m["name"], (m.get("details") or {}).get("families"), _caps.get(m.get("digest"))),
             "family": (m.get("details") or {}).get("family"),
             "parameter_size": (m.get("details") or {}).get("parameter_size"),
             "quantization": (m.get("details") or {}).get("quantization_level"), "loaded": m["name"] in loaded,
             "size_vram": loaded.get(m["name"], {}).get("size_vram"), "expires_at": loaded.get(m["name"], {}).get("expires_at")}
            for m in models]


# shortcut: pull jobs live in memory (lost on backend restart; Ollama resumes a re-started pull from its partial blobs).
_pulls: dict[str, dict] = {}


_bg: set[asyncio.Task] = set()


async def _pull(job: dict) -> None:
    try:
        timeout = httpx.Timeout(30, read=600)
        async with httpx.AsyncClient(timeout=timeout) as c, \
                c.stream("POST", _base() + "/api/pull", json={"model": job["model"], "stream": True}) as r:
            if r.status_code >= 400:
                raise RuntimeError((await r.aread()).decode(errors="replace")[:300])
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                ev = json.loads(line)
                if ev.get("error"):
                    raise RuntimeError(ev["error"])
                job["status"] = ev.get("status", job["status"])
                if ev.get("digest"):
                    job["digest"] = ev["digest"]
                if ev.get("total"):
                    job.update(total=ev["total"], completed=ev.get("completed", 0))
                    job["percent"] = round(100 * job["completed"] / job["total"], 1)
        if job["status"] != "success":
            raise RuntimeError(f"Pull ended with status {job['status']!r}")
        job.update(state="done", percent=100.0)
    except Exception as e:  # noqa: BLE001 - surfaced to the UI
        job.update(state="error", error=e.detail if isinstance(e, HTTPException) else str(e) or type(e).__name__)


def start_pull(model: str) -> dict:
    running = next((j for j in _pulls.values() if j["model"] == model and j["state"] == "running"), None)
    if running:
        return running
    job = {"id": uuid.uuid4().hex[:12], "model": model, "state": "running", "status": "starting", "digest": None,
           "completed": 0, "total": 0, "percent": 0.0, "error": None, "started": int(time.time())}
    _pulls[job["id"]] = job
    t = asyncio.create_task(_pull(job))
    _bg.add(t)
    t.add_done_callback(_bg.discard)
    return job


class ModelBody(BaseModel):
    model: str = Field(pattern=MODEL_RE)


@router.post("/models/pull")
async def pull(body: ModelBody):
    _base()
    return start_pull(body.model)


@router.get("/models/pull")
async def pulls():
    return sorted(_pulls.values(), key=lambda j: j["started"], reverse=True)


@router.get("/models/pull/{job_id}")
async def pull_status(job_id: str = PathParam(pattern=r"^[0-9a-f]{12}$")):
    if job_id not in _pulls:
        raise HTTPException(404, "No such download job (backend restarted?)")
    return _pulls[job_id]


@router.post("/models/unload")
async def unload(body: ModelBody):
    await ollama("POST", "/api/generate", json={"model": body.model, "keep_alive": 0})
    return {"ok": True}


@router.delete("/models/{name:path}")
async def delete_model(name: str = PathParam(pattern=MODEL_RE)):
    await ollama("DELETE", "/api/delete", json={"model": name})
    return {"ok": True}


class ChatMessage(BaseModel):
    role: str = Field(pattern=r"^(user|assistant|system)$")
    content: str = Field(max_length=100_000)
    images: list[str] | None = None  # data URLs, bare base64 or saved image names (see decode_image)


class ChatBody(BaseModel):
    model: str = Field(pattern=MODEL_RE)
    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    system: str | None = Field(None, max_length=20_000)
    stream: bool = False


def speed(r: dict) -> dict:
    ev, dur = r.get("eval_count") or 0, r.get("eval_duration") or 0
    return {"tokens_per_sec": round(ev / (dur / 1e9), 1) if dur else None, "eval_count": ev,
            "total_duration_ms": round((r.get("total_duration") or 0) / 1e6)}


@router.post("/chat")
async def chat(body: ChatBody):
    msgs = [{"role": "system", "content": body.system}] if body.system else []
    for m in body.messages:
        imgs = check_images(m.images)
        # Ollama wants bare base64 (no data: prefix) in messages[].images.
        msgs.append({"role": m.role, "content": m.content, **({"images": [base64.b64encode(raw).decode() for raw, _ in imgs]} if imgs else {})})
    req = {"model": body.model, "messages": msgs}
    if not body.stream:
        r = await ollama("POST", "/api/chat", timeout=900, json={**req, "stream": False})
        msg = r.get("message") or {}
        return {"model": body.model, "text": msg.get("content", ""), "thinking": msg.get("thinking") or "", **speed(r)}
    url = _base() + "/api/chat"

    async def events():
        """NDJSON: {"delta", "thinking"} chunks while generating, then {"done": true, ...speed} or {"error"}."""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=900)) as c, \
                    c.stream("POST", url, json={**req, "stream": True}) as r:
                if r.status_code >= 400:
                    raise RuntimeError((await r.aread()).decode(errors="replace")[:300])
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    ev = json.loads(line)
                    if ev.get("error"):
                        raise RuntimeError(ev["error"])
                    msg = ev.get("message") or {}
                    if msg.get("content") or msg.get("thinking"):
                        yield json.dumps({"delta": msg.get("content", ""), "thinking": msg.get("thinking", "")}) + "\n"
                    if ev.get("done"):
                        yield json.dumps({"done": True, **speed(ev)}) + "\n"
        except (httpx.HTTPError, RuntimeError, ValueError) as e:
            yield json.dumps({"error": f"Ollama: {e or type(e).__name__}"}) + "\n"

    # X-Accel-Buffering: nginx would otherwise hold the chunks until the reply is complete.
    return StreamingResponse(events(), media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"})
