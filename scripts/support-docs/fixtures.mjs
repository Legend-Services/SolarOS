// Demo API fixtures for the support-docs screenshot run. Playwright strips one "/api" and calls
// fixture(method, path, search); undefined means "unknown endpoint" (let the harness 404 it).
// Shapes follow frontend/src/lib/types.ts plus the local interfaces in each component.

const T0 = 1764000000; // fixed "now" (Nov 2025) so screenshots are deterministic
const GiB = 1024 ** 3;
const TB = 1e12;
const NODE = "solardeck";
const HOST = "10.20.0.10";
const GW = "10.20.0.1";

/** Auth: useAuth.init() calls /auth/me; any 2xx answer unlocks the desktop. */
export const SESSION = { username: "admin", node: NODE };

/* ---------------- Guests ---------------- */

const GUESTS = [
  { vmid: 100, name: "media-server", type: "qemu", status: "running", cpu: 0.12, maxcpu: 4, mem: 6.2 * GiB, maxmem: 8 * GiB, disk: 0, maxdisk: 64 * GiB, uptime: 864000, netin: 9.1e10, netout: 3.4e11 },
  { vmid: 101, name: "home-assistant-ct", type: "lxc", status: "running", cpu: 0.03, maxcpu: 2, mem: 0.9 * GiB, maxmem: 2 * GiB, disk: 3.1 * GiB, maxdisk: 16 * GiB, uptime: 864000, netin: 2.2e9, netout: 1.1e9 },
  { vmid: 102, name: "dev-workstation", type: "qemu", status: "stopped", cpu: 0, maxcpu: 6, mem: 0, maxmem: 12 * GiB, disk: 0, maxdisk: 128 * GiB, uptime: 0, netin: 0, netout: 0 },
  { vmid: 103, name: "dns-filter", type: "lxc", status: "running", cpu: 0.01, maxcpu: 1, mem: 0.2 * GiB, maxmem: 0.5 * GiB, disk: 1.2 * GiB, maxdisk: 4 * GiB, uptime: 1728000, netin: 8.8e8, netout: 9.6e8 },
  { vmid: 104, name: "nextcloud-ct", type: "lxc", status: "stopped", cpu: 0, maxcpu: 2, mem: 0, maxmem: 4 * GiB, disk: 11.4 * GiB, maxdisk: 32 * GiB, uptime: 0, netin: 0, netout: 0 },
  { vmid: 105, name: "local-ai", type: "lxc", status: "running", cpu: 0.06, maxcpu: 8, mem: 5.1 * GiB, maxmem: 12 * GiB, disk: 22 * GiB, maxdisk: 64 * GiB, uptime: 432000, netin: 1.6e10, netout: 4.1e8 },
];
GUESTS.forEach((g) => ["mem", "maxmem", "disk", "maxdisk"].forEach((k) => (g[k] = Math.round(g[k]))));
const guestIp = (vmid) => `10.20.0.${vmid - 50}`;
const mac = (n) => `BC:24:11:0${Math.floor(n / 10) % 10}:${String(n % 100).padStart(2, "0")}:A${n % 10}`;

const guestConfig = (g) => ({
  name: g.name,
  cores: g.maxcpu,
  sockets: 1,
  memory: Math.round(g.maxmem / 1024 ** 2),
  swap: g.type === "lxc" ? 512 : null,
  onboot: g.status === "running",
  description: "",
  tags: "",
  disks: [{ key: g.type === "lxc" ? "rootfs" : "scsi0", volume: `fast-vm:${g.type === "lxc" ? "subvol" : "vm"}-${g.vmid}-disk-0`, size: `${Math.round(g.maxdisk / GiB)}G`, resizable: true }],
});

/* ---------------- Host / telemetry ---------------- */

const overview = () => ({
  node: NODE,
  cpu: 17.4,
  loadavg: [1.42, 1.31, 1.18],
  memory: { used: 19.6 * GiB, total: 32 * GiB, free: 12.4 * GiB, arc: 6 * GiB },
  swap: { used: 0, total: 8 * GiB },
  uptime: 1728000,
  kernel: "Linux 6.8.12",
  platform_version: "SolarOS 2.7.1",
  cpuinfo: { model: "16-core x86-64 CPU", cpus: 32, sockets: 1, cores: 16 },
  net: { in: 1.8e6, out: 4.2e6 },
  vms: { running: 1, stopped: 1, total: 2 },
  containers: { running: 3, stopped: 1, total: 4 },
});

const vdev = (name, children) => ({ name, state: "ONLINE", read: 0, write: 0, cksum: 0, ...(children ? { children } : {}) });
const POOLS = [
  {
    name: "tank", size: 23.9 * TB, alloc: 9.1 * TB, free: 14.8 * TB, frag: 4, dedup: 1, health: "ONLINE",
    detail: { state: "ONLINE", scan: "scrub repaired 0B in 05:12:41 with 0 errors on Sun Nov 9 05:36:41 2025", errors: "No known data errors", children: [vdev("tank", [vdev("raidz1-0", [vdev("sda"), vdev("sdb"), vdev("sdc")])])] },
  },
  {
    name: "fast", size: 0.99 * TB, alloc: 0.31 * TB, free: 0.68 * TB, frag: 9, dedup: 1, health: "ONLINE",
    detail: { state: "ONLINE", scan: "scrub repaired 0B in 00:04:12 with 0 errors on Sun Nov 9 00:28:12 2025", errors: "No known data errors", children: [vdev("fast", [vdev("mirror-0", [vdev("nvme0n1"), vdev("nvme1n1")])])] },
  },
];

const TARGETS = [
  { storage: "local", type: "dir", content: "iso,vztmpl,backup", active: 1, enabled: 1, total: 98 * GiB, used: 21 * GiB, avail: 77 * GiB },
  { storage: "fast-vm", type: "zfspool", content: "images,rootdir", active: 1, enabled: 1, total: 0.96 * TB, used: 0.31 * TB, avail: 0.65 * TB },
  { storage: "tank-data", type: "zfspool", content: "images,rootdir", active: 1, enabled: 1, total: 15.7 * TB, used: 6.1 * TB, avail: 9.6 * TB },
  { storage: "backup", type: "dir", content: "backup", active: 1, enabled: 1, total: 4 * TB, used: 0.82 * TB, avail: 3.18 * TB },
];

// [devpath, model, serial, type, bus, size, pool, vdev, rotational, wear, temp]
const DISK_ROWS = [
  ["/dev/nvme0n1", "NVMe SSD 1 TB", "S6EXNF0R1001", "nvme", "NVMe", 1.0 * TB, "fast", "mirror-0", false, 96, 41],
  ["/dev/nvme1n1", "NVMe SSD 1 TB", "S6EXNF0R1002", "nvme", "NVMe", 1.0 * TB, "fast", "mirror-0", false, 97, 43],
  ["/dev/sda", "SATA HDD 8 TB", "ZA1B2C3D", "hdd", "SATA", 8.0 * TB, "tank", "raidz1-0", true, null, 34],
  ["/dev/sdb", "SATA HDD 8 TB", "ZA1B2C3E", "hdd", "SATA", 8.0 * TB, "tank", "raidz1-0", true, null, 35],
  ["/dev/sdc", "SATA HDD 8 TB", "ZA1B2C3F", "hdd", "SATA", 8.0 * TB, "tank", "raidz1-0", true, null, 35],
  ["/dev/sdd", "SATA SSD 500 GB", "2231E5A0B7C1", "ssd", "SATA", 0.5 * TB, null, null, false, 99, 31],
];
const short = (p) => p.split("/").pop();

const DISKS = DISK_ROWS.map(([devpath, model, serial, type, , size, pool, , , wear]) => ({
  devpath, model, serial, size, type, health: "PASSED", wearout: wear ?? "N/A", used: pool ? "ZFS" : "",
}));

const PHYSICAL_DISKS = DISK_ROWS.map(([devpath, model, serial, type, bus, size, pool, vd, rot, wear]) => ({
  devpath, by_id: `/dev/disk/by-id/${bus.toLowerCase()}-${model.replace(/ /g, "_")}_${serial}`, model, serial, vendor: "", size, type, bus,
  rotational: rot, rpm: rot ? 7200 : null, rpm_label: rot ? "7200 RPM" : "SSD / NVMe", used: pool ? "ZFS" : "", gpt: !!pool,
  health: "PASSED", wearout_pct: wear, pool_name: pool, vdev_name: vd, member_device: pool ? `/dev/${short(devpath)}` : null,
  member_state: pool ? "ONLINE" : null, read_errors: pool ? 0 : null, write_errors: pool ? 0 : null, cksum_errors: pool ? 0 : null,
}));

const GPU = { available: true, name: "Discrete GPU 16 GB", temp_c: 48, utilization_pct: 12, vram_used_mb: 5120, vram_total_mb: 16384, power_w: 38 };
const hardwareTelemetry = () => ({
  disks: DISK_ROWS.map(([devpath, model, serial, type, , size, , , , wear, temp]) => ({ devpath, model, serial, type, size, health: "PASSED", life_left_pct: wear, temp_c: temp })),
  gpu: GPU,
  igpu: { available: false, quicksync: false, render_nodes: [] },
});

const DATASETS = [
  ["tank", 9.1, 14.8, 0.2, "/tank"], ["tank/media", 6.4, 14.8, 6.4, "/tank/media"], ["tank/documents", 0.4, 14.8, 0.4, "/tank/documents"],
  ["tank/photos", 1.6, 14.8, 1.6, "/tank/photos"], ["tank/backups", 0.8, 14.8, 0.8, "/tank/backups"],
  ["fast", 0.31, 0.65, 0.01, "/fast"], ["fast/subvol-101-disk-0", 0.003, 0.013, 0.003, "/fast/subvol-101-disk-0"],
];
const DATASET_INFO = DATASETS.map(([name, used, avail, refer, mountpoint]) => ({
  name, type: "filesystem", pool: name.split("/")[0], used: used * TB, available: avail * TB, refer: refer * TB, mountpoint,
  compression: "lz4", recordsize: name.includes("media") ? "1M" : "128K", quota: 0, atime: "off", volsize: 0, guest_volume: name.includes("subvol"),
}));
const SNAPSHOTS = ["tank/documents", "tank/photos", "tank/media"].flatMap((ds, i) =>
  [1, 2, 3].map((d) => ({ name: `${ds}@auto-2025-11-${String(25 - d).padStart(2, "0")}`, dataset: ds, snapshot: `auto-2025-11-${String(25 - d).padStart(2, "0")}`, used: (i + 1) * d * 0.4 * GiB, refer: (i + 1) * 120 * GiB, creation: T0 - d * 86400 })),
);

const bench = (mbpsR, mbpsW, iops, lat) => ({ read: { mbps: mbpsR, iops, lat_us: lat }, write: { mbps: mbpsW, iops: Math.round(iops * 0.8), lat_us: lat * 1.3 } });
const BENCH_HISTORY = [
  {
    id: "b1", label: "fast (NVMe mirror)", target_type: "mountpoint", target: "/fast", mode: "readwrite", test_size_mb: 1024, passes: 3, status: "done", phase: null, pass: 3, error: null,
    started_at: T0 - 7200, finished_at: T0 - 6900, done_steps: 4, total_steps: 4,
    steps: [
      { profile: "SEQ1M_Q8T1", status: "done", ...bench(3410, 2870, 3400, 2300) },
      { profile: "SEQ128K_Q32T1", status: "done", ...bench(3120, 2650, 24900, 1280) },
      { profile: "RND4K_Q32T1", status: "done", ...bench(1210, 980, 310000, 102) },
      { profile: "RND4K_Q1T1", status: "done", ...bench(72, 210, 18400, 54) },
    ],
  },
];

/* ---------------- Backups / ISOs ---------------- */

const archive = (g, d) => ({
  volid: `backup:backup/vzdump-${g.type}-${g.vmid}-2025_11_${String(25 - d).padStart(2, "0")}-02_00_00.${g.type === "qemu" ? "vma" : "tar"}.zst`,
  storage: "backup", content: "backup", format: g.type === "qemu" ? "vma.zst" : "tar.zst", size: (g.maxdisk / 6) * (1 + d * 0.02),
  ctime: T0 - d * 86400, vmid: g.vmid, notes: g.name, protected: d === 1, type: g.type, name: g.name,
});
const BACKUPS = {
  storages: ["backup", "local"],
  archives: GUESTS.filter((g) => g.vmid !== 102).flatMap((g) => [1, 2].map((d) => archive(g, d))),
  schedules: [
    { id: "backup-nightly", enabled: true, schedule: "02:00", storage: "backup", all: true, vmid: "", mode: "snapshot", compress: "zstd", comment: "Nightly backup of every guest", keep_last: 7, next_run: T0 + 30000 },
    { id: "backup-weekly-dev", enabled: false, schedule: "sun 03:30", storage: "backup", all: false, vmid: "102", mode: "stop", compress: "zstd", comment: "Weekly dev workstation", keep_last: 4, next_run: T0 + 300000 },
  ],
};
const vol = (storage, content, file, size, d) => ({ volid: `${storage}:${content}/${file}`, storage, content, format: content === "iso" ? "iso" : "tzst", size, ctime: T0 - d * 86400, vmid: null, notes: "", protected: false });
const ISOS = [vol("local", "iso", "linux-server-24.04-x86_64.iso", 2.6 * GiB, 20), vol("local", "iso", "linux-desktop-24.04-x86_64.iso", 5.8 * GiB, 12), vol("local", "iso", "rescue-toolkit-2025.10.iso", 0.9 * GiB, 40)];
const TEMPLATES = [vol("local", "vztmpl", "linux-base-24.04-standard_x86_64.tar.zst", 0.14 * GiB, 30), vol("local", "vztmpl", "linux-minimal-3.20-default_x86_64.tar.xz", 0.003 * GiB, 30)];

/* ---------------- Shares / files ---------------- */

const share = (name, path, comment, extra = {}) => ({ name, path, comment, read_only: false, guest_ok: false, browseable: true, recycle_bin: true, timemachine: false, users: ["admin", "family"], ...extra });
const SHARES = [
  share("media", "/tank/media", "Movies, shows and music", { read_only: true, guest_ok: true }),
  share("documents", "/tank/documents", "Household paperwork"),
  share("photos", "/tank/photos", "Family photo library"),
  share("laptop-backups", "/tank/backups", "Laptop backups", { timemachine: true, users: ["admin"] }),
];

const f = (dir, name, size, d, isDir = false) => ({ name, path: `${dir === "/" ? "" : dir}/${name}`, is_dir: isDir, size: isDir ? 0 : size, mtime: T0 - d * 3600 });
function listing(path) {
  const p = path || "/";
  if (p === "/") return { path: p, items: ["backups", "documents", "isos", "media", "photos", "projects"].map((n, i) => f(p, n, 0, i * 30, true)).concat([f(p, "README.txt", 2140, 400)]) };
  return {
    path: p,
    items: [
      f(p, "archive", 0, 200, true), f(p, "2025", 0, 50, true),
      f(p, "budget-2025.xlsx", 48_210, 26), f(p, "family-trip.mp4", 1_840_000_000, 90), f(p, "invoice-0412.pdf", 182_400, 4),
      f(p, "notes.md", 6_120, 2), f(p, "router-config.tar.gz", 92_300, 140), f(p, "sunset.jpg", 4_210_000, 70),
    ],
  };
}

/* ---------------- Network switch ---------------- */

const phys = (name, bridge, mode, access, tagged, up, speed) => ({ name, mac: `A8:A1:59:3C:0${name.slice(-1)}:1${name.length}`, link_up: up, speed_mbps: up ? speed : null, driver: null, pci_slot: `0000:0${name.slice(-1)}:00.0`, assigned_bridge: bridge, vlan_mode: mode, access_vlan: access, tagged_vlans: tagged, ipv4_cidr: null, method: "manual", mtu: 1500 });
const dhcp20 = { enabled: true, gateway_ip: "10.20.20.1", subnet_mask: "255.255.255.0", range_start: "10.20.20.100", range_end: "10.20.20.199", lease_time: "12h", dns_servers: ["10.20.20.1", "9.9.9.9"], static_leases: [{ mac: "BC:24:11:0A:01:01", ip: "10.20.20.10", hostname: "thermostat" }] };
const SWITCH = {
  physical: [
    phys("eno1", "br0", "trunk", 1, [10, 20], true, 2500),
    phys("eno2", "br0", "access", 10, [], true, 1000),
    phys("enp3s0", "br-lab", "trunk", 1, [30], true, 10000),
    phys("enp4s0", null, "unassigned", null, [], false, null),
  ],
  bridges: [
    { name: "br0", vlan_aware: true, ipv4_cidr: `${HOST}/24`, ipv4_gateway: GW, ipv6_cidr: null, dns_servers: [GW], method: "static", mtu: 1500, autostart: true, mode: "bridged", member_ports: ["eno1", "eno2"], comment: "Main LAN", live: true, protected: true },
    { name: "br-lab", vlan_aware: true, ipv4_cidr: "10.30.0.1/24", ipv4_gateway: null, ipv6_cidr: null, dns_servers: [], method: "static", mtu: 1500, autostart: true, mode: "isolated", member_ports: ["enp3s0"], comment: "Lab segment", live: true, protected: false },
  ],
  host_vnics: [
    { name: "br0.10", type: "vlan", parent: "br0", vlan_id: 10, ipv4_cidr: "10.20.10.10/24", method: "static", link_up: true, assigned_bridge: "br0", vlan_mode: "access", access_vlan: 10, tagged_vlans: [] },
  ],
  guest_vnics: GUESTS.map((g, i) => {
    const vlan = [null, 20, 30, 10, 20, null][i];
    return {
      guest_id: g.vmid, guest_name: g.name, guest_type: g.type === "qemu" ? "vm" : "lxc", status: g.status, net_id: "net0",
      bridge: vlan === 30 ? "br-lab" : "br0", vlan_tag: vlan, trunks: [], model: g.type === "qemu" ? "virtio" : "veth", mac: mac(g.vmid),
      ip_address: g.status === "running" ? guestIp(g.vmid) : null, rate_mbps: null, link_disconnected: false, vlan_mode: "access",
    };
  }),
  vlans: [
    { vlan_id: 10, name: "Management", color: "#38bdf8", bridge: "br0", host_ipv4_cidr: "10.20.10.10/24", description: "Admin access to the server and switches", dhcp_config: null, dhcp_active: false },
    { vlan_id: 20, name: "Smart Home", color: "#22c55e", bridge: "br0", host_ipv4_cidr: "10.20.20.1/24", description: "Sensors, plugs and the home automation hub", dhcp_config: dhcp20, dhcp_active: true },
    { vlan_id: 30, name: "Lab", color: "#a855f7", bridge: "br-lab", host_ipv4_cidr: null, description: "Throwaway test machines", dhcp_config: null, dhcp_active: false },
  ],
  default_bridge: "br0",
  bridge_prefix: "br",
  pending: false,
  rollback_seconds_left: null,
  dnsmasq_installed: true,
  nic_models: ["virtio", "e1000"],
};
const LEASES = { leases: [
  { ip: "10.20.20.10", mac: "BC:24:11:0A:01:01", hostname: "thermostat", expires_at: 0, is_static: true },
  { ip: "10.20.20.112", mac: "BC:24:11:0A:01:22", hostname: "living-room-plug", expires_at: T0 + 21600, is_static: false },
  { ip: "10.20.20.131", mac: "BC:24:11:0A:01:31", hostname: "door-sensor", expires_at: T0 + 30000, is_static: false },
] };

const IFACES = [
  { iface: "eno1", type: "eth", active: 1, autostart: 1, method: "manual" },
  { iface: "eno2", type: "eth", active: 1, autostart: 1, method: "manual" },
  { iface: "br0", type: "bridge", active: 1, autostart: 1, method: "static", cidr: `${HOST}/24`, address: HOST, netmask: "24", gateway: GW, bridge_ports: "eno1 eno2", comments: "Main LAN" },
  { iface: "br-lab", type: "bridge", active: 1, autostart: 1, method: "static", cidr: "10.30.0.1/24", address: "10.30.0.1", netmask: "24", bridge_ports: "enp3s0", comments: "Lab segment" },
];

const TOPOLOGY = (() => {
  const n = (id, type, label, ip, status, meta = {}) => ({ id, type, label, ip, mac: null, status, meta });
  const e = (source, target, kind, label = "") => ({ id: `${source}-${target}`, source, target, kind, label });
  const nodes = [n("internet", "internet", "Internet", GW, "up"), n("eno1", "nic", "eno1", null, "up"), n("enp3s0", "nic", "enp3s0", null, "up"),
    n("br0", "bridge", "br0", HOST, "up", { comment: "Main LAN" }), n("br-lab", "bridge", "br-lab", "10.30.0.1", "up", { comment: "Lab segment" }),
    n("vlan20", "vlan", "VLAN 20 · Smart Home", "10.20.20.1", "up"), n("wg0", "wireguard", "wg0", "10.99.0.1", "up"), n("peer-phone", "peer", "phone", "10.99.0.2", "up")];
  const edges = [e("internet", "eno1", "uplink"), e("eno1", "br0", "port"), e("enp3s0", "br-lab", "port"), e("br0", "vlan20", "port", "VLAN 20"), e("br0", "wg0", "vpn"), e("wg0", "peer-phone", "vpn")];
  for (const g of GUESTS) {
    const id = `g${g.vmid}`;
    nodes.push(n(id, g.type === "qemu" ? "vm" : "lxc", g.name, g.status === "running" ? guestIp(g.vmid) : null, g.status, { vmid: g.vmid, guest_type: g.type }));
    edges.push(e(g.vmid === 102 ? "br-lab" : "br0", id, "vnic", "net0"));
  }
  return { nodes, edges };
})();

/* ---------------- Network services ---------------- */

const NET_STATUS = {
  packages: { dnsmasq: true, "wireguard-tools": true, nftables: true, "acme-client": true },
  services: { dnsmasq: "active", router: "active", "wg-quick@wg0": "active" },
  forwarding: { ipv4: true, ipv6: false },
  wg_interfaces: ["wg0"],
  interfaces: [{ iface: "br0", type: "bridge", cidr: `${HOST}/24`, active: true }, { iface: "br-lab", type: "bridge", cidr: "10.30.0.1/24", active: true }, { iface: "wg0", type: "wireguard", cidr: "10.99.0.1/24", active: true }],
  host_ip: HOST,
};
const DNS = {
  enabled: true, interfaces: ["br0"], upstream: "custom", custom_upstream: ["9.9.9.9", "149.112.112.112"], cache_size: 10000,
  records: [{ type: "A", name: "solardeck.home.lan", value: HOST }, { type: "A", name: "media.home.lan", value: guestIp(100) }, { type: "CNAME", name: "files.home.lan", value: "solardeck.home.lan" }],
  adblock: { lists: ["ads", "trackers"], whitelist: ["status.example.org"], blacklist: [], updated: T0 - 21600, domains: 184_220 },
  blocklists: { ads: { name: "Community ad list", url: "https://lists.example.org/ads.txt" }, trackers: { name: "Tracker list", url: "https://lists.example.org/trackers.txt" }, malware: { name: "Malware domains", url: "https://lists.example.org/malware.txt" } },
};
const DNS_STATS = { queries: 48_211, blocked: 6_904, blocked_pct: 14.3, top_blocked: [{ domain: "ads.example.net", count: 1204 }, { domain: "metrics.example.com", count: 811 }, { domain: "beacon.example.io", count: 402 }], cache: { size: 10000, inserted: 22_140, evicted: 0, hits: 31_802, misses: 16_409 } };
const DHCP = {
  enabled: true, interface: "br0", start: "10.20.0.100", end: "10.20.0.199", netmask: "255.255.255.0", gateway: GW, dns: [HOST], lease: "12h",
  reservations: [{ mac: mac(100), ip: guestIp(100), hostname: "media-server" }, { mac: "3C:22:FB:10:22:01", ip: "10.20.0.40", hostname: "printer" }],
  leases: [{ expires: T0 + 20000, mac: "3C:22:FB:10:22:31", ip: "10.20.0.131", hostname: "laptop" }, { expires: T0 + 36000, mac: "3C:22:FB:10:22:45", ip: "10.20.0.145", hostname: "tablet" }, { expires: T0 + 9000, mac: "3C:22:FB:10:22:52", ip: "10.20.0.152", hostname: "tv" }],
};
const live = (h) => ({ endpoint: "203.0.113.24:51820", handshake: T0 - h, rx: 3.1e8, tx: 1.2e9 });
const WG = {
  enabled: true, port: 51820, subnet: "10.99.0.0/24", wan: "br0", endpoint: "vpn.example.net", dns: [HOST], public_key: "kV9mS2c8w0Gx6oQe3yJ1bTz5LhR4nUdA7pFiXqWvYs8=", address: "10.99.0.1/24", running: true,
  peers: [
    { name: "phone", ip: "10.99.0.2", public_key: "pQ3rT5uV7wX9yZ1aB3cD5eF7gH9iJ1kL3mN5oP7qR9s=", allowed_ips: "10.99.0.2/32", live: live(90) },
    { name: "laptop", ip: "10.99.0.3", public_key: "aB1cD3eF5gH7iJ9kL1mN3oP5qR7sT9uV1wX3yZ5aB7c=", allowed_ips: "10.99.0.3/32", live: null },
  ],
};
const WG_CLIENTS = [{ name: "office-vpn", up: true, live: { public_key: "zY8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE8dC6bA4zY2x=", peers: [{ ...live(40), allowed_ips: "10.50.0.0/24" }] } }];
const ROUTER = {
  ipv4_forward: true, ipv6_forward: false, wan: "br0", lan: "br-lab", masquerade: true,
  forwards: [{ proto: "tcp", ext_port: "8443", int_ip: guestIp(104), int_port: 443, comment: "Cloud files" }, { proto: "udp", ext_port: "51820", int_ip: HOST, int_port: 51820, comment: "WireGuard" }],
  routes: [{ dest: "10.50.0.0/24", gateway: null, dev: "wg-office" }],
  ruleset: "table inet solardeck {\n  chain prerouting { type nat hook prerouting priority dstnat; }\n  chain postrouting { type nat hook postrouting priority srcnat; oifname \"br0\" masquerade }\n}",
};
const CERTS = {
  certificates: [{ filename: "solardeck.pem", subject: "CN=solardeck.home.lan", issuer: "CN=Example Public CA R3", notafter: T0 + 60 * 86400, san: ["solardeck.home.lan", "files.home.lan"] }],
  acme: "account=default\ndomains=solardeck.home.lan", domains: ["solardeck.home.lan"], accounts: [{ name: "default" }],
  plugins: [{ plugin: "home-dns", api: "rfc2136", type: "dns" }], dns_apis: ["rfc2136", "acmedns"], nginx_https: true,
};
const DOMAINS = {
  domains: [{ name: "home.lan", hosts: [{ name: "solardeck", ip: HOST }, { name: "media", ip: guestIp(100) }, { name: "files", ip: HOST }] }],
  certificate: { fqdn: "solardeck.home.lan", plugin: "rfc2136", email: "admin@home.lan", issued: T0 - 30 * 86400 },
  dns_service: { installed: true, enabled: true },
  https: { subject: "solardeck.home.lan", issuer: "Example Public CA R3", names: ["solardeck.home.lan", "files.home.lan"], self_signed: false, lets_encrypt: true, expires: T0 + 60 * 86400 },
  job: null,
};

/* ---------------- Datacenter ---------------- */

const USERS = [
  { userid: "admin@pam", enable: 1, expire: 0, email: "admin@home.lan", firstname: "Server", lastname: "Admin", comment: "Built-in administrator", groups: ["admins"], tokens: [{ tokenid: "automation" }], "realm-type": "pam" },
  { userid: "family@solar", enable: 1, expire: 0, email: "family@home.lan", firstname: "Family", lastname: "", comment: "Media and file access", groups: ["viewers"], tokens: [], "realm-type": "solar" },
  { userid: "ops@solar", enable: 1, expire: T0 + 90 * 86400, email: "ops@home.lan", firstname: "Lab", lastname: "Operator", comment: "Runs the lab VMs", groups: ["operators"], tokens: [], "realm-type": "solar" },
  { userid: "guest@solar", enable: 0, expire: 0, email: "", firstname: "Guest", lastname: "", comment: "Disabled", groups: [], tokens: [], "realm-type": "solar" },
];
const GROUPS = [{ groupid: "admins", comment: "Full access", users: "admin@pam" }, { groupid: "operators", comment: "Start, stop and console", users: "ops@solar" }, { groupid: "viewers", comment: "Read-only", users: "family@solar" }];
const PRIVS = ["Datastore.Allocate", "Datastore.Audit", "Sys.Audit", "Sys.Console", "Sys.Modify", "VM.Allocate", "VM.Audit", "VM.Backup", "VM.Config.Disk", "VM.Console", "VM.PowerMgmt", "VM.Snapshot"];
const ROLES = [
  { roleid: "Administrator", privs: PRIVS.join(","), special: 1 },
  { roleid: "NoAccess", privs: "", special: 1 },
  { roleid: "VMOperator", privs: "VM.Audit,VM.Console,VM.PowerMgmt,VM.Snapshot", special: 0 },
  { roleid: "Auditor", privs: "Datastore.Audit,Sys.Audit,VM.Audit", special: 1 },
];
const ACL = [
  { path: "/", type: "group", ugid: "admins", roleid: "Administrator", propagate: 1 },
  { path: "/pool/lab", type: "group", ugid: "operators", roleid: "VMOperator", propagate: 1 },
  { path: "/vms/100", type: "user", ugid: "family@solar", roleid: "Auditor", propagate: 0 },
  { path: "/", type: "token", ugid: "admin@pam!automation", roleid: "Auditor", propagate: 1 },
];
const POOLS_DC = [
  { poolid: "lab", comment: "Lab machines", members: [{ id: "qemu/102", type: "qemu", vmid: 102, name: "dev-workstation" }, { id: "lxc/104", type: "lxc", vmid: 104, name: "nextcloud-ct" }] },
  { poolid: "home", comment: "Always-on home services", members: [{ id: "lxc/101", type: "lxc", vmid: 101, name: "home-assistant-ct" }, { id: "lxc/103", type: "lxc", vmid: 103, name: "dns-filter" }, { id: "storage/backup", type: "storage", storage: "backup" }] },
];
const TOKENS = [{ userid: "admin@pam", tokenid: "automation", comment: "Home automation hub", expire: 0, privsep: 1 }, { userid: "admin@pam", tokenid: "monitoring", comment: "Metrics exporter", expire: T0 + 180 * 86400, privsep: 1 }];
const REALMS = [{ realm: "pam", type: "pam", comment: "Linux PAM standard authentication", tfa: "" }, { realm: "solar", type: "solar", comment: "SolarDeck built-in users", default: 1 }];
const FW_RULES = [
  { pos: 0, type: "in", action: "ACCEPT", enable: 1, proto: "tcp", dport: "443", source: "10.20.0.0/24", comment: "Web UI from LAN" },
  { pos: 1, type: "in", action: "ACCEPT", enable: 1, macro: "SSH", source: "10.20.10.0/24", comment: "SSH from management VLAN" },
  { pos: 2, type: "in", action: "ACCEPT", enable: 1, proto: "udp", dport: "51820", comment: "WireGuard" },
  { pos: 3, type: "in", action: "DROP", enable: 1, source: "10.30.0.0/24", dest: "10.20.0.0/24", comment: "Keep the lab off the LAN", log: "info" },
];
const LOG_LINES = [
  "Nov 25 08:00:01 solardeck systemd[1]: Started daily snapshot timer.",
  "Nov 25 08:00:02 solardeck zed[1882]: eid=412 class=history_event pool='tank'",
  "Nov 25 08:02:14 solardeck solardeck[911]: admin signed in from 10.20.0.131",
  "Nov 25 08:05:40 solardeck kernel: br0: port 3(tap100i0) entered forwarding state",
  "Nov 25 08:10:00 solardeck dnsmasq[1201]: read /etc/hosts - 12 names",
  "Nov 25 08:15:22 solardeck solardeck[911]: backup job backup-nightly finished (5 guests, 0 errors)",
];
const CLUSTER_LOG = LOG_LINES.map((msg, i) => ({ uid: `log${i}`, time: T0 - (LOG_LINES.length - i) * 600, user: i === 2 ? "admin@pam" : "root@pam", tag: ["systemd", "zed", "auth", "kernel", "dnsmasq", "backup"][i], msg: msg.split(": ").slice(1).join(": "), pri: 6 }));

/* ---------------- Security ---------------- */

const POSTURE = {
  score: 86, host_reachable: true,
  items: [
    { id: "2fa", title: "Two-factor sign-in", weight: 20, status: "pass", detail: "Enabled for admin.", fix: null, link: null },
    { id: "https", title: "Trusted HTTPS certificate", weight: 15, status: "pass", detail: "Valid until Jan 24, 2026.", fix: null, link: null },
    { id: "firewall", title: "Host firewall", weight: 15, status: "pass", detail: "Enabled; web UI and SSH limited to the LAN.", fix: null, link: null },
    { id: "ssh-password", title: "SSH password login", weight: 15, status: "warn", detail: "Password login is still allowed for SSH.", fix: "Allow only key-based SSH sign-in", link: null },
    { id: "updates", title: "System updates", weight: 15, status: "pass", detail: "Up to date (checked today).", fix: null, link: null },
    { id: "audit", title: "Tamper-evident audit log", weight: 10, status: "pass", detail: "Hash chain intact.", fix: null, link: null },
    { id: "backups", title: "Recent backups", weight: 10, status: "pass", detail: "Last backup 6 hours ago.", fix: null, link: null },
  ],
};
const SESSIONS = [
  { id: "s1", user: "admin", ip: "10.20.0.131", device: "Desktop browser", issued: T0 - 3600, last_seen: T0 - 5, current: true },
  { id: "s2", user: "admin", ip: "10.99.0.2", device: "Mobile browser (VPN)", issued: T0 - 86400 * 2, last_seen: T0 - 7200, current: false },
];
const AUDIT = [
  ["login", "admin", "10.20.0.131", true, { method: "password+2fa" }],
  ["guest", "admin", "10.20.0.131", true, { action: "start", vmid: 100 }],
  ["zfs", "admin", "10.20.0.131", true, { action: "snapshot", dataset: "tank/documents" }],
  ["firewall", "admin", "10.20.0.131", true, { action: "rule_add", pos: 3 }],
  ["login", "admin", "10.20.0.77", false, { reason: "bad password" }],
  ["update", "system", null, true, { action: "check", result: "up to date" }],
  ["session", "admin", "10.99.0.2", true, { action: "created" }],
].map(([event, user, ip, ok, details], i) => ({ ts: new Date((T0 - i * 2700) * 1000).toISOString(), event, user, ip, ok, details, entry_hash: (0x9f3a1c00 + i * 7919).toString(16).padStart(64, "0") }));

/* ---------------- System ---------------- */

const SYSTEM_INFO = {
  node: NODE, version: { version: "2.7.1", release: "2.7", repoid: "c1ecf74" }, platform_version: "SolarOS 2.7.1", kernel: "Linux 6.8.12", uptime: 1728000,
  cpu_model: "16-core x86-64 CPU", cpus: 32, boot_mode: "efi", network: IFACES, dns: { search: "home.lan", dns1: GW, dns2: "9.9.9.9" },
  api: { host: "127.0.0.1:8006", token_id: "solardeck@local!api", connected: true, verify_ssl: false }, admin_username: "admin", storage_root: "/tank", helper: "/usr/local/libexec/solardeck-helper",
};
const UPDATE_SETTINGS = { mode: "notify", schedule_frequency: "daily", schedule_time: "03:00", schedule_day: 0, last_checked_at: new Date((T0 - 3600) * 1000).toISOString(), latest_remote_commit: "c1ecf74", latest_remote_tag: "v2.7.1", update_available: false, last_check_error: null };
const VERSIONS = [
  ["c1ecf74", "v2.7.1", "Settings de-duplication", 0], ["5b36b77", "v2.7.0", "Visual virtual switch and VLAN patch panel", 6], ["a91d2e0", "v2.6.1", "Disk benchmark history", 19], ["7f03b52", "v2.6.0", "Local AI Studio storage settings", 33],
].map(([h, tag, subject, d], i) => ({ hash: h.padEnd(40, "0"), short_hash: h, tag, date: new Date((T0 - d * 86400) * 1000).toISOString(), subject, is_current: i === 0 }));
const UPDATE_STATUS = {
  git: true, commit: "c1ecf74", tag: "v2.7.1", branch: "main", remote: "origin", version: "2.7.1", driver: "native_ubuntu", edition: "solaros", service: "solardeck",
  supports_system_packages: true, remote_commit: "c1ecf74", remote_tag: "v2.7.1", update_available: false, incoming: [], settings: UPDATE_SETTINGS, running: false, exit_code: null, log: [], logs: [],
};
const REPOS = {
  digest: "4be1c0de",
  repositories: [
    { path: "/etc/apt/sources.list.d/system.sources", index: 0, enabled: true, types: ["deb"], uris: ["https://packages.example.org/linux"], suites: ["stable", "stable-updates"], components: ["main"], handle: null },
    { path: "/etc/apt/sources.list.d/system.sources", index: 1, enabled: true, types: ["deb"], uris: ["https://security.example.org/linux"], suites: ["stable-security"], components: ["main"], handle: null },
    { path: "/etc/apt/sources.list.d/solardeck.sources", index: 0, enabled: true, types: ["deb"], uris: ["https://repo.example.org/solardeck"], suites: ["stable"], components: ["main"], handle: "solardeck" },
  ],
  names: { solardeck: "SolarDeck packages" },
  available: [{ handle: "testing", name: "Testing", description: "Pre-release packages; not for production." }],
  errors: [],
};
const APT_UPDATES = [
  { Package: "openssl", Title: "Secure Sockets Layer toolkit", OldVersion: "3.0.13-1", Version: "3.0.13-2", Origin: "security" },
  { Package: "zfsutils-linux", Title: "ZFS command-line tools", OldVersion: "2.2.6-1", Version: "2.2.7-1", Origin: "stable-updates" },
  { Package: "curl", Title: "Command line URL tool", OldVersion: "8.5.0-2", Version: "8.5.0-3", Origin: "security" },
];
const SERVICES = [
  ["solardeck.service", "SolarDeck web interface"], ["ssh.service", "Secure Shell server"], ["zfs-zed.service", "ZFS Event Daemon"],
  ["dnsmasq.service", "DNS and DHCP server"], ["smbd.service", "File sharing server"], ["nftables.service", "Packet filtering rules"],
  ["wg-quick@wg0.service", "WireGuard tunnel wg0"], ["cron.service", "Regular background program processing"], ["chrony.service", "Time synchronisation"],
].map(([unit, description]) => ({ unit, load: "loaded", active: "active", sub: "running", description }));

const INVENTORY = {
  system: { manufacturer: "Generic", product: "Tower Server", board_manufacturer: "Generic", board: "Workstation Board", board_version: "1.0", bios_vendor: "Generic UEFI", bios_version: "2.14", bios_date: "08/12/2025", kernel: "6.8.12" },
  virtualization: { cpu: "Hardware virtualization (VMX)", iommu: true, cmdline: "BOOT_IMAGE=/vmlinuz root=ZFS=rpool/ROOT/solaros iommu=pt" },
  cpu: { model: "16-core x86-64 CPU", sockets: 1, cores: 16, threads: 32, max_mhz: 5100, mhz: { min: 1400, avg: 2850, max: 4900 }, package_c: 52, cores_c: Array.from({ length: 8 }, (_, i) => ({ label: `Core ${i}`, c: 46 + (i % 4) * 2 })) },
  memory: {
    total: 32 * GiB, available: 12.4 * GiB, used: 19.6 * GiB, cached: 2.1 * GiB, arc: 6 * GiB, swap_total: 8 * GiB, swap_used: 0,
    dimms: ["A1", "B1"].map((l) => ({ locator: `DIMM_${l}`, bank: `BANK ${l[0]}`, size: "16 GB", type: "DDR5", speed: "5600 MT/s", configured_speed: "5200 MT/s", manufacturer: null, part_number: null })),
  },
  gpus: [{
    id: "0000:01:00.0", name: "Discrete GPU 16 GB", vendor: "other", driver: "gpu-driver", iommu_group: 14, audio_function: "0000:01:00.1", warnings: [], mode: "host", reboot_required: false, passthrough_ready: true,
    metrics: { name: "Discrete GPU 16 GB", driver_version: "550.1", vram_total_mib: 16384, vram_used_mib: 5120, util_pct: 12, temp_c: 48, power_w: 38 }, vram_bytes: 16 * GiB,
  }],
  storage: {
    controllers: [{ id: "0000:02:00.0", name: "NVMe controller", class_name: "Non-Volatile memory controller", driver: "nvme" }, { id: "0000:00:17.0", name: "SATA controller", class_name: "SATA controller", driver: "ahci" }],
    drives: DISK_ROWS.map(([devpath, model, serial, type, , size, , , , wear, temp]) => ({ devpath, model, serial, size, type, wearout: wear ?? "N/A", health: "PASSED", temp_c: temp })),
  },
  network: [
    ...["eno1", "eno2", "enp3s0", "enp4s0"].map((name, i) => ({ name, mac: `A8:A1:59:3C:0${i}:10`, state: i < 3 ? "UP" : "DOWN", mtu: 1500, master: i < 2 ? "br0" : i === 2 ? "br-lab" : null, addresses: [], speed_mbps: [2500, 1000, 10000, null][i], driver: null, physical: true })),
    { name: "br0", mac: "A8:A1:59:3C:00:10", state: "UP", mtu: 1500, master: null, addresses: [`${HOST}/24`], speed_mbps: null, driver: "bridge", physical: false },
  ],
  packages: { "zfsutils-linux": "2.2.6", qemu: "9.0.2", lxc: "6.0.1", dnsmasq: "2.90", "wireguard-tools": "1.0.20210914" },
  ssh_bridge_connected: true, ssh_bridge_message: "Connected", ssh_setup_command: null,
};

/* ---------------- Help ---------------- */

const diag = (id, title, status, summary, extra = {}) => ({ id, title, status, summary, details: summary, fix: null, manual: [], link: null, bios: null, ...extra });
const DIAGNOSTICS = [
  diag("network", "Network connection", "ok", `Reachable on ${HOST}; gateway ${GW} answers.`),
  diag("dns", "Name resolution", "ok", "Local and public names resolve."),
  diag("zfs", "ZFS pools", "ok", "tank and fast are ONLINE with no errors.", { link: { app: "storage", intent: "pools" } }),
  diag("disks", "Drive health", "ok", "All 6 drives pass SMART checks."),
  diag("virtualization", "Hardware virtualization", "ok", "Enabled in firmware; IOMMU active.", { bios: "virtualization" }),
  diag("backups", "Backups", "ok", "Last nightly backup finished 6 hours ago.", { link: { app: "backup", intent: "backups" } }),
  diag("ssh", "SSH password login", "warning", "SSH still accepts passwords. Key-only sign-in is safer.", {
    details: "Anyone on the network can try to guess the root password over SSH.",
    fix: { label: "Allow key-based SSH only", changes: ["Set PasswordAuthentication no in the SSH server config", "Restart the SSH service"], reboot: false },
    manual: ["Add your public key in Settings > Security first.", "Then run the fix."],
  }),
];
const BIOS = {
  facts: { manufacturer: "Generic", board_vendor: "Generic", board: "Workstation Board", bios_vendor: "Generic UEFI", bios_version: "2.14", cpu: "16-core x86-64 CPU", virtualization: true, secure_boot: false },
  detected_vendor: "generic", vendor: "generic", vendors: [{ id: "generic", name: "Generic UEFI" }],
  guides: [
    { id: "virtualization", title: "Enable hardware virtualization", why: "Virtual machines need the CPU virtualization extension.", verify: "Already enabled on this server.", needed: false, steps: ["Restart and press Del or F2 to enter firmware setup.", "Open Advanced > CPU Configuration.", "Set Virtualization Technology to Enabled.", "Save and exit."], text: "Enable hardware virtualization\n1. Enter firmware setup\n2. Advanced > CPU Configuration\n3. Virtualization Technology: Enabled", qr: [] },
    { id: "iommu", title: "Enable IOMMU", why: "Needed to pass a GPU or other PCI device to a VM.", verify: "IOMMU groups are visible.", needed: null, steps: ["Open Advanced > Chipset.", "Set IOMMU (or VT-d) to Enabled.", "Save and exit."], text: "Enable IOMMU\nAdvanced > Chipset > IOMMU: Enabled", qr: [] },
    { id: "power-loss", title: "Power on after power loss", why: "The server comes back by itself after an outage.", verify: "Check after the next outage.", needed: true, steps: ["Open Advanced > Power Management.", "Set Restore on AC Power Loss to Power On.", "Save and exit."], text: "Restore on AC Power Loss: Power On", qr: [] },
  ],
};

/* ---------------- Apps / Local AI ---------------- */

const app = (id, name, category, description, icon, cores, memory_mb, disk_gb, web_port, extra = {}) => ({
  id, name, category, description, icon, cores, memory_mb, disk_gb, web_port, web_scheme: "http", supports_igpu: false, supports_storage_mount: true, featured: false, compute_selector: false, installed: [], ...extra,
});
const inst = (app_id, app_name, label, guest_id, ip, port, status, scheme = "http") => ({
  instance_id: `${app_id}-${guest_id}`, app_id, app_name, instance_label: label, display_name: label ? `${app_name} — ${label}` : app_name, guest_id,
  ip_address: ip, web_url: ip ? `${scheme}://${ip}:${port}` : null, created_at: "2026-11-20T09:00:00+00:00", status, cores: 2, memory_mb: 2048,
});
const INSTANCES = [
  inst("docker-portainer", "Container Host", "", 110, "192.168.1.60", 9443, "running", "https"),
  inst("docker-portainer", "Container Host", "Dev", 111, null, 9443, "stopped", "https"),
  inst("local-ai", "Local AI Studio", "", 105, "192.168.1.55", 8080, "running"),
];

const CATALOG = [
  app("local-ai", "Local AI Studio", "AI & Compute", "Private AI chat on your own hardware, with a model library and a web chat interface.", "BrainCircuit", 8, 12288, 64, 8080, { featured: true, installed: [{ vmid: 105, name: "local-ai", status: "running" }] }),
  app("jellyfin", "Jellyfin Media Server", "Media", "Stream your movies, shows and music to any device, with hardware transcoding when a GPU is present.", "Clapperboard", 2, 2048, 16, 8096, { supports_igpu: true }),
  app("immich", "Immich", "Media", "Self-hosted photo and video backup with phone apps, face recognition and shared albums.", "Images", 4, 4096, 32, 2283),
  app("music-library", "Music Library", "Media", "Organise and stream your music collection in the browser.", "Clapperboard", 1, 1024, 8, 4533),
  app("docker-portainer", "Container Host", "Infrastructure", "A container engine in a nested container, managed from a web dashboard.", "Container", 2, 2048, 32, 9443, { web_scheme: "https", installed: [{ vmid: 110, name: "docker-portainer", status: "running" }, { vmid: 111, name: "docker-portainer-dev", status: "stopped" }] }),
  app("git-server", "Git Server", "Infrastructure", "Lightweight self-hosted code hosting with issues and pull requests.", "Container", 1, 1024, 16, 3000),
  app("uptime-monitor", "Uptime Monitor", "Infrastructure", "Watch your websites and services and get alerts when they go down.", "Waypoints", 1, 512, 4, 3001),
  app("samba", "Samba File Server", "Network", "Standalone SMB server that shares a folder with every computer on your network.", "FolderTree", 1, 512, 4, null, { supports_storage_mount: true }),
  app("adguard-home", "AdGuard Home", "Network", "Network-wide DNS ad and tracker blocking. Point your router's DNS at it.", "ShieldCheck", 1, 512, 4, 3000, { installed: [{ vmid: 103, name: "dns-filter", status: "running" }] }),
  app("nginx-proxy-manager", "Nginx Proxy Manager", "Network", "Reverse proxy with free TLS certificates and a simple web interface.", "Waypoints", 1, 1024, 8, 81),
  app("vpn-gateway", "VPN Gateway", "Network", "Reach your home network securely from anywhere.", "ShieldCheck", 1, 512, 4, 51821),
  app("notebook-lab", "Notebook Lab", "AI & Compute", "Interactive notebooks for data science and machine-learning experiments.", "BrainCircuit", 4, 8192, 32, 8888),
];

const AI_STATUS = {
  installed: true, vmid: 105, running: true, ip: guestIp(105), ollama_url: `http://${guestIp(105)}:11434`, openai_url: `http://${guestIp(105)}:11434/v1`, webui_url: `http://${guestIp(105)}:8080`,
  ollama_reachable: true, ollama_version: "0.4.2", compute_target: "gpu:0000:01:00.0", gpu_name: "Discrete GPU 16 GB", vram_mb: 16384, flash_attention: true, kv_cache_q8: true, model_storage: "/mnt/storage/ai-models",
  gpu: { name: "Discrete GPU 16 GB", vram_total_mib: 16384, vram_used_mib: 5120, util_pct: 12, temp_c: 48, power_w: 38 },
};
const LOCAL_MODELS = [
  { name: "assistant:8b", size: 4.9e9, modified_at: new Date((T0 - 5 * 86400) * 1000).toISOString(), family: "assistant", parameter_size: "8.0B", quantization: "Q4_K_M", loaded: true, size_vram: 5.4e9 },
  { name: "coder:7b", size: 4.7e9, modified_at: new Date((T0 - 12 * 86400) * 1000).toISOString(), family: "coder", parameter_size: "7.6B", quantization: "Q4_K_M", loaded: false, size_vram: null },
];
const AI_HARDWARE = {
  targets: [
    { id: "gpu:0000:01:00.0", kind: "gpu", name: "Discrete GPU 16 GB", pci: "0000:01:00.0", vram_total_mb: 16384, vram_free_mb: 11264, driver_version: "550.1", driver: "gpu-driver", driver_ready: true, device_nodes: ["/dev/dri/renderD128"], backend: "GPU", recommendation: "Best choice: models up to about 14B parameters fit in VRAM.", prepare: null },
    { id: "cpu", kind: "cpu", name: "16-core x86-64 CPU", vram_total_mb: null, driver_ready: true, device_nodes: [], backend: "CPU", recommendation: "Works for small models; slower than the GPU.", prepare: null, cores: 16, threads: 32, ram_total_mb: 32768 },
  ],
  default: "gpu:0000:01:00.0", ssh_bridge_connected: true, message: null,
};
const tag = (t, size, p, gb, fit) => ({ tag: t, size, params_b: p, download_gb: gb, vram_required_gb: gb * 1.2, vram_fit: fit });
const ONLINE_MODELS = {
  source: "library", vram_gb: 16,
  models: [
    { name: "assistant", description: "General-purpose chat model with strong instruction following.", category: "chat", capabilities: ["tools"], pulls: "12M", tags: [tag("8b", "4.9GB", 8, 4.9, "optimal_gpu"), tag("70b", "43GB", 70, 43, "cpu_offload")] },
    { name: "coder", description: "Code completion and explanation in many programming languages.", category: "code", capabilities: ["tools"], pulls: "4.1M", tags: [tag("7b", "4.7GB", 7.6, 4.7, "optimal_gpu"), tag("32b", "20GB", 32, 20, "tight_gpu")] },
    { name: "vision", description: "Describes and answers questions about images.", category: "vision", capabilities: ["vision"], pulls: "2.3M", tags: [tag("11b", "7.9GB", 11, 7.9, "optimal_gpu")] },
    { name: "embed", description: "Text embeddings for search and retrieval.", category: "embedding", capabilities: ["embedding"], pulls: "8.7M", tags: [tag("latest", "274MB", 0.14, 0.27, "optimal_gpu")] },
  ],
};
const CHATS = [
  { id: "c1", title: "Plan a ZFS snapshot schedule", model: "assistant:8b", updated: T0 - 1800, messages: 4, snippet: "Keep 24 hourly, 14 daily and 8 weekly snapshots…" },
  { id: "c2", title: "Explain this nftables rule", model: "coder:7b", updated: T0 - 86400, messages: 2, snippet: "The rule masquerades traffic leaving br0…" },
];
const CHAT = {
  model: "assistant:8b",
  messages: [
    { role: "user", content: "How many snapshots should I keep for my documents dataset?" },
    { role: "assistant", content: "A good default for documents:\n\n- **Hourly**: keep 24\n- **Daily**: keep 14\n- **Weekly**: keep 8\n\nSnapshots only store changed blocks, so this costs little space.", tps: 61.4, tokens: 92 },
  ],
};

/* ---------------- Automation ---------------- */

const CHANNELS = {
  telegram: { enabled: false, bot_token: "", chat_id: "" },
  discord: { enabled: false, webhook_url: "" },
  webhook: { enabled: true, url: "https://hooks.example.org/solardeck", method: "POST", bearer_token: "" },
  email: { enabled: true, smtp_host: "mail.home.lan", smtp_port: 587, username: "alerts@home.lan", password: "", from_email: "alerts@home.lan", to_email: "admin@home.lan", use_tls: true },
};
const rule = (id, name, trigger, action, extra = {}) => ({ id, name, enabled: true, trigger, threshold: null, target: null, time: null, days: [], action, channels: ["email"], cooldown_minutes: 60, prune_older_than_days: 30, last_fired: null, last_status: null, ...extra });
const RULES = [
  rule("r1", "GPU running hot", "gpu_temp_above", "send_external_alert", { threshold: 85 }),
  rule("r2", "Pool degraded", "zfs_pool_degraded", "send_external_alert", { channels: ["email", "webhook"] }),
  rule("r3", "Restart home automation if it stops", "guest_stopped_unexpectedly", "start_guest", { target: { type: "lxc", vmid: 101 }, last_fired: T0 - 9 * 86400, last_status: "ok" }),
  rule("r4", "Prune old snapshots", "scheduled_time", "prune_old_snapshots", { time: "04:00", days: [0], channels: [], last_fired: T0 - 2 * 86400, last_status: "ok" }),
];
const AUTO_LOGS = [
  { id: "l1", timestamp: T0 - 2 * 86400, rule_name: "Prune old snapshots", trigger_summary: "Scheduled Sunday 04:00", action_result: "Removed 12 snapshots older than 30 days", status: "ok" },
  { id: "l2", timestamp: T0 - 9 * 86400, rule_name: "Restart home automation if it stops", trigger_summary: "home-assistant-ct stopped", action_result: "Started CT 101", status: "ok" },
];

/* ---------------- Misc ---------------- */

const TASKS = [
  { type: "vzdump", id: "", user: "root@pam", status: "OK", state: "ok", starttime: T0 - 21600, endtime: T0 - 20400 },
  { type: "qmstart", id: "100", user: "admin@pam", status: "OK", state: "ok", starttime: T0 - 7200, endtime: T0 - 7195 },
  { type: "zfs-scrub", id: "fast", user: "root@pam", status: "OK", state: "ok", starttime: T0 - 3600, endtime: T0 - 3348 },
].map((t, i) => ({ upid: `UPID:${NODE}:000${i}1A2B:00${i}3C4D:${t.starttime.toString(16).toUpperCase()}:${t.type}:${t.id}:${t.user}:`, ...t }));

const SCHEDULES = [
  { id: "sc1", kind: "snapshot", target: "tank/documents", interval: "hourly", retention: 24, enabled: true, created: T0 - 60 * 86400, next_run: T0 + 1200, last_run: T0 - 2400, last_status: "ok", last_error: null },
  { id: "sc2", kind: "snapshot", target: "tank/photos", interval: "daily", retention: 14, enabled: true, created: T0 - 60 * 86400, next_run: T0 + 40000, last_run: T0 - 46400, last_status: "ok", last_error: null },
  { id: "sc3", kind: "scrub", target: "tank", interval: "monthly", retention: 0, enabled: true, created: T0 - 90 * 86400, next_run: T0 + 14 * 86400, last_run: T0 - 16 * 86400, last_status: "ok", last_error: null },
];
const STORAGE_CFG = [
  { storage: "local", type: "dir", content: "iso,vztmpl,backup", path: "/var/lib/solardeck" },
  { storage: "fast-vm", type: "zfspool", content: "images,rootdir", pool: "fast" },
  { storage: "tank-data", type: "zfspool", content: "images,rootdir", pool: "tank" },
  { storage: "backup", type: "dir", content: "backup", path: "/tank/backups/guests" },
];

/* ---------------- Router ---------------- */

const EXACT = {
  "/health": () => ({ status: "ok", node: NODE }),
  "/auth/setup": () => ({ required: false }),
  "/auth/me": () => ({ username: SESSION.username }),
  "/auth/2fa/status": () => ({ enabled: true, recovery_codes_left: 8 }),
  "/auth/sessions": () => SESSIONS,
  "/system/capabilities": () => ({ supports_clustering: false, supports_lxc: true, supports_qemu: true, supports_zfs: true, supports_gpu_passthrough: true, supports_bios_manager: true, supports_rbac_realms: true, supports_apt_repos: true, supports_host_shell: true, default_bridge: "br0" }),
  "/system/preferences": () => ({ wizard: { welcomeAuto: false }, widgets: { visible: true }, layout: { hideSearchIntroBalloon: true } }),
  "/system/themes": () => ({ themes: [] }),
  "/system/branding/info": () => ({ hostname: "solardeck", display_host: "solardeck", platform_label: "SolarOS", brand_mode: "solaros" }),
  "/system/app-usage": () => ({ files: { launch_count: 14, last_opened_at: "2025-11-24T18:10:00Z" }, compute: { launch_count: 22, last_opened_at: "2025-11-24T20:31:00Z" }, settings: { launch_count: 9, last_opened_at: "2025-11-24T21:02:00Z" } }),
  "/system/info": () => SYSTEM_INFO,
  "/system/updates/status": () => UPDATE_STATUS,
  "/system/updates/settings": () => UPDATE_SETTINGS,
  "/system/updates/versions": () => ({ versions: VERSIONS }),
  "/system/updates/iso": () => ({ build_command: "sudo scripts/build-iso.sh", test_command: null, search_paths: ["/var/lib/solardeck/iso"], isos: [{ name: "solaros-2.7.1.iso", path: "/var/lib/solardeck/iso/solaros-2.7.1.iso", size: 1.9 * GiB, modified: T0 - 86400, sha256: "3f7a".padEnd(64, "0") }] }),
  "/system/repositories": () => REPOS,
  "/system/updates": () => APT_UPDATES,
  "/system/upgrade": () => ({ running: false, exit_code: null, log: [] }),
  "/system/services": () => SERVICES,
  "/system/nested-virt": () => ({ nested: true, raw: "Y" }),
  "/system/bug-report/diagnostics": () => ({ version: "2.7.1", node: NODE, kernel: "Linux 6.8.12", uptime: 1728000 }),
  "/host/bridge": () => ({ target: "root@127.0.0.1", public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyForScreens solardeck", connected: true, error: null, hostname: NODE, setup_command: null }),
  "/notifications": () => ({ alerts: [{ id: "scrub-fast", severity: "info", category: "zfs", title: "Scrub finished", message: "Pool fast was scrubbed with 0 errors." }] }),
  "/search": () => ({ results: [] }),
  "/v1/overview": overview,
  "/v1/storage": () => ({ pools: POOLS, targets: TARGETS, disks: DISKS }),
  "/v1/telemetry/hardware": hardwareTelemetry,
  "/v1/guests": () => GUESTS,
  "/v1/tasks": () => TASKS,
  "/v1/nextid": () => ({ vmid: 106 }),
  "/v1/zfs/pools": () => POOLS,
  "/v1/zfs/datasets": () => DATASET_INFO,
  "/v1/zfs/snapshots": () => ({ datasets: DATASET_INFO.map(({ name, type, used, refer, mountpoint }) => ({ name, type, used, refer, mountpoint })), snapshots: SNAPSHOTS }),
  "/v1/disks": () => PHYSICAL_DISKS,
  "/v1/disks/benchmark/history": () => BENCH_HISTORY,
  "/v1/storage-config": () => STORAGE_CFG,
  "/v1/backups": () => BACKUPS,
  "/v1/backups/schedules": () => BACKUPS.schedules,
  "/schedules": () => SCHEDULES,
  "/shares": () => SHARES,
  "/shares/users": () => [{ username: "admin" }, { username: "family" }],
  "/v1/access/users": () => USERS,
  "/v1/access/groups": () => GROUPS,
  "/v1/access/roles": () => ROLES,
  "/v1/access/privileges": () => PRIVS,
  "/v1/access/acl": () => ACL,
  "/v1/access/tokens": () => TOKENS,
  "/v1/access/domains": () => REALMS,
  "/v1/pools": () => POOLS_DC.map(({ poolid, comment }) => ({ poolid, comment })),
  "/v1/firewall/cluster/rules": () => FW_RULES,
  "/v1/firewall/node/rules": () => FW_RULES.slice(0, 3),
  "/v1/firewall/cluster/options": () => ({ enable: 1, policy_in: "DROP", policy_out: "ACCEPT" }),
  "/v1/firewall/node/options": () => ({ enable: 1 }),
  "/v1/firewall/cluster/aliases": () => [{ name: "lan", cidr: "10.20.0.0/24", comment: "Home LAN" }, { name: "mgmt", cidr: "10.20.10.0/24", comment: "Management VLAN" }],
  "/v1/firewall/cluster/ipsets": () => [{ name: "trusted", comment: "Admin devices" }],
  "/v1/logs/cluster": () => CLUSTER_LOG,
  "/v1/logs/syslog": () => ({ lines: LOG_LINES }),
  "/v1/logs/journal": () => ({ lines: LOG_LINES }),
  "/v1/network/topology": () => TOPOLOGY,
  "/security/posture": () => POSTURE,
  "/security/audit-log": () => AUDIT,
  "/security/audit-log/verify": () => ({ ok: true, entries: 1284, first_bad_line: null, reason: null }),
  "/network/switch/state": () => SWITCH,
  "/net/status": () => NET_STATUS,
  "/net/dns": () => DNS,
  "/net/dns/stats": () => DNS_STATS,
  "/net/dhcp": () => DHCP,
  "/net/wg": () => WG,
  "/net/wg/clients": () => WG_CLIENTS,
  "/net/router": () => ROUTER,
  "/net/certs": () => CERTS,
  "/domains": () => DOMAINS,
  "/domains/certificate/job": () => ({ fqdn: "solardeck.home.lan", state: "done", step: "Installed", error: null, log: ["Certificate issued and installed."] }),
  "/automation/channels": () => CHANNELS,
  "/automation/rules": () => RULES,
  "/automation/logs": () => AUTO_LOGS,
  "/hardware/inventory": () => INVENTORY,
  "/help/diagnostics": () => DIAGNOSTICS,
  "/help/bios": () => BIOS,
  "/apps/catalog": () => CATALOG,
  "/apps/deployments": () => [],
  "/apps/instances": () => INSTANCES,
  "/ai/status": () => AI_STATUS,
  "/ai/models/local": () => LOCAL_MODELS,
  "/ai/models/online": () => ONLINE_MODELS,
  "/ai/models/pull": () => [],
  "/ai/hardware": () => AI_HARDWARE,
  "/ai/chats": () => CHATS,
  "/files/list": (s) => listing(s.get("path")),
};

const PATTERNS = [
  [/^\/v1\/guests\/(qemu|lxc)\/(\d+)\/config$/, (m) => { const g = GUESTS.find((x) => x.vmid === +m[2]); return g && guestConfig(g); }],
  [/^\/v1\/storage\/([^/]+)\/content$/, (m, s) => { if (m[1] !== "local" && m[1] !== "backup") return []; const c = s.get("content"); return c === "iso" ? ISOS : c === "vztmpl" ? TEMPLATES : c === "backup" ? BACKUPS.archives : [...ISOS, ...TEMPLATES]; }],
  [/^\/v1\/pools\/([^/]+)$/, (m) => POOLS_DC.find((p) => p.poolid === decodeURIComponent(m[1]))],
  [/^\/v1\/firewall\/(qemu|lxc)\/rules$/, () => [{ pos: 0, type: "in", action: "ACCEPT", enable: 1, proto: "tcp", dport: "8096", comment: "Media streaming" }]],
  [/^\/v1\/firewall\/(qemu|lxc)\/options$/, () => ({ enable: 0, policy_in: "ACCEPT", policy_out: "ACCEPT" })],
  [/^\/v1\/firewall\/cluster\/ipsets\/[^/]+$/, () => [{ cidr: "10.20.0.131", comment: "Admin laptop" }, { cidr: "10.99.0.2", comment: "Phone over VPN" }]],
  [/^\/v1\/tasks\/[^/]+\/status$/, () => ({ state: "ok" })],
  [/^\/v1\/tasks\/[^/]+\/log$/, () => ({ lines: ["INFO: starting task", "INFO: finished successfully", "TASK OK"] })],
  [/^\/v1\/disks\/benchmark\/(.+)$/, (m) => BENCH_HISTORY.find((j) => j.id === m[1])],
  [/^\/network\/switch\/vlans\/\d+\/leases$/, () => LEASES],
  [/^\/ai\/chats\/[^/]+$/, () => CHAT],
];

export function fixture(method, path, search = new URLSearchParams()) {
  if (String(method).toUpperCase() !== "GET") {
    if (path === "/auth/login" || path === "/auth/login/2fa") return { username: SESSION.username };
    return { ok: true };
  }
  const p = path.startsWith("/api/") ? path.slice(4) : path; // a raw fetch("/api/api/...") never happens, but be lenient
  const hit = EXACT[p];
  if (hit) return hit(search);
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(p);
    if (m) return fn(m, search);
  }
  return undefined;
}

// Self-check: `node scripts/support-docs/fixtures.mjs` asserts the screens' key endpoints answer.
if (import.meta.url === `file://${process.argv[1]}`) {
  const must = ["/auth/me", "/health", "/v1/overview", "/v1/storage", "/network/switch/state", "/help/bios", "/ai/status", "/files/list", "/v1/storage/local/content"];
  for (const p of must) if (fixture("GET", p, new URLSearchParams("content=iso&path=/")) === undefined) throw new Error(`missing fixture ${p}`);
  console.log("fixtures ok");
}
