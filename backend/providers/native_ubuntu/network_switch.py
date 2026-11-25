"""Visual Virtual Switch on SolarOS: Netplan <-> the app.network_switch model.

Every Netplan file is read and merged; an apply writes the whole model into SolarOS's own Netplan file and parks the
other files (the rollback snapshot restores them). Netplan has no per-port bridge VLAN settings, so VLAN-aware
switches get them from vlan_script(), which the switch service runs after every reload and at boot.
"""
import copy

import yaml

from app import host_ssh
from app.config import settings
from app.network_switch import blank

from .guest_edit import delete_net, hardware, set_net  # noqa: F401 (the guest NIC handlers of the contract)

BRIDGE_RE = r"^br\d{1,4}$"
BRIDGE_PREFIX = "br"
NIC_MODELS = ("virtio", "e1000", "e1000e", "rtl8139", "vmxnet3")
NETPLAN_DIR = "/etc/netplan"
NETPLAN_FILE = f"{NETPLAN_DIR}/60-solardeck-bridge.yaml"  # the file the SolarOS installer writes
PARKED = f"/etc/{settings.system_prefix}/netplan-parked"
SNAPSHOT = [NETPLAN_DIR]
RELOAD = (f"mkdir -p {PARKED}; for f in {NETPLAN_DIR}/*.yaml; do [ \"$f\" = {NETPLAN_FILE} ] || mv -f \"$f\" {PARKED}/; done; "
          "netplan generate && netplan apply")
SECTIONS = {"ethernets": "eth", "bridges": "bridge", "vlans": "vlan", "bonds": "bond", "dummy-devices": "dummy"}
MANAGED = ("dhcp4", "addresses", "gateway4", "gateway6", "mtu", "interfaces", "id", "link")


def merge(a: dict, b: dict) -> dict:
    """Netplan's file merge: mappings merge key by key, later scalars and lists win."""
    out = dict(a)
    for k, v in b.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def _default_via(cfg: dict, v6: bool) -> str | None:
    for r in cfg.get("routes") or []:
        to = str(r.get("to", ""))
        if (to in ("default", "::/0") if v6 else to in ("default", "0.0.0.0/0")) and r.get("via"):
            if (":" in str(r["via"])) == v6:
                return str(r["via"])
    return cfg.get("gateway6" if v6 else "gateway4")


def parse(docs: list[dict]) -> dict[str, dict]:
    net: dict = {}
    for d in docs:
        net = merge(net, (d or {}).get("network") or {})
    model: dict[str, dict] = {}
    for section, kind in SECTIONS.items():
        for name, cfg in (net.get(section) or {}).items():
            cfg = cfg or {}
            i = blank(name, kind)
            addrs = [str(a) for a in cfg.get("addresses") or [] if isinstance(a, str)]
            v4 = next((a for a in addrs if ":" not in a), None)
            v6 = next((a for a in addrs if ":" in a), None)
            i.update(method="static" if v4 else ("dhcp" if cfg.get("dhcp4") in (True, "yes", "true") else "manual"),
                     address=v4, gateway=_default_via(cfg, False) if v4 else None, address6=v6,
                     gateway6=_default_via(cfg, True) if v6 else None,
                     dns=[str(x) for x in (cfg.get("nameservers") or {}).get("addresses") or []],
                     mtu=cfg.get("mtu"), ports=list(cfg.get("interfaces") or []) if kind == "bridge" else [],
                     raw=cfg.get("link") if kind == "vlan" else None, vid=cfg.get("id") if kind == "vlan" else None,
                     extra={"section": section, "cfg": cfg, "renderer": net.get("renderer")})
            model[name] = i
    return model


def _cfg(i: dict) -> dict:
    cfg = copy.deepcopy((i.get("extra") or {}).get("cfg") or {})
    for k in MANAGED:
        cfg.pop(k, None)
    routes = [r for r in cfg.pop("routes", []) or [] if str(r.get("to")) not in ("default", "0.0.0.0/0", "::/0")]
    ns = cfg.pop("nameservers", None) or {}
    cfg["dhcp4"] = i["method"] == "dhcp" and not i["address"]
    addrs = [a for a in (i["address"], i["address6"]) if a]
    if addrs:
        cfg["addresses"] = addrs
    if i["gateway"] and i["address"]:
        routes.append({"to": "default", "via": i["gateway"]})
    if i["gateway6"] and i["address6"]:
        routes.append({"to": "::/0", "via": i["gateway6"]})
    if routes:
        cfg["routes"] = routes
    if i["dns"]:
        ns["addresses"] = i["dns"]
    elif "addresses" in ns:
        del ns["addresses"]
    if ns:
        cfg["nameservers"] = ns
    if i["mtu"]:
        cfg["mtu"] = i["mtu"]
    if i["kind"] == "bridge":
        cfg["interfaces"] = i["ports"]
        cfg.setdefault("parameters", {"stp": False, "forward-delay": 0})
    if i["kind"] == "vlan":
        cfg.update(id=i["vid"], link=i["raw"])
    if not i["auto"]:
        cfg["activation-mode"] = "manual"
    elif cfg.get("activation-mode") == "manual":
        del cfg["activation-mode"]
    return cfg


def render_netplan(model: dict[str, dict]) -> str:
    net: dict = {"version": 2}
    renderer = next((i["extra"].get("renderer") for i in model.values() if (i.get("extra") or {}).get("renderer")), None)
    if renderer:
        net["renderer"] = renderer
    inverse = {v: k for k, v in SECTIONS.items()}
    for i in sorted(model.values(), key=lambda i: i["name"]):
        section = (i.get("extra") or {}).get("section") or inverse.get(i["kind"])
        if section:
            net.setdefault(section, {})[i["name"]] = _cfg(i)
    return "# Managed by SolarDeck (Network & Virtual Switch).\n" + yaml.safe_dump({"network": net}, sort_keys=False)


def render(model: dict[str, dict]) -> dict[str, str | None]:
    return {NETPLAN_FILE: render_netplan(model)}


def vlan_script(model: dict[str, dict]) -> str:
    """`bridge vlan` commands for the VLAN-aware switches (and VLAN filtering off on the others)."""
    out = []
    for b in sorted((i for i in model.values() if i["kind"] == "bridge"), key=lambda i: i["name"]):
        n = b["name"]
        if not b["vlan_aware"]:
            out.append(f"ip link set dev {n} type bridge vlan_filtering 0 2>/dev/null")
            continue
        out.append(f"ip link set dev {n} type bridge vlan_filtering 1")
        ports = [model[p] for p in b["ports"] if p in model]
        used = {i["vid"] for i in model.values() if i["kind"] == "vlan" and i["raw"] == n and i["vid"]}
        for p in ports:
            used |= set(p["vids"]) | ({p["pvid"]} if p["pvid"] else set())
        out += [f"bridge vlan add dev {n} vid {v} self" for v in sorted(used)]
        for p in ports:
            if p["pvid"]:
                out += [f"bridge vlan del dev {p['name']} vid 1", f"bridge vlan add dev {p['name']} vid {p['pvid']} pvid untagged"]
            out += [f"bridge vlan add dev {p['name']} vid {v}" for v in sorted(p["vids"])]
    return "".join(f"{x} || true\n" for x in out)


async def read() -> dict[str, dict]:
    txt = await host_ssh.run(f"for f in $(ls {NETPLAN_DIR}/*.yaml 2>/dev/null | sort); do cat \"$f\"; echo; echo '---'; done",
                             check=False)
    docs = []
    for part in txt.split("\n---\n"):
        try:
            docs.append(yaml.safe_load(part) or {})
        except yaml.YAMLError:
            continue
    return parse(docs)

