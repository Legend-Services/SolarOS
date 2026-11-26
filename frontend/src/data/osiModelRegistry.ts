import type { TKey } from "../i18n";

/** The seven OSI layers, L1 (Physical) to L7 (Application). */
export type OsiLayer = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Live values (MAC, VLAN tag, IP/CIDR, ports, TLS, …) shown as chips on the layer they belong to. */
export type OsiValues = Partial<Record<OsiLayer, string[]>>;

export interface OsiLayerInfo {
  n: OsiLayer;
  name: TKey;
  pdu: TKey;
  protocols: string;
  what: TKey;
  tip: TKey;
}

const layer = (n: OsiLayer, protocols: string): OsiLayerInfo => ({
  n,
  name: `osi.l${n}.name` as TKey,
  pdu: `osi.l${n}.pdu` as TKey,
  protocols,
  what: `osi.l${n}.what` as TKey,
  tip: `osi.l${n}.tip` as TKey,
});

/** Top (L7) to bottom (L1), the order the stack diagram draws them. */
export const OSI_LAYERS: OsiLayerInfo[] = [
  layer(7, "HTTP(S) · DNS · DHCP · SMB · NFS · SSH · REST · WebSocket"),
  layer(6, "TLS 1.3 · SSL certificates · UTF-8 · JSON · media codecs"),
  layer(5, "TLS sessions · login cookies · WebSocket upgrade · RPC · SPICE/VNC"),
  layer(4, "TCP · UDP · QUIC · port numbers"),
  layer(3, "IPv4 · IPv6 · ICMP · ARP/NDP · routing · NAT"),
  layer(2, "Ethernet · 802.1Q VLAN · MAC learning · LACP · PPP"),
  layer(1, "Copper · fiber/SFP+ · radio · PCIe/USB bus · virtual cable"),
];

export type OsiKind =
  | "wan_uplink"
  | "host_node"
  | "physical_nic"
  | "vswitch"
  | "vlan"
  | "vrouter"
  | "dhcp_server"
  | "dns_server"
  | "firewall_ids"
  | "wireguard_vpn"
  | "reverse_proxy"
  | "vnic"
  | "vm_guest"
  | "container_guest"
  | "storage_device"
  | "peripheral_device"
  | "serial_modem"
  | "gpu_passthrough"
  | "app_instance"
  | "discovered_device";

export interface OsiComponent {
  name: TKey;
  summary: TKey;
  /** Layers where this component does its main job. */
  primary: OsiLayer[];
  /** Layers it relies on or wraps traffic in (encapsulation / supporting). */
  encap: OsiLayer[];
  /** What happens inside this component at each active layer; also the "how data flows" walkthrough, read L1 → L7. */
  roles: Partial<Record<OsiLayer, TKey>>;
}

const k = (kind: OsiKind, primary: OsiLayer[], encap: OsiLayer[]): OsiComponent => ({
  name: `osi.k.${kind}.name` as TKey,
  summary: `osi.k.${kind}.sum` as TKey,
  primary,
  encap,
  roles: Object.fromEntries([...primary, ...encap].map((n) => [n, `osi.k.${kind}.${n}` as TKey])),
});

export const OSI_COMPONENTS: Record<OsiKind, OsiComponent> = {
  wan_uplink: k("wan_uplink", [1, 2, 3], []),
  host_node: k("host_node", [3, 4, 7], [1, 2, 6]),
  physical_nic: k("physical_nic", [1, 2], [3]),
  vswitch: k("vswitch", [2], [1, 3]),
  vlan: k("vlan", [2, 3], []),
  vrouter: k("vrouter", [3], [2, 4]),
  dhcp_server: k("dhcp_server", [2, 3, 4, 7], []),
  dns_server: k("dns_server", [4, 7], [3, 6]),
  firewall_ids: k("firewall_ids", [3, 4, 7], []),
  wireguard_vpn: k("wireguard_vpn", [3, 4], [6]),
  reverse_proxy: k("reverse_proxy", [4, 5, 6, 7], []),
  vnic: k("vnic", [2], [1, 3]),
  vm_guest: k("vm_guest", [3, 4, 7], [1, 2]),
  container_guest: k("container_guest", [3, 4, 7], [1, 2]),
  storage_device: k("storage_device", [1], [7]),
  peripheral_device: k("peripheral_device", [1], [6, 7]),
  serial_modem: k("serial_modem", [1, 2], [4]),
  gpu_passthrough: k("gpu_passthrough", [1], [6, 7]),
  app_instance: k("app_instance", [4, 7], [2, 3, 5, 6]),
  discovered_device: k("discovered_device", [2, 3], [4, 7]),
};

/** Builds the per-layer chips from the values a view already has; empty values are dropped. */
export function osiValues(v: {
  link?: string | null;
  mac?: string | null;
  vlan?: number | string | null;
  model?: string | null;
  ip?: (string | null | undefined)[] | string | null;
  ports?: string[];
  session?: string | null;
  tls?: string | null;
  app?: (string | null | undefined)[] | string | null;
}): OsiValues {
  const list = (x: (string | null | undefined)[] | string | null | undefined) => (Array.isArray(x) ? x : [x]).filter((s): s is string => !!s);
  const out: OsiValues = {
    1: list(v.link),
    2: list([v.mac ? `MAC ${v.mac}` : null, v.vlan ? `VLAN ${v.vlan}` : null, v.model]),
    3: list(v.ip),
    4: v.ports ?? [],
    5: list(v.session),
    6: list(v.tls),
    7: list(v.app),
  };
  for (const n of Object.keys(out)) if (!out[+n as OsiLayer]!.length) delete out[+n as OsiLayer];
  return out;
}

/** Ports, TLS and endpoint of a web URL such as https://10.10.20.45:8443. */
export function urlValues(url: string | null | undefined) {
  if (!url) return {};
  try {
    const u = new URL(url);
    const https = u.protocol === "https:";
    return { ports: [`TCP ${u.port || (https ? 443 : 80)}`], tls: https ? "TLS (HTTPS)" : null, app: `${https ? "HTTPS" : "HTTP"} ${u.host}` };
  } catch {
    return {};
  }
}

/** Which inspector kind a virtual device type (backend catalog id) maps to. */
export const deviceKind = (type: string): OsiKind =>
  type === "hayes_modem" ? "serial_modem" : /nvme|hba|disk|scsi|sata/.test(type) ? "storage_device" : "peripheral_device";
