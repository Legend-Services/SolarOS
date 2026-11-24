"""Step-by-step BIOS/UEFI instructions for fixes the OS can't make itself (VT-x, VT-d/IOMMU, Above 4G, primary display,
Secure Boot), tailored to the detected motherboard vendor, with QR codes that carry the text itself.

The server is rebooting (and ProxmoxOS offline) while the user is in the BIOS, so the QR codes encode the instructions
as plain text, not a link: any phone camera shows them with no network. Long guides are split into numbered parts.
"""
import re

import qrcode
import qrcode.image.svg

VENDORS = {
    "asus": ("ASUS", r"asus", "Del or F2"),
    "msi": ("MSI", r"micro-star|\bmsi\b", "Del"),
    "gigabyte": ("Gigabyte / AORUS", r"gigabyte", "Del"),
    "asrock": ("ASRock", r"asrock", "F2 or Del"),
    "dell": ("Dell", r"dell", "F2"),
    "hp": ("HP", r"\bhp\b|hewlett", "F10"),
    "lenovo": ("Lenovo", r"lenovo", "F1 (ThinkCentre/ThinkStation) or F2"),
    "supermicro": ("Supermicro", r"supermicro", "Del"),
    "ami": ("AMI Aptio (mini PCs and most other boards)", r"american megatrends|\bami\b", "Del, F2 or F7"),
}
GENERIC = "ami"  # AMI Aptio menus are what most unbranded / mini-PC boards ship

# topic -> vendor -> cpu ("intel" | "amd" | "any") -> menu steps. Missing vendors fall back to GENERIC.
PATHS: dict[str, dict[str, dict[str, list[str]]]] = {
    "vt-x": {
        "asus": {"intel": ["Press F7 for Advanced Mode.", "Advanced → CPU Configuration → Intel Virtualization Technology → Enabled."],
                 "amd": ["Press F7 for Advanced Mode.", "Advanced → CPU Configuration → SVM Mode → Enabled."]},
        "msi": {"intel": ["Press F7 for Advanced mode.", "OC → CPU Features → Intel Virtualization Tech → Enabled."],
                "amd": ["Press F7 for Advanced mode.", "OC → Advanced CPU Configuration → SVM Mode → Enabled."]},
        "gigabyte": {"intel": ["Press F2 for Advanced Mode.", "Tweaker → Advanced CPU Settings → Intel Virtualization Technology → Enabled."],
                     "amd": ["Press F2 for Advanced Mode.", "Tweaker → Advanced CPU Settings → SVM Mode → Enabled."]},
        "asrock": {"intel": ["Advanced → CPU Configuration → Intel Virtualization Technology → Enabled."],
                   "amd": ["Advanced → CPU Configuration → SVM Mode → Enabled."]},
        "dell": {"any": ["Virtualization Support → Virtualization → On (Enabled)."]},
        "hp": {"any": ["Advanced → System Options (on some models: Security → System Security).",
                       "Tick 'Virtualization Technology (VTx)'."]},
        "lenovo": {"any": ["Advanced (or Security) → Virtualization → Intel Virtualization Technology / AMD SVM → Enabled."]},
        "supermicro": {"any": ["Advanced → CPU Configuration → Intel Virtualization Technology (AMD: SVM Mode) → Enabled."]},
        "ami": {"intel": ["Advanced → CPU Configuration → Intel (VMX) Virtualization Technology → Enabled."],
                "amd": ["Advanced → CPU Configuration → SVM Mode → Enabled."]},
    },
    "vt-d": {
        "asus": {"intel": ["Press F7 for Advanced Mode.", "Advanced → System Agent (SA) Configuration → VT-d → Enabled."],
                 "amd": ["Press F7 for Advanced Mode.", "Advanced → AMD CBS → NBIO Common Options → IOMMU → Enabled."]},
        "msi": {"intel": ["Press F7 for Advanced mode.", "OC → CPU Features → Intel VT-D Tech → Enabled."],
                "amd": ["Press F7 for Advanced mode.", "Settings → Advanced → AMD CBS → NBIO Common Options → IOMMU → Enabled."]},
        "gigabyte": {"intel": ["Press F2 for Advanced Mode.", "Settings → Miscellaneous → VT-d → Enabled."],
                     "amd": ["Press F2 for Advanced Mode.", "Settings → Miscellaneous → IOMMU → Enabled."]},
        "asrock": {"intel": ["Advanced → Chipset Configuration → VT-d → Enabled."],
                   "amd": ["Advanced → AMD CBS → NBIO Common Options → IOMMU → Enabled."]},
        "dell": {"any": ["Virtualization Support → VT for Direct I/O → On (Enabled)."]},
        "hp": {"any": ["Advanced → System Options → tick 'Virtualization Technology for Directed I/O (VTd)'."]},
        "lenovo": {"any": ["Advanced (or Security) → Virtualization → VT-d Feature (AMD: AMD-Vi / IOMMU) → Enabled."]},
        "supermicro": {"intel": ["Advanced → Chipset Configuration → North Bridge → IIO Configuration → Intel VT for Directed I/O (VT-d) → Enable."],
                       "amd": ["Advanced → NB Configuration → IOMMU → Enabled."]},
        "ami": {"intel": ["Chipset → System Agent (SA) Configuration → VT-d → Enabled.",
                          "Leave 'Control Iommu Pre-boot Behavior' on its default (Disabled)."],
                "amd": ["Advanced → AMD CBS → NBIO Common Options → IOMMU → Enabled."]},
    },
    "above4g": {
        "msi": {"any": ["Settings → Advanced → PCI Subsystem Settings → Above 4G memory/Crypto Currency mining → Enabled.",
                        "Re-Size BAR Support → Disabled (more reliable for passthrough)."]},
        "gigabyte": {"any": ["Settings → IO Ports → Above 4G Decoding → Enabled.", "Re-Size BAR Support → Disabled."]},
        "dell": {"any": ["Look under Advanced / PCI settings for 'Above 4G' or 'Memory Mapped I/O above 4GB' → Enabled."]},
        "hp": {"any": ["Advanced → Option ROM / PCI settings → 'Memory Mapped I/O above 4GB' → Enabled (if present)."]},
        "ami": {"any": ["Advanced → PCI Subsystem Settings → Above 4G Decoding → Enabled.",
                        "Re-Size BAR Support → Disabled (more reliable for passthrough)."]},
    },
    "primary-display": {
        "asus": {"any": ["Advanced → System Agent (SA) Configuration → Graphics Configuration → Primary Display → CPU Graphics (iGPU).",
                         "iGPU Multi-Monitor → Enabled."]},
        "msi": {"any": ["Settings → Advanced → Integrated Graphics Configuration → Initiate Graphic Adapter → IGD.",
                        "IGD Multi-Monitor → Enabled."]},
        "gigabyte": {"any": ["Settings → IO Ports → Initial Display Output → IGD Video.", "Internal Graphics → Enabled."]},
        "asrock": {"any": ["Advanced → Chipset Configuration → Primary Graphics Adapter → Onboard.", "IGPU Multi-Monitor → Enabled."]},
        "dell": {"any": ["Video → Primary Display → Intel HD Graphics (or 'Auto' with the monitor on the motherboard port)."]},
        "hp": {"any": ["Advanced → Built-In Device Options → Graphics → Integrated Graphics → Force Enable / Primary."]},
        "ami": {"any": ["Chipset → System Agent (SA) Configuration → Graphics Configuration → Primary Display → IGFX.",
                        "Internal Graphics → Enabled."]},
    },
    "secure-boot": {
        "asus": {"any": ["Boot → Secure Boot → OS Type → Other OS (this turns Secure Boot off)."]},
        "msi": {"any": ["Settings → Security → Secure Boot → Secure Boot → Disabled."]},
        "gigabyte": {"any": ["Boot → Secure Boot → Disabled."]},
        "dell": {"any": ["Secure Boot → Secure Boot Enable → Off."]},
        "hp": {"any": ["Security (or Advanced) → Secure Boot Configuration → Secure Boot → Disable / Legacy Support Disable and Secure Boot Disable."]},
        "lenovo": {"any": ["Security → Secure Boot → Disabled."]},
        "ami": {"any": ["Security (or Boot) → Secure Boot → Secure Boot → Disabled."]},
    },
}

TOPICS = {
    "vt-x": ("Turn on CPU virtualization (VT-x / AMD-V)",
             "Without it, virtual machines can't start at all.",
             "In Host Shell run: grep -cE 'vmx|svm' /proc/cpuinfo — any number above 0 means it is on."),
    "vt-d": ("Turn on device passthrough (VT-d / AMD-Vi IOMMU)",
             "Needed to give a graphics card, USB controller, NVMe drive or network card to a VM.",
             "Help Center → Fix problems → 'Check again': 'Device passthrough (IOMMU / VT-d)' turns green. "
             "If it doesn't, also run the IOMMU fix there (kernel setting)."),
    "above4g": ("Enable Above 4G Decoding (GPU passthrough)",
                "Large graphics cards (e.g. RTX 3090 with 24 GB) need it to be passed through reliably.",
                "Start the VM with the GPU; the NVIDIA driver inside the VM no longer reports error 43/code 12."),
    "primary-display": ("Use the built-in graphics for the server screen",
                        "Lets the server keep its own screen on the motherboard's video port while the big graphics card "
                        "goes to a VM. Plug your monitor into the motherboard port afterwards.",
                        "The server's boot screen appears on the motherboard video port."),
    "secure-boot": ("Turn off Secure Boot (NVIDIA driver)",
                    "The official NVIDIA driver is built on your server and isn't signed, so Secure Boot blocks it from loading.",
                    "In Host Shell run: mokutil --sb-state — it should say 'SecureBoot disabled'. Then run nvidia-smi."),
}


def detect_vendor(*names: str) -> str:
    text = " ".join(n or "" for n in names).lower()
    return next((k for k, (_, rx, _) in VENDORS.items() if k != GENERIC and re.search(rx, text)), GENERIC)


def guide_steps(topic: str, vendor: str, cpu: str) -> list[str]:
    name, _, key = VENDORS.get(vendor, VENDORS[GENERIC])
    by_cpu = PATHS[topic].get(vendor) or PATHS[topic][GENERIC]
    menu = by_cpu.get(cpu) or by_cpu.get("any") or by_cpu.get("intel") or []
    if vendor != GENERIC and vendor not in PATHS[topic]:
        menu = [f"(Exact menu names vary on {name}; these are the most common.)", *menu]
    return ["Shut down your VMs first: the server will be offline for a few minutes.",
            "Restart the server (Control Panel → System & Power → Reboot host) with a monitor and keyboard attached.",
            f"As soon as the start-up logo appears, press {key} repeatedly until the BIOS/UEFI setup opens.",
            *menu,
            "Press F10 (or go to Save & Exit → Save Changes and Reset) and confirm with Yes.",
            "Wait 2–3 minutes for Proxmox to start, then sign in to ProxmoxOS again."]


def guide_text(title: str, vendor: str, steps: list[str], verify: str, board: str = "") -> str:
    menus = VENDORS.get(vendor, VENDORS[GENERIC])[0]
    lines = [f"ProxmoxOS - {title}", f"Board: {board} ({menus} menus)" if board else f"Board: {menus}", ""]
    lines += [f"{i}. {s}" for i, s in enumerate(steps, 1)]
    return "\n".join([*lines, "", f"Check: {verify}"])


def split_text(text: str, limit: int = 900) -> list[str]:
    """Split on line boundaries into chunks small enough for an easily scanned QR code; parts get 'Part i/n'."""
    chunks, cur = [], ""
    for line in text.splitlines():
        while len(line) > limit:  # a single huge line: hard-wrap it
            chunks.append((cur + "\n" + line[:limit]).strip())
            cur, line = "", line[limit:]
        if cur and len(cur) + len(line) + 1 > limit:
            chunks.append(cur)
            cur = ""
        cur = f"{cur}\n{line}" if cur else line
    if cur:
        chunks.append(cur)
    return chunks if len(chunks) == 1 else [f"(Part {i}/{len(chunks)})\n{c}" for i, c in enumerate(chunks, 1)]


def qr_svg(text: str) -> str:
    return qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, border=2,
                       error_correction=qrcode.constants.ERROR_CORRECT_L).to_string(encoding="unicode")


def build_guide(topic: str, vendor: str, cpu: str, needed: bool | None, board: str = "") -> dict:
    title, why, verify = TOPICS[topic]
    steps = guide_steps(topic, vendor, cpu)
    text = guide_text(title, vendor, steps, verify, board)
    return {"id": topic, "title": title, "why": why, "verify": verify, "needed": needed, "steps": steps, "text": text,
            "qr": [qr_svg(p) for p in split_text(text)]}
