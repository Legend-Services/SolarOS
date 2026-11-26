import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { Card } from "../../ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassInput, GlassSelect } from "../../../components/ui/GlassKit";
import type { Ctx, Stream } from "./shared";

const BLANK = { protocol: "tcp" as Stream["protocol"], listen_port: "", upstream_host: "", upstream_port: "", comment: "" };

export default function StreamsTab({ d, call, run, busy, ask }: Ctx) {
  const { t } = useTranslation();
  const [f, setF] = useState(BLANK);
  const add = () =>
    run(async () => {
      await call("/proxy/streams", "POST", { ...f, listen_port: Number(f.listen_port), upstream_port: Number(f.upstream_port) });
      setF(BLANK);
    });
  return (
    <div data-anchor="rp-streams">
      <Card title={t("rp.streams.title")}>
        <p className="mb-3 text-[11px] text-slate-400">{t("rp.streams.hint")}</p>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <Field label={t("rp.streams.protocol")}>
            <GlassSelect value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value as Stream["protocol"] })}>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="both">TCP + UDP</option>
            </GlassSelect>
          </Field>
          <Field label={t("rp.streams.listen")}>
            <GlassInput className="w-24" type="number" min={1} max={65535} value={f.listen_port} onChange={(e) => setF({ ...f, listen_port: e.target.value })} />
          </Field>
          <Field label={t("rp.upstreamHost")} className="min-w-40 flex-1">
            <GlassInput className="w-full font-mono" value={f.upstream_host} onChange={(e) => setF({ ...f, upstream_host: e.target.value.trim() })} placeholder="192.168.1.50" />
          </Field>
          <Field label={t("rp.port")}>
            <GlassInput className="w-24" type="number" min={1} max={65535} value={f.upstream_port} onChange={(e) => setF({ ...f, upstream_port: e.target.value })} />
          </Field>
          <Field label={t("rp.streams.comment")} className="min-w-32 flex-1">
            <GlassInput className="w-full" maxLength={60} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
          </Field>
          <GlassButton variant="primary" disabled={busy || !f.listen_port || !f.upstream_host || !f.upstream_port} onClick={add}>
            <Plus size={12} />
            {t("rp.add")}
          </GlassButton>
        </div>
        {d.streams.length === 0 ? (
          <p className="text-xs text-slate-500">{t("rp.streams.empty")}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1.5">{t("rp.streams.protocol")}</th>
                <th className="px-2">{t("rp.streams.listen")}</th>
                <th className="px-2">{t("rp.hosts.upstream")}</th>
                <th className="px-2 max-md:hidden">{t("rp.streams.comment")}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {d.streams.map((s) => (
                <tr key={s.id} className="border-t border-white/5">
                  <td className="py-1.5">
                    <GlassBadge>{s.protocol === "both" ? "TCP + UDP" : s.protocol.toUpperCase()}</GlassBadge>
                  </td>
                  <td className="px-2 font-mono text-slate-100">{s.listen_port}</td>
                  <td className="px-2 font-mono text-slate-300">{`${s.upstream_host}:${s.upstream_port}`}</td>
                  <td className="px-2 text-slate-400 max-md:hidden">{s.comment}</td>
                  <td className="text-right">
                    <GlassButton
                      size="xs"
                      variant="ghost"
                      aria-label={t("rp.delete")}
                      title={t("rp.delete")}
                      onClick={() => ask(t("rp.streams.deleteTitle"), t("rp.streams.deleteMsg", { port: s.listen_port }), () => call(`/proxy/streams/${s.id}`, "DELETE"))}
                    >
                      <Trash2 size={12} />
                    </GlassButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
