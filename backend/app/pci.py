"""Host PCI inventory read over the SSH bridge (`lspci -Dnnk` + /sys/kernel/iommu_groups).

Works before any GPU driver is installed: the RTX 3090 / Intel UHD are listed from the PCI bus with their current
kernel driver, IOMMU group, companion functions (HDMI audio at .1) and passthrough warnings.
"""
import re

from . import host_ssh

DEV_RE = re.compile(r"^([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]) (.+?) \[([0-9a-f]{4})\]: (.+?) "
                    r"\[([0-9a-f]{4}):([0-9a-f]{4})\](?: \(rev ([0-9a-f]+)\))?(?: \(prog-if .*\))?$")
HOST_GPU_DRIVERS = {"nvidia", "nouveau", "i915", "xe", "amdgpu", "radeon"}
PROBE = ("lspci -Dnnk; echo ---IOMMU---; find /sys/kernel/iommu_groups -mindepth 3 -maxdepth 3 2>/dev/null; "
         "echo ---CMDLINE---; cat /proc/cmdline")


def vendor_of(vendor_id: str) -> str:
    return {"10de": "nvidia", "8086": "intel", "1002": "amd"}.get(vendor_id, "other")


def parse(out: str) -> dict:
    """Parse PROBE output into {devices, iommu_enabled, cmdline}."""
    lspci, _, rest = out.partition("---IOMMU---")
    iommu_txt, _, cmdline = rest.partition("---CMDLINE---")
    groups = {m.group(2): int(m.group(1)) for m in re.finditer(r"/iommu_groups/(\d+)/devices/(\S+)", iommu_txt)}
    devs: list[dict] = []
    for line in lspci.splitlines():
        m = DEV_RE.match(line)
        if m:
            slot, cname, ccode, name, vid, did, rev = m.groups()
            devs.append({"slot": slot, "id": slot[5:], "class_name": cname, "class": ccode, "name": name,
                         "vendor_id": vid, "device_id": did, "vendor": vendor_of(vid), "rev": rev, "driver": None,
                         "modules": [], "subsystem": "", "iommu_group": groups.get(slot)})
        elif devs and line.startswith("\t"):
            k, _, v = line.strip().partition(": ")
            if k == "Kernel driver in use":
                devs[-1]["driver"] = v
            elif k == "Kernel modules":
                devs[-1]["modules"] = [x.strip() for x in v.split(",")]
            elif k == "Subsystem":
                devs[-1]["subsystem"] = v
    for d in devs:
        base = d["id"].rsplit(".", 1)[0]
        d["gpu"] = d["class"].startswith("03")
        d["functions"] = [x["id"] for x in devs if x["id"].rsplit(".", 1)[0] == base]
        d["audio_function"] = next((x["id"] for x in devs if x["id"].rsplit(".", 1)[0] == base and x["class"] == "0403"
                                    and x["id"] != d["id"]), None)
        d["iommu_shared_with"] = [x["id"] for x in devs if d["iommu_group"] is not None and x["iommu_group"] ==
                                  d["iommu_group"] and x["id"] not in d["functions"]]
        d["warnings"] = warnings(d, bool(groups))
    return {"devices": devs, "iommu_enabled": bool(groups), "cmdline": cmdline.strip()}


def warnings(d: dict, iommu: bool) -> list[str]:
    w = []
    if not iommu:
        w.append("IOMMU is disabled: enable VT-d/AMD-Vi in the BIOS and add intel_iommu=on (or amd_iommu=on) to the kernel "
                 "command line before passing devices through.")
    if d["class"].startswith("03") and d["driver"] in HOST_GPU_DRIVERS:
        w.append(f"Bound to the host driver '{d['driver']}' instead of vfio-pci. Switch it to VM Passthrough Mode in "
                 "Control Panel → Hardware & System → GPU & Drivers (reboot required).")
    if d["iommu_shared_with"]:
        w.append(f"Shares IOMMU group {d['iommu_group']} with {', '.join(d['iommu_shared_with'])}; all of them move to "
                 "the VM together (or enable ACS override).")
    return w


async def probe() -> dict:
    return parse(await host_ssh.run(PROBE, timeout=30))


def gpu_view(d: dict) -> dict:
    return {**d, "passthrough_ready": d["driver"] in (None, "vfio-pci") and not d["iommu_shared_with"]
            and d["iommu_group"] is not None}
