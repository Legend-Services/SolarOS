import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CreditCard, Cpu, Dices, Gauge, HardDrive, Mic, Music, Network, Phone, Plus, Server, ShieldCheck, Timer, Webcam } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import type { Guest } from "../../lib/types";
import { useTranslation, type TKey } from "../../i18n";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassInput, GlassModal, GlassSelect, GlassSlider, Notice, Segmented } from "../ui/GlassKit";

/* Shapes of /api/virtual-hardware (backend/app/virtual_hardware.py). */
interface OptionSpec {
  key: string;
  kind: "select" | "text" | "number";
  choices?: string[];
  default: string | number;
  min?: number;
  max?: number;
  when?: [string, string];
}
interface CatalogDevice {
  type: string;
  category: "audio" | "video" | "storage" | "legacy" | "security";
  bus: string;
  guest_types: ("vm" | "lxc")[];
  hotplug: boolean;
  single?: boolean;
  options: OptionSpec[];
}
interface Catalog {
  devices: CatalogDevice[];
  cpu_models: string[];
}
interface Device {
  id: string;
  type: string;
  options: Record<string, string | number>;
  bus: string;
  category: string;
  hotplug: boolean;
}
interface NicShape {
  preset: string;
  rate_kbps: number | null;
  latency_ms: number;
  jitter_ms: number;
  packet_loss_pct: number;
}
interface Throttling {
  cpu_limit_percent: number;
  cpu_model: string | null;
  nics: Record<string, NicShape>;
}
interface GuestHw {
  running: boolean;
  devices: Device[];
  throttling: Throttling;
  nics: { net_id: string; model: string; bridge: string }[];
}

const ICONS: Record<string, ReactNode> = {
  hd_audio: <Mic size={16} />,
  legacy_audio: <Music size={16} />,
  virtual_camera: <Webcam size={16} />,
  sas_hba: <Server size={16} />,
  virtual_nvme: <HardDrive size={16} />,
  hayes_modem: <Phone size={16} />,
  legacy_nic: <Network size={16} />,
  vtpm: <ShieldCheck size={16} />,
  smartcard: <CreditCard size={16} />,
  watchdog: <Timer size={16} />,
  virtio_rng: <Dices size={16} />,
};
const CATEGORIES = ["audio", "video", "storage", "legacy", "security"] as const;
const PRESETS = ["native", "100mbps", "10mbps", "56k", "4g", "custom"] as const;
const RATES = [56, 128, 256, 512, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 1000000];
const fmtRate = (k: number) => (k >= 1000 ? `${k / 1000} Mbps` : `${k} kbps`);
const NATIVE: NicShape = { preset: "native", rate_kbps: null, latency_ms: 0, jitter_ms: 0, packet_loss_pct: 0 };

const shown = (o: OptionSpec, v: Record<string, string | number>) => !o.when || v[o.when[0]] === o.when[1];
const defaults = (d: CatalogDevice) => Object.fromEntries(d.options.map((o) => [o.key, o.default])) as Record<string, string | number>;

/* ---------------- Add / configure modal ---------------- */

function DeviceModal({
  open,
  onClose,
  catalog,
  guestType,
  taken,
  initial,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  catalog: CatalogDevice[];
  guestType: "vm" | "lxc";
  taken: string[];
  initial: Device | null;
  onSubmit: (type: string, options: Record<string, string | number>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState<CatalogDevice | null>(null);
  const [vals, setVals] = useState<Record<string, string | number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const d = initial ? catalog.find((c) => c.type === initial.type) ?? null : null;
    setPick(d);
    setVals(d && initial ? { ...defaults(d), ...initial.options } : {});
  }, [open, initial, catalog]);
  const choose = (d: CatalogDevice) => (setPick(d), setVals(defaults(d)));
  const submit = async () => {
    if (!pick) return;
    setBusy(true);
    const opts = Object.fromEntries(pick.options.filter((o) => shown(o, vals)).map((o) => [o.key, vals[o.key]]));
    if (await onSubmit(pick.type, opts)) onClose();
    setBusy(false);
  };
  const usable = (d: CatalogDevice) => d.guest_types.includes(guestType) && !(d.single && taken.includes(d.type) && !initial);

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      width="max-w-3xl"
      title={initial ? t("vhw.configureTitle") : t("vhw.addTitle")}
      footer={
        <>
          {pick && !initial && (
            <GlassButton onClick={() => setPick(null)} className="mr-auto">
              {t("vhw.back")}
            </GlassButton>
          )}
          <GlassButton onClick={onClose}>{t("common.cancel")}</GlassButton>
          <GlassButton variant="primary" disabled={!pick || busy} onClick={submit}>
            {initial ? t("common.save") : t("vhw.attach")}
          </GlassButton>
        </>
      }
    >
      {!pick ? (
        <div className="space-y-4">
          {CATEGORIES.map((cat) => {
            const items = catalog.filter((d) => d.category === cat);
            return (
              <section key={cat}>
                <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-300 uppercase">{t(`vhw.cat.${cat}` as TKey)}</h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  {items.map((d) => {
                    const ok = usable(d);
                    return (
                      <button
                        key={d.type}
                        type="button"
                        disabled={!ok}
                        onClick={() => choose(d)}
                        className="glass-soft flex gap-3 rounded-xl p-3 text-left ring-1 ring-white/10 transition ring-inset hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-sky-200">{ICONS[d.type]}</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-white">{t(`vhw.dev.${d.type}` as TKey)}</span>
                          <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{t(`vhw.desc.${d.type}` as TKey)}</span>
                          <span className="mt-1.5 flex flex-wrap gap-1">
                            <GlassBadge>{d.bus}</GlassBadge>
                            {!d.guest_types.includes(guestType) && (
                              <GlassBadge tone="warning">{t(guestType === "vm" ? "vhw.containersOnly" : "vhw.vmsOnly")}</GlassBadge>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-sky-200">{ICONS[pick.type]}</span>
            <div>
              <div className="text-sm font-semibold text-white">{t(`vhw.dev.${pick.type}` as TKey)}</div>
              <div className="text-[11px] text-slate-400">{t(`vhw.desc.${pick.type}` as TKey)}</div>
            </div>
          </div>
          {pick.options.filter((o) => shown(o, vals)).length === 0 && <p className="text-xs text-slate-400">{t("vhw.noOptions")}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {pick.options
              .filter((o) => shown(o, vals))
              .map((o) => (
                <Field key={o.key} label={t(`vhw.opt.${o.key}` as TKey)}>
                  {o.kind === "select" ? (
                    <GlassSelect className="w-full" value={String(vals[o.key])} onChange={(e) => setVals({ ...vals, [o.key]: e.target.value })}>
                      {o.choices!.map((c) => (
                        <option key={c} value={c}>
                          {o.key === "source" || o.key === "action" ? t(`vhw.choice.${c}` as TKey) : c.toUpperCase().replace("_", " ")}
                        </option>
                      ))}
                    </GlassSelect>
                  ) : (
                    <GlassInput
                      className="w-full"
                      type={o.kind === "number" ? "number" : "text"}
                      min={o.min}
                      max={o.max}
                      value={vals[o.key] ?? ""}
                      placeholder={t(`vhw.ph.${o.key}` as TKey)}
                      onChange={(e) => setVals({ ...vals, [o.key]: o.kind === "number" ? Number(e.target.value) : e.target.value })}
                    />
                  )}
                </Field>
              ))}
          </div>
          {!pick.hotplug && guestType === "vm" && <p className="text-[11px] text-amber-300/90">{t("vhw.coldplugHint")}</p>}
        </div>
      )}
    </GlassModal>
  );
}

/* ---------------- Throttling ---------------- */

function ThrottlingCard({ guest, hw, cpuModels, reload }: { guest: Guest; hw: GuestHw; cpuModels: string[]; reload: () => void }) {
  const { t } = useTranslation();
  const vm = guest.type === "qemu";
  const [cpu, setCpu] = useState(hw.throttling.cpu_limit_percent);
  const [model, setModel] = useState(hw.throttling.cpu_model ?? "");
  const [nics, setNics] = useState<Record<string, NicShape>>(hw.throttling.nics);
  const { busy, error, notice, run } = useRunner(reload);
  const nic = (id: string) => nics[id] ?? NATIVE;
  const setNic = (id: string, v: Partial<NicShape>) => setNics({ ...nics, [id]: { ...nic(id), ...v } });
  const save = () =>
    run(async () => {
      const r = await api<{ waiting_for_start: string[]; restart_required: boolean }>(`/virtual-hardware/${vm ? "vm" : "lxc"}/${guest.vmid}/throttling`, {
        method: "PUT",
        json: { cpu_limit_percent: cpu, cpu_model: vm && model ? model : null, nics },
      });
      if (r.restart_required) throw new Error(t("vhw.cpuModelRestart"));
    }, t("vhw.throttleSaved"));

  return (
    <section className="glass-soft space-y-4 rounded-xl p-3">
      <div className="flex items-center gap-2">
        <Gauge size={14} className="text-sky-300" />
        <h4 className="flex-1 text-xs font-semibold text-slate-200">{t("vhw.throttleTitle")}</h4>
        <GlassButton variant="primary" size="xs" disabled={busy} onClick={save}>
          {t("common.save")}
        </GlassButton>
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-slate-300">
          <Cpu size={13} /> {t("vhw.cpuTitle")}
        </div>
        <GlassSlider label={t("vhw.cpuLimit")} value={cpu} min={5} max={100} step={5} unit="%" onChange={setCpu} />
        {vm && (
          <Field label={t("vhw.cpuModel")} hint={t("vhw.cpuModelHint")}>
            <Segmented
              value={model}
              onChange={setModel}
              options={[{ id: "", label: t("vhw.cpu.keep") }, ...cpuModels.map((m) => ({ id: m, label: t(`vhw.cpu.${m}` as TKey) }))]}
            />
          </Field>
        )}
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-slate-300">
          <Network size={13} /> {t("vhw.netTitle")}
        </div>
        {hw.nics.length === 0 && <p className="text-xs text-slate-500">{t("vhw.noNics")}</p>}
        {hw.nics.map((n) => {
          const s = nic(n.net_id);
          return (
            <div key={n.net_id} className="space-y-2 rounded-lg bg-white/5 p-2.5 ring-1 ring-white/10 ring-inset">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                <span className="font-mono text-white">{n.net_id}</span>
                <span className="text-slate-500">
                  {n.model} · {n.bridge || "—"}
                </span>
              </div>
              <Segmented
                value={s.preset}
                onChange={(p) => setNic(n.net_id, p === "custom" ? { preset: p, rate_kbps: s.rate_kbps ?? 10000 } : { preset: p })}
                options={PRESETS.map((p) => ({ id: p, label: t(`vhw.preset.${p}` as TKey) }))}
              />
              {s.preset === "custom" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <GlassSlider
                    label={t("vhw.bandwidth")}
                    value={Math.max(0, RATES.findIndex((r) => r >= (s.rate_kbps ?? 10000)))}
                    min={0}
                    max={RATES.length - 1}
                    display={fmtRate(s.rate_kbps ?? 10000)}
                    onChange={(i) => setNic(n.net_id, { rate_kbps: RATES[i] })}
                  />
                  <GlassSlider label={t("vhw.latency")} value={s.latency_ms} min={0} max={1000} step={5} unit=" ms" onChange={(v) => setNic(n.net_id, { latency_ms: v })} />
                  <GlassSlider label={t("vhw.jitter")} value={s.jitter_ms} min={0} max={200} unit=" ms" onChange={(v) => setNic(n.net_id, { jitter_ms: v })} />
                  <GlassSlider label={t("vhw.loss")} value={s.packet_loss_pct} min={0} max={20} step={0.5} unit="%" onChange={(v) => setNic(n.net_id, { packet_loss_pct: v })} />
                </div>
              )}
            </div>
          );
        })}
        <p className="text-[10px] text-slate-500">{t("vhw.netHint")}</p>
      </div>
      <Notice error={error} notice={notice} />
    </section>
  );
}

/* ---------------- Panel ---------------- */

export default function VirtualHardwarePanel({ guest }: { guest: Guest }) {
  const { t } = useTranslation();
  const gt = guest.type === "qemu" ? "vm" : "lxc";
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [hw, setHw] = useState<GuestHw | null>(null);
  const [modal, setModal] = useState<"add" | Device | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [loadError, setLoadError] = useState("");
  const [noticeText, setNoticeText] = useState("");
  const load = useCallback(() => {
    api<GuestHw>(`/virtual-hardware/${gt}/${guest.vmid}`).then((h) => (setHw(h), setLoadError("")), (e) => setLoadError(e.message));
  }, [gt, guest.vmid]);
  useEffect(() => {
    api<Catalog>("/virtual-hardware/catalog").then(setCatalog, (e) => setLoadError(e.message));
    load();
  }, [load]);
  const { busy, error, notice, run } = useRunner(load);
  const byType = useMemo(() => Object.fromEntries((catalog?.devices ?? []).map((d) => [d.type, d])), [catalog]);

  const restartNote = (r: { restart_required?: boolean }) => (r.restart_required ? ` ${t("vhw.restartNote")}` : "");
  const add = (type: string, options: Record<string, string | number>) =>
    run(async () => {
      // Configure = replace: the old device goes, the new one takes its place.
      if (modal && modal !== "add") await api(`/virtual-hardware/${gt}/${guest.vmid}/devices/${modal.id}`, { method: "DELETE" });
      const r = await api<{ restart_required: boolean }>(`/virtual-hardware/${gt}/${guest.vmid}/devices`, { method: "POST", json: { type, options } });
      setNoticeText(t("vhw.attached", { name: t(`vhw.dev.${type}` as TKey) }) + restartNote(r));
    });
  const remove = (d: Device) =>
    run(async () => {
      const r = await api<{ restart_required: boolean }>(`/virtual-hardware/${gt}/${guest.vmid}/devices/${d.id}`, { method: "DELETE" });
      setNoticeText(t("vhw.removed", { name: t(`vhw.dev.${d.type}` as TKey) }) + restartNote(r));
      setRemoving(null);
    });

  if (loadError && !hw) return <Notice error={loadError} />;
  if (!hw || !catalog) return <p className="text-sm text-slate-400">{t("common.loading")}</p>;
  const summary = (d: Device) =>
    Object.entries(d.options)
      .filter(([, v]) => v !== "" && v !== null)
      .map(([k, v]) => `${t(`vhw.opt.${k}` as TKey)}: ${k === "source" || k === "action" ? t(`vhw.choice.${v}` as TKey) : v}`)
      .join(" · ");

  return (
    <div className="space-y-3">
      <section className="glass-soft rounded-xl p-3">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="flex-1 text-xs font-semibold text-slate-200">{t("vhw.attachedTitle")}</h4>
          <GlassButton variant="primary" size="xs" onClick={() => (setNoticeText(""), setModal("add"))}>
            <Plus size={12} /> {t("vhw.add")}
          </GlassButton>
        </div>
        {hw.devices.length === 0 ? (
          <p className="text-xs text-slate-500">{t("vhw.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {hw.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 rounded-lg bg-white/5 px-2.5 py-2 ring-1 ring-white/10 ring-inset">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-sky-200">{ICONS[d.type]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${hw.running ? "bg-emerald-400" : "bg-slate-500"}`} title={hw.running ? t("vhw.statusActive") : t("vhw.statusIdle")} />
                    <span className="text-sm font-medium text-white">{t(`vhw.dev.${d.type}` as TKey)}</span>
                    <GlassBadge>{d.bus}</GlassBadge>
                    <GlassBadge tone="success">{t("vhw.universalDriver")}</GlassBadge>
                    {!d.hotplug && guest.type === "qemu" && <GlassBadge tone="warning">{t("vhw.powerCycle")}</GlassBadge>}
                  </div>
                  {summary(d) && <div className="mt-0.5 truncate text-[11px] text-slate-400">{summary(d)}</div>}
                </div>
                {byType[d.type]?.options.length > 0 && d.type !== "virtual_nvme" && (
                  <GlassButton size="xs" disabled={busy} onClick={() => (setNoticeText(""), setModal(d))}>
                    {t("vhw.configure")}
                  </GlassButton>
                )}
                <GlassButton size="xs" variant="danger" disabled={busy} onClick={() => setRemoving(d)}>
                  {t("vhw.remove")}
                </GlassButton>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2">
          <Notice error={error} notice={noticeText || notice} />
        </div>
      </section>
      <ThrottlingCard key={`${guest.vmid}-${JSON.stringify(hw.throttling)}`} guest={guest} hw={hw} cpuModels={catalog.cpu_models} reload={load} />
      <DeviceModal
        open={!!modal}
        onClose={() => setModal(null)}
        catalog={catalog.devices}
        guestType={gt}
        taken={hw.devices.map((d) => d.type)}
        initial={modal && modal !== "add" ? modal : null}
        onSubmit={add}
      />
      <ConfirmModal
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
        busy={busy}
        error={error}
        title={t("vhw.removeTitle")}
        confirmLabel={t("vhw.remove")}
        message={removing ? t(removing.type === "virtual_nvme" ? "vhw.removeNvme" : "vhw.removeMsg", { name: t(`vhw.dev.${removing.type}` as TKey) }) : ""}
      />
    </div>
  );
}
