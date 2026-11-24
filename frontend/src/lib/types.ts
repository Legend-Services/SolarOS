export interface Overview {
  node: string;
  cpu: number;
  loadavg: number[];
  memory: { used: number; total: number; free: number; arc: number };
  swap: { used: number; total: number };
  uptime: number;
  kernel: string;
  pveversion: string;
  cpuinfo: { model: string; cpus: number; sockets: number; cores: number };
  net: { in: number; out: number };
  vms: { running: number; stopped: number; total: number };
  containers: { running: number; stopped: number; total: number };
}

export interface Guest {
  vmid: number;
  name: string;
  type: "qemu" | "lxc";
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  netin: number;
  netout: number;
}

export interface ZfsVdev {
  name: string;
  state?: string;
  read?: number;
  write?: number;
  cksum?: number;
  msg?: string;
  children?: ZfsVdev[];
}

export interface ZfsPool {
  name: string;
  size: number;
  alloc: number;
  free: number;
  frag: number;
  dedup: number;
  health: string;
  detail: { state?: string; status?: string; scan?: string; errors?: string; children?: ZfsVdev[] };
}

export interface StorageTarget {
  storage: string;
  type: string;
  content: string;
  active: number;
  enabled?: number;
  total: number;
  used: number;
  avail: number;
}

export interface Disk {
  devpath: string;
  model?: string;
  serial?: string;
  size: number;
  type?: string;
  health?: string;
  wearout?: number | string;
  used?: string;
}

export interface StorageInfo {
  pools: ZfsPool[];
  targets: StorageTarget[];
  disks: Disk[];
}

export interface ConsoleTarget {
  type: "qemu" | "lxc" | "node"; // "node" = Proxmox host shell (vmid 0, mode "shell" only)
  vmid: number;
  name: string;
  mode: "vnc" | "shell";
}

export type TaskState = "running" | "ok" | "error";

export interface PveTask {
  upid: string;
  type: string;
  id: string;
  user: string;
  status: string;
  state: TaskState;
  starttime: number;
  endtime?: number;
}

export interface CatalogApp {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  cores: number;
  memory_mb: number;
  disk_gb: number;
  web_port: number | null;
  web_scheme: string;
  supports_igpu: boolean;
  supports_storage_mount: boolean;
  installed: { vmid: number; name: string; status: string }[];
}

export interface Deployment {
  vmid: number;
  upid: string;
  phase: "creating" | "configuring" | "starting" | "installing" | "done" | "error";
  error: string | null;
  ip: string | null;
  web_port: number | null;
  web_scheme: string;
  log: string[];
}

export interface Share {
  name: string;
  path: string;
  comment: string;
  read_only: boolean;
  guest_ok: boolean;
  browseable: boolean;
  recycle_bin: boolean;
  timemachine: boolean;
  users: string[];
}

export interface ZfsDataset {
  name: string;
  type: string;
  used: number;
  refer: number;
  mountpoint: string;
}

export interface ZfsSnapshot {
  name: string;
  dataset: string;
  snapshot: string;
  used: number;
  refer: number;
  creation: number;
}

export interface GpuInfo {
  available: boolean;
  name: string | null;
  temp_c: number | null;
  utilization_pct: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  power_w: number | null;
}

export interface DiskTelemetry {
  devpath: string;
  model?: string;
  serial?: string;
  type?: string;
  size: number;
  health: string;
  life_left_pct: number | null;
  temp_c: number | null;
}

export interface HardwareInfo {
  disks: DiskTelemetry[];
  gpu: GpuInfo;
  igpu: { available: boolean; quicksync: boolean; render_nodes: { path: string; vendor: string; intel: boolean }[] };
}

export type Severity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  severity: Severity;
  category: "zfs" | "disk" | "capacity" | "task";
  title: string;
  message: string;
}

export interface Schedule {
  id: string;
  kind: "snapshot" | "scrub";
  target: string;
  interval: "hourly" | "daily" | "weekly" | "monthly";
  retention: number;
  enabled: boolean;
  created: number;
  next_run: number;
  last_run: number | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
}

export interface AptRepository {
  path: string;
  index: number;
  enabled: boolean;
  types: string[];
  uris: string[];
  suites: string[];
  components: string[];
  handle: string | null;
}

export interface RepoInfo {
  digest: string | null;
  repositories: AptRepository[];
  names: Record<string, string>;
  available: { handle: string; name: string; description: string }[];
  errors: string[];
}

export interface AptUpdate {
  Package: string;
  Title?: string;
  OldVersion?: string;
  Version: string;
  Origin?: string;
}

export interface UpgradeStatus {
  running: boolean;
  exit_code: number | null;
  log: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
}

export interface PveDisk {
  devpath: string;
  by_id: string;
  model: string;
  serial: string;
  vendor: string;
  size: number;
  type: string;
  bus: "NVMe" | "SATA" | "SAS" | "USB";
  rpm: number | null;
  used: string; // empty = unused
  gpt: boolean;
  health: string;
  wearout: number | null; // % of rated life remaining
}

export interface SmartReport {
  health: string;
  type: string;
  temperature_c: number | null;
  power_on_hours: number | null;
  unsafe_shutdowns: number | null;
  media_errors: number | null;
  wearout_used_pct: number | null;
  attributes: { id?: string; name: string; value?: number; worst?: number; threshold?: number; raw?: string; flags?: string; fail?: string }[];
  text: string;
}

export interface ZfsDatasetInfo {
  name: string;
  type: "filesystem" | "volume";
  pool: string;
  used: number;
  available: number;
  refer: number;
  mountpoint: string;
  compression: string;
  recordsize: string;
  quota: number;
  atime: string;
  volsize: number;
  guest_volume: boolean;
}

export interface GuestConfig {
  name: string;
  cores: number;
  sockets: number;
  memory: number;
  swap: number | null;
  onboot: boolean;
  description: string;
  tags: string;
  disks: { key: string; volume: string; size: string | null; resizable: boolean }[];
}

export interface NetIface {
  iface: string;
  type: string;
  active?: number;
  autostart?: number;
  method?: string;
  cidr?: string;
  address?: string;
  netmask?: string;
  gateway?: string;
  bridge_ports?: string;
  comments?: string;
}

export interface SystemInfo {
  node: string;
  version: { version?: string; release?: string; repoid?: string };
  pveversion: string;
  kernel: string;
  uptime: number;
  cpu_model: string;
  cpus: number;
  boot_mode: string;
  network: NetIface[];
  dns: { search?: string; dns1?: string; dns2?: string; dns3?: string };
  api: { host: string; token_id: string; connected: boolean; verify_ssl: boolean };
  admin_username: string;
  storage_root: string;
  helper: string;
}
