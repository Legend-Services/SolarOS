import { useCallback, useEffect, useState } from "react";
import { Copy, Download, Plus, Trash2, Wand2 } from "lucide-react";
import { api } from "../../lib/api";
import type { Guest } from "../../lib/types";
import { useRunner } from "../../lib/hooks";
import { useTelemetry } from "../../lib/stores";
import { useTranslation } from "../../i18n";
import { Card } from "../../apps/ControlPanelApp";
import { Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSwitch, Notice } from "../ui/GlassKit";
import { TaskLog } from "../TaskCenter";
import ZeroTouchWizard from "./ZeroTouchWizard";

interface CatalogImage {
  id: string;
  name: string;
  category: string;
  kind: string;
  description: string;
  pattern?: string;
  save_as?: string;
}
interface Template {
  vmid: number;
  name: string;
  notes: string;
}
const CATEGORIES = ["server", "desktop", "firewall", "drivers", "cloud"] as const;

/** Compute > Templates & Images: curated, checksum-verified images, Zero-Touch provisioning and golden templates. */
export default function ImageHubPanel() {
  const { t } = useTranslation();
  const targets = useTelemetry((s) => s.storage?.targets ?? []);
  const stores = targets.filter((x) => x.active && x.content.split(",").includes("iso")).map((x) => x.storage);
  const [images, setImages] = useState<CatalogImage[] | null>(null);
  const [store, setStore] = useState("");
  const [task, setTask] = useState<{ upid: string; filename: string } | null>(null);
  const [zt, setZt] = useState<string | null>(null);
  const { busy, error, notice, run } = useRunner();
  useEffect(() => void run(() => api<{ images: CatalogImage[] }>("/images/catalog").then((r) => setImages(r.images))), [run]);
  useEffect(() => {
    if (!stores.includes(store)) setStore(stores[0] ?? "");
  }, [stores.join(","), store]); // eslint-disable-line react-hooks/exhaustive-deps
  const download = (img: CatalogImage) =>
    run(async () => {
      const r = await api<{ task: string; filename: string }>("/images/download", { method: "POST", json: { image_id: img.id, storage: store } });
      setTask({ upid: r.task, filename: r.filename });
    });

  return (
    <div className="space-y-4">
      <Card
        title={t("ih.catalog")}
        action={
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            {t("ih.downloadTo")}
            <GlassSelect value={store} onChange={(e) => setStore(e.target.value)}>
              {!stores.length && <option value="">{t("ih.noStorage")}</option>}
              {stores.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </GlassSelect>
          </label>
        }
      >
        <div data-anchor="ih-catalog" className="space-y-4">
          <p className="text-[11px] text-slate-400">{t("ih.catalogHint")}</p>
          <Notice error={error} notice={notice} />
          {task && (
            <div>
              <p className="mb-1 text-[11px] text-slate-400">{t("ih.downloading", { name: task.filename })}</p>
              <TaskLog key={task.upid} upid={task.upid} className="h-28" />
            </div>
          )}
          {!images && <p className="text-xs text-slate-400">{t("common.loading")}</p>}
          {CATEGORIES.map((cat) => {
            const list = images?.filter((i) => i.category === cat) ?? [];
            return (
              list.length > 0 && (
                <section key={cat}>
                  <h4 className="mb-2 text-xs font-semibold text-slate-200">{t(`ih.cat.${cat}`)}</h4>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {list.map((img) => (
                      <div key={img.id} className="glass-field flex flex-col gap-2 rounded-xl p-3">
                        <div className="text-xs font-medium text-slate-100">{img.name}</div>
                        <p className="flex-1 text-[11px] text-slate-400">{img.description}</p>
                        <div className="flex flex-wrap gap-1.5">
                          <GlassButton size="xs" disabled={busy || !store} onClick={() => download(img)}>
                            <Download size={12} /> {t("ih.download")}
                          </GlassButton>
                          {img.kind === "cloud" && (
                            <GlassButton size="xs" variant="primary" onClick={() => setZt(img.save_as ?? img.pattern ?? "")}>
                              <Wand2 size={12} /> {t("zt.create")}
                            </GlassButton>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            );
          })}
        </div>
      </Card>
      <Templates />
      <ZeroTouchWizard open={zt !== null} imageMatch={zt ?? undefined} onClose={() => setZt(null)} />
    </div>
  );
}

function Templates() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ templates: Template[]; clone_supported: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [clone, setClone] = useState<Template | null>(null);
  const load = useCallback(() => api<{ templates: Template[]; clone_supported: boolean }>("/compute/templates").then(setData), []);
  const { busy, error, notice, run } = useRunner();
  useEffect(() => void run(load), [run, load]);

  return (
    <Card
      title={t("ih.templates")}
      action={
        <GlassButton size="xs" onClick={() => setSaving(true)}>
          <Plus size={12} /> {t("ih.saveAsTemplate")}
        </GlassButton>
      }
    >
      <div data-anchor="ih-templates" className="space-y-2">
        <Notice error={error} notice={notice} />
        {data?.templates.length === 0 && <p className="text-xs text-slate-400">{t("ih.noTemplates")}</p>}
        {data?.templates.map((x) => (
          <div key={x.vmid} className="glass-field flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs">
            <GlassBadge>{x.vmid}</GlassBadge>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-slate-100">{x.name}</div>
              {x.notes && <div className="truncate text-[11px] text-slate-500">{x.notes}</div>}
            </div>
            {data.clone_supported && (
              <GlassButton size="xs" onClick={() => setClone(x)}>
                <Copy size={12} /> {t("ih.clone")}
              </GlassButton>
            )}
            <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => run(() => api(`/compute/templates/${x.vmid}`, { method: "DELETE" }).then(load), t("ih.forgotten"))} title={t("ih.forgetHint")}>
              <Trash2 size={12} /> {t("ih.forget")}
            </GlassButton>
          </div>
        ))}
        {data && !data.clone_supported && <p className="text-[11px] text-slate-500">{t("ih.noClone")}</p>}
      </div>
      <SaveTemplateModal open={saving} onClose={() => setSaving(false)} onSaved={load} />
      <CloneModal template={clone} onClose={() => setClone(null)} />
    </Card>
  );
}

function SaveTemplateModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [vms, setVms] = useState<Guest[]>([]);
  const [vmid, setVmid] = useState(0);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const { busy, error, run } = useRunner(onSaved);
  useEffect(() => {
    if (!open) return;
    setName("");
    setNotes("");
    api<Guest[]>("/v1/guests").then((g) => {
      const q = g.filter((x) => x.type === "qemu");
      setVms(q);
      setVmid(q[0]?.vmid ?? 0);
    }, () => setVms([]));
  }, [open]);
  const vm = vms.find((x) => x.vmid === vmid);
  const save = () => run(() => api("/compute/templates", { method: "POST", json: { vmid, name, notes } }).then(onClose));
  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={t("ih.saveAsTemplate")}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !vmid || !name || vm?.status === "running"} onClick={save}>
            {t("common.save")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">{t("ih.templateWarn")}</p>
        <Field label={t("ih.vm")} hint={vm?.status === "running" ? t("ih.vmRunning") : undefined}>
          <GlassSelect className="w-full" value={vmid} onChange={(e) => setVmid(Number(e.target.value))}>
            {vms.map((x) => (
              <option key={x.vmid} value={x.vmid}>
                {x.vmid} · {x.name} ({x.status})
              </option>
            ))}
          </GlassSelect>
        </Field>
        <Field label={t("ih.name")}>
          <GlassInput className="w-full" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("ih.notes")}>
          <GlassInput className="w-full" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Notice error={error} />
      </div>
    </GlassModal>
  );
}

function CloneModal({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [vmid, setVmid] = useState(0);
  const [name, setName] = useState("");
  const [full, setFull] = useState(true);
  const { busy, error, notice, run } = useRunner();
  useEffect(() => {
    if (!template) return;
    setName("");
    setFull(true);
    api<{ vmid: number }>("/v1/nextid").then((r) => setVmid(r.vmid), () => {});
  }, [template]);
  const go = () => template && run(() => api(`/compute/templates/${template.vmid}/clone`, { method: "POST", json: { new_vmid: vmid, name, full } }), t("ih.cloned", { vmid }));
  return (
    <GlassModal
      open={!!template}
      onClose={onClose}
      title={t("ih.cloneTitle", { name: template?.name ?? "" })}
      footer={
        <>
          <GlassButton onClick={onClose}>{t("common.close")}</GlassButton>
          <GlassButton variant="primary" disabled={busy || !vmid || !name} onClick={go}>
            <Copy size={13} /> {t("ih.clone")}
          </GlassButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
          <Field label={t("zt.vmid")}>
            <GlassInput className="w-full" type="number" min={100} value={vmid} onChange={(e) => setVmid(Number(e.target.value))} />
          </Field>
          <Field label={t("zt.name")}>
            <GlassInput className="w-full" placeholder="web-01" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <GlassSwitch checked={full} onChange={setFull} label={t("ih.fullClone")} />
        <Notice error={error} notice={notice} />
      </div>
    </GlassModal>
  );
}
