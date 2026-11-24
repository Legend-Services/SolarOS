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
  featured?: boolean;
  compute_selector?: boolean;
  installed: { vmid: number; name: string; status: string }[];
}

/* ---------------- Local AI Studio ---------------- */

export interface ComputeTarget {
  id: string; // "nvidia:01:00.0" | "intel:/dev/dri/renderD128" | "amd:..." | "cpu"
  kind: "nvidia" | "intel" | "amd" | "cpu";
  name: string;
  pci?: string;
  vram_total_mb: number | null;
  vram_free_mb?: number | null;
  driver_version?: string | null;
  driver?: string | null;
  driver_ready: boolean;
  device_nodes: string[];
  backend: string;
  recommendation: string;
  prepare: { action: "nvidia-install" | "mode-host"; gpu: string } | null;
  cores?: number | null;
  threads?: number | null;
  ram_total_mb?: number;
}

export interface AiHardware {
  targets: ComputeTarget[];
  default: string;
  ssh_bridge_connected: boolean;
  message: string | null;
}

export type VramFit = "optimal_gpu" | "tight_gpu" | "cpu_offload" | "cpu_only";

export interface OnlineModel {
  name: string;
  description: string;
  category: string;
  capabilities: string[];
  pulls: string | null;
  tags: { tag: string; size: string; params_b: number | null; download_gb: number | null; vram_required_gb: number | null; vram_fit: VramFit }[];
}

export interface LocalModel {
  name: string;
  size: number;
  modified_at: string | null;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  loaded: boolean;
  size_vram: number | null;
}

export interface PullJob {
  id: string;
  model: string;
  state: "running" | "done" | "error";
  status: string;
  digest: string | null;
  completed: number;
  total: number;
  percent: number;
  error: string | null;
}

export interface AiStatus {
  installed: boolean;
  missing_vmid?: number;
  vmid?: number;
  running?: boolean;
  ip?: string | null;
  ollama_url?: string | null;
  openai_url?: string | null;
  webui_url?: string | null;
  ollama_reachable?: boolean;
  ollama_version?: string | null;
  compute_target?: string;
  gpu_name?: string | null;
  vram_mb?: number | null;
  flash_attention?: boolean;
  kv_cache_q8?: boolean;
  model_storage?: string | null;
  gpu?: { name: string; vram_total_mib: number | null; vram_used_mib: number | null; util_pct: number | null; temp_c: number | null; power_w: number | null } | null;
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
  rotational: boolean;
  rpm: number | null; // known spindle speed of a spinning disk
  rpm_label: string; // "7200 RPM", "HDD" (speed unknown) or "SSD / NVMe"
  used: string; // empty = unused
  gpt: boolean;
  health: string;
  wearout_pct: number | null; // % of rated life remaining; null for HDDs
  // ZFS membership (null when the disk is not in a pool)
  pool_name: string | null;
  vdev_name: string | null;
  member_device: string | null;
  member_state: string | null;
  read_errors: number | null;
  write_errors: number | null;
  cksum_errors: number | null;
}

export interface Capability {
  supported: boolean;
  reason: string | null;
}

export interface DiskSettings {
  device: string;
  bus: string;
  rotational: boolean;
  by_id: string | null;
  persist_supported: boolean;
  nvme_cli_installed: boolean;
  values: { apm_level: number | "disabled" | null; spindown_minutes: number | null; write_cache: boolean | null; power_state: number | null; smart_enabled: boolean | null };
  power_states: { id: number; max_power_w: number; operational: boolean; entry_latency_us: number; exit_latency_us: number }[];
  capabilities: Record<"apm_level" | "spindown_minutes" | "write_cache" | "power_state" | "smart_enabled", Capability>;
  persisted?: boolean;
}

export interface ScanStatus {
  device: string;
  smart: {
    running: boolean;
    test: string | null;
    progress_pct: number | null;
    eta_seconds: number | null;
    history: { type: string; status: string; passed: boolean; lifetime_hours: number | null; failing_lba: number | null }[];
  };
  surface: { running: boolean; progress_pct: number | null; elapsed: string | null; eta_seconds: number | null; errors: number; bad_blocks: number; exit_code: number | null };
}

export type BenchProfile = "SEQ1M_Q8T1" | "SEQ128K_Q32T1" | "RND4K_Q32T1" | "RND4K_Q1T1";
export interface BenchMetric {
  mbps: number;
  iops: number;
  lat_us: number;
}
export interface BenchStep {
  profile: BenchProfile;
  status: string;
  read: BenchMetric | null;
  write: BenchMetric | null;
}
export interface BenchJob {
  id: string;
  label: string;
  target_type: "disk" | "mountpoint";
  target: string;
  mode: "readonly" | "readwrite";
  test_size_mb: number;
  passes: number;
  status?: "running" | "done" | "error" | "cancelled";
  phase?: string | null;
  pass?: number;
  error?: string | null;
  started_at: number;
  finished_at: number | null;
  done_steps?: number;
  total_steps?: number;
  steps: BenchStep[];
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

/* ---------------- Phase 5: provisioning, backups, search, updates ---------------- */

export interface StorageVolume {
  volid: string;
  storage: string;
  content: "iso" | "vztmpl" | "backup";
  format: string;
  size: number;
  ctime: number;
  vmid: number | null;
  notes: string;
  protected: boolean;
}

export interface PciDevice {
  id: string;
  iommugroup: number;
  vendor_name: string;
  device_name: string;
  class: string;
  gpu: boolean;
}

export interface BackupArchive extends StorageVolume {
  type: "qemu" | "lxc" | null;
  name: string;
}

export interface BackupJob {
  id: string;
  enabled: boolean;
  schedule: string;
  storage: string;
  all: boolean;
  vmid: string;
  mode: string;
  compress: string;
  comment: string;
  keep_last: number | null;
  next_run?: number;
}

export interface BackupsInfo {
  storages: string[];
  archives: BackupArchive[];
  schedules: BackupJob[];
}

export type SearchKind = "qemu" | "lxc" | "pool" | "dataset" | "share" | "app" | "section";

export interface SearchResult {
  kind: SearchKind;
  title: string;
  subtitle: string;
  target: { type?: "qemu" | "lxc"; vmid?: number; name?: string; status?: string; path?: string; pool?: string; app_id?: string; section?: string };
}

export interface UpdateSettings {
  mode: "manual" | "notify" | "auto";
  schedule_frequency: "6h" | "daily" | "weekly";
  schedule_time: string;
  schedule_day: number;
  last_checked_at: string | null;
  latest_remote_commit: string | null;
  latest_remote_tag: string | null;
  update_available: boolean;
  last_check_error: string | null;
}

export interface VersionEntry {
  hash: string;
  short_hash: string;
  tag: string | null;
  date: string;
  subject: string;
  is_current: boolean;
}

export interface HypervisorIsoFile {
  name: string;
  path: string;
  size: number;
  modified: number;
  sha256: string | null;
}

export interface HypervisorIsoStatus {
  build_command: string;
  test_command: string | null;
  search_paths: string[];
  isos: HypervisorIsoFile[];
}

export interface UpdateStatus {
  git: boolean;
  commit: string | null;
  tag: string | null;
  branch: string;
  remote: string;
  version: string | null;
  driver: "proxmox" | "native_ubuntu";
  edition: string;
  service: string;
  supports_system_packages: boolean;
  remote_commit: string | null;
  remote_tag: string | null;
  update_available: boolean;
  incoming: VersionEntry[];
  settings: UpdateSettings;
  running: boolean;
  exit_code: number | null;
  log: string[];
}
