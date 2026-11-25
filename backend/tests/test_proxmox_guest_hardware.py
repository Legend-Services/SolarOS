"""Guest hardware helpers self-check. Run: python -m tests.test_proxmox_guest_hardware (from backend/)."""
import os

os.environ.update(ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import guest_hardware as g  # noqa: E402
from app.provisioning import PciPassthrough, UsbPassthrough, pci_category  # noqa: E402
from providers.proxmox.routes import guest_hardware as pg  # noqa: E402
from providers.proxmox.routes.provisioning import hostpci_value, usb_value  # noqa: E402

# Passthrough property strings.
assert hostpci_value(PciPassthrough(id="01:00.0", x_vga=True)) == "01:00,pcie=1,rombar=1,x-vga=1"
assert hostpci_value(PciPassthrough(id="0000:00:1f.3", include_audio=False, pcie=False, rombar=False)) == "0000:00:1f.3,rombar=0"
assert usb_value(UsbPassthrough(host="1532:025d", usb3=True)) == "host=1532:025d,usb3=1"
assert usb_value(UsbPassthrough(host="2-1.4")) == "host=2-1.4"
for bad in ({"id": "01:00.0;rm"}, {"id": "01:00.0,x=1"}):
    try:
        PciPassthrough(**bad)
        raise AssertionError(bad)
    except ValidationError:
        pass
try:
    UsbPassthrough(host="1532:025d,usb3=1")
    raise AssertionError("usb injection accepted")
except ValidationError:
    pass
assert [pci_category(c) for c in ("0x030000", "0403", "0x010802", "0x0c0330", "0x020000", "0x060400")] == \
    ["gpu", "audio", "nvme", "usb-controller", "network", "other"]

# Config parsing.
cfg = {"hostpci0": "0000:01:00,pcie=1,x-vga=1", "hostpci1": "00:1f.3,rombar=0", "usb0": "host=1532:025d,usb3=1",
       "net0": "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1,tag=20", "net2": "e1000,bridge=vmbr1",
       "memory": "2048", "ide2": "local-lvm:vm-101-cloudinit,media=cdrom", "sshkeys": "ssh-ed25519%20AAA%20me",
       "ipconfig0": "ip=dhcp", "cipassword": "**********"}
d = g.list_devices("qemu", cfg)
assert [x["key"] for x in d["hostpci"]] == ["hostpci0", "hostpci1"]
assert d["hostpci"][0] | {"raw": ""} == {"key": "hostpci0", "index": 0, "raw": "", "id": "0000:01:00", "mapping": None,
                                          "pcie": True, "rombar": True, "x_vga": True, "all_functions": True}
assert not d["hostpci"][1]["rombar"] and not d["hostpci"][1]["all_functions"]
assert d["usb"][0]["host"] == "1532:025d" and d["usb"][0]["usb3"]
n0, n2 = d["net"]
assert (n0["model"], n0["macaddr"], n0["tag"], n0["firewall"]) == ("virtio", "BC:24:11:00:00:01", 20, True), n0
assert (n2["index"], n2["model"], n2["macaddr"], n2["firewall"]) == (2, "e1000", None, False)
lxc = g.parse_net("lxc", "name=eth0,bridge=vmbr0,gw=192.168.68.1,hwaddr=BC:24:11:4C:6F:33,ip=192.168.68.230/24,type=veth")
assert (lxc["name"], lxc["ip"], lxc["gw"], lxc["macaddr"]) == ("eth0", "192.168.68.230/24", "192.168.68.1", "BC:24:11:4C:6F:33")
ci = g.cloudinit_view(cfg)
assert ci["sshkeys"] == "ssh-ed25519 AAA me" and ci["password_set"] and ci["drive"] == "ide2" and ci["ipconfig"] == {"ipconfig0": "ip=dhcp"}
assert "cipassword" not in ci

# Builders.
assert pg.net_value("qemu", 0, g.NetBody(bridge="vmbr0", tag=20, macaddr="BC:24:11:00:00:01")) == \
    "virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1,tag=20"
assert pg.net_value("lxc", 1, g.NetBody(bridge="vmbr1", firewall=False, ip="10.0.0.5/24", gw="10.0.0.1")) == \
    "name=eth1,bridge=vmbr1,firewall=0,ip=10.0.0.5/24,gw=10.0.0.1"
assert pg.net_value("lxc", 0, g.NetBody(bridge="vmbr0", gw="10.0.0.1")) == "name=eth0,bridge=vmbr0,firewall=1,ip=dhcp"
p = pg.cloudinit_params(g.CloudInitBody(ciuser="ubuntu", cipassword="", sshkeys="ssh-ed25519 AAA me", nameserver="",
                                       ipconfig={"ipconfig0": "ip=10.0.0.9/24,gw=10.0.0.1"}, add_drive_storage="local-lvm"),
                       {"ide2": "none,media=cdrom"})
assert p == {"ciuser": "ubuntu", "ipconfig0": "ip=10.0.0.9/24,gw=10.0.0.1", "sshkeys": "ssh-ed25519%20AAA%20me",
             "ide0": "local-lvm:cloudinit", "delete": "nameserver"}, p
assert "ide0" not in pg.cloudinit_params(g.CloudInitBody(add_drive_storage="local-lvm"), cfg)  # drive exists
assert pg.options_params("qemu", g.OptionsBody(onboot=True, startup="", cpu="host")) == {"onboot": 1, "cpu": "host", "delete": "startup"}
try:
    pg.options_params("lxc", g.OptionsBody(bios="ovmf"))
    raise AssertionError("qemu option accepted for lxc")
except HTTPException as e:
    assert e.status_code == 400
print("guest hardware self-check OK")
