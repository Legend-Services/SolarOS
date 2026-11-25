import { useCallback, useEffect, useState, type ReactNode } from "react";
import { edition } from "@edition";
import { AtSign, Award, Download, Globe, Network, Share2, Plus, QrCode, RefreshCw, Route, ShieldCheck, Trash2, Waypoints } from "lucide-react";
import { api } from "../lib/api";
import { bytes } from "../lib/format";
import { usePoll, useRunner } from "../lib/hooks";
import { JobLog } from "../components/JobLog";
import { GuideBanner } from "../components/wizards/GuidedWizardModal";
import { useIntentFor } from "../lib/stores";
import DomainsTab from "./network/DomainsTab";
import TopologyTab from "./network/TopologyTab";
import { useTranslation, type TKey } from "../i18n";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "../components/ui/GlassKit";
import { useCapabilities } from "../store/capabilitiesStore";

/* ---------------- Types (local to this app) ---------------- */

interface Iface {
  iface: string;
  type: string;
  cidr: string;
  active: boolean;
}
interface NetStatus {
  packages: Record<string, boolean>;
  services: Record<string, string>;
  forwarding: Record<string, boolean>;
  wg_interfaces: string[];
  interfaces: Iface[];
  host_ip: string;
}
interface DnsRecord {
  type: "A" | "AAAA" | "CNAME";
  name: string;
  value: string;
}
interface Adblock {
  lists: string[];
  whitelist: string[];
  blacklist: string[];
  updated: number | null;
  domains: number;
}
interface DnsState {
  enabled: boolean;
  interfaces: string[];
  upstream: string;
  custom_upstream: string[];
  cache_size: number;
  records: DnsRecord[];
  adblock: Adblock;
  blocklists: Record<string, { name: string; url: string }>;
}
interface DnsStats {
  queries: number;
  blocked: number;
  blocked_pct: number;
  top_blocked: { domain: string; count: number }[];
  cache: Record<string, number>;
}
interface Reservation {
  mac: string;
  ip: string;
  hostname: string;
}
interface DhcpState {
  enabled: boolean;
  interface: string;
  start: string;
  end: string;
  netmask: string;
  gateway: string;
  dns: string[];
  lease: string;
  reservations: Reservation[];
  leases: { expires: number; mac: string; ip: string; hostname: string }[];
}
interface Live {
  endpoint: string | null;
  handshake: number;
  rx: number;
  tx: number;
}
interface Peer {
  name: string;
  ip: string;
  public_key: string;
  allowed_ips: string;
  live: Live | null;
}
interface WgState {
  enabled: boolean;
  port: number;
  subnet: string;
  wan: string;
  endpoint: string;
  dns: string[];
  public_key: string;
  address: string;
  running: boolean;
  peers: Peer[];
}
interface WgClient {
  name: string;
  up: boolean;
  live: { public_key: string; peers: (Live & { allowed_ips: string })[] } | null;
}
interface PortForward {
  proto: "tcp" | "udp" | "both";
  ext_port: string;
  int_ip: string;
  int_port: number | null;
  comment: string;
}
interface StaticRoute {
  dest: string;
  gateway: string | null;
  dev: string | null;
}
interface RouterState {
  ipv4_forward: boolean;
  ipv6_forward: boolean;
  wan: string;
  lan: string;
  masquerade: boolean;
  forwards: PortForward[];
  routes: StaticRoute[];
  ruleset: string;
}
interface CertInfo {
  filename: string;
  subject?: string;
  issuer?: string;
  notafter?: number;
  san?: string[];
}
interface CertState {
  certificates: CertInfo[];
  acme: string;
  domains: string[];
  accounts: { name: string }[];
  plugins: { plugin: string; api?: string; type: string }[];
  dns_apis: string[];
  nginx_https: boolean;
}

type Tab = "topology" | "dns" | "dhcp" | "wg" | "wgc" | "router" | "domains" | "certs";
const TABS: { id: Tab; label: TKey; icon: ReactNode }[] = [
  { id: "topology", label: "net.topology", icon: <Share2 size={15} /> },
  { id: "dns", label: "net.dns", icon: <ShieldCheck size={15} /> },
  { id: "dhcp", label: "net.dhcp", icon: <Network size={15} /> },
  { id: "wg", label: "net.wg", icon: <Waypoints size={15} /> },
  { id: "wgc", label: "net.wgc", icon: <Globe size={15} /> },
  { id: "router", label: "net.router", icon: <Route size={15} /> },
  { id: "domains", label: "net.domains", icon: <AtSign size={15} /> },
  { id: "certs", label: "net.certs", icon: <Award size={15} /> },
];

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const ago = (ts: number) => (!ts ? "never" : `${Math.max(0, Math.round(Date.now() / 1000 - ts))}s ago`);

/* ---------------- Shared bits ---------------- */

function Card({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="glass-soft rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Warn({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-300/20 ring-inset">{children}</p>;
}

function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
          {empty && (
            <tr>
              <td colSpan={head.length} className="px-2 py-3 text-center text-slate-500">
                None yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const td = "border-t border-white/5 px-2 py-1.5";

/** Install / uninstall a host package as a detached job with a live log. */
function PackageBar({ pkg, label, installed, onChanged }: { pkg: "dnsmasq" | "wireguard"; label: string; installed?: boolean; onChanged: () => void }) {
  const [active, setActive] = useState(false);
  const [ask, setAsk] = useState(false);
  const { busy, error, run } = useRunner();
  const start = (action: "install" | "uninstall") =>
    run(() => api(`/net/packages/${pkg}/${action}`, { method: "POST" }).then(() => (setActive(true), setAsk(false))));
  const done = useCallback(() => (setActive(false), onChanged()), [onChanged]);
  return (
    <Card
      title={label}
      action={installed !== undefined && <GlassBadge tone={installed ? "success" : "neutral"}>{installed ? "INSTALLED" : "NOT INSTALLED"}</GlassBadge>}
    >
      <div className="flex flex-wrap gap-2">
        {installed ? (
          <GlassButton variant="danger" disabled={busy || active} onClick={() => setAsk(true)}>
            <Trash2 size={13} /> Uninstall
          </GlassButton>
        ) : (
          <GlassButton variant="primary" disabled={busy || active} onClick={() => start("install")}>
            <Download size={13} /> Install
          </GlassButton>
        )}
      </div>
      <JobLog name={`net-${pkg}`} active={active} onDone={done} className="mt-3" />
      <div className="mt-2">
        <Notice error={error} />
      </div>
      <ConfirmModal
        open={ask}
        onClose={() => setAsk(false)}
        onConfirm={() => start("uninstall")}
        busy={busy}
        title={`Uninstall ${label}`}
        confirmLabel="Uninstall"
        message={`The service stops and the package is removed from the ${useCapabilities.getState().capabilities.platform_label} host. Your SolarDeck settings are kept.`}
      />
    </Card>
  );
}

function IfaceSelect({ value, onChange, ifaces, allowEmpty }: { value: string; onChange: (v: string) => void; ifaces: Iface[]; allowEmpty?: string }) {
  return (
    <GlassSelect className="w-full" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
      {ifaces.map((i) => (
        <option key={i.iface} value={i.iface}>
          {i.iface} {i.cidr && `(${i.cidr})`}
        </option>
      ))}
    </GlassSelect>
  );
}

/* ---------------- DNS & AdBlock ---------------- */

function DnsTab({ status, reload }: { status: NetStatus; reload: () => void }) {
  const [d, setD] = useState<DnsState | null>(null);
  const [stats, setStats] = useState<DnsStats | null>(null);
  const [rec, setRec] = useState<DnsRecord>({ type: "A", name: "", value: "" });
  const [custom, setCustom] = useState("");
  const [wl, setWl] = useState("");
  const [bl, setBl] = useState("");
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(
    () =>
      api<DnsState>("/net/dns").then((x) => {
        setD(x);
        setCustom(x.custom_upstream.join(", "));
        setWl(x.adblock.whitelist.join("\n"));
        setBl(x.adblock.blacklist.join("\n"));
      }),
    [],
  );
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  const loadStats = () => run(() => api<DnsStats>("/net/dns/stats").then(setStats));
  if (!d) return <Notice error={error} />;
  const installed = status.packages.dnsmasq;
  const save = () =>
    run(
      () =>
        api("/net/dns", {
          method: "PUT",
          json: { enabled: d.enabled, interfaces: d.interfaces, upstream: d.upstream, custom_upstream: lines(custom), cache_size: d.cache_size, records: d.records },
        }).then(reload),
      "DNS settings applied.",
    );
  const saveAdblock = () =>
    run(
      () => api<Adblock>("/net/dns/adblock", { method: "PUT", json: { lists: d.adblock.lists, whitelist: lines(wl), blacklist: lines(bl) } }).then((ab) => setD({ ...d, adblock: ab })),
      "Blocklists downloaded and applied.",
    );
  const toggleIface = (i: string) => setD({ ...d, interfaces: d.interfaces.includes(i) ? d.interfaces.filter((x) => x !== i) : [...d.interfaces, i] });
  const toggleList = (id: string) =>
    setD({ ...d, adblock: { ...d.adblock, lists: d.adblock.lists.includes(id) ? d.adblock.lists.filter((x) => x !== id) : [...d.adblock.lists, id] } });
  return (
    <div className="space-y-4">
      <PackageBar pkg="dnsmasq" label="dnsmasq (DNS + DHCP server)" installed={installed} onChanged={reload} />
      <Card title="DNS server" action={<GlassBadge tone={status.services.dnsmasq === "active" ? "success" : "neutral"}>{status.services.dnsmasq?.toUpperCase()}</GlassBadge>}>
        <div className="space-y-3">
          <GlassSwitch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Serve DNS on the selected interfaces" disabled={!installed} />
          <Field label="Listen on interfaces">
            <div className="flex flex-wrap gap-3">
              {status.interfaces.map((i) => (
                <label key={i.iface} className="flex items-center gap-1.5 text-xs text-slate-200">
                  <input type="checkbox" checked={d.interfaces.includes(i.iface)} onChange={() => toggleIface(i.iface)} />
                  <span className="font-mono">{i.iface}</span>
                  {i.cidr && <span className="text-slate-500">{i.cidr}</span>}
                </label>
              ))}
            </div>
          </Field>
          <Warn>Only pick LAN-facing interfaces. Answering DNS on an interface reachable from the internet makes this host an open resolver that can be abused for DDoS attacks.</Warn>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Upstream DNS">
              <GlassSelect className="w-full" value={d.upstream} onChange={(e) => setD({ ...d, upstream: e.target.value })}>
                <option value="cloudflare">Cloudflare (1.1.1.1)</option>
                <option value="quad9">Quad9 (9.9.9.9)</option>
                <option value="google">Google (8.8.8.8)</option>
                <option value="custom">Custom</option>
              </GlassSelect>
            </Field>
            {d.upstream === "custom" && (
              <Field label="Custom servers" hint="Comma separated IPs">
                <GlassInput className="w-full font-mono" value={custom} onChange={(e) => setCustom(e.target.value)} />
              </Field>
            )}
            <Field label="Cache size (entries)">
              <GlassInput type="number" min={0} max={100000} className="w-full" value={d.cache_size} onChange={(e) => setD({ ...d, cache_size: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Local records">
            <Table head={["Type", "Name", "Value", ""]} empty={!d.records.length}>
              {d.records.map((r, i) => (
                <tr key={i}>
                  <td className={td}>{r.type}</td>
                  <td className={`${td} font-mono`}>{r.name}</td>
                  <td className={`${td} font-mono`}>{r.value}</td>
                  <td className={`${td} text-right`}>
                    <GlassButton variant="ghost" size="xs" aria-label="Remove record" onClick={() => setD({ ...d, records: d.records.filter((_, j) => j !== i) })}>
                      <Trash2 size={12} />
                    </GlassButton>
                  </td>
                </tr>
              ))}
            </Table>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <GlassSelect value={rec.type} onChange={(e) => setRec({ ...rec, type: e.target.value as DnsRecord["type"] })} aria-label="Record type">
              <option>A</option>
              <option>AAAA</option>
              <option>CNAME</option>
            </GlassSelect>
            <GlassInput className="w-44 font-mono" placeholder="nas.lan" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value.toLowerCase() })} aria-label="Record name" />
            <GlassInput className="w-44 font-mono" placeholder={rec.type === "CNAME" ? "target.lan" : rec.type === "A" ? "192.168.1.10" : "fd00::10"} value={rec.value} onChange={(e) => setRec({ ...rec, value: e.target.value })} aria-label="Record value" />
            <GlassButton disabled={!rec.name || !rec.value} onClick={() => (setD({ ...d, records: [...d.records, rec] }), setRec({ ...rec, name: "", value: "" }))}>
              <Plus size={13} /> Add record
            </GlassButton>
          </div>
          <GlassButton variant="primary" disabled={busy || !installed} onClick={save}>
            Apply DNS settings
          </GlassButton>
        </div>
      </Card>
      <Card title="AdBlocker" action={<span className="text-[11px] text-slate-400">{d.adblock.domains.toLocaleString()} domains blocked{d.adblock.updated && ` · updated ${new Date(d.adblock.updated * 1000).toLocaleString()}`}</span>}>
        <GuideBanner className="mb-3" guide="net-dns" text="Point your router at this server to block ads on every device. We'll walk you through it." />
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">
            {Object.entries(d.blocklists).map(([id, l]) => (
              <GlassSwitch key={id} checked={d.adblock.lists.includes(id)} onChange={() => toggleList(id)} label={l.name} />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Whitelist (never blocked)" hint="One domain per line">
              <textarea className="glass-field h-24 w-full font-mono" value={wl} onChange={(e) => setWl(e.target.value)} />
            </Field>
            <Field label="Blacklist (always blocked)" hint="One domain per line; subdomains included">
              <textarea className="glass-field h-24 w-full font-mono" value={bl} onChange={(e) => setBl(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <GlassButton variant="primary" disabled={busy || !installed} onClick={saveAdblock}>
              Save & apply blocklists
            </GlassButton>
            <GlassButton disabled={busy || !installed} onClick={() => run(() => api<Adblock>("/net/dns/adblock/update", { method: "POST" }).then((ab) => setD({ ...d, adblock: ab })), "Blocklists updated.")}>
              <RefreshCw size={13} /> Update now
            </GlassButton>
          </div>
        </div>
      </Card>
      <Card title="Query metrics" action={<GlassButton size="xs" disabled={busy || !installed} onClick={loadStats}><RefreshCw size={12} /> Refresh</GlassButton>}>
        {!stats ? (
          <p className="text-xs text-slate-500">Press Refresh to read the dnsmasq query log.</p>
        ) : (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Queries", stats.queries.toLocaleString()],
                ["Blocked", stats.blocked.toLocaleString()],
                ["Blocked %", `${stats.blocked_pct}%`],
                ["Answered from cache/local", (stats.cache.answered_locally ?? 0).toLocaleString()],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-black/20 p-3">
                  <div className="text-[11px] text-slate-400">{k}</div>
                  <div className="text-lg font-semibold text-white tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            <Table head={["Top blocked domains", "Count"]} empty={!stats.top_blocked.length}>
              {stats.top_blocked.map((t) => (
                <tr key={t.domain}>
                  <td className={`${td} font-mono`}>{t.domain}</td>
                  <td className={`${td} tabular-nums`}>{t.count}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>
      <Notice error={error} notice={notice} />
    </div>
  );
}

/* ---------------- DHCP ---------------- */

function DhcpTab({ status, reload }: { status: NetStatus; reload: () => void }) {
  const [d, setD] = useState<DhcpState | null>(null);
  const [dns, setDns] = useState("");
  const [res, setRes] = useState<Reservation>({ mac: "", ip: "", hostname: "" });
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<DhcpState>("/net/dhcp").then((x) => (setD(x), setDns(x.dns.join(", ")))), []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  if (!d) return <Notice error={error} />;
  const installed = status.packages.dnsmasq;
  const save = () =>
    run(
      () =>
        api("/net/dhcp", {
          method: "PUT",
          json: { enabled: d.enabled, interface: d.interface, start: d.start, end: d.end, netmask: d.netmask, gateway: d.gateway || null, dns: lines(dns), lease: d.lease, reservations: d.reservations },
        }).then(() => (reload(), load())),
      "DHCP settings applied.",
    );
  const set = (k: keyof DhcpState) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="space-y-4">
      {!installed && <Warn>Install dnsmasq in the DNS & AdBlock tab first.</Warn>}
      <Card title="DHCP server">
        <div className="space-y-3">
          <Warn>
            Never run this DHCP server on a network that already has one (for example <span className="font-mono">{edition.bridgePrefix}0</span> behind your home router): two DHCP servers hand out conflicting addresses and
            can knock devices, and this host, off the network. Use it on an internal bridge such as <span className="font-mono">{edition.bridgePrefix}1</span>.
          </Warn>
          <GlassSwitch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Enable DHCP" disabled={!installed} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Interface / bridge">
              <IfaceSelect value={d.interface} onChange={(v) => setD({ ...d, interface: v })} ifaces={status.interfaces} allowEmpty="Choose…" />
            </Field>
            <Field label="Range start">
              <GlassInput className="w-full font-mono" placeholder="10.10.0.100" value={d.start} onChange={set("start")} />
            </Field>
            <Field label="Range end">
              <GlassInput className="w-full font-mono" placeholder="10.10.0.200" value={d.end} onChange={set("end")} />
            </Field>
            <Field label="Subnet mask">
              <GlassInput className="w-full font-mono" value={d.netmask} onChange={set("netmask")} />
            </Field>
            <Field label="Gateway (router option)">
              <GlassInput className="w-full font-mono" placeholder="10.10.0.1" value={d.gateway} onChange={set("gateway")} />
            </Field>
            <Field label="DNS servers pushed" hint="Comma separated">
              <GlassInput className="w-full font-mono" value={dns} onChange={(e) => setDns(e.target.value)} />
            </Field>
            <Field label="Lease time" hint="e.g. 12h, 30m, 7d, infinite">
              <GlassInput className="w-full font-mono" value={d.lease} onChange={set("lease")} />
            </Field>
          </div>
          <Field label="Static reservations">
            <Table head={["MAC", "IP", "Hostname", ""]} empty={!d.reservations.length}>
              {d.reservations.map((r, i) => (
                <tr key={i}>
                  <td className={`${td} font-mono`}>{r.mac}</td>
                  <td className={`${td} font-mono`}>{r.ip}</td>
                  <td className={td}>{r.hostname || "—"}</td>
                  <td className={`${td} text-right`}>
                    <GlassButton variant="ghost" size="xs" aria-label="Remove reservation" onClick={() => setD({ ...d, reservations: d.reservations.filter((_, j) => j !== i) })}>
                      <Trash2 size={12} />
                    </GlassButton>
                  </td>
                </tr>
              ))}
            </Table>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <GlassInput className="w-40 font-mono" placeholder="aa:bb:cc:dd:ee:ff" value={res.mac} onChange={(e) => setRes({ ...res, mac: e.target.value })} aria-label="MAC address" />
            <GlassInput className="w-32 font-mono" placeholder="10.10.0.50" value={res.ip} onChange={(e) => setRes({ ...res, ip: e.target.value })} aria-label="Reserved IP" />
            <GlassInput className="w-32" placeholder="hostname" value={res.hostname} onChange={(e) => setRes({ ...res, hostname: e.target.value.toLowerCase() })} aria-label="Hostname" />
            <GlassButton disabled={!res.mac || !res.ip} onClick={() => (setD({ ...d, reservations: [...d.reservations, res] }), setRes({ mac: "", ip: "", hostname: "" }))}>
              <Plus size={13} /> Add reservation
            </GlassButton>
          </div>
          <GlassButton variant="primary" disabled={busy || !installed || !d.interface} onClick={save}>
            Apply DHCP settings
          </GlassButton>
          <Notice error={error} notice={notice} />
        </div>
      </Card>
      <Card title="Active leases" action={<GlassButton size="xs" onClick={() => load().catch(() => {})}><RefreshCw size={12} /> Refresh</GlassButton>}>
        <Table head={["IP", "MAC", "Hostname", "Expires"]} empty={!d.leases.length}>
          {d.leases.map((l) => (
            <tr key={l.mac + l.ip}>
              <td className={`${td} font-mono`}>{l.ip}</td>
              <td className={`${td} font-mono`}>{l.mac}</td>
              <td className={td}>{l.hostname || "—"}</td>
              <td className={td}>{l.expires ? new Date(l.expires * 1000).toLocaleString() : "never"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

/* ---------------- WireGuard server ---------------- */

function WgServerTab({ status, reload }: { status: NetStatus; reload: () => void }) {
  const [w, setW] = useState<WgState | null>(null);
  const [dns, setDns] = useState("");
  const [peer, setPeer] = useState({ name: "", allowed_ips: "0.0.0.0/0, ::/0" });
  const [qr, setQr] = useState<{ name: string; svg: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<WgState>("/net/wg").then((x) => (setW(x), setDns((cur) => cur || x.dns.join(", ")))), []);
  const poll = useCallback(() => {
    load().catch(() => {});
  }, [load]);
  usePoll(poll, 10000);
  if (!w) return <Notice error={error} />;
  const installed = status.packages["wireguard-tools"];
  const save = () =>
    run(
      () => api("/net/wg", { method: "PUT", json: { enabled: w.enabled, port: w.port, subnet: w.subnet, wan: w.wan, endpoint: w.endpoint, dns: lines(dns) } }).then(() => (load(), reload())),
      "WireGuard server applied.",
    );
  const addPeer = () => run(() => api("/net/wg/peers", { method: "POST", json: peer }).then(() => (setPeer({ ...peer, name: "" }), load())), "Peer added.");
  const showQr = (name: string) => run(() => api<{ svg: string }>(`/net/wg/peers/${name}/qr`).then((r) => setQr({ name, svg: r.svg })));
  const removePeer = () => del && run(() => api(`/net/wg/peers/${del}`, { method: "DELETE" }).then(() => (setDel(null), load())));
  return (
    <div className="space-y-4">
      <PackageBar pkg="wireguard" label="WireGuard tools" installed={installed} onChanged={reload} />
      <GuideBanner guide="net-wireguard" text="Set up the VPN server and connect your phone by scanning a QR code, step by step." />
      <Card title="Server" action={<GlassBadge tone={w.running ? "success" : "neutral"}>{w.running ? "RUNNING" : "STOPPED"}</GlassBadge>}>
        <div className="space-y-3">
          <GlassSwitch checked={w.enabled} onChange={(v) => setW({ ...w, enabled: v })} label="Enable WireGuard server (wg0)" disabled={!installed} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Listen port (UDP)">
              <GlassInput type="number" min={1} max={65535} className="w-full" value={w.port} onChange={(e) => setW({ ...w, port: Number(e.target.value) })} />
            </Field>
            <Field label="VPN subnet" hint={`Server address ${w.address}`}>
              <GlassInput className="w-full font-mono" value={w.subnet} onChange={(e) => setW({ ...w, subnet: e.target.value })} />
            </Field>
            <Field label="WAN interface (masquerade)">
              <IfaceSelect value={w.wan} onChange={(v) => setW({ ...w, wan: v })} ifaces={status.interfaces} />
            </Field>
            <Field label="Public endpoint" hint={`Hostname or IP clients connect to; default ${status.host_ip}`}>
              <GlassInput className="w-full font-mono" placeholder={status.host_ip} value={w.endpoint} onChange={(e) => setW({ ...w, endpoint: e.target.value.toLowerCase() })} />
            </Field>
            <Field label="DNS for clients" hint="Comma separated">
              <GlassInput className="w-full font-mono" value={dns} onChange={(e) => setDns(e.target.value)} />
            </Field>
          </div>
          {w.public_key && (
            <p className="text-[11px] text-slate-400">
              Server public key: <span className="font-mono break-all text-slate-200 select-all">{w.public_key}</span>
            </p>
          )}
          <p className="text-[11px] text-slate-500">Forward UDP port {w.port} on your internet router to {status.host_ip} so clients can reach the server from outside.</p>
          <GlassButton variant="primary" disabled={busy || !installed} onClick={save}>
            Apply server settings
          </GlassButton>
        </div>
      </Card>
      <Card title="Peers">
        <Table head={["Name", "VPN IP", "Endpoint", "Last handshake", "Received", "Sent", ""]} empty={!w.peers.length}>
          {w.peers.map((p) => (
            <tr key={p.name}>
              <td className={td}>{p.name}</td>
              <td className={`${td} font-mono`}>{p.ip}</td>
              <td className={`${td} font-mono`}>{p.live?.endpoint ?? "—"}</td>
              <td className={td}>{p.live ? ago(p.live.handshake) : "—"}</td>
              <td className={`${td} tabular-nums`}>{p.live ? bytes(p.live.rx) : "—"}</td>
              <td className={`${td} tabular-nums`}>{p.live ? bytes(p.live.tx) : "—"}</td>
              <td className={`${td} text-right whitespace-nowrap`}>
                <GlassButton variant="ghost" size="xs" onClick={() => showQr(p.name)} aria-label={`QR code for ${p.name}`}>
                  <QrCode size={12} />
                </GlassButton>
                <a className="inline-flex rounded-lg px-2 py-1 text-slate-300 hover:bg-white/10" href={`/api/net/wg/peers/${encodeURIComponent(p.name)}/conf`} download aria-label={`Download ${p.name}.conf`}>
                  <Download size={12} />
                </a>
                <GlassButton variant="ghost" size="xs" onClick={() => setDel(p.name)} aria-label={`Remove ${p.name}`}>
                  <Trash2 size={12} />
                </GlassButton>
              </td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Peer name">
            <GlassInput className="w-40" placeholder="phone" value={peer.name} onChange={(e) => setPeer({ ...peer, name: e.target.value })} />
          </Field>
          <Field label="Client AllowedIPs" hint="0.0.0.0/0 = full tunnel">
            <GlassInput className="w-56 font-mono" value={peer.allowed_ips} onChange={(e) => setPeer({ ...peer, allowed_ips: e.target.value })} />
          </Field>
          <GlassButton disabled={busy || !peer.name || !w.public_key} onClick={addPeer}>
            <Plus size={13} /> Add peer
          </GlassButton>
        </div>
        <div className="mt-3">
          <Notice error={error} notice={notice} />
        </div>
      </Card>
      <GlassModal open={!!qr} onClose={() => setQr(null)} title={`Scan with the WireGuard app — ${qr?.name ?? ""}`} width="max-w-sm">
        {qr && <img src={`data:image/svg+xml;utf8,${encodeURIComponent(qr.svg)}`} alt={`WireGuard QR code for ${qr.name}`} className="mx-auto w-64 rounded-xl bg-white p-2" />}
      </GlassModal>
      <ConfirmModal open={!!del} onClose={() => setDel(null)} onConfirm={removePeer} busy={busy} error={error} title="Remove peer" confirmLabel="Remove" message={`Remove ${del}? The device loses VPN access immediately.`} />
    </div>
  );
}

/* ---------------- WireGuard client ---------------- */

function WgClientTab({ status, reload }: { status: NetStatus; reload: () => void }) {
  const [clients, setClients] = useState<WgClient[]>([]);
  const [f, setF] = useState({ name: "", conf: "", table_off: true });
  const [del, setDel] = useState<string | null>(null);
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => {
    api<WgClient[]>("/net/wg/clients").then(setClients, () => {});
  }, []);
  usePoll(load, 10000);
  const fullTunnel = /AllowedIPs\s*=.*(0\.0\.0\.0\/0|::\/0)/i.test(f.conf) && !f.table_off;
  const add = () =>
    run(
      () => api<{ full_tunnel: boolean }>("/net/wg/clients", { method: "POST", json: f }).then(() => (setF({ name: "", conf: "", table_off: true }), load())),
      "Profile saved. Bring the tunnel up from the list.",
    );
  const act = (name: string, action: "up" | "down") => run(() => api(`/net/wg/clients/${name}/${action}`, { method: "POST" }).then(() => (load(), reload())));
  return (
    <div className="space-y-4">
      {!status.packages["wireguard-tools"] && <Warn>Install WireGuard tools in the WireGuard Server tab first.</Warn>}
      <Card title="Tunnels">
        <Table head={["Name", "State", "Endpoint", "Last handshake", "Received", "Sent", ""]} empty={!clients.length}>
          {clients.map((c) => {
            const p = c.live?.peers[0];
            return (
              <tr key={c.name}>
                <td className={`${td} font-mono`}>{c.name}</td>
                <td className={td}>
                  <GlassBadge tone={c.up ? "success" : "neutral"}>{c.up ? "UP" : "DOWN"}</GlassBadge>
                </td>
                <td className={`${td} font-mono`}>{p?.endpoint ?? "—"}</td>
                <td className={td}>{p ? ago(p.handshake) : "—"}</td>
                <td className={`${td} tabular-nums`}>{p ? bytes(p.rx) : "—"}</td>
                <td className={`${td} tabular-nums`}>{p ? bytes(p.tx) : "—"}</td>
                <td className={`${td} text-right whitespace-nowrap`}>
                  <GlassButton size="xs" disabled={busy} onClick={() => act(c.name, c.up ? "down" : "up")}>
                    {c.up ? "Down" : "Up"}
                  </GlassButton>
                  <GlassButton variant="ghost" size="xs" onClick={() => setDel(c.name)} aria-label={`Delete ${c.name}`}>
                    <Trash2 size={12} />
                  </GlassButton>
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <Card title="Add a profile">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Interface name" hint="Lowercase letters/digits, e.g. vpn1">
              <GlassInput className="w-36 font-mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase() })} />
            </Field>
            <Field label="Or upload a .conf file">
              <input
                type="file"
                accept=".conf,text/plain"
                className="text-xs text-slate-300"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setF({ ...f, conf: await file.text(), name: f.name || file.name.replace(/\.conf$/, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) });
                }}
              />
            </Field>
          </div>
          <Field label="WireGuard profile" hint="Script hooks (PostUp, PreUp, …) are refused; DNS lines are dropped so the host's resolver stays unchanged.">
            <textarea className="glass-field h-40 w-full font-mono" spellCheck={false} placeholder={"[Interface]\nPrivateKey = …\nAddress = 10.2.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.2.0.0/24"} value={f.conf} onChange={(e) => setF({ ...f, conf: e.target.value })} />
          </Field>
          <GlassSwitch checked={f.table_off} onChange={(v) => setF({ ...f, table_off: v })} label="Route only the tunnel subnets (Table = off)" />
          {fullTunnel && (
            <Warn>
              This profile has AllowedIPs = 0.0.0.0/0 (or ::/0): bringing it up routes ALL traffic of {edition.host} through the tunnel, which can cut off your access to the host and its web UI. Keep
              &quot;Table = off&quot; enabled unless you have console access.
            </Warn>
          )}
          <GlassButton variant="primary" disabled={busy || !f.name || !f.conf} onClick={add}>
            Save profile
          </GlassButton>
          <Notice error={error} notice={notice} />
        </div>
      </Card>
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        onConfirm={() => del && run(() => api(`/net/wg/clients/${del}`, { method: "DELETE" }).then(() => (setDel(null), load())))}
        busy={busy}
        error={error}
        title="Delete tunnel"
        confirmLabel="Delete"
        message={`Bring ${del} down and delete its profile from the host?`}
      />
    </div>
  );
}

/* ---------------- Router & NAT ---------------- */

const emptyFwd: PortForward = { proto: "tcp", ext_port: "", int_ip: "", int_port: null, comment: "" };

function RouterTab({ status, reload }: { status: NetStatus; reload: () => void }) {
  const [r, setR] = useState<RouterState | null>(null);
  const [fwd, setFwd] = useState<PortForward>(emptyFwd);
  const [route, setRoute] = useState({ dest: "", gateway: "", dev: "" });
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(() => api<RouterState>("/net/router").then(setR), []);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  if (!r) return <Notice error={error} />;
  const save = () =>
    run(
      () =>
        api("/net/router", {
          method: "PUT",
          json: { ipv4_forward: r.ipv4_forward, ipv6_forward: r.ipv6_forward, wan: r.wan, lan: r.lan, masquerade: r.masquerade, forwards: r.forwards, routes: r.routes },
        }).then(() => (load(), reload())),
      "Router configuration applied and persisted (router service).",
    );
  return (
    <div className="space-y-4">
      <Card title="Gateway" action={<GlassBadge tone={status.services.router === "active" ? "success" : "neutral"}>{(status.services.router || "inactive").toUpperCase()}</GlassBadge>}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">
            <GlassSwitch checked={r.ipv4_forward} onChange={(v) => setR({ ...r, ipv4_forward: v })} label="IPv4 forwarding" />
            <GlassSwitch checked={r.ipv6_forward} onChange={(v) => setR({ ...r, ipv6_forward: v })} label="IPv6 forwarding" />
            <GlassSwitch checked={r.masquerade} onChange={(v) => setR({ ...r, masquerade: v })} label="Masquerade (SNAT) LAN → WAN" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="WAN interface">
              <IfaceSelect value={r.wan} onChange={(v) => setR({ ...r, wan: v })} ifaces={status.interfaces} allowEmpty="None" />
            </Field>
            <Field label="LAN interface" hint="Empty = masquerade everything leaving the WAN">
              <IfaceSelect value={r.lan} onChange={(v) => setR({ ...r, lan: v })} ifaces={status.interfaces} allowEmpty="Any" />
            </Field>
          </div>
          <p className="text-[11px] text-slate-500">Rules live in their own nftables table; other firewall rules on the host are not touched.</p>
        </div>
      </Card>
      <Card title="Port forwarding (DNAT)">
        <Table head={["Protocol", "External port", "Internal target", "Comment", ""]} empty={!r.forwards.length}>
          {r.forwards.map((x, i) => (
            <tr key={i}>
              <td className={`${td} uppercase`}>{x.proto === "both" ? "TCP+UDP" : x.proto}</td>
              <td className={`${td} font-mono`}>{x.ext_port}</td>
              <td className={`${td} font-mono`}>
                {x.int_ip}
                {x.int_port ? `:${x.int_port}` : ""}
              </td>
              <td className={td}>{x.comment || "—"}</td>
              <td className={`${td} text-right`}>
                <GlassButton variant="ghost" size="xs" aria-label="Remove forward" onClick={() => setR({ ...r, forwards: r.forwards.filter((_, j) => j !== i) })}>
                  <Trash2 size={12} />
                </GlassButton>
              </td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <GlassSelect value={fwd.proto} onChange={(e) => setFwd({ ...fwd, proto: e.target.value as PortForward["proto"] })} aria-label="Protocol">
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="both">TCP+UDP</option>
          </GlassSelect>
          <GlassInput className="w-28 font-mono" placeholder="8080 or 27015-27020" value={fwd.ext_port} onChange={(e) => setFwd({ ...fwd, ext_port: e.target.value })} aria-label="External port" />
          <GlassInput className="w-32 font-mono" placeholder="10.10.0.5" value={fwd.int_ip} onChange={(e) => setFwd({ ...fwd, int_ip: e.target.value })} aria-label="Internal IP" />
          <GlassInput className="w-24 font-mono" type="number" min={1} max={65535} placeholder="port" value={fwd.int_port ?? ""} onChange={(e) => setFwd({ ...fwd, int_port: e.target.value ? Number(e.target.value) : null })} aria-label="Internal port" />
          <GlassInput className="w-36" placeholder="comment" value={fwd.comment} onChange={(e) => setFwd({ ...fwd, comment: e.target.value })} aria-label="Comment" />
          <GlassButton disabled={!fwd.ext_port || !fwd.int_ip} onClick={() => (setR({ ...r, forwards: [...r.forwards, fwd] }), setFwd(emptyFwd))}>
            <Plus size={13} /> Add
          </GlassButton>
        </div>
      </Card>
      <Card title="Static routes">
        <Table head={["Destination", "Gateway", "Device", ""]} empty={!r.routes.length}>
          {r.routes.map((x, i) => (
            <tr key={i}>
              <td className={`${td} font-mono`}>{x.dest}</td>
              <td className={`${td} font-mono`}>{x.gateway || "—"}</td>
              <td className={`${td} font-mono`}>{x.dev || "—"}</td>
              <td className={`${td} text-right`}>
                <GlassButton variant="ghost" size="xs" aria-label="Remove route" onClick={() => setR({ ...r, routes: r.routes.filter((_, j) => j !== i) })}>
                  <Trash2 size={12} />
                </GlassButton>
              </td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <GlassInput className="w-36 font-mono" placeholder="172.16.0.0/16" value={route.dest} onChange={(e) => setRoute({ ...route, dest: e.target.value })} aria-label="Destination CIDR" />
          <GlassInput className="w-32 font-mono" placeholder="via 10.10.0.254" value={route.gateway} onChange={(e) => setRoute({ ...route, gateway: e.target.value })} aria-label="Gateway" />
          <div className="w-40">
            <IfaceSelect value={route.dev} onChange={(v) => setRoute({ ...route, dev: v })} ifaces={status.interfaces} allowEmpty="Any device" />
          </div>
          <GlassButton
            disabled={!route.dest || (!route.gateway && !route.dev)}
            onClick={() => (setR({ ...r, routes: [...r.routes, { dest: route.dest, gateway: route.gateway || null, dev: route.dev || null }] }), setRoute({ dest: "", gateway: "", dev: "" }))}
          >
            <Plus size={13} /> Add route
          </GlassButton>
        </div>
      </Card>
      <div className="flex items-center gap-2">
        <GlassButton variant="primary" disabled={busy} onClick={save}>
          Apply router configuration
        </GlassButton>
      </div>
      <Notice error={error} notice={notice} />
      {r.ruleset && (
        <Card title="Active nftables table">
          <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] text-slate-300">{r.ruleset}</pre>
        </Card>
      )}
    </div>
  );
}

/* ---------------- Certificates ---------------- */

function TaskLog({ upid }: { upid: string }) {
  const [log, setLog] = useState<string[]>([]);
  const [state, setState] = useState("running");
  const poll = useCallback(() => {
    if (state !== "running") return;
    api<{ lines: string[] }>(`/v1/tasks/${encodeURIComponent(upid)}/log`).then((r) => setLog(r.lines), () => {});
    api<{ state: string }>(`/v1/tasks/${encodeURIComponent(upid)}/status`).then((s) => setState(s.state), () => {});
  }, [upid, state]);
  usePoll(poll, 2000);
  return (
    <div className="mt-3">
      <GlassBadge tone={state === "running" ? "info" : state === "ok" ? "success" : "danger"}>{state.toUpperCase()}</GlassBadge>
      <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">{log.join("\n") || "Starting…"}</pre>
    </div>
  );
}

function CertsTab() {
  const [c, setC] = useState<CertState | null>(null);
  const [acct, setAcct] = useState({ name: "default", contact: "", directory: "production", accept_tos: false });
  const [plugin, setPlugin] = useState({ id: "", api: "", data: "" });
  const [account, setAccount] = useState("");
  const [domains, setDomains] = useState<{ domain: string; plugin: string }[]>([{ domain: "", plugin: "" }]);
  const [upid, setUpid] = useState<string | null>(null);
  const [custom, setCustom] = useState({ certificates: "", key: "", node: edition.certNodeLabel !== null, nginx: false });
  const { busy, error, notice, run } = useRunner();
  const load = useCallback(
    () =>
      api<CertState>("/net/certs").then((x) => {
        setC(x);
        setAccount(x.acme.replace(/^account=/, "").split(",")[0] || x.accounts[0]?.name || "");
        const ds = x.domains.map((d) => ({ domain: /domain=([^,]+)/.exec(d)?.[1] ?? "", plugin: /plugin=([^,]+)/.exec(d)?.[1] ?? "" }));
        if (ds.length) setDomains(ds);
      }),
    [],
  );
  useEffect(() => {
    run(load);
  }, [load, run]);
  if (!c) return <Notice error={error} />;
  const del = (path: string) => run(() => api(path, { method: "DELETE" }).then(load), "Removed.");
  return (
    <div className="space-y-4">
      <Card title="Node certificates">
        <Table head={["File", "Subject", "Issuer", "Expires", "SANs"]} empty={!c.certificates.length}>
          {c.certificates.map((x) => (
            <tr key={x.filename}>
              <td className={`${td} font-mono`}>{x.filename}</td>
              <td className={td}>{x.subject ?? "—"}</td>
              <td className={td}>{x.issuer ?? "—"}</td>
              <td className={td}>{x.notafter ? new Date(x.notafter * 1000).toLocaleDateString() : "—"}</td>
              <td className={`${td} font-mono text-[10px]`}>{x.san?.join(", ") ?? "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Let's Encrypt (ACME) accounts">
        <div className="mb-3 flex flex-wrap gap-2">
          {c.accounts.map((a) => (
            <span key={a.name} className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1 text-xs text-slate-200">
              {a.name}
              <GlassButton variant="ghost" size="xs" aria-label={`Deactivate ${a.name}`} onClick={() => del(`/net/certs/acme/accounts/${a.name}`)}>
                <Trash2 size={11} />
              </GlassButton>
            </span>
          ))}
          {!c.accounts.length && <span className="text-xs text-slate-500">No account registered.</span>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Account name">
            <GlassInput className="w-32" value={acct.name} onChange={(e) => setAcct({ ...acct, name: e.target.value })} />
          </Field>
          <Field label="Contact e-mail">
            <GlassInput className="w-56" type="email" value={acct.contact} onChange={(e) => setAcct({ ...acct, contact: e.target.value })} />
          </Field>
          <Field label="Directory">
            <GlassSelect value={acct.directory} onChange={(e) => setAcct({ ...acct, directory: e.target.value })}>
              <option value="production">Let&apos;s Encrypt</option>
              <option value="staging">Let&apos;s Encrypt (staging)</option>
            </GlassSelect>
          </Field>
          <GlassSwitch checked={acct.accept_tos} onChange={(v) => setAcct({ ...acct, accept_tos: v })} label="I accept the Let's Encrypt terms of service" />
          <GlassButton disabled={busy || !acct.contact || !acct.accept_tos} onClick={() => run(() => api("/net/certs/acme/accounts", { method: "POST", json: acct }).then(load), "Account registered.")}>
            <Plus size={13} /> Register
          </GlassButton>
        </div>
      </Card>
      <Card title="DNS challenge plugins">
        <div className="mb-3 flex flex-wrap gap-2">
          {c.plugins.filter((p) => p.type === "dns").map((p) => (
            <span key={p.plugin} className="inline-flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1 text-xs text-slate-200">
              {p.plugin} <span className="text-slate-500">({p.api})</span>
              <GlassButton variant="ghost" size="xs" aria-label={`Delete plugin ${p.plugin}`} onClick={() => del(`/net/certs/acme/plugins/${p.plugin}`)}>
                <Trash2 size={11} />
              </GlassButton>
            </span>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-[8rem_12rem_1fr_auto] sm:items-end">
          <Field label="Plugin ID">
            <GlassInput className="w-full" value={plugin.id} onChange={(e) => setPlugin({ ...plugin, id: e.target.value })} />
          </Field>
          <Field label="DNS provider">
            <GlassSelect className="w-full" value={plugin.api} onChange={(e) => setPlugin({ ...plugin, api: e.target.value })}>
              <option value="">Choose…</option>
              {c.dns_apis.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </GlassSelect>
          </Field>
          <Field label="API credentials" hint="KEY=value per line, e.g. CF_Token=…">
            <textarea className="glass-field h-16 w-full font-mono" value={plugin.data} onChange={(e) => setPlugin({ ...plugin, data: e.target.value })} />
          </Field>
          <GlassButton disabled={busy || !plugin.id || !plugin.api} onClick={() => run(() => api("/net/certs/acme/plugins", { method: "POST", json: plugin }).then(() => (setPlugin({ id: "", api: "", data: "" }), load())), "Plugin added.")}>
            <Plus size={13} /> Add
          </GlassButton>
        </div>
      </Card>
      <Card title="Host certificate domains">
        <div className="space-y-2">
          <Field label="ACME account">
            <GlassSelect value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose…</option>
              {c.accounts.map((a) => (
                <option key={a.name}>{a.name}</option>
              ))}
            </GlassSelect>
          </Field>
          {domains.map((d, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <GlassInput className="w-64 font-mono" placeholder={edition.hostExample} value={d.domain} onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, domain: e.target.value.toLowerCase() } : x)))} aria-label="Domain" />
              <GlassSelect value={d.plugin} onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, plugin: e.target.value } : x)))} aria-label="Challenge">
                <option value="">HTTP-01 (port 80 on the host)</option>
                {c.plugins.filter((p) => p.type === "dns").map((p) => (
                  <option key={p.plugin} value={p.plugin}>
                    DNS-01 via {p.plugin}
                  </option>
                ))}
              </GlassSelect>
              <GlassButton variant="ghost" size="xs" disabled={domains.length === 1} onClick={() => setDomains(domains.filter((_, j) => j !== i))} aria-label="Remove domain">
                <Trash2 size={12} />
              </GlassButton>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <GlassButton size="xs" disabled={domains.length >= 6} onClick={() => setDomains([...domains, { domain: "", plugin: "" }])}>
              <Plus size={12} /> Domain
            </GlassButton>
            <GlassButton
              disabled={busy || !account || domains.some((d) => !d.domain)}
              onClick={() => run(() => api("/net/certs/acme/domains", { method: "PUT", json: { account, domains: domains.map((d) => ({ domain: d.domain, plugin: d.plugin || null })) } }).then(load), "Domains saved.")}
            >
              Save domains
            </GlassButton>
            <GlassButton variant="primary" disabled={busy || !c.domains.length} onClick={() => run(() => api<{ upid: string }>("/net/certs/acme/order", { method: "POST", json: { renew: false } }).then((r) => setUpid(r.upid)))}>
              Order certificate
            </GlassButton>
            <GlassButton disabled={busy || !c.domains.length} onClick={() => run(() => api<{ upid: string }>("/net/certs/acme/order", { method: "POST", json: { renew: true } }).then((r) => setUpid(r.upid)))}>
              Renew now
            </GlassButton>
          </div>
          {upid && <TaskLog upid={upid} />}
        </div>
      </Card>
      <Card title="Custom certificate (third-party)" action={c.nginx_https && <GlassBadge tone="success">SOLARDECK HTTPS ON</GlassBadge>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Certificate PEM (with chain)">
              <textarea className="glass-field h-32 w-full font-mono text-[10px]" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" value={custom.certificates} onChange={(e) => setCustom({ ...custom, certificates: e.target.value })} />
            </Field>
            <Field label="Private key PEM">
              <textarea className="glass-field h-32 w-full font-mono text-[10px]" spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" value={custom.key} onChange={(e) => setCustom({ ...custom, key: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-4">
            {edition.certNodeLabel && <GlassSwitch checked={custom.node} onChange={(v) => setCustom({ ...custom, node: v })} label={edition.certNodeLabel} />}
            <GlassSwitch checked={custom.nginx} onChange={(v) => setCustom({ ...custom, nginx: v })} label="Apply to SolarDeck HTTPS (port 443)" />
          </div>
          <div className="flex flex-wrap gap-2">
            <GlassButton
              variant="primary"
              disabled={busy || !custom.certificates || !custom.key || (!custom.node && !custom.nginx)}
              onClick={() => run(() => api<{ subject: string }>("/net/certs/custom", { method: "POST", json: custom }).then(() => (setCustom({ ...custom, key: "" }), load())), "Certificate applied.")}
            >
              Upload & apply
            </GlassButton>
            {edition.certNodeLabel && (
              <GlassButton variant="danger" disabled={busy} onClick={() => del("/net/certs/custom/node")}>
                Remove node custom cert
              </GlassButton>
            )}
            {c.nginx_https && (
              <GlassButton variant="danger" disabled={busy} onClick={() => del("/net/certs/custom/nginx")}>
                Disable SolarDeck HTTPS
              </GlassButton>
            )}
          </div>
          <p className="text-[11px] text-slate-500">{edition.certApplyNote}</p>
        </div>
      </Card>
      <Notice error={error} notice={notice} />
    </div>
  );
}

/* ---------------- App ---------------- */

export default function NetworkServicesApp({ initialTab = "topology" }: { initialTab?: Tab }) {
  const { t: tr } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  useIntentFor("netservices", setTab);
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api<NetStatus>("/net/status").then((s) => (setStatus(s), setError("")), (e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);
  return (
    <div className="flex h-full">
      <nav className="w-48 shrink-0 space-y-1 border-r border-white/10 bg-black/20 p-2 max-sm:w-14">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${
              tab === t.id ? "bg-white/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
            title={tr(t.label)}
          >
            {t.icon}
            <span className="max-sm:hidden">{tr(t.label)}</span>
          </button>
        ))}
        <button onClick={reload} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 hover:text-slate-200" title="Refresh">
          <RefreshCw size={15} /> <span className="max-sm:hidden">{tr("common.refresh")}</span>
        </button>
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <Notice error={error} />
        {tab === "topology" ? (
          <TopologyTab onTab={setTab} />
        ) : tab === "certs" ? (
          <CertsTab />
        ) : tab === "domains" ? (
          <DomainsTab onOpenDns={() => setTab("dns")} />
        ) : !status ? (
          !error && <p className="text-sm text-slate-400">Loading…</p>
        ) : tab === "dns" ? (
          <DnsTab status={status} reload={reload} />
        ) : tab === "dhcp" ? (
          <DhcpTab status={status} reload={reload} />
        ) : tab === "wg" ? (
          <WgServerTab status={status} reload={reload} />
        ) : tab === "wgc" ? (
          <WgClientTab status={status} reload={reload} />
        ) : (
          <RouterTab status={status} reload={reload} />
        )}
      </div>
    </div>
  );
}
