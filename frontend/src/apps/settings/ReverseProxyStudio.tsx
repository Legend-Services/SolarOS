import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { useTranslation, type TKey } from "../../i18n";
import { ConfirmModal, Notice, Segmented } from "../../components/ui/GlassKit";
import type { Acl, AcmeJob, Call, Cert, Ctx, Data, Host, Overview, Stream } from "./proxy/shared";
import HostsTab from "./proxy/HostsTab";
import CertsTab from "./proxy/CertsTab";
import StreamsTab from "./proxy/StreamsTab";
import AccessTab from "./proxy/AccessTab";
import { OsiDisclosure } from "../../components/osi/OsiArchitecturePanel";
import { osiValues } from "../../data/osiModelRegistry";

const TABS = ["hosts", "certs", "streams", "access"] as const;
type Tab = (typeof TABS)[number];

/** Settings > Network & Services > Reverse Proxy & SSL: proxy hosts, certificates & private root CA, streams, access lists. */
export default function ReverseProxyStudio({ initialTab }: { initialTab?: string }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(TABS.find((x) => x === initialTab) ?? "hosts");
  const [d, setD] = useState<Data | null>(null);
  const [fail, setFail] = useState("");
  const [confirm, setConfirm] = useState<{ title: string; message: ReactNode; fn: () => Promise<unknown> } | null>(null);
  const { busy, error, run } = useRunner();

  const load = useCallback(async () => {
    const [ov, hosts, c, acls, streams] = await Promise.all([
      api<Overview>("/proxy"),
      api<Host[]>("/proxy/hosts"),
      api<{ certificates: Cert[]; acme_job: AcmeJob | null }>("/proxy/certificates"),
      api<Acl[]>("/proxy/access-lists"),
      api<Stream[]>("/proxy/streams"),
    ]);
    setD({ ov, hosts, certs: c.certificates, acmeJob: c.acme_job, acls, streams });
  }, []);
  useEffect(() => void run(load), [run, load]);

  const call: Call = async (path, method = "POST", json) => {
    const r = await api<{ ok?: boolean; error?: string }>(path, { method, json });
    setFail(r.ok === false ? r.error || "?" : "");
    await load().catch(() => undefined);
    return r;
  };
  const ask: Ctx["ask"] = (title, message, fn) => setConfirm({ title, message, fn });

  const ctx = d && { d, call, reload: load, run, busy, ask };
  return (
    <div className="space-y-3">
      <Segmented value={tab} onChange={setTab} options={TABS.map((id) => ({ id, label: t(`rp.tab.${id}` as TKey) }))} />
      <OsiDisclosure kind="reverse_proxy" name={t(`rp.tab.${tab}` as TKey)} values={osiValues({ ports: ["TCP 80", "TCP 443", ...(d?.streams ?? []).map((s) => `${s.protocol.toUpperCase()} ${s.listen_port}`)], tls: "TLS 1.3", app: (d?.hosts ?? []).flatMap((h) => h.domain_names).slice(0, 6) })} />
      {fail && <Notice error={t("rp.notApplied", { error: fail })} />}
      <Notice error={error} />
      {!ctx ? (
        <p className="text-xs text-slate-500">{t("rp.loading")}</p>
      ) : tab === "hosts" ? (
        <HostsTab {...ctx} />
      ) : tab === "certs" ? (
        <CertsTab {...ctx} />
      ) : tab === "streams" ? (
        <StreamsTab {...ctx} />
      ) : (
        <AccessTab {...ctx} />
      )}
      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && run(confirm.fn).then(() => setConfirm(null))}
        title={confirm?.title ?? ""}
        message={confirm?.message}
        confirmLabel={t("rp.delete")}
        busy={busy}
      />
    </div>
  );
}
