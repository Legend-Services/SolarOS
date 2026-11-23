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

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
}
