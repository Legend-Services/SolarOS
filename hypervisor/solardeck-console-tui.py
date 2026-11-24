#!/usr/bin/env python3
"""SolarOS console dashboard for the server's own monitor (tty1). Python standard library only.

Shows the host summary, LAN addresses with the web management URL and ZFS pool health, plus a numbered menu:
network setup (Netplan), admin password reset / initial-password dismissal, update from Git, root shell,
reboot / shut down, and a nested virtualization & hardware readiness check.
Installed as /usr/local/bin/solardeck-console and run by solardeck-console.service.
  solardeck-console --self-test   checks the pure helpers (CI).
"""
import curses
import json
import os
import re
import secrets
import shutil
import socket
import string
import subprocess
import sys
import time
from pathlib import Path

APP_DIR = Path(os.environ.get("SOLARDECK_DIR", "/opt/solardeck"))
ENV_FILE = APP_DIR / "backend/.env"
CREDS_FILE = Path("/etc/solardeck/initial-credentials.txt")
LEGACY_CREDS = Path("/root/solardeck-credentials.txt")  # v1.14 installs
NETPLAN_DIR = Path("/etc/netplan")
UPDATE_UNIT = "solardeck-self-update"
UPDATE_LOG = Path(f"/var/log/{UPDATE_UNIT}.log")
EXIT_MARK = re.compile(r"[\w-]+: exit \d+$")
BANNER = r"""
  ____        _              ___  ____
 / ___|  ___ | | __ _ _ __  / _ \/ ___|
 \___ \ / _ \| |/ _` | '__|| | | \___ \
  ___) | (_) | | (_| | |   | |_| |___) |
 |____/ \___/|_|\__,_|_|    \___/|____/
"""
MENU = [
    ("1", "Configure Network Interface / Static IP (Netplan)"),
    ("2", "Reset / Clear Initial Password Display"),
    ("3", "Update SolarOS from Git (main)"),
    ("4", "Open Root Diagnostic Shell"),
    ("5", "Reboot or Shut Down Server"),
    ("6", "Show Nested Virtualization & Hardware Readiness"),
]


# ---------------------------------------------------------------- Pure helpers (self-tested)


def sh(*argv: str, timeout: float = 15) -> str:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def parse_ipv4(ip_json: str) -> list[tuple[str, str]]:
    """`ip -j -4 addr` -> [(iface, "a.b.c.d/nn")] for LAN-facing interfaces (no loopback, guest or Incus bridges)."""
    try:
        data = json.loads(ip_json or "[]")
    except ValueError:
        return []
    out = []
    for i in data:
        name = i.get("ifname", "")
        if name == "lo" or name.startswith(("virbr", "incusbr", "vnet", "veth", "tap", "docker", "wg")):
            continue
        for a in i.get("addr_info", []):
            if a.get("family") == "inet":
                out.append((name, f"{a['local']}/{a['prefixlen']}"))
    return out


def parse_pools(text: str) -> list[tuple[str, str, str, str]]:
    """`zpool list -H -o name,health,size,alloc` -> [(name, health, size, alloc)]."""
    return [tuple(line.split("\t")[:4]) for line in text.splitlines() if line.count("\t") >= 3]


def netplan_doc(iface: str, kind: str, mode: str, address: str = "", gateway: str = "", dns: list[str] | None = None,
                members: list[str] | None = None) -> dict:
    """A Netplan document for one interface. kind: ethernets|bridges. JSON is valid YAML, so no PyYAML needed."""
    cfg: dict = {"dhcp4": mode == "dhcp", "dhcp6": False}
    if mode == "static":
        cfg["addresses"] = [address]
        if gateway:
            cfg["routes"] = [{"to": "default", "via": gateway}]
        if dns:
            cfg["nameservers"] = {"addresses": dns}
    net: dict = {"version": 2}
    if kind == "bridges":
        cfg["interfaces"] = members or []
        cfg["parameters"] = {"stp": False, "forward-delay": 0}
        net["ethernets"] = {m: {"dhcp4": False, "dhcp6": False} for m in members or []}
    net[kind] = {iface: cfg}
    return {"network": net}


def valid_cidr(v: str) -> bool:
    m = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})", v)
    return bool(m) and all(int(x) <= 255 for x in m.groups()[:4]) and 1 <= int(m.group(5)) <= 32


def valid_ip(v: str) -> bool:
    return valid_cidr(f"{v}/32")


def set_env(text: str, key: str, value: str) -> str:
    """Replace or append KEY='value' in a .env text (same quoting as the backend's write_env)."""
    entry = f"{key}='{value}'"
    lines = [entry if line.startswith(f"{key}=") else line for line in text.splitlines()]
    if entry not in lines:
        lines.append(entry)
    return "\n".join(lines) + "\n"


def new_password(n: int = 14) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def initial_password(text: str) -> str:
    m = re.search(r"^Password:\s*(\S+)", text, re.M)
    return m.group(1) if m else ""


def readiness(f: dict) -> list[tuple[str, bool, str]]:
    """Hardware / hypervisor readiness rows (label, ok, detail) from raw probe results (see probe_readiness)."""
    nested = f.get("nested", "").strip()
    return [
        ("CPU virtualization (VT-x / AMD-V)", bool(f.get("cpu_flag")), f.get("cpu_flag") or "no vmx/svm flag: enable it in the BIOS or the VM's CPU type"),
        ("/dev/kvm", bool(f.get("kvm")), "present" if f.get("kvm") else "missing: KVM guests cannot start"),
        ("Nested virtualization", nested in ("Y", "1"), f"kvm nested={nested}" if nested else "kvm module not loaded"),
        ("libvirtd", f.get("libvirtd") == "active", f.get("libvirtd") or "unknown"),
        ("Incus", f.get("incus") == "active", f.get("incus") or "unknown"),
        ("OpenZFS", bool(f.get("zfs")), f.get("zfs") or "zfs module not loaded"),
        ("Bridge br0", bool(f.get("br0")), f.get("br0") or "missing: guests have no LAN bridge"),
        ("Platform", True, f.get("virt") or "bare metal"),
    ]


def env_get(key: str) -> str:
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


# ---------------------------------------------------------------- Host facts


def facts() -> dict:
    mem = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            mem[k] = int(v.split()[0]) * 1024
    except OSError:
        pass
    cpu = ""
    try:
        cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                    if line.startswith("model name")), "")
    except OSError:
        pass
    total, avail = mem.get("MemTotal", 0), mem.get("MemAvailable", 0)
    load = Path("/proc/loadavg").read_text().split()[:3] if Path("/proc/loadavg").exists() else []
    return {"host": socket.gethostname(), "kernel": os.uname().release, "cpu": cpu, "cores": os.cpu_count() or 0,
            "mem": f"{(total - avail) / 2**30:.1f} / {total / 2**30:.1f} GiB", "load": " ".join(load),
            "ips": parse_ipv4(sh("ip", "-j", "-4", "addr")),
            "pools": parse_pools(sh("zpool", "list", "-H", "-o", "name,health,size,alloc")),
            "backend": sh("systemctl", "is-active", "solardeck-backend").strip() or "unknown"}


def probe_readiness() -> dict:
    flags = Path("/proc/cpuinfo").read_text() if Path("/proc/cpuinfo").exists() else ""
    nested = next((p.read_text() for p in (Path("/sys/module/kvm_intel/parameters/nested"),
                                           Path("/sys/module/kvm_amd/parameters/nested")) if p.exists()), "")
    zfs = Path("/sys/module/zfs/version")
    br0 = next((cidr for iface, cidr in parse_ipv4(sh("ip", "-j", "-4", "addr", "show", "dev", "br0")) if iface == "br0"),
               "up, no IPv4 address" if Path("/sys/class/net/br0").exists() else "")
    virt = sh("systemd-detect-virt").strip()
    return {"cpu_flag": "vmx" if re.search(r"\bvmx\b", flags) else "svm" if re.search(r"\bsvm\b", flags) else "",
            "kvm": Path("/dev/kvm").exists(), "nested": nested,
            # Ubuntu starts libvirtd on demand: an active socket is ready.
            "libvirtd": "active" if "active" in sh("systemctl", "is-active", "libvirtd", "libvirtd.socket").split() else
                        sh("systemctl", "is-active", "libvirtd").strip(),
            "incus": sh("systemctl", "is-active", "incus").strip(),
            "zfs": f"zfs {zfs.read_text().strip()}" if zfs.exists() else "", "br0": br0,
            "virt": f"virtual machine ({virt})" if virt and virt != "none" else ""}


def read_initial_password() -> str:
    for f in (CREDS_FILE, LEGACY_CREDS):
        try:
            return initial_password(f.read_text())
        except OSError:
            continue
    return ""


# ---------------------------------------------------------------- Screens


class Console:
    def __init__(self, scr):
        self.scr = scr
        curses.curs_set(0)
        curses.start_color()
        curses.use_default_colors()
        for i, c in enumerate((curses.COLOR_CYAN, curses.COLOR_GREEN, curses.COLOR_YELLOW, curses.COLOR_RED), 1):
            curses.init_pair(i, c, -1)
        self.status = ""

    def put(self, y: int, x: int, text: str, attr: int = 0) -> None:
        h, w = self.scr.getmaxyx()
        if 0 <= y < h - 1:
            self.scr.addnstr(y, x, text, max(0, w - x - 1), attr)

    def dashboard(self) -> None:
        f = facts()
        # clear(), not erase(): a full repaint wipes kernel/journal lines written to tty1 behind curses' back.
        self.scr.clear()
        y = 0
        for line in BANNER.strip("\n").splitlines():
            self.put(y, 2, line, curses.color_pair(1) | curses.A_BOLD)
            y += 1
        y += 1
        self.put(y, 2, f"Host  {f['host']}    Kernel  {f['kernel']}    Backend  {f['backend']}")
        self.put(y + 1, 2, f"CPU   {f['cpu']} ({f['cores']} threads)    Load  {f['load']}")
        self.put(y + 2, 2, f"RAM   {f['mem']}")
        y += 4
        self.put(y, 2, "Web Management", curses.A_BOLD)
        y += 1
        if not f["ips"]:
            self.put(y, 4, "No IPv4 address yet: use [1] to configure the network.", curses.color_pair(3))
            y += 1
        for iface, cidr in f["ips"]:
            self.put(y, 4, f"http://{cidr.split('/')[0]}", curses.color_pair(2) | curses.A_BOLD)
            self.put(y, 30, f"{iface}  {cidr}")
            y += 1
        initial = read_initial_password()
        if initial:
            self.put(y, 4, f"Initial login:  {env_get('ADMIN_USERNAME') or 'admin'} / {initial}", curses.color_pair(3) | curses.A_BOLD)
            self.put(y + 1, 4, "Change it after signing in, then clear this display with [2].", curses.A_DIM)
            y += 2
        y += 1
        self.put(y, 2, "ZFS Pools", curses.A_BOLD)
        y += 1
        if not f["pools"]:
            self.put(y, 4, "none (create one in Storage & ZFS)")
            y += 1
        for name, health, size, alloc in f["pools"]:
            color = curses.color_pair(2) if health == "ONLINE" else curses.color_pair(4) | curses.A_BOLD
            self.put(y, 4, f"{name:<16}", curses.A_BOLD)
            self.put(y, 21, f"{health:<10}", color)
            self.put(y, 32, f"{alloc} / {size}")
            y += 1
        y += 1
        for key, label in MENU:
            self.put(y, 4, f"[{key}] ", curses.color_pair(1) | curses.A_BOLD)
            self.put(y, 8, label)
            y += 1
        if self.status:
            self.put(y + 1, 2, self.status, curses.color_pair(3))
        self.put(self.scr.getmaxyx()[0] - 2, 2, time.strftime("%Y-%m-%d %H:%M:%S") + "   press a number", curses.A_DIM)
        self.scr.refresh()

    def ask(self, prompt: str, default: str = "") -> str:
        h, _ = self.scr.getmaxyx()
        curses.echo()
        curses.curs_set(1)
        self.scr.move(h - 3, 0)
        self.scr.clrtoeol()
        self.put(h - 3, 2, f"{prompt}{f' [{default}]' if default else ''}: ", curses.A_BOLD)
        self.scr.refresh()
        try:
            val = self.scr.getstr(h - 3, min(len(prompt) + len(default) + 8, 70), 120).decode(errors="replace").strip()
        finally:
            curses.noecho()
            curses.curs_set(0)
        return val or default

    def message(self, lines: list[str], title: str = "") -> None:
        self.scr.erase()
        if title:
            self.put(1, 2, title, curses.color_pair(1) | curses.A_BOLD)
        for i, line in enumerate(lines):
            self.put(3 + i, 2, line)
        self.put(self.scr.getmaxyx()[0] - 2, 2, "Press any key to return", curses.A_DIM)
        self.scr.refresh()
        self.scr.timeout(-1)
        self.scr.getch()

    # [1]
    def network(self) -> None:
        names = sorted(p.name for p in Path("/sys/class/net").iterdir()
                       if p.name != "lo" and not p.name.startswith(("vnet", "veth", "tap", "virbr", "incusbr")))
        default = "br0" if "br0" in names else (names[0] if names else "")
        self.status = f"Interfaces: {', '.join(names)}"
        self.dashboard()
        iface = self.ask("Interface", default)
        if iface not in names:
            self.status = f"Unknown interface {iface!r}"
            return
        mode = self.ask("Mode dhcp/static", "dhcp").lower()
        address = gateway = ""
        dns: list[str] = []
        if mode == "static":
            address = self.ask("Address (CIDR, e.g. 192.168.1.20/24)")
            gateway = self.ask("Gateway")
            dns = [d for d in self.ask("DNS servers (comma separated)", gateway).replace(" ", "").split(",") if d]
            if not valid_cidr(address) or (gateway and not valid_ip(gateway)) or not all(valid_ip(d) for d in dns):
                self.status = "Invalid address, gateway or DNS server; nothing changed"
                return
        elif mode != "dhcp":
            self.status = "Mode must be dhcp or static"
            return
        is_bridge = Path(f"/sys/class/net/{iface}/bridge").exists()
        members = sorted(p.name for p in Path(f"/sys/class/net/{iface}/brif").iterdir()) if is_bridge else []
        doc = netplan_doc(iface, "bridges" if is_bridge else "ethernets", mode, address, gateway, dns, members)
        if self.ask(f"Apply {mode} on {iface}? The connection may drop (yes/no)", "no").lower() != "yes":
            self.status = "Cancelled"
            return
        target = NETPLAN_DIR / ("60-solardeck-bridge.yaml" if iface == "br0" else f"90-solardeck-{iface}.yaml")
        backup = target.read_text() if target.exists() else None
        target.write_text(json.dumps(doc, indent=2) + "\n")
        target.chmod(0o600)
        r = subprocess.run(["netplan", "apply"], capture_output=True, text=True)
        if r.returncode:
            if backup is None:
                target.unlink()
            else:
                target.write_text(backup)
            subprocess.run(["netplan", "apply"], capture_output=True)
            self.status = f"netplan apply failed, previous configuration restored: {(r.stderr or r.stdout).strip()[:120]}"
        else:
            self.status = f"{iface}: {mode} configuration applied"

    # [2]
    def reset_password(self) -> None:
        choice = self.ask("r = reset the admin password, c = clear the initial password display, x = cancel", "x").lower()
        if choice == "c":
            for f in (CREDS_FILE, LEGACY_CREDS):
                f.unlink(missing_ok=True)
            self.status = "Initial password removed from this screen and from disk"
            return
        if choice != "r" or self.ask("Generate a new Web UI admin password? (yes/no)", "no").lower() != "yes":
            self.status = "Cancelled"
            return
        pw = new_password()
        CREDS_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        ENV_FILE.write_text(set_env(ENV_FILE.read_text() if ENV_FILE.exists() else "", "ADMIN_PASSWORD", pw))
        ENV_FILE.chmod(0o600)
        CREDS_FILE.write_text(f"SolarOS Web UI\nUsername: {env_get('ADMIN_USERNAME') or 'admin'}\nPassword: {pw}\n")
        CREDS_FILE.chmod(0o600)
        subprocess.run(["systemctl", "restart", "solardeck-backend"], capture_output=True)
        self.message([f"Username:  {env_get('ADMIN_USERNAME') or 'admin'}", f"Password:  {pw}", "",
                      "The backend was restarted with the new password.",
                      "Two-factor authentication, if enabled, still applies."], "New Web UI admin password")

    # [3]
    def update(self) -> None:
        if self.ask("Update SolarDeck to the latest version of main? (yes/no)", "no").lower() != "yes":
            self.status = "Cancelled"
            return
        script = Path(f"/tmp/{UPDATE_UNIT}.sh")
        shutil.copy(APP_DIR / "deploy/self-update.sh", script)
        subprocess.run(["systemctl", "reset-failed", UPDATE_UNIT], capture_output=True)
        # Detached unit: the update restarts this console, which must not stop the update.
        r = subprocess.run(["systemd-run", "--quiet", f"--unit={UPDATE_UNIT}", "--collect",
                            "-p", f"StandardOutput=truncate:{UPDATE_LOG}", "-p", "StandardError=inherit", "bash",
                            str(script), str(APP_DIR.resolve()), env_get("REPO_URL") or
                            "https://github.com/Legend-Services/SolarOS.git", env_get("REPO_BRANCH") or "main"],
                           capture_output=True, text=True)
        if r.returncode:
            self.status = f"Could not start the update: {r.stderr.strip()[:120]}"
            return
        self.scr.timeout(1000)
        while True:
            lines = UPDATE_LOG.read_text(errors="replace").splitlines()[-30:] if UPDATE_LOG.exists() else []
            self.scr.erase()
            self.put(1, 2, "Updating SolarDeck (q to return; the update keeps running)", curses.A_BOLD)
            for i, line in enumerate(lines):
                self.put(3 + i, 2, line)
            self.scr.refresh()
            done = any(EXIT_MARK.match(x) for x in lines)
            if self.scr.getch() in (ord("q"), ord("Q")) or done:
                self.status = next((x for x in reversed(lines) if EXIT_MARK.match(x)), "Update running")
                return

    # [4]
    def shell(self) -> None:
        curses.endwin()
        print("\nSolarDeck root diagnostic shell. Type 'exit' to return to the dashboard.\n")
        subprocess.call(["/bin/bash", "--login"])
        self.scr.refresh()

    # [5]
    def power(self) -> None:
        choice = self.ask("r = reboot, s = shut down, c = cancel", "c").lower()
        if choice not in ("r", "s") or self.ask("Are you sure? (yes/no)", "no").lower() != "yes":
            self.status = "Cancelled"
            return
        subprocess.run(["systemctl", "reboot" if choice == "r" else "poweroff"])

    # [6]
    def hardware(self) -> None:
        rows = readiness(probe_readiness())
        lines = [f"{'OK  ' if ok else 'FAIL'}  {label:<36} {detail}" for label, ok, detail in rows]
        # Nested virtualization (row 2) only matters for VMs inside guests, so it does not block readiness.
        ready = all(ok for i, (_, ok, _) in enumerate(rows) if i != 2)
        lines += ["", "Ready to host VMs and containers." if ready else "Not fully ready: fix the FAIL rows above."]
        self.message(lines, "Nested Virtualization & Hardware Readiness")

    def loop(self) -> None:
        actions = {"1": self.network, "2": self.reset_password, "3": self.update, "4": self.shell, "5": self.power,
                   "6": self.hardware}
        while True:
            self.dashboard()
            self.scr.timeout(5000)  # refresh the dashboard every 5 s
            key = self.scr.getch()
            if key == -1:
                continue
            fn = actions.get(chr(key)) if 0 < key < 256 else None
            if fn:
                self.status = ""
                try:
                    fn()
                except Exception as e:  # noqa: BLE001 - the console must never exit on an error
                    self.status = f"Error: {e}"[:150]


def self_test() -> None:
    assert parse_ipv4(json.dumps([{"ifname": "lo", "addr_info": [{"family": "inet", "local": "127.0.0.1", "prefixlen": 8}]},
                                  {"ifname": "br0", "addr_info": [{"family": "inet", "local": "10.0.0.5", "prefixlen": 24}]},
                                  {"ifname": "incusbr0", "addr_info": [{"family": "inet", "local": "10.1.1.1", "prefixlen": 24}]}])) \
        == [("br0", "10.0.0.5/24")]
    assert parse_pools("tank\tONLINE\t3.6T\t1.2T\nbad\n") == [("tank", "ONLINE", "3.6T", "1.2T")]
    d = netplan_doc("br0", "bridges", "static", "10.0.0.5/24", "10.0.0.1", ["1.1.1.1"], ["enp1s0"])
    br = d["network"]["bridges"]["br0"]
    assert br["addresses"] == ["10.0.0.5/24"] and br["routes"][0]["via"] == "10.0.0.1" and br["interfaces"] == ["enp1s0"]
    assert d["network"]["ethernets"] == {"enp1s0": {"dhcp4": False, "dhcp6": False}}
    assert netplan_doc("eth0", "ethernets", "dhcp")["network"]["ethernets"]["eth0"]["dhcp4"] is True
    assert valid_cidr("192.168.1.20/24") and not valid_cidr("192.168.1.300/24") and not valid_cidr("10.0.0.1")
    assert set_env("A=1\nADMIN_PASSWORD=old\n", "ADMIN_PASSWORD", "new") == "A=1\nADMIN_PASSWORD='new'\n"
    assert set_env("A=1", "B", "2") == "A=1\nB='2'\n"
    assert len(new_password()) == 14 and new_password().isalnum()
    assert initial_password("SolarOS Web UI\nUsername: admin\nPassword: Ab12\n") == "Ab12"
    assert initial_password("nothing") == ""
    rows = readiness({"cpu_flag": "vmx", "kvm": True, "nested": "Y\n", "libvirtd": "active", "incus": "inactive",
                      "zfs": "zfs 2.2.2", "br0": "10.0.0.5/24", "virt": ""})
    assert [ok for _, ok, _ in rows] == [True, True, True, True, False, True, True, True]
    assert rows[-1][2] == "bare metal" and not readiness({})[0][1]
    print("solardeck-console self-test OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        os.environ.setdefault("TERM", "linux")
        curses.wrapper(lambda scr: Console(scr).loop())
