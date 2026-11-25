import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Globe, Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassSelect, Notice } from "../../components/ui/GlassKit";

type Host = { name: string; ip: string };
type Domain = { name: string; hosts: Host[] };
type CertInfo = { subject: string; issuer: string; names: string[]; self_signed: boolean; lets_encrypt: boolean; expires: number };
type Job = { fqdn: string; state: "running" | "done" | "error"; step: string; error: string | null; log: string[] };
type State = {
  domains: Domain[];
  certificate: { fqdn: string; plugin: string; email: string; issued: number } | null;
  dns_service: { installed: boolean; enabled: boolean };
  https: CertInfo | null;
  job: Job | null;
};

/** DNS providers with ready-made fields; "other" takes any acme.sh DNS API plugin and its settings. */
const PROVIDERS: { id: string; label: string; plugin: string; fields: { key: string; label: string; optional?: boolean; hint?: string }[]; help?: string }[] = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    plugin: "dns_cf",
    fields: [
      { key: "CF_Token", label: "API token", hint: "Permissions: Zone → DNS → Edit, limited to your domain" },
      { key: "CF_Zone_ID", label: "Zone ID", optional: true, hint: "Optional; needed when the token cannot list zones (domain Overview page, right column)" },
    ],
    help: "Create the token at dash.cloudflare.com → My Profile → API Tokens → Create Token → \"Edit zone DNS\" template.",
  },
  { id: "hetzner", label: "Hetzner DNS", plugin: "dns_hetzner", fields: [{ key: "HETZNER_Token", label: "API token" }] },
  { id: "digitalocean", label: "DigitalOcean", plugin: "dns_dgon", fields: [{ key: "DO_API_KEY", label: "API token" }] },
  { id: "other", label: "Other provider (acme.sh DNS API)", plugin: "", fields: [] },
];

const fqdnOf = (host: string, domain: string) => (host === "@" ? domain : `${host}.${domain}`);
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|:/;

function HostsEditor({ domain, dnsActive, onSaved }: { domain: Domain; dnsActive: boolean; onSaved: () => void }) {
  const [hosts, setHosts] = useState<Host[]>(domain.hosts);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ error: "", notice: "" });
  useEffect(() => setHosts(domain.hosts), [domain.hosts]);
  const dirty = JSON.stringify(hosts) !== JSON.stringify(domain.hosts);
  const set = (i: number, patch: Partial<Host>) => setHosts((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const defaultIp = IP_RE.test(location.hostname) ? location.hostname : "";

  const save = async () => {
    setBusy(true);
    setMsg({ error: "", notice: "" });
    try {
      const r = await api<{ dns_applied: boolean }>(`/domains/${domain.name}/hosts`, { method: "PUT", json: { hosts: hosts.filter((h) => h.name.trim()) } });
      onSaved(); // reload the full state (DNS service, certificate) rather than the partial response
      setMsg({ error: "", notice: r.dns_applied ? "Saved and active in the DNS service." : "Saved. They resolve once the DNS service is installed and on." });
    } catch (e) {
      setMsg({ error: (e as Error).message, notice: "" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {hosts.map((h, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <GlassInput
              className="w-40 py-1.5 font-mono text-xs"
              value={h.name}
              onChange={(e) => set(i, { name: e.target.value.trim().toLowerCase() })}
              placeholder="solardeck"
              aria-label="Host name"
            />
            <span className="text-xs text-slate-500">.{domain.name}</span>
            <span className="text-xs text-slate-500">→</span>
            <GlassInput className="w-40 py-1.5 font-mono text-xs" value={h.ip} onChange={(e) => set(i, { ip: e.target.value.trim() })} placeholder="192.168.1.10" aria-label="IP address" />
            <GlassButton size="xs" variant="ghost" onClick={() => setHosts((hs) => hs.filter((_, j) => j !== i))} aria-label={`Remove ${fqdnOf(h.name, domain.name)}`}>
              <Trash2 size={12} />
            </GlassButton>
          </div>
        ))}
        {hosts.length === 0 && <p className="text-[11px] text-slate-500">No host names yet. Use @ for the domain itself.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <GlassButton size="xs" onClick={() => setHosts((hs) => [...hs, { name: hs.length ? "" : "solardeck", ip: defaultIp }])}>
          <Plus size={12} /> Add host name
        </GlassButton>
        <GlassButton size="xs" variant="primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </GlassButton>
        <span className="text-[10px] text-slate-500">{dnsActive ? "Resolved by SolarDeck's DNS service on your network." : "Kept until the DNS service is installed and on."}</span>
      </div>
      <Notice {...msg} />
    </div>
  );
}

function CertificateCard({ state, reload }: { state: State; reload: () => void }) {
  const fqdns = useMemo(() => state.domains.flatMap((d) => d.hosts.map((h) => fqdnOf(h.name, d.name))), [state.domains]);
  const [fqdn, setFqdn] = useState("");
  const [provider, setProvider] = useState("cloudflare");
  const [plugin, setPlugin] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [other, setOther] = useState("");
  const [email, setEmail] = useState(state.certificate?.email ?? "");
  const [job, setJob] = useState<Job | null>(state.job);
  const [msg, setMsg] = useState({ error: "", notice: "" });
  const [revert, setRevert] = useState(false);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const p = PROVIDERS.find((x) => x.id === provider)!;
  const target = fqdn || fqdns.find((f) => f.startsWith("solardeck.")) || fqdns[0] || "";
  const running = job?.state === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api<Job>("/domains/certificate/job")
        .then((j) => {
          setJob(j);
          if (j.state !== "running") reload();
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [running, reload]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log.length]);

  const credentials = (): Record<string, string> => {
    if (provider !== "other") return Object.fromEntries(Object.entries(creds).filter(([k, v]) => v.trim() && p.fields.some((f) => f.key === k)));
    return Object.fromEntries(other.split("\n").map((l) => l.split(/=(.*)/s).map((x) => x.trim())).filter(([k, v]) => k && v));
  };
  const missing = provider === "other" ? !/^dns_[a-z0-9_]+$/.test(plugin) || Object.keys(credentials()).length === 0 : p.fields.some((f) => !f.optional && !creds[f.key]?.trim());

  const request = async () => {
    setMsg({ error: "", notice: "" });
    try {
      setJob(await api<Job>("/domains/certificate", { method: "POST", json: { fqdn: target, email, plugin: provider === "other" ? plugin : p.plugin, credentials: credentials() } }));
      setCreds({});
      setOther("");
    } catch (e) {
      setMsg({ error: (e as Error).message, notice: "" });
    }
  };
  const backToSelfSigned = async () => {
    setBusy(true);
    try {
      await api("/domains/certificate", { method: "DELETE" });
      setRevert(false);
      setMsg({ error: "", notice: "Back on the self-signed certificate; automatic renewal of the Let's Encrypt one is stopped." });
      reload();
    } catch (e) {
      setMsg({ error: (e as Error).message, notice: "" });
    } finally {
      setBusy(false);
    }
  };

  const https = state.https;
  return (
    <section className="glass-soft space-y-3 rounded-xl p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Lock size={15} /> HTTPS certificate for SolarDeck
      </h3>
      {https ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
          <GlassBadge tone={https.lets_encrypt ? "success" : https.self_signed ? "warning" : "info"}>{https.lets_encrypt ? "Let's Encrypt" : https.self_signed ? "Self-signed" : https.issuer}</GlassBadge>
          <span>{https.names.join(", ")}</span>
          <span className="text-slate-500">· valid until {new Date(https.expires * 1000).toLocaleDateString()}</span>
          {https.lets_encrypt && <span className="text-slate-500">· renews automatically</span>}
          {state.certificate && (
            <a className="inline-flex items-center gap-1 text-sky-300 hover:underline" href={`https://${state.certificate.fqdn}`} target="_blank" rel="noreferrer">
              Open https://{state.certificate.fqdn} <ExternalLink size={11} />
            </a>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-slate-400">No HTTPS certificate installed.</p>
      )}

      {fqdns.length === 0 ? (
        <p className="text-[11px] text-slate-400">Add a host name for SolarDeck above (for example solardeck → this server's IP) to request a Let's Encrypt certificate for it.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Host name">
            <GlassSelect className="w-full py-1.5 text-xs" value={target} onChange={(e) => setFqdn(e.target.value)}>
              {fqdns.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </GlassSelect>
          </Field>
          <Field label="DNS provider of the domain" hint="Let's Encrypt checks a temporary DNS record, so SolarDeck stays private.">
            <GlassSelect className="w-full py-1.5 text-xs" value={provider} onChange={(e) => (setProvider(e.target.value), setCreds({}))}>
              {PROVIDERS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </GlassSelect>
          </Field>
          {provider === "other" ? (
            <>
              <Field label="acme.sh DNS plugin" hint="For example dns_transip; see github.com/acmesh-official/acme.sh/wiki/dnsapi">
                <GlassInput className="w-full py-1.5 font-mono text-xs" value={plugin} onChange={(e) => setPlugin(e.target.value.trim())} placeholder="dns_xxx" />
              </Field>
              <Field label="Settings (one NAME=value per line)">
                <textarea className="glass-field h-16 w-full p-2 font-mono text-xs" value={other} onChange={(e) => setOther(e.target.value)} placeholder="PROVIDER_Token=…" spellCheck={false} autoComplete="off" />
              </Field>
            </>
          ) : (
            p.fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.optional ? " (optional)" : ""}`} hint={f.hint}>
                <GlassInput
                  type="password"
                  autoComplete="off"
                  className="w-full py-1.5 font-mono text-xs"
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                  aria-label={f.label}
                />
              </Field>
            ))
          )}
          <Field label="Email for Let's Encrypt" hint="Only used for expiry warnings from Let's Encrypt.">
            <GlassInput type="email" className="w-full py-1.5 text-xs" value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="you@example.com" />
          </Field>
          {p.help && <p className="text-[10px] text-slate-500 sm:col-span-2">{p.help}</p>}
          <p className="text-[10px] text-slate-500 sm:col-span-2">Credentials go straight to acme.sh inside the SolarDeck container and are stored only in its root-only settings file, for automatic renewals.</p>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <GlassButton variant="primary" disabled={running || missing || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)} onClick={request}>
              <ShieldCheck size={13} /> {running ? "Requesting…" : https?.lets_encrypt ? "Request again" : "Request certificate"}
            </GlassButton>
            {state.certificate && (
              <GlassButton variant="danger" onClick={() => setRevert(true)}>
                Back to self-signed
              </GlassButton>
            )}
          </div>
        </div>
      )}
      <Notice {...msg} />
      {job && (
        <div className="space-y-1">
          <p className={`text-[11px] ${job.state === "error" ? "text-rose-300" : job.state === "done" ? "text-emerald-300" : "text-sky-300"}`}>
            {job.fqdn}: {job.state === "error" ? job.error : job.step}
          </p>
          <pre ref={logRef} className="max-h-48 overflow-auto rounded-lg bg-black/50 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">
            {job.log.join("\n") || "…"}
          </pre>
        </div>
      )}
      <ConfirmModal
        open={revert}
        onClose={() => setRevert(false)}
        title="Back to the self-signed certificate"
        message="Stop renewing the Let's Encrypt certificate and switch SolarDeck back to its self-signed certificate? Browsers will warn again."
        confirmLabel="Switch back"
        busy={busy}
        onConfirm={backToSelfSigned}
      />
    </section>
  );
}

export default function DomainsTab({ onOpenDns }: { onOpenDns: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [del, setDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    api<State>("/domains")
      .then((s) => (setState(s), setError("")))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const add = async () => {
    setBusy(true);
    try {
      await api("/domains", { method: "POST", json: { name: name.trim().toLowerCase() } });
      setName("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await api(`/domains/${del}`, { method: "DELETE" });
      setDel(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <div className="p-1">{error ? <Notice error={error} /> : <p className="text-sm text-slate-400">Loading…</p>}</div>;
  const dnsActive = state.dns_service.installed && state.dns_service.enabled;
  return (
    <div className="space-y-4">
      <Notice error={error} />
      <section className="glass-soft space-y-3 rounded-xl p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Globe size={15} /> Your domains
        </h3>
        {!dnsActive && (
          <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200 ring-1 ring-amber-300/20 ring-inset">
            {state.dns_service.installed ? "The DNS service is installed but off." : "The DNS service is not installed yet."} Host names are kept and start resolving on your
            network as soon as it runs.{" "}
            <button type="button" className="underline hover:text-white" onClick={onOpenDns}>
              Open DNS &amp; AdBlock
            </button>
          </p>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <GlassInput className="w-64 py-1.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="example.com" aria-label="Domain name" />
          <GlassButton type="submit" variant="primary" disabled={busy || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(name.trim())}>
            <Plus size={13} /> Add domain
          </GlassButton>
        </form>
        {state.domains.length === 0 && <p className="text-[11px] text-slate-500">No domains yet.</p>}
        {state.domains.map((d) => (
          <div key={d.name} className="space-y-2 rounded-lg bg-black/20 p-3 ring-1 ring-white/10">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-mono text-sm text-white">{d.name}</span>
              <GlassButton size="xs" variant="ghost" onClick={() => setDel(d.name)} aria-label={`Remove ${d.name}`}>
                <Trash2 size={12} /> Remove
              </GlassButton>
            </div>
            <HostsEditor domain={d} dnsActive={dnsActive} onSaved={reload} />
          </div>
        ))}
      </section>
      <CertificateCard state={state} reload={reload} />
      <ConfirmModal
        open={!!del}
        onClose={() => setDel(null)}
        title="Remove domain"
        message={`Remove ${del} and its host names from SolarDeck? The domain itself and its public DNS are not touched.`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={remove}
      />
    </div>
  );
}
