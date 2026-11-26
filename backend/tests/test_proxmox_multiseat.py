"""Multi-seat on Proxmox VE: VM options for a seat. Run: python -m tests.test_proxmox_multiseat"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from fastapi import HTTPException  # noqa: E402

from providers.proxmox import multiseat as pm  # noqa: E402

seat = {"gpu_pci_slot": "0000:01:00.0", "gpu_audio_pci_slot": "0000:01:00.1", "extra_pci_slots": ["0000:03:00.0"],
        "usb_controller_pci_slots": ["0000:00:14.0"], "usb_ports": ["1-4", "3-2.1"], "cpu_cores": [2, 3, 10, 11]}
cfg = {"machine": "q35", "hostpci0": "0000:05:00.0", "usb0": "host=046d:c52b", "hostpci1": "0000:01:00,x-vga=1"}
opts = pm.seat_options(seat, cfg, drop=["hostpci1"])
# The user's own hostpci0 / usb0 stay; the seat's previous hostpci1 is reused.
assert opts == {"hostpci1": "0000:01:00,pcie=1,rombar=1,x-vga=1", "hostpci2": "0000:03:00.0,pcie=1,rombar=1",
                "hostpci3": "0000:00:14.0,pcie=1,rombar=1", "usb1": "host=1-4", "usb2": "host=3-2.1",
                "affinity": "2,3,10,11"}, opts
# Audio in another slot is passed on its own; no pcie=1 on an i440fx machine.
o2 = pm.seat_options({"gpu_pci_slot": "0000:01:00.0", "gpu_audio_pci_slot": "0000:02:00.1"}, {}, [])
assert o2 == {"hostpci0": "0000:01:00.0,rombar=1,x-vga=1", "hostpci1": "0000:02:00.1,rombar=1"}, o2
assert pm.seat_options({"usb_ports": []}, cfg, []) == {}
try:
    pm.seat_options({"usb_ports": [f"1-{i}" for i in range(1, 15)]}, {"usb0": "x"}, [])
    raise AssertionError("expected a full-slots error")
except HTTPException as e:
    assert e.status_code == 409

print("proxmox multiseat: all checks passed")
