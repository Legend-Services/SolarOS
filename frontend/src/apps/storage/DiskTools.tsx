import { useCallback, useEffect, useState } from "react";
import { Activity, BookOpen, OctagonX, ScanLine, Timer } from "lucide-react";
import { api } from "../../lib/api";
import type { DiskSettings, PveDisk, ScanStatus } from "../../lib/types";
import { usePoll, useRunner } from "../../lib/hooks";
import { useWizard } from "../../store/wizardStore";
import { Bar } from "../../components/charts";
import { Field, GlassBadge, GlassButton, GlassModal, GlassSelect, GlassSlider, GlassSwitch, Notice } from "../../components/ui/GlassKit";

export const diskUrl = (d: PveDisk) => `/v1/disks/${encodeURIComponent(d.devpath)}`;

export const eta = (s: number | null | undefined) => {
  if (s == null) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${Math.max(1, s)} s`;
};

/* ---------------- Disk settings (APM, spindown, write cache, NVMe power state, SMART) ---------------- */

const SPINDOWN = [0, 5, 10, 20, 30, 60, 120];
const spindownLabel = (m: number) => (m === 0 ? "Always active" : m < 60 ? `${m} min` : `${m / 60} h`);

function Unsupported({ reason }: { reason: string | null }) {
  return reason ? <p className="mt-1 text-[10px] text-slate-500">{reason}</p> : null;
}

export function DiskSettingsModal({ disk, onClose }: { disk: PveDisk | null; onClose: () => void }) {
  const [cfg, setCfg] = useState<DiskSettings | null>(null);
  const [form, setForm] = useState<DiskSettings["values"] | null>(null);
  const [persist, setPersist] = useState(true);
  const [loadError, setLoadError] = useState("");
  const { busy, error, notice, run } = useRunner();

  useEffect(() => {
    setCfg(null);
    setForm(null);
    setLoadError("");
    if (disk)
      api<DiskSettings>(`${diskUrl(disk)}/settings`).then(
        (c) => (setCfg(c), setForm(c.values)),
        (e) => setLoadError(e.message),
      );
  }, [disk]);

  const caps = cfg?.capabilities;
  const changed = cfg && form ? (Object.keys(form) as (keyof DiskSettings["values"])[]).filter((k) => form[k] !== cfg.values[k] && form[k] !== null) : [];
  const save = () =>
    run(async () => {
      const json = Object.fromEntries(changed.map((k) => [k, form![k]]));
      const c = await api<DiskSettings>(`${diskUrl(disk!)}/settings`, { method: "PUT", json: { ...json, persist } });
      setCfg(c);
      setForm(c.values);
    }, "Settings applied" + (persist && cfg?.persist_supported ? " and saved for the next boot." : "."));

  const apm = form?.apm_level;
  return (
    <GlassModal
      open={!!disk}
      onClose={onClose}
      title={
        <>
          Disk settings · <span className="font-mono">{disk?.devpath}</span>
        </>
      }
      footer={
        <>
          <GlassButton onClick={onClose}>Close</GlassButton>
          <GlassButton variant="primary" disabled={busy || !changed.length} onClick={save}>
            {busy ? "Applying…" : "Apply"}
          </GlassButton>
        </>
      }
    >
      {!cfg || !form || !caps ? (
        loadError ? <Notice error={loadError} /> : <p className="text-sm text-slate-400">Reading drive settings…</p>
      ) : (
        <div className="space-y-5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5 text-slate-400">
            {disk?.model} <GlassBadge tone="info">{cfg.bus}</GlassBadge>
            <GlassBadge>{cfg.rotational ? disk?.rpm_label : "Solid state"}</GlassBadge>
          </div>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-slate-200">Advanced Power Management (APM)</span>
              <GlassSwitch
                checked={apm === "disabled"}
                disabled={!caps.apm_level.supported}
                onChange={(v) => setForm({ ...form, apm_level: v ? "disabled" : 128 })}
                label="Disabled"
              />
            </div>
            <GlassSlider
              label="Level (1 = most power saving, 254 = best performance; 128+ never spins down)"
              min={1}
              max={254}
              value={typeof apm === "number" ? apm : 254}
              display={apm === "disabled" ? "Off" : (apm ?? "—")}
              disabled={!caps.apm_level.supported || apm === "disabled"}
              onChange={(v) => setForm({ ...form, apm_level: v })}
            />
            <Unsupported reason={caps.apm_level.reason} />
          </section>

          <section>
            <GlassSlider
              label="Standby / spindown timeout"
              min={0}
              max={SPINDOWN.length - 1}
              value={Math.max(0, SPINDOWN.indexOf(form.spindown_minutes ?? 0))}
              display={form.spindown_minutes == null ? "Not set" : spindownLabel(form.spindown_minutes)}
              disabled={!caps.spindown_minutes.supported}
              onChange={(i) => setForm({ ...form, spindown_minutes: SPINDOWN[i] })}
            />
            <Unsupported reason={caps.spindown_minutes.reason} />
            {caps.spindown_minutes.supported && <p className="mt-1 text-[10px] text-slate-500">Disks that spin down often wear faster. Avoid short timeouts on pool members.</p>}
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div>
              <GlassSwitch checked={!!form.write_cache} disabled={!caps.write_cache.supported} onChange={(v) => setForm({ ...form, write_cache: v })} label="Write cache" />
              <Unsupported reason={caps.write_cache.reason} />
            </div>
            <div>
              <GlassSwitch checked={!!form.smart_enabled} disabled={!caps.smart_enabled.supported} onChange={(v) => setForm({ ...form, smart_enabled: v })} label="SMART monitoring" />
              <Unsupported reason={caps.smart_enabled.reason} />
            </div>
          </section>

          <section>
            <Field label="NVMe power state" hint={caps.power_state.supported && !cfg.nvme_cli_installed ? "nvme-cli is installed on the host the first time you apply a power state." : undefined}>
              <GlassSelect
                className="w-full"
                value={form.power_state ?? ""}
                disabled={!caps.power_state.supported}
                onChange={(e) => setForm({ ...form, power_state: Number(e.target.value) })}
              >
                {form.power_state == null && <option value="">{caps.power_state.supported ? "Unknown (install nvme-cli to read)" : "Not available"}</option>}
                {cfg.power_states.map((p) => (
                  <option key={p.id} value={p.id}>
                    PS{p.id} · max {p.max_power_w} W{p.operational ? "" : " · idle only"}
                  </option>
                ))}
              </GlassSelect>
            </Field>
            <Unsupported reason={caps.power_state.reason} />
          </section>

          <div className="border-t border-white/10 pt-3">
            <GlassSwitch checked={persist && cfg.persist_supported} disabled={!cfg.persist_supported} onChange={setPersist} label="Re-apply these settings after every reboot" />
            <p className="mt-1 text-[10px] text-slate-500">
              {cfg.persist_supported ? (
                <>
                  Saved in <span className="font-mono">/etc/udev/rules.d/69-proxmoxos-disk-tuning.rules</span>, keyed by <span className="font-mono">{cfg.by_id}</span>.
                </>
              ) : (
                "This drive has no stable /dev/disk/by-id name, so settings apply until the next reboot only."
              )}
            </p>
          </div>
          <Notice error={error} notice={notice} />
        </div>
      )}
    </GlassModal>
  );
}

/* ---------------- SMART self-tests & read-only surface scan ---------------- */

export function ScanModal({ disk, onClose }: { disk: PveDisk | null; onClose: () => void }) {
  const [st, setSt] = useState<ScanStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(() => {
    if (disk) api<ScanStatus>(`${diskUrl(disk)}/scan`).then((s) => (setSt(s), setLoadError("")), (e) => setLoadError(e.message));
  }, [disk]);
  useEffect(() => setSt(null), [disk]);
  usePoll(load, disk ? 3000 : 3_600_000);
  const { busy, error, notice, run } = useRunner(load);
  const start = (kind: "short" | "long" | "surface", label: string) =>
    run(() => api(`${diskUrl(disk!)}/scan`, { method: "POST", json: { kind } }), `${label} started. You can close this window; it keeps running on the server.`);
  const running = !!st && (st.smart.running || st.surface.running);
  const showGuide = useWizard((s) => s.show);

  return (
    <GlassModal
      open={!!disk}
      onClose={onClose}
      side
      width="max-w-xl"
      title={
        <>
          SMART & surface scan · <span className="font-mono">{disk?.devpath}</span>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ["short", "SMART Short Test", "~2 min. Quick electrical and mechanical check."],
              ["long", "SMART Extended Test", "Reads the whole disk inside the drive. Minutes on SSDs, hours on large HDDs."],
              ["surface", "Read-Only Surface Scan", "badblocks reads every sector from the host. Never writes."],
            ] as const
          ).map(([kind, label, desc]) => (
            <button
              key={kind}
              type="button"
              disabled={busy || running || !st}
              onClick={() => start(kind, label)}
              className="glass-soft rounded-xl p-3 text-left transition hover:bg-white/[0.08] active:scale-[0.98] disabled:opacity-40"
            >
              <span className="mb-1 flex items-center gap-1.5 font-medium text-slate-100">
                {kind === "surface" ? <ScanLine size={13} /> : kind === "short" ? <Timer size={13} /> : <Activity size={13} />} {label}
              </span>
              <span className="text-[10px] text-slate-400">{desc}</span>
            </button>
          ))}
        </div>
        <GlassButton size="xs" variant="ghost" onClick={() => showGuide("storage-disk-tests")}>
          <BookOpen size={12} /> Short test, extended test or surface scan: which one?
        </GlassButton>
        <Notice error={error || loadError} notice={notice} />
        {!st && !loadError && <p className="text-slate-400">Reading drive status…</p>}

        {st?.smart.running && (
          <div className="glass-soft space-y-2 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium text-slate-100">{st.smart.test ?? "SMART self-test"} running</span>
              <span className="text-slate-400">{st.smart.progress_pct ?? 0}%{st.smart.eta_seconds != null && ` · about ${eta(st.smart.eta_seconds)} left`}</span>
            </div>
            <Bar value={st.smart.progress_pct ?? 0} />
          </div>
        )}
        {st?.surface.running && (
          <div className="glass-soft space-y-2 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-medium text-slate-100">Surface scan running</span>
              <span className="text-slate-400">
                {(st.surface.progress_pct ?? 0).toFixed(1)}%{st.surface.eta_seconds != null && ` · about ${eta(st.surface.eta_seconds)} left`}
              </span>
            </div>
            <Bar value={st.surface.progress_pct ?? 0} />
            <p className={st.surface.errors ? "text-rose-300" : "text-slate-400"}>
              {st.surface.errors} read error(s) so far · elapsed {st.surface.elapsed ?? "0:00"}
            </p>
          </div>
        )}
        {running && (
          <GlassButton variant="danger" disabled={busy} onClick={() => run(() => api(`${diskUrl(disk!)}/scan`, { method: "DELETE" }), "Aborted.")}>
            <OctagonX size={13} /> Abort
          </GlassButton>
        )}
        {st && !st.surface.running && st.surface.exit_code != null && (
          <p className={`rounded-lg px-3 py-2 ${st.surface.bad_blocks ? "bg-rose-500/10 text-rose-300" : "bg-emerald-500/10 text-emerald-200"}`}>
            Last surface scan {st.surface.exit_code === 0 ? "finished" : "stopped"}: {st.surface.bad_blocks} bad block(s) found.
            {st.surface.bad_blocks > 0 && " Back up this disk and plan to replace it."}
          </p>
        )}

        {st && (
          <div>
            <h4 className="mb-1.5 font-medium text-slate-200">SMART self-test history</h4>
            {st.smart.history.length === 0 ? (
              <p className="text-slate-500">No self-tests recorded on this drive yet.</p>
            ) : (
              <table className="w-full text-left text-[11px]">
                <thead className="text-slate-400">
                  <tr>
                    <th className="py-1 font-medium">Test</th>
                    <th className="px-2 font-medium">Result</th>
                    <th className="px-2 text-right font-medium">At power-on hour</th>
                    <th className="px-2 text-right font-medium">First failing LBA</th>
                  </tr>
                </thead>
                <tbody>
                  {st.smart.history.map((h, i) => (
                    <tr key={i} className="border-t border-white/5">
                      <td className="py-1 text-slate-200">{h.type}</td>
                      <td className={`px-2 ${h.passed ? "text-emerald-300" : /progress|abort|interrupt/i.test(h.status) ? "text-amber-300" : "text-rose-300"}`}>{h.status}</td>
                      <td className="px-2 text-right tabular-nums text-slate-300">{h.lifetime_hours?.toLocaleString() ?? "—"}</td>
                      <td className="px-2 text-right font-mono text-slate-400">{h.failing_lba ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </GlassModal>
  );
}
