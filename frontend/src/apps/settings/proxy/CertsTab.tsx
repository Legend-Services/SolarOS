import { useEffect, useState } from "react";
import { Download, FileUp, Plus, Trash2, X } from "lucide-react";
import { api } from "../../../lib/api";
import { useRunner } from "../../../lib/hooks";
import { useTranslation, type TKey } from "../../../i18n";
import { Card } from "../../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice, Segmented } from "../../../components/ui/GlassKit";
import { area, day, daysLeft, linkBtn, list, type AcmeJob, type Ctx } from "./shared";

const Expiry = ({ ts }: { ts: number }) => {
  const { t } = useTranslation();
  const n = daysLeft(ts);
  return <GlassBadge tone={n < 0 ? "danger" : n < 30 ? "warning" : "neutral"}>{n < 0 ? t("rp.cert.expired") : t("rp.cert.expires", { date: day(ts), n })}</GlassBadge>;
};

export default function CertsTab(ctx: Ctx) {
  const { d, call, ask } = ctx;
  const { t } = useTranslation();
  const [modal, setModal] = useState<"self" | "upload" | null>(null);
  return (
    <div className="space-y-3">
      <RootCa {...ctx} />
      <div data-anchor="rp-certs">
        <Card
          title={t("rp.cert.title")}
          action={
            <>
              <GlassButton size="xs" variant="primary" onClick={() => setModal("self")}>
                <Plus size={12} />
                {t("rp.self.title")}
              </GlassButton>
              <GlassButton size="xs" onClick={() => setModal("upload")}>
                <FileUp size={12} />
                {t("rp.upload.title")}
              </GlassButton>
            </>
          }
        >
          {d.certs.length === 0 ? (
            <p className="text-xs text-slate-500">{t("rp.cert.empty")}</p>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1.5">{t("rp.name")}</th>
                    <th className="px-2">{t("rp.hosts.domains")}</th>
                    <th className="px-2">{t("rp.cert.source")}</th>
                    <th className="px-2 max-md:hidden">{t("rp.cert.issuer")}</th>
                    <th className="px-2">{t("rp.cert.expiry")}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {d.certs.map((c) => (
                    <tr key={c.id} className="border-t border-white/5">
                      <td className="py-1.5 text-slate-100">{c.name}</td>
                      <td className="px-2 font-mono text-slate-300">{c.domains.join(", ")}</td>
                      <td className="px-2">
                        <GlassBadge tone={c.source === "acme" ? "success" : c.source === "upload" ? "info" : "neutral"}>{t(`rp.source.${c.source}` as TKey)}</GlassBadge>
                      </td>
                      <td className="px-2 text-slate-400 max-md:hidden">{c.issuer}</td>
                      <td className="px-2">
                        <Expiry ts={c.expires} />
                      </td>
                      <td className="text-right">
                        <GlassButton
                          size="xs"
                          variant="ghost"
                          aria-label={t("rp.delete")}
                          title={t("rp.delete")}
                          onClick={() => ask(t("rp.cert.deleteTitle"), t("rp.cert.deleteMsg", { name: c.name }), () => call(`/proxy/certificates/${c.id}`, "DELETE"))}
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
      </div>
      <Acme {...ctx} />
      {modal === "self" && <SelfSigned ctx={ctx} onClose={() => setModal(null)} />}
      {modal === "upload" && <Upload ctx={ctx} onClose={() => setModal(null)} />}
    </div>
  );
}

function RootCa({ d, call, run, busy, ask }: Ctx) {
  const { t } = useTranslation();
  const ca = d.ov.root_ca;
  const [f, setF] = useState({ common_name: "SolarDeck Private Root CA", key_type: "ecdsa-p384", valid_years: 10 });
  return (
    <div data-anchor="rp-root-ca">
      <Card title={t("rp.ca.title")}>
        <p className="mb-3 text-[11px] text-slate-400">{t("rp.ca.intro")}</p>
        {ca ? (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex-1">
              <div className="font-medium text-slate-100">{ca.name}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {ca.key_type && <GlassBadge>{ca.key_type}</GlassBadge>}
                <Expiry ts={ca.expires} />
              </div>
            </div>
            <a href="/api/proxy/certificates/root-ca/download" download className={linkBtn}>
              <Download size={12} />
              {t("rp.ca.download")}
            </a>
            <GlassButton size="xs" variant="ghost" onClick={() => ask(t("rp.ca.deleteTitle"), t("rp.ca.deleteMsg"), () => call("/proxy/certificates/root-ca", "DELETE"))}>
              <Trash2 size={12} />
              {t("rp.delete")}
            </GlassButton>
            <p className="w-full text-[11px] text-slate-500">{t("rp.ca.install")}</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t("rp.ca.cn")} className="min-w-48 flex-1">
              <GlassInput className="w-full" maxLength={64} value={f.common_name} onChange={(e) => setF({ ...f, common_name: e.target.value })} />
            </Field>
            <Field label={t("rp.ca.keyType")}>
              <GlassSelect value={f.key_type} onChange={(e) => setF({ ...f, key_type: e.target.value })}>
                <option value="ecdsa-p384">ECDSA P-384</option>
                <option value="rsa-4096">RSA 4096</option>
              </GlassSelect>
            </Field>
            <Field label={t("rp.ca.years")}>
              <GlassInput className="w-20" type="number" min={1} max={25} value={f.valid_years} onChange={(e) => setF({ ...f, valid_years: Number(e.target.value) })} />
            </Field>
            <GlassButton variant="primary" disabled={busy || !f.common_name.trim()} onClick={() => run(() => call("/proxy/certificates/root-ca", "POST", f))}>
              {t("rp.ca.create")}
            </GlassButton>
          </div>
        )}
      </Card>
    </div>
  );
}

function SelfSigned({ ctx: { call }, onClose }: { ctx: Ctx; onClose: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: "", domains: "", ips: "", valid_days: 397 });
  const m = useRunner();
  const save = () =>
    m
      .run(() => call("/proxy/certificates/self-signed", "POST", { name: f.name, domains: list(f.domains), ip_addresses: list(f.ips), valid_days: f.valid_days }))
      .then((ok) => ok && onClose());
  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("rp.self.title")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("rp.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={m.busy || !list(f.domains).length} onClick={save}>
            {t("rp.self.issue")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[11px] text-slate-400">{t("rp.self.intro")}</p>
        <Field label={t("rp.nameOptional")}>
          <GlassInput className="w-full" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t("rp.hosts.domains")} hint={t("rp.self.domainsHint")}>
          <textarea className={area} rows={2} value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="*.solardeck.local" spellCheck={false} />
        </Field>
        <Field label={t("rp.self.ips")} hint={t("rp.listHint")}>
          <GlassInput className="w-full font-mono" value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} placeholder="192.168.1.10" />
        </Field>
        <Field label={t("rp.self.days")}>
          <GlassInput className="w-24" type="number" min={1} max={3650} value={f.valid_days} onChange={(e) => setF({ ...f, valid_days: Number(e.target.value) })} />
        </Field>
        <Notice error={m.error} />
      </div>
    </GlassModal>
  );
}

function Upload({ ctx: { call }, onClose }: { ctx: Ctx; onClose: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: "", certificate: "", private_key: "", chain: "" });
  const m = useRunner();
  const pem = (k: "certificate" | "private_key" | "chain", label: TKey) => (
    <Field label={t(label)}>
      <textarea className={area} rows={4} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder="-----BEGIN ..." spellCheck={false} />
    </Field>
  );
  return (
    <GlassModal
      open
      onClose={onClose}
      title={t("rp.upload.title")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("rp.cancel")}</GlassButton>
          <GlassButton
            variant="primary"
            disabled={m.busy || !f.certificate.trim() || !f.private_key.trim()}
            onClick={() => m.run(() => call("/proxy/certificates/upload", "POST", f)).then((ok) => ok && onClose())}
          >
            {t("rp.upload.submit")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t("rp.nameOptional")}>
          <GlassInput className="w-full" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        {pem("certificate", "rp.upload.cert")}
        {pem("private_key", "rp.upload.key")}
        {pem("chain", "rp.upload.chain")}
        <Notice error={m.error} />
      </div>
    </GlassModal>
  );
}

function Acme({ d, call, reload, run, busy }: Ctx) {
  const { t } = useTranslation();
  const [f, setF] = useState({ domains: "", email: d.ov.settings.acme_email, challenge: "http-01" as "http-01" | "dns-01", dns_plugin: "", staging: false });
  const [creds, setCreds] = useState<[string, string][]>([["", ""]]);
  const [job, setJob] = useState<AcmeJob | null>(d.acmeJob);
  const dns = f.challenge === "dns-01";

  useEffect(() => {
    if (job?.state !== "running") return;
    const id = setTimeout(
      () =>
        api<AcmeJob>("/proxy/certificates/acme/job").then(
          (j) => {
            setJob(j);
            if (j.state !== "running") void reload().catch(() => undefined);
          },
          () => setJob({ ...job }), // transient error: try again in 2 s
        ),
      2000,
    );
    return () => clearTimeout(id);
  }, [job, reload]);

  const request = () =>
    run(async () => {
      const body = {
        domains: list(f.domains),
        email: f.email.trim(),
        challenge: f.challenge,
        staging: f.staging,
        dns_plugin: dns ? f.dns_plugin.trim() : null,
        credentials: dns ? Object.fromEntries(creds.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) : {},
      };
      setJob((await call("/proxy/certificates/acme", "POST", body)) as AcmeJob);
    });

  const setCred = (i: number, j: 0 | 1, v: string) => setCreds(creds.map((r, n) => (n === i ? (j ? [r[0], v] : [v, r[1]]) : r)));
  return (
    <div data-anchor="rp-acme">
      <Card title={t("rp.acme.title")}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("rp.hosts.domains")} hint={t("rp.listHint")}>
            <GlassInput className="w-full font-mono" value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} placeholder="app.example.com" />
          </Field>
          <Field label={t("rp.acme.email")}>
            <GlassInput className="w-full" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Segmented
              value={f.challenge}
              onChange={(challenge) => setF({ ...f, challenge })}
              options={[
                { id: "http-01", label: t("rp.acme.http") },
                { id: "dns-01", label: t("rp.acme.dns") },
              ]}
            />
            <GlassSwitch checked={f.staging} onChange={(staging) => setF({ ...f, staging })} label={t("rp.acme.staging")} />
          </div>
          <p className="text-[11px] text-slate-500 sm:col-span-2">{dns ? t("rp.acme.dnsHint") : t("rp.acme.httpHint")}</p>
          {dns && (
            <>
              <Field label={t("rp.acme.plugin")} hint={t("rp.acme.pluginHint")}>
                <GlassInput className="w-full font-mono" value={f.dns_plugin} onChange={(e) => setF({ ...f, dns_plugin: e.target.value })} placeholder="dns_cf" />
              </Field>
              <div className="space-y-1.5 sm:col-span-2">
                <span className="text-[11px] text-slate-400">{t("rp.acme.creds")}</span>
                {creds.map(([k, v], i) => (
                  <div key={i} className="flex gap-2">
                    <GlassInput className="flex-1 font-mono" value={k} onChange={(e) => setCred(i, 0, e.target.value)} placeholder="CF_Token" aria-label={t("rp.acme.key")} />
                    <GlassInput className="flex-1" type="password" value={v} onChange={(e) => setCred(i, 1, e.target.value)} aria-label={t("rp.acme.value")} autoComplete="off" />
                    <GlassButton size="xs" variant="ghost" onClick={() => setCreds(creds.filter((_, n) => n !== i))} aria-label={t("rp.remove")}>
                      <X size={12} />
                    </GlassButton>
                  </div>
                ))}
                {creds.length < 6 && (
                  <GlassButton size="xs" variant="ghost" onClick={() => setCreds([...creds, ["", ""]])}>
                    <Plus size={12} />
                    {t("rp.acme.addCred")}
                  </GlassButton>
                )}
              </div>
            </>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <GlassButton variant="primary" disabled={busy || job?.state === "running" || !list(f.domains).length || !f.email.trim() || (dns && !f.dns_plugin.trim())} onClick={request}>
            {t("rp.acme.request")}
          </GlassButton>
          {job && (
            <GlassBadge tone={job.state === "done" ? "success" : job.state === "error" ? "danger" : "info"}>
              {`${t(`rp.acme.state.${job.state}` as TKey)} · ${job.domains.join(", ")}`}
            </GlassBadge>
          )}
        </div>
        {job?.error && <div className="mt-2"><Notice error={job.error} /></div>}
        {job && job.log.length > 0 && (
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-300">{job.log.slice(-60).join("\n")}</pre>
        )}
      </Card>
    </div>
  );
}

