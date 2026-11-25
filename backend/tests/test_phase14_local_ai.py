"""Local AI Studio self-check. Run: python -m tests.test_phase14_local_ai (from backend/)."""
import os
import re
import tempfile
from pathlib import Path

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from pydantic import ValidationError  # noqa: E402

from app import apps, local_ai as ai  # noqa: E402

FIX = Path(__file__).parent / "fixtures"

# Library scrape (trimmed live ollama.com/library?q=qwen page).
lib = ai.parse_library((FIX / "ollama_library.html").read_text())
assert lib and lib[0]["name"] == "qwen2.5", lib[:1]
assert lib[0]["sizes"] == ["0.5b", "1.5b", "3b", "7b", "14b", "32b", "72b"] and "tools" in lib[0]["capabilities"], lib[0]
assert lib[0]["description"].startswith("Qwen2.5 models") and "&#39;" not in lib[0]["description"]
assert lib[0]["pulls"] and re.fullmatch(r"[\d.]+[KMB]?", lib[0]["pulls"]), lib[0]["pulls"]

# Size badges and VRAM fit for a 24 GB RTX 3090.
assert [ai.params_b(x) for x in ("32b", "0.5b", "137m", "8x7b", "e4b", "tools")] == [32, 0.5, 0.137, 56, 4, None]
fits = {t["tag"]: t["vram_fit"] for t in ai.annotate({**ai.FALLBACK[1], "category": None}, 24)["tags"]}
assert fits["deepseek-r1:32b"] == "optimal_gpu" and fits["deepseek-r1:70b"] == "cpu_offload", fits
assert ai.vram_fit(22.5, 24) == "tight_gpu" and ai.vram_fit(5, 0) == "cpu_only"
assert "up to ~35B" in ai.recommendation(24, 64), ai.recommendation(24, 64)
assert ai.category("qwen2.5-coder", []) == "Coding" and ai.category("deepseek-r1", ["thinking"]) == "Reasoning"
assert ai.category("llava", ["vision"]) == "Vision" and ai.category("nomic-embed-text", ["embedding"]) == "Embeddings"
names = {f"{m['name']}:{s}" for m in ai.FALLBACK for s in m["sizes"]}
assert {"qwen2.5-coder:32b", "qwen2.5-coder:14b", "deepseek-r1:32b", "deepseek-r1:14b", "gemma3:27b", "gemma3:12b",
        "llama3.3:70b", "llama3.1:8b", "mistral-small:24b", "llava:13b", "nomic-embed-text:137m"} <= names

# nvidia-smi parsing and device majors.
nv = ai.parse_nv_list("0, 00000000:01:00.0, NVIDIA GeForce RTX 3090, 24576, 23800, 595.104.02\n")
assert nv == [{"index": 0, "pci": "01:00.0", "name": "NVIDIA GeForce RTX 3090", "vram_total_mb": 24576,
               "vram_free_mb": 23800, "driver_version": "595.104.02"}], nv
assert ai.parse_majors("/dev/nvidiactl c3\n/dev/nvidia-uvm 1f9\n") == {"/dev/nvidiactl": 195, "/dev/nvidia-uvm": 505}

# Ollama environment drop-in per target.
assert 'CUDA_VISIBLE_DEVICES=-1' in ai.ollama_env("cpu", True, False)
assert f"OLLAMA_CONTEXT_LENGTH={ai.CONTEXT_LENGTH}" in ai.ollama_env("nvidia:0", True, False)
assert ai.speed({"eval_count": 100, "eval_duration": 2e9, "total_duration": 3e9}) == \
    {"tokens_per_sec": 50.0, "eval_count": 100, "total_duration_ms": 3000}
gpu = ai.ollama_env("nvidia:01:00.0", True, True)
assert "OLLAMA_FLASH_ATTENTION=1" in gpu and "OLLAMA_KV_CACHE_TYPE=q8_0" in gpu and "CUDA_VISIBLE" not in gpu
assert "KV_CACHE" not in ai.ollama_env("nvidia:0", False, True)  # q8 KV cache needs flash attention
assert "OLLAMA_VULKAN=1" in ai.ollama_env("intel:/dev/dri/renderD128", False, False)

# Deploy body validation: compute targets and starter model names are embedded in shell / guest config.
base = {"app_id": "local-ai", "hostname": "local-ai", "cores": 8, "memory": 16384, "disk_gb": 64}
for ok in ("cpu", "nvidia:0", "nvidia:01:00.0", "nvidia:0000:01:00.0", "intel:/dev/dri/renderD128"):
    apps.DeployBody(**base, compute_target=ok)
for bad in ("nvidia:0;reboot", "intel:/dev/sda", "gpu", "amd:/dev/dri/renderD128 x"):
    try:
        apps.DeployBody(**base, compute_target=bad)
        raise AssertionError(bad)
    except ValidationError:
        pass
try:
    apps.DeployBody(**base, starter_models=["llama3.1:8b", "$(id)"])
    raise AssertionError("starter model not validated")
except ValidationError:
    pass
assert apps.BY_ID["local-ai"]["category"] == "AI & Compute" and (apps.DATA / "apps/local-ai.sh").exists()
assert apps.installed_map([{"vmid": 105, "tags": f"{apps.TAG};pos-ollama", "name": "ollama"}])["local-ai"][0]["vmid"] == 105
assert ai.LocalAiDeployBody(ip_config={"cidr": "10.0.0.9/24", "gateway": "10.0.0.1"}).ip_config.cidr == "10.0.0.9/24"

# Chat history: stored server-side (temp file here), newest first, capped, validated.
import asyncio  # noqa: E402

ai.CHATS_FILE = Path(tempfile.mkdtemp()) / "ai_chats.json"
msg = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello", "tps": 50.0, "tokens": 3}]
doc = lambda t: ai.ChatDoc(title=t, model="qwen2.5:0.5b", messages=msg)  # noqa: E731
assert asyncio.run(ai.list_chats()) == []
asyncio.run(ai.put_chat(doc("first"), "a" * 12))
asyncio.run(ai.put_chat(doc("second"), "b" * 12))
ai.save_chats({**ai.load_chats(), "a" * 12: {**ai.load_chats()["a" * 12], "updated": 1}})  # make "first" the oldest
assert [c["title"] for c in asyncio.run(ai.list_chats())] == ["second", "first"]
got = asyncio.run(ai.get_chat("b" * 12))
assert got["messages"][1] == {"role": "assistant", "content": "hello", "tps": 50.0, "tokens": 3} and got["created"] <= got["updated"]
asyncio.run(ai.delete_chat("b" * 12))
assert [c["title"] for c in asyncio.run(ai.list_chats())] == ["first"]
ai.MAX_CHATS = 2
for i, cid in enumerate(("c" * 12, "d" * 12)):
    asyncio.run(ai.put_chat(doc(f"new{i}"), cid))
assert sorted(c["title"] for c in asyncio.run(ai.list_chats())) == ["new0", "new1"], "oldest chat not dropped at the cap"
for bad in ({"title": "", "model": "m", "messages": msg}, {"title": "t", "model": "$(id)", "messages": msg},
            {"title": "t", "model": "m", "messages": []}, {"title": "t", "model": "m", "messages": [{"role": "system", "content": "x"}]}):
    try:
        ai.ChatDoc(**bad)
        raise AssertionError(f"chat accepted: {bad}")
    except ValidationError:
        pass
assert re.fullmatch(ai.CHAT_ID_RE, "0123456789ab") and not re.fullmatch(ai.CHAT_ID_RE, "../../etc/pw")

# Rename survives autosave and keeps the list order; search covers titles and message text.
ai.MAX_CHATS = 200
order = [c["id"] for c in asyncio.run(ai.list_chats())]
asyncio.run(ai.rename_chat(ai.RenameBody(title="  PowerShell tips  "), "c" * 12))
assert asyncio.run(ai.get_chat("c" * 12))["title"] == "PowerShell tips" and [c["id"] for c in asyncio.run(ai.list_chats())] == order
asyncio.run(ai.put_chat(doc("first question as title"), "c" * 12))  # autosave after the next reply
assert asyncio.run(ai.get_chat("c" * 12))["title"] == "PowerShell tips", "autosave overwrote a user-chosen name"
for blank in ("", "   "):
    try:
        ai.RenameBody(title=blank)
        raise AssertionError("blank title accepted")
    except ValidationError:
        pass
long = [{"role": "user", "content": "x " * 100 + "Get-ChildItem lists files " + "y " * 100}]
asyncio.run(ai.put_chat(ai.ChatDoc(title="files", model="m", messages=long), "e" * 12))
hits = {c["title"]: c["snippet"] for c in asyncio.run(ai.list_chats(q="get-childitem"))}
assert list(hits) == ["files"] and "Get-ChildItem lists files" in hits["files"] and hits["files"].startswith("…"), hits
assert [c["title"] for c in asyncio.run(ai.list_chats(q="powershell"))] == ["PowerShell tips"]  # title match: no snippet
assert asyncio.run(ai.list_chats(q="powershell"))[0]["snippet"] is None and asyncio.run(ai.list_chats(q="no-such-text")) == []
s = ai.snippet("Once upon a time an old lighthouse keeper watched the stormy sea every night.", "stormy sea")
assert s.startswith("…") and s[1:].split()[0] in "Once upon a time an old lighthouse keeper".split() and "stormy sea" in s, s
print("phase14 local ai: ok")
