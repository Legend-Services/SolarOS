"""Visual Virtual Switch on Proxmox VE: /etc/network/interfaces (ifupdown2) <-> the app.network_switch model.

Options this module does not model (bridge-stp, bridge-fd, bond settings, post-up hooks, comments) are kept verbatim
per stanza, and top-level lines (source ...) survive a round trip, so only the edited values change.
"""
import ipaddress
import re

from app import host_ssh
from app.network_switch import blank

from .routes.guest_hardware import delete_net, hardware, set_net  # noqa: F401 (the guest NIC handlers of the contract)

BRIDGE_RE = r"^vmbr\d{1,4}$"
BRIDGE_PREFIX = "vmbr"
NIC_MODELS = ("virtio", "e1000", "e1000e", "rtl8139", "vmxnet3")
INTERFACES = "/etc/network/interfaces"
RESOLV = "/etc/resolv.conf"
SNAPSHOT = [INTERFACES, RESOLV]
RELOAD = "ifreload -a"
HANDLED = {"address", "netmask", "gateway", "mtu", "bridge-ports", "bridge_ports", "bridge-vlan-aware", "vlan-raw-device",
           "vlan-id", "link-type"}
PORT_KEYS = ("bridge-vids", "bridge-pvid", "bridge-access")


def vlan_script(model: dict) -> str:
    return ""  # ifupdown2 applies bridge-vlan-aware / bridge-vids / bridge-access itself


def _vids(v: str) -> list[int]:
    out: list[int] = []
    for part in v.split():
        a, _, b = part.partition("-")
        if a.isdigit() and (not b or b.isdigit()):
            out += list(range(int(a), int(b or a) + 1)) if int(b or a) - int(a) < 64 else []
    return out


def parse(text: str, resolv: str = "") -> dict[str, dict]:
    model: dict[str, dict] = {}
    autos: set[str] = set()
    top: list[str] = []
    cur, fam = None, "inet"
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        head = line.split()
        if raw[:1] not in (" ", "\t") and head[0] in ("auto", "allow-hotplug", "allow-auto"):
            autos.update(head[1:])
            cur = None
        elif raw[:1] not in (" ", "\t") and head[0] == "iface" and len(head) >= 4:
            name, fam, method = head[1], head[2], head[3]
            i = model.setdefault(name, blank(name, "eth"))
            i["extra"] = i["extra"] or {"inet": [], "inet6": []}
            if fam == "inet":
                i["method"] = {"static": "static", "dhcp": "dhcp", "loopback": "loopback"}.get(method, "manual")
            else:
                i["extra"]["method6"] = method
            cur = i
        elif cur is not None and raw[:1] in (" ", "\t"):
            key, _, val = line.partition(" ")
            val = val.strip()
            if fam == "inet6":
                if key == "address":
                    cur["address6"] = val
                elif key == "gateway":
                    cur["gateway6"] = val
                else:
                    cur["extra"]["inet6"].append(line)
            elif key == "address":
                cur["address"] = val
            elif key == "netmask" and cur["address"] and "/" not in cur["address"]:
                cur["address"] = str(ipaddress.IPv4Interface(f"{cur['address']}/{val}"))
            elif key == "gateway":
                cur["gateway"] = val
            elif key == "mtu" and val.isdigit():
                cur["mtu"] = int(val)
            elif key in ("bridge-ports", "bridge_ports"):
                cur["kind"] = "bridge"
                cur["ports"] = [p for p in val.split() if p != "none"]
            elif key == "bridge-vlan-aware":
                cur["vlan_aware"] = val in ("yes", "1", "on")
            elif key == "vlan-raw-device":
                cur["kind"], cur["raw"] = "vlan", val
            elif key == "vlan-id" and val.isdigit():
                cur["vid"] = int(val)
            elif key == "link-type" and val == "dummy":
                cur["kind"] = "dummy"
            else:
                if key.startswith("bond-"):
                    cur["kind"] = "bond"
                cur["extra"]["inet"].append(line)
        else:
            top.append(line)
            cur = None
    for name, i in model.items():
        i["auto"] = name in autos
        if i["kind"] == "eth" and "." in name and i["raw"] is None:
            raw, _, vid = name.rpartition(".")
            if vid.isdigit():
                i.update(kind="vlan", raw=raw, vid=int(vid))
        if i["kind"] == "vlan" and i["vid"] is None and name.rpartition(".")[2].isdigit():
            i["vid"] = int(name.rpartition(".")[2])
        if i["address"] and i["method"] == "manual":
            i["method"] = "static"
        if i["kind"] != "bridge":
            # On a port these are its VLANs; on a bridge stanza they are the switch's own defaults, kept verbatim.
            for x in [x for x in i["extra"]["inet"] if x.split()[0] in PORT_KEYS]:
                key, _, val = x.partition(" ")
                if key == "bridge-vids":
                    i["vids"] = _vids(val)
                elif val.strip().isdigit():
                    i["pvid"] = int(val)
                i["extra"]["inet"].remove(x)
            if i["pvid"] and i["vids"] == [i["pvid"]]:
                i["vids"] = []  # "bridge-vids 20 + bridge-pvid 20" is an access port
            else:
                i["vids"] = [v for v in i["vids"] if v != i["pvid"]]
        if i["method"] == "loopback":
            i["kind"] = "other"
    if "lo" in model:
        model["lo"]["kind"] = "loopback"
        model["lo"]["extra"]["top"] = top
    dns = re.findall(r"^\s*nameserver\s+(\S+)", resolv, re.M)
    gw = next((i for i in model.values() if i["gateway"]), None)
    if gw is not None:
        gw["dns"] = dns
    if "lo" in model:
        model["lo"]["extra"]["resolv"] = [x for x in resolv.splitlines() if x.strip() and not re.match(r"\s*nameserver\s", x)]
    return model


ORDER = {"loopback": 0, "eth": 1, "bond": 2, "bridge": 3, "vlan": 4, "dummy": 5, "other": 6}


def _stanza(i: dict) -> list[str]:
    ex = i.get("extra") or {"inet": [], "inet6": []}
    out = [f"auto {i['name']}"] if i["auto"] else []
    if i["kind"] == "loopback":
        return [*out, f"iface {i['name']} inet loopback", *[f"\t{x}" for x in ex.get("inet", [])]]
    method = "static" if i["address"] else ("dhcp" if i["method"] == "dhcp" else "manual")
    out.append(f"iface {i['name']} inet {method}")
    opts = []
    if i["address"]:
        opts.append(f"address {i['address']}")
    if i["gateway"] and i["address"]:
        opts.append(f"gateway {i['gateway']}")
    if i["kind"] == "bridge":
        opts.append(f"bridge-ports {' '.join(i['ports']) or 'none'}")
    if i["kind"] == "vlan" and i["raw"] and f"{i['raw']}.{i['vid']}" != i["name"]:
        opts += [f"vlan-raw-device {i['raw']}", f"vlan-id {i['vid']}"]
    if i["kind"] == "dummy":
        opts.append("link-type dummy")
    extra = [x for x in ex.get("inet", []) if x.split()[0] not in HANDLED]
    if i["kind"] == "bridge" and not any(x.startswith(("bridge-stp", "bridge_stp")) for x in extra):
        extra += ["bridge-stp off", "bridge-fd 0"]
    own_vids = [x for x in extra if i["kind"] == "bridge" and x.startswith("bridge-vids")]
    opts += [x for x in extra if x not in own_vids]
    if i["kind"] == "bridge" and i["vlan_aware"]:
        opts += ["bridge-vlan-aware yes", *(own_vids or ["bridge-vids 2-4094"])]
    else:
        opts += own_vids
    if i["kind"] != "bridge":
        if i.get("vids"):
            opts += [f"bridge-vids {' '.join(map(str, sorted(set(i['vids']) | ({i['pvid']} if i.get('pvid') else set()))))}"]
            if i.get("pvid"):
                opts.append(f"bridge-pvid {i['pvid']}")
        elif i.get("pvid"):
            opts.append(f"bridge-access {i['pvid']}")
    if i["mtu"]:
        opts.append(f"mtu {i['mtu']}")
    out += [f"\t{x}" for x in opts]
    if i["address6"] or ex.get("method6"):
        out += ["", f"iface {i['name']} inet6 {'static' if i['address6'] else ex.get('method6', 'manual')}"]
        out += [f"\taddress {i['address6']}"] if i["address6"] else []
        out += [f"\tgateway {i['gateway6']}"] if i["gateway6"] and i["address6"] else []
        out += [f"\t{x}" for x in ex.get("inet6", [])]
    return out


def render_interfaces(model: dict[str, dict]) -> str:
    blocks = [_stanza(i) for i in sorted(model.values(), key=lambda i: (ORDER.get(i["kind"], 9), i["name"]))]
    top = ((model.get("lo") or {}).get("extra") or {}).get("top") or ["source /etc/network/interfaces.d/*"]
    return "\n\n".join("\n".join(b) for b in blocks) + "\n\n" + "\n".join(top) + "\n"


def render_resolv(model: dict[str, dict]) -> str | None:
    gw = next((i for i in model.values() if i["gateway"] and i["dns"]), None)
    if gw is None:
        return None
    keep = ((model.get("lo") or {}).get("extra") or {}).get("resolv") or []
    return "\n".join([*keep, *[f"nameserver {d}" for d in gw["dns"]]]) + "\n"


def render(model: dict[str, dict]) -> dict[str, str | None]:
    files: dict[str, str | None] = {INTERFACES: render_interfaces(model)}
    if (resolv := render_resolv(model)) is not None:
        files[RESOLV] = resolv
    return files


async def read() -> dict[str, dict]:
    return parse(await host_ssh.read_file(INTERFACES), await host_ssh.read_file(RESOLV))
