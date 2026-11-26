"""Virtual Hardware & Lab Forge self-check (catalog options, traffic shaping, modem, lab switch, SolarOS domain XML).
Run: python -m tests.test_virtual_hardware"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from fastapi import HTTPException  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import network_switch as ns  # noqa: E402
from app import virtual_hardware as vh  # noqa: E402
from app.vhw_modem import Modem  # noqa: E402
from providers.native_ubuntu import virtual_hardware as nv  # noqa: E402


def raises(fn, exc=(HTTPException, ValidationError, ValueError)):
    try:
        fn()
    except exc:
        return True
    raise AssertionError("expected an error")


# Options: defaults, conditional fields, refusals.
assert vh.clean_options("legacy_audio", {}) == {"model": "ac97"}
cam = vh.clean_options("virtual_camera", {"source": "rtsp_url", "url": "rtsp://10.0.0.5:554/live"})
assert cam["url"] == "rtsp://10.0.0.5:554/live" and "file" not in cam and cam["fps"] == 30
raises(lambda: vh.clean_options("virtual_camera", {"source": "rtsp_url", "url": "rtsp://x/$(reboot)"}))
raises(lambda: vh.clean_options("virtual_camera", {"source": "video_file", "file": "/srv/../etc/shadow"}))
raises(lambda: vh.clean_options("virtual_camera", {"source": "rtsp_url"}))  # the URL is required for that source
raises(lambda: vh.clean_options("hayes_modem", {"dial_port": 70000}))
raises(lambda: vh.clean_options("hayes_modem", {"dial_host": "bbs;rm -rf /"}))
raises(lambda: vh.clean_options("watchdog", {"action": "explode"}))
raises(lambda: vh.clean_options("vtpm", {"extra": 1}))
assert vh.clean_options("hayes_modem", {"dial_host": "bbs.example.org"}) == {"dial_host": "bbs.example.org", "dial_port": 23}

# Shaping presets and tc commands.
assert vh.shape_of({"preset": "native"}) is None and vh.shape_of({"preset": "56k"}) == (56, 120, 0, 0)
assert vh.shape_of({"preset": "custom", "rate_kbps": 0}) is None
assert vh.shape_of({"preset": "custom", "rate_kbps": 512, "latency_ms": 80, "packet_loss_pct": 1.5}) == (512, 80, 0, 1.5)
s = vh.tc_script("tap101i0", (25_000, 45, 10, 0))
assert "root netem limit 10000 delay 45ms 10ms rate 25000kbit" in s and "police rate 25000kbit" in s and "loss" not in s
assert "delay" not in vh.tc_script("veth1", (10_000, 0, 0, 0)) and "ingress" in vh.tc_script("veth1", None)
assert "'a b'" in vh.tc_script("a b", None)  # interface names are quoted
raises(lambda: vh.ThrottleBody(cpu_limit_percent=3))
raises(lambda: vh.ThrottleBody(nics={"eth0": {"preset": "10mbps"}}))
assert vh.ThrottleBody(cpu_limit_percent=25, cpu_model="486", nics={"net0": {"preset": "4g"}}).nics["net0"].preset == "4g"

# Camera feed: test pattern, file loop and guest display capture.
base = {"resolution": "640x480", "fps": 15}
assert "testsrc2=size=640x480:rate=15" in vh.vcam_command({**base, "source": "test_pattern"}, 41)
assert "-stream_loop -1" in vh.vcam_command({**base, "source": "video_file", "file": "/srv/a b.mp4"}, 41)
assert "( grab ) || sleep 1" in vh.vcam_command({**base, "source": "vnc_guest_capture"}, 42, "grab")
assert vh.vcam_command({**base, "source": "test_pattern"}, 41).endswith("/dev/video41")

# Lab sandbox: request checks, switch naming, subnet clashes, air-gap firewall.
ok = dict(name="Retro LAN", gateway_cidr="10.66.0.1/24", range_start="10.66.0.100", range_end="10.66.0.200")
assert vh.LabBody(**ok).dhcp().subnet_mask == "255.255.255.0"
raises(lambda: vh.LabBody(**{**ok, "gateway_cidr": "8.8.8.1/24"}))  # public subnet
raises(lambda: vh.LabBody(**{**ok, "range_end": "10.67.0.9"}))  # outside the subnet
raises(lambda: vh.LabBody(**{**ok, "range_start": "10.66.0.1"}))  # gateway inside the range
raises(lambda: vh.LabBody(**{**ok, "name": "x\"; reboot"}))
m = {"br0": {**ns.blank("br0", "bridge"), "address": "10.66.5.2/16"}, "br50": ns.blank("br50", "bridge")}
assert vh.free_bridge(m, "br", r"^br\d{1,4}$") == "br51" and vh.overlaps("10.66.0.1/24", m) == "br0"
assert vh.overlaps("172.20.0.1/24", m) is None
lab = {**ns.blank("br51", "bridge"), "mode": "isolated", "airgap": True, "address": "10.66.0.1/24"}
sh = ns.render_switch_script({"br51": lab, "br0": m["br0"]}, "")
assert 'iifname "br51" oifname != "br51" drop' in sh and 'iifname { "br51" } udp dport 67 accept' in sh
assert '"br0"' not in sh.split("_airgap {")[1] and "airgap 2>/dev/null" in ns.render_switch_script(m, "")
assert ns.meta_of({"br51": lab})["br51"]["airgap"] is True
assert ns.with_meta({"br51": ns.blank("br51", "bridge")}, {"br51": {"airgap": True, "mode": "isolated"}})["br51"]["airgap"]

# Modem: AT commands, dialing, quiet / numeric modes.
md = Modem("bbs.local", 23)
out, acts = md.feed(b"ATZ\r")
assert out.endswith(b"\r\nOK\r\n") and out.startswith(b"ATZ") and acts == []
out, acts = md.feed(b"ATE0\rATDT10.1.2.3:2323\r")
assert acts == [("dial", "10.1.2.3", 2323)]
assert md.feed(b"ATDT5551234\r")[1] == [("dial", "bbs.local", 23)]  # plain digits dial the default target
assert md.feed(b"ATH0\r")[1] == [("hangup",)] and b"ERROR" in md.feed(b"ATY\r")[0]
assert md.feed(b"AT&F&C1&D2 L1M0X4\r")[0].endswith(b"OK\r\n")
md.feed(b"ATV0\r")
assert md.feed(b"AT\r")[0] == b"0\r" and Modem().feed(b"ATDT123\r")[0].endswith(b"NO CARRIER\r\n")
assert b"SolarDeck" in Modem().feed(b"ATI\r")[0]

# SolarOS domain XML: aliased devices, emulator arguments, CPU tuning, interface list.
XML = ("<domain type='kvm'><name>vm</name><cpu mode='host-passthrough'><topology sockets='1' cores='2' threads='1'/></cpu>"
       "<devices><controller type='scsi' index='0' model='virtio-scsi'/><serial type='pty'><target port='0'/></serial>"
       "</devices></domain>")
d = {"id": "a1b2c3", "type": "sas_hba", "options": {"model": "megasas"}}
x = nv.add_element(XML, nv.device_element(d, XML))
assert "model=\"lsisas1078\"" in x and "index=\"1\"" in x and "ua-vhw-a1b2c3" in x
modem = {"id": "dddddd", "type": "hayes_modem", "options": {}}
x = nv.add_element(x, nv.device_element(modem, x, {"socket": "/var/lib/libvirt/qemu/m.sock"}))
assert "port=\"1\"" in x and "m.sock" in x
x = nv.add_qemu_args(x, ["-drive", "file=/i/vhw-1-eeeeee.raw,if=none,id=vhweeeeeed", "-device", "nvme,id=vhweeeeee"])
assert "xmlns:qemu" in x and "qemu:arg" in x
x = nv.remove_device(nv.remove_device(x, "a1b2c3"), "eeeeee")
assert "lsisas1078" not in x and "qemu:commandline" not in x and "m.sock" in x and "virtio-scsi" in x
for t, needle in (("hd_audio", "duplex"), ("vtpm", "tpm-tis"), ("watchdog", "i6300esb"), ("virtio_rng", "/dev/urandom"),
                  ("smartcard", "ccid"), ("legacy_audio", "sb16")):
    opts = {"action": "reset"} if t == "watchdog" else {"model": "sb16"} if t == "legacy_audio" else {}
    assert needle in nv.add_element(XML, nv.device_element({"id": "ffffff", "type": t, "options": opts}, XML)), t
c = nv.set_cpu_xml(XML, 25, "486")
assert "<quota>25000</quota>" in c and "<model fallback=\"forbid\">486</model>" in c and "topology" in c
c = nv.set_cpu_xml(c, 100, "host")
assert "cputune" not in c and "host-passthrough" in c and "topology" in c
assert nv.parse_domiflist(" Interface   Type     Source   Model    MAC\n------\n vnet3   bridge   br0   virtio   52:54:00:aa:bb:cc\n"
                          " -   bridge   br1   ne2k_pci   52:54:00:aa:bb:cd\n") == {"net0": "vnet3"}

# Routes: the static paths are declared before the per-guest ones.
paths = [r.path for r in vh.router.routes]
assert paths.index("/api/virtual-hardware/labs/sandbox") < paths.index("/api/virtual-hardware/{guest_type}/{guest_id}")
print("virtual hardware ok")
