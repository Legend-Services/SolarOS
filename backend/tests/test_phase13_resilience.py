"""Fresh-install resilience: no SSH bridge, no dmidecode, no ZFS, no GPU. Run: python -m tests.test_phase13_resilience (from backend/)."""
import os
import tempfile
from pathlib import Path

tmp = Path(tempfile.mkdtemp())
os.environ.update(NODE_NAME="pve", STORAGE_ROOT=str(tmp), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32,
                  HOST_ROOT_KEY=str(tmp / ".ssh" / "id_ed25519"))

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import hardware_admin as h, help_center, host, host_ssh, pci, pve  # noqa: E402
from app.main import app  # noqa: E402

STATUS = {"cpuinfo": {"model": "AMD Ryzen 7 5700U", "sockets": 1, "cores": 8, "cpus": 16, "mhz": "1800.000",
                      "flags": "fpu svm sse2"}, "memory": {"total": 16 * 2**30, "used": 4 * 2**30},
          "swap": {"total": 0, "used": 0}, "current-kernel": {"release": "6.8.12-4-pve"}, "pveversion": "pve-manager/8.3.0"}
PCI = [{"id": "0000:00:00.0", "class": "0x060000", "vendor": "0x1022", "device": "0x1630", "vendor_name": "AMD",
        "device_name": "Root Complex", "iommugroup": 0}]


def handler(req: httpx.Request) -> httpx.Response:
    path = req.url.path.split("/api2/json", 1)[-1]
    data = {"/nodes/pve/status": STATUS, "/nodes/pve/hardware/pci": PCI, "/nodes/pve/disks/zfs": [],
            "/nodes/pve/disks/list": [], "/nodes/pve/storage": [{"storage": "local-lvm", "type": "lvmthin"}]}.get(path)
    return httpx.Response(200, json={"data": data})


async def no_bridge(*a, **kw):
    raise HTTPException(503, "Host SSH bridge unavailable (10.0.0.2): Permission denied")


async def no_zfs(args, **kw):
    raise HTTPException(502, "Host helper failed: zfs: command not found")


pve._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://pve/api2/json")
host_ssh._open = no_bridge
host.run = no_zfs

with TestClient(app) as c:  # lifespan runs: creates the bridge key
    assert (tmp / ".ssh" / "id_ed25519").exists() and oct((tmp / ".ssh" / "id_ed25519").stat().st_mode)[-3:] == "600"
    assert c.post("/api/auth/login", json={"username": "admin", "password": "pw"}).status_code == 200

    r = c.get("/api/hardware/inventory")
    assert r.status_code == 200, r.text
    inv = r.json()
    assert inv["ssh_bridge_connected"] is False and "Permission denied" in inv["ssh_bridge_message"]
    assert inv["ssh_setup_command"].startswith("mkdir -p /root/.ssh") and "ssh-ed25519" in inv["ssh_setup_command"]
    assert inv["cpu"]["model"] == "AMD Ryzen 7 5700U" and (inv["cpu"]["cores"], inv["cpu"]["threads"]) == (8, 16)
    assert inv["memory"]["total"] == 16 * 2**30 and inv["system"]["kernel"] == "6.8.12-4-pve"
    assert inv["virtualization"]["cpu"] == "AMD-V" and inv["gpus"] == []

    b = c.get("/api/v1/bios/status")
    assert b.status_code == 200, b.text
    assert b.json()["virtualization"] is True and b.json()["cpu"] == "amd" and not b.json()["ssh_bridge_connected"]

    assert c.get("/api/hardware/gpu-metrics").json() == {"nvidia": {}, "amd_vram": {}}
    assert c.get("/api/host/bridge").json()["setup_command"]
    assert c.get("/api/v1/zfs/snapshots").json() == {"datasets": [], "snapshots": [], "zfs_available": False}
    assert c.get("/api/v1/zfs/datasets").json() == []
    assert c.get("/api/v1/storage").json()["zfs_available"] is False
    assert c.get("/api/v1/telemetry/hardware").status_code == 200

# Parsers: OEM placeholders, sysfs fallback, odd lscpu values, PVE PCI fallback.
f = help_center.parse_bios_facts("system-manufacturer=To Be Filled By O.E.M.\nbaseboard-product-name=B550M\n"
                                 "bios-vendor=Default string\nvirt=16\ncpu=vendor_id : AuthenticAMD")
assert (f["manufacturer"], f["board"], f["bios_vendor"], f["virtualization"], f["cpu"]) == ("", "B550M", "", True, "amd"), f
assert h.num("-") is None and h.num("5800,0000", float) == 5800.0 and h.num("0") is None and h.num(None) is None
p = pci.parse(pci.from_pve([{"id": "0000:01:00.0", "class": "0x030000", "vendor": "0x10de", "device": "0x2204",
                             "vendor_name": "NVIDIA Corporation", "device_name": "GA102", "iommugroup": 14}]))
assert p["devices"][0]["gpu"] and p["devices"][0]["vendor"] == "nvidia" and p["iommu_enabled"], p
inv = h.build_inventory(h.split_sections("@@lscpu@@\n" + '{"lscpu":[{"field":"Socket(s):","data":"-"},'
                                         '{"field":"CPU max MHz:","data":"4,5"}]}'), p, [])
assert inv["cpu"]["sockets"] is None and inv["cpu"]["max_mhz"] == 4.5

# Real HP ProDesk dmidecode with empty values ("\tAsset Tag:  ") used to crash the whole inventory.
dmi = (Path(__file__).parent / "fixtures" / "dmi_empty_values.txt").read_text()
inv = h.build_inventory({"dmi": dmi, "meminfo": "MemTotal: 100 kB\nCached: 8 kB\n", "mhz": "cpu MHz\t\t: 3000.000",
                         "ipaddr": '[{"ifname":"tap100i0","addr_info":[{}]},{"ifname":"vmbr0","addr_info":'
                                   '[{"local":"10.0.0.2","prefixlen":24,"scope":"global"}]}]'}, p, [{"devpath": "/dev/sda"}])
sy = inv["system"]
assert (sy["manufacturer"], sy["product"], sy["board"], sy["bios_vendor"], sy["bios_version"]) == \
    ("HP", "HP ProDesk 400 G6 SFF", "859B", "HP", "R08 Ver. 02.23.00"), sy
assert inv["memory"]["cached"] == 8 * 1024 and inv["cpu"]["mhz"]["avg"] == 3000 and inv["storage"]["drives"]
assert {n["name"]: n["addresses"] for n in inv["network"]} == {"tap100i0": [], "vmbr0": ["10.0.0.2/24"]}
# One broken section only empties itself.
inv = h.build_inventory({"dmi": dmi, "lscpu": "{not json", "pkgs": None}, p, [])  # pkgs None -> AttributeError
assert inv["system"]["manufacturer"] == "HP" and inv["packages"] == {k: None for k in h.PKGS}
print("phase13 resilience: ok")
