"""Multi-seat workstations on Proxmox VE (contract: app.multiseat).

A seat becomes hostpciN entries (GPU with x-vga, its audio function, extra PCIe devices, USB controllers), usbN entries
bound by physical port (host=1-4.2, so whatever is plugged into that port follows the seat) and the VM's CPU
`affinity`. The keys written last time are kept in the seat's driver state and removed before the new ones go in.
"""
from fastapi import HTTPException

from app.provisioning import PciPassthrough

from .api import _node, pve
from .routes.provisioning import hostpci_value, qm_set


def seat_options(seat: dict, cfg: dict, drop: list[str]) -> dict[str, str]:
    """New VM options for `seat`, using hostpciN / usbN slots that are free in `cfg` once `drop` is removed."""
    taken = {k for k in cfg if k not in drop}
    free_pci = (f"hostpci{i}" for i in range(16) if f"hostpci{i}" not in taken)
    free_usb = (f"usb{i}" for i in range(14) if f"usb{i}" not in taken)
    q35 = "q35" in str(cfg.get("machine", ""))
    opts: dict[str, str] = {}
    gpu, audio = seat.get("gpu_pci_slot"), seat.get("gpu_audio_pci_slot")
    same_slot = bool(gpu and audio and audio.rsplit(".", 1)[0] == gpu.rsplit(".", 1)[0])
    try:
        if gpu:
            opts[next(free_pci)] = hostpci_value(PciPassthrough(id=gpu, include_audio=same_slot, x_vga=True, pcie=q35))
        for dev in ([audio] if audio and not same_slot else []) + seat.get("extra_pci_slots", []) + \
                seat.get("usb_controller_pci_slots", []):
            opts[next(free_pci)] = hostpci_value(PciPassthrough(id=dev, include_audio=False, pcie=q35))
        for port in seat.get("usb_ports", []):
            opts[next(free_usb)] = f"host={port}"
    except StopIteration:
        raise HTTPException(409, "The VM has no free PCI or USB passthrough slot left for this seat")
    if seat.get("cpu_cores"):
        opts["affinity"] = ",".join(map(str, seat["cpu_cores"]))
    return opts


async def apply(vmid: int, seat: dict, state: dict) -> dict:
    cfg = await pve("GET", _node(f"/qemu/{int(vmid)}/config"))
    drop = [k for k in state.get("keys", []) if k in cfg]
    opts = seat_options(seat, cfg, drop)
    if drop:
        await qm_set(vmid, {"delete": ",".join(drop)})
    if opts:
        await qm_set(vmid, opts)
    return {"keys": sorted(opts)}
