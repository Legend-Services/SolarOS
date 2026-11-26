import { useEffect, useState } from "react";
import { Lock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useRunner } from "../../../lib/hooks";
import { useTranslation, type TKey } from "../../../i18n";
import { Card } from "../../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "../../../components/ui/GlassKit";
import { area, list, type Ctx, type Host, type HostBody } from "./shared";

interface Upstream {
  kind: "app" | "vm" | "container";
  name: string;
  host: string | null;
}

const BLANK: HostBody = {
  domain_names: [],
  upstream_scheme: "http",
  upstream_host: "",
  upstream_port: 80,
  websocket_support: true,
  http2_enabled: true,
  force_ssl: true,
  hsts_enabled: false,
  client_max_body_size: "512m",
  rate_limit_rpm: null,
  solardeck_sso_auth: false,
  access_list_id: null,
  certificate_id: null,
  custom_nginx_config: "",
  enabled: true,
};

export default function HostsTab(ctx: Ctx) {
  const { d, call, run, busy, ask } = ctx;
  const { t } = useTranslation();
  const [edit, setEdit] = useState<Host | "new" | null>(null);
  const name = (items: { id: string; name: string }[], id: string | null) => items.find((x) => x.id === id)?.name ?? "?";
  return (
    <div data-anchor="rp-hosts">
      <Card
        title={t("rp.hosts.title")}
        action={
          <>
            <span className="text-[11px] text-slate-500">
              {d.ov.applied ? t("rp.applied", { time: new Date(d.ov.applied * 1000).toLocaleString() }) : t("rp.neverApplied")}
            </span>
            <GlassButton size="xs" disabled={busy} onClick={() => run(() => call("/proxy/apply"))}>
              <RefreshCw size={12} />
              {t("rp.apply")}
            </GlassButton>
            <GlassButton size="xs" variant="primary" onClick={() => setEdit("new")}>
              <Plus size={12} />
              {t("rp.hosts.add")}
            </GlassButton>
          </>
        }
      >
        {d.hosts.length === 0 ? (
          <p className="text-xs text-slate-500">{t("rp.hosts.empty")}</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1.5">{t("rp.hosts.domains")}</th>
                  <th className="px-2">{t("rp.hosts.upstream")}</th>
                  <th className="px-2">{t("rp.hosts.cert")}</th>
                  <th className="px-2 max-md:hidden">{t("rp.hosts.features")}</th>
                  <th className="px-2">{t("rp.enabled")}</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {d.hosts.map((h) => (
                  <tr key={h.id} className="border-t border-white/5">
                    <td className="py-1.5 font-mono text-slate-100">{h.domain_names.join(", ")}</td>
                    <td className="px-2 font-mono text-slate-300">{`${h.upstream_scheme}://${h.upstream_host}:${h.upstream_port}`}</td>
                    <td className="px-2">
                      {h.certificate_id ? (
                        <GlassBadge tone="success">
                          <Lock size={10} />
                          {name(d.certs, h.certificate_id)}
                        </GlassBadge>
                      ) : (
                        <GlassBadge>{t("rp.hosts.noCert")}</GlassBadge>
                      )}
                    </td>
                    <td className="px-2 max-md:hidden">
                      <div className="flex flex-wrap gap-1">
                        {h.solardeck_sso_auth && <GlassBadge tone="info">{t("rp.badge.gate")}</GlassBadge>}
                        {h.access_list_id && <GlassBadge tone="warning">{name(d.acls, h.access_list_id)}</GlassBadge>}
                        {h.rate_limit_rpm != null && <GlassBadge>{t("rp.badge.rate", { n: h.rate_limit_rpm })}</GlassBadge>}
                        {h.websocket_support && <GlassBadge>{t("rp.badge.ws")}</GlassBadge>}
                      </div>
                    </td>
                    <td className="px-2">
                      <GlassSwitch checked={h.enabled} disabled={busy} onChange={(v) => run(() => call(`/proxy/hosts/${h.id}`, "PUT", { ...h, enabled: v }))} />
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <GlassButton size="xs" variant="ghost" onClick={() => setEdit(h)} aria-label={t("rp.edit")} title={t("rp.edit")}>
                        <Pencil size={12} />
                      </GlassButton>
                      <GlassButton
                        size="xs"
                        variant="ghost"
                        aria-label={t("rp.delete")}
                        title={t("rp.delete")}
                        onClick={() => ask(t("rp.hosts.deleteTitle"), t("rp.hosts.deleteMsg", { name: h.domain_names[0] }), () => call(`/proxy/hosts/${h.id}`, "DELETE"))}
                      >
                        <Trash2 size={12} />
                      </GlassButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit && <HostModal ctx={ctx} host={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function HostModal({ ctx: { d, call }, host, onClose }: { ctx: Ctx; host: Host | "new"; onClose: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<HostBody>(host === "new" ? BLANK : host);
  const [domains, setDomains] = useState(f.domain_names.join("\n"));
  const [ups, setUps] = useState<Upstream[]>([]);
  const [pick, setPick] = useState("");
  const m = useRunner();
  useEffect(() => void api<Upstream[]>("/proxy/upstreams").then(setUps, () => undefined), []);
  const set = (p: Partial<HostBody>) => setF((x) => ({ ...x, ...p }));
  const save = () =>
    m
      .run(() => call(host === "new" ? "/proxy/hosts" : `/proxy/hosts/${host.id}`, host === "new" ? "POST" : "PUT", { ...f, domain_names: list(domains) }))
      .then((ok) => ok && onClose());
  const picked = ups[Number(pick)];
  const sw = (k: "websocket_support" | "http2_enabled" | "force_ssl" | "hsts_enabled" | "solardeck_sso_auth" | "enabled", label: TKey) => (
    <GlassSwitch checked={f[k]} onChange={(v) => set({ [k]: v })} label={t(label)} />
  );

  return (
    <GlassModal
      open
      onClose={onClose}
      width="max-w-2xl"
      title={host === "new" ? t("rp.hosts.add") : t("rp.hosts.edit")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("rp.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={m.busy || !list(domains).length || !f.upstream_host} onClick={save}>
            {t("rp.save")}
          </GlassButton>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("rp.hosts.domains")} hint={t("rp.listHint")} className="sm:col-span-2">
          <textarea className={area} rows={2} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="app.example.com" spellCheck={false} />
        </Field>
        <Field label={t("rp.hosts.pick")} hint={picked && !picked.host ? t("rp.hosts.typeIp") : undefined} className="sm:col-span-2">
          <GlassSelect
            className="w-full"
            value={pick}
            onChange={(e) => {
              setPick(e.target.value);
              const u = ups[Number(e.target.value)];
              if (e.target.value && u) set({ upstream_host: u.host ?? "" });
            }}
          >
            <option value="">{t("rp.hosts.custom")}</option>
            {ups.map((u, i) => (
              <option key={i} value={i}>
                {`${u.name} (${t(`rp.kind.${u.kind}` as TKey)})${u.host ? ` · ${u.host}` : ""}`}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <div className="flex gap-2 sm:col-span-2">
          <Field label={t("rp.hosts.scheme")}>
            <GlassSelect value={f.upstream_scheme} onChange={(e) => set({ upstream_scheme: e.target.value as HostBody["upstream_scheme"] })}>
              <option value="http">http</option>
              <option value="https">https</option>
            </GlassSelect>
          </Field>
          <Field label={t("rp.upstreamHost")} className="flex-1">
            <GlassInput className="w-full font-mono" value={f.upstream_host} onChange={(e) => set({ upstream_host: e.target.value.trim() })} placeholder="192.168.1.50" />
          </Field>
          <Field label={t("rp.port")}>
            <GlassInput className="w-24" type="number" min={1} max={65535} value={f.upstream_port} onChange={(e) => set({ upstream_port: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label={t("rp.hosts.cert")}>
          <GlassSelect className="w-full" value={f.certificate_id ?? ""} onChange={(e) => set({ certificate_id: e.target.value || null })}>
            <option value="">{t("rp.hosts.noCert")}</option>
            {d.certs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <Field label={t("rp.hosts.acl")}>
          <GlassSelect className="w-full" value={f.access_list_id ?? ""} onChange={(e) => set({ access_list_id: e.target.value || null })}>
            <option value="">{t("rp.none")}</option>
            {d.acls.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <Field label={t("rp.hosts.bodySize")} hint={t("rp.hosts.bodySizeHint")}>
          <GlassInput className="w-full font-mono" value={f.client_max_body_size} onChange={(e) => set({ client_max_body_size: e.target.value.trim() })} />
        </Field>
        <Field label={t("rp.hosts.rate")} hint={t("rp.hosts.rateHint")}>
          <GlassInput
            className="w-full"
            type="number"
            min={1}
            value={f.rate_limit_rpm ?? ""}
            onChange={(e) => set({ rate_limit_rpm: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
          {sw("websocket_support", "rp.hosts.ws")}
          {sw("http2_enabled", "rp.hosts.http2")}
          {sw("force_ssl", "rp.hosts.forceSsl")}
          {sw("hsts_enabled", "rp.hosts.hsts")}
          {sw("solardeck_sso_auth", "rp.hosts.gate")}
          {sw("enabled", "rp.enabled")}
        </div>
        <Field label={t("rp.hosts.advanced")} hint={t("rp.hosts.advancedHint")} className="sm:col-span-2">
          <textarea
            className={area}
            rows={3}
            maxLength={4000}
            value={f.custom_nginx_config}
            onChange={(e) => set({ custom_nginx_config: e.target.value })}
            placeholder="proxy_read_timeout 300s;"
            spellCheck={false}
          />
        </Field>
      </div>
      <div className="mt-3">
        <Notice error={m.error} />
      </div>
    </GlassModal>
  );
}
