import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Gauge, Play, ShieldCheck, Square } from "lucide-react";
import { api } from "../../lib/api";
import type { BenchJob, BenchMetric, BenchProfile, PveDisk, ZfsDatasetInfo } from "../../lib/types";
import { usePoll, useRunner } from "../../lib/hooks";
import { useWizard } from "../../store/wizardStore";
import { Bar } from "../../components/charts";
import { ConfirmModal, Field, GlassBadge, GlassButton, GlassSelect, Notice, Segmented } from "../../components/ui/GlassKit";

const PROFILES: { id: BenchProfile; label: string; hint: string }[] = [
  { id: "SEQ1M_Q8T1", label: "SEQ1M Q8T1", hint: "Sequential 1 MiB, queue depth 8: large file copies" },
  { id: "SEQ128K_Q32T1", label: "SEQ128K Q32T1", hint: "Sequential 128 KiB, queue depth 32: streaming, backups" },
  { id: "RND4K_Q32T1", label: "RND4K Q32T1", hint: "Random 4 KiB, queue depth 32: busy VMs and databases" },
  { id: "RND4K_Q1T1", label: "RND4K Q1T1", hint: "Random 4 KiB, queue depth 1: how snappy a single VM feels" },
];
type Unit = "mbps" | "iops" | "lat_us";
const UNIT_LABEL: Record<Unit, string> = { mbps: "MB/s", iops: "IOPS", lat_us: "Latency µs" };

const fmt = (m: BenchMetric | null | undefined, u: Unit) => {
  if (!m) return "—";
  const v = m[u];
  return u === "iops" ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Lower latency is better: for latency, `max` is the best (lowest) value and its bar is the fullest. */
function Cell({ m, unit, max, active }: { m: BenchMetric | null | undefined; unit: Unit; max: number; active: boolean }) {
  const v = m ? m[unit] : 0;
  const width = !m || !max || !v ? 0 : unit === "lat_us" ? (100 * max) / v : (100 * v) / max;
  return (
    <div className={`glass-soft relative overflow-hidden rounded-xl px-3 py-2.5 ${active ? "ring-1 ring-sky-300/50" : ""}`}>
      <div
        className="absolute inset-y-0 left-0 bg-gradient-to-r from-sky-500/25 to-emerald-400/25 transition-[width] duration-700"
        style={{ width: `${width}%`, transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)" }}
      />
      <div className={`relative text-right font-mono text-xl font-semibold tabular-nums ${m ? "text-white" : "text-slate-600"} ${active ? "animate-pulse" : ""}`}>{fmt(m, unit)}</div>
    </div>
  );
}

export default function Benchmark({ disks }: { disks: PveDisk[] | null }) {
  const [mounts, setMounts] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [size, setSize] = useState(1024);
  const [passes, setPasses] = useState(1);
  const [mode, setMode] = useState<"readonly" | "readwrite">("readonly");
  const [unit, setUnit] = useState<Unit>("mbps");
  const [job, setJob] = useState<BenchJob | null>(null);
  const [history, setHistory] = useState<BenchJob[]>([]);
  const [confirmRaw, setConfirmRaw] = useState<BenchProfile[] | null>(null);
  const { busy, error, run, setError } = useRunner();
  const showGuide = useWizard((s) => s.show);

  const loadHistory = useCallback(() => {
    api<BenchJob[]>("/pve/disks/benchmark/history").then((h) => setHistory([...h].reverse()), () => {});
  }, []);
  useEffect(() => {
    loadHistory();
    api<ZfsDatasetInfo[]>("/pve/zfs/datasets").then(
      (d) => setMounts(d.filter((x) => x.type === "filesystem" && !x.guest_volume && x.mountpoint.startsWith("/")).map((x) => x.mountpoint)),
      () => {},
    );
  }, [loadHistory]);

  const targets = useMemo(
    () => [
      ...(disks ?? []).map((d) => ({ id: `disk:${d.devpath}`, label: `${d.model || d.devpath} · ${d.devpath}${d.pool_name ? ` · ${d.pool_name}` : ""}`, disk: d })),
      ...[...new Set(["/", "/var/lib/vz", ...mounts])].map((m) => ({ id: `mountpoint:${m}`, label: m === "/" ? "/ (host system)" : m, disk: null })),
    ],
    [disks, mounts],
  );
  const chosen = targets.find((t) => t.id === target) ?? targets[0];
  const [targetType, targetPath] = chosen ? [chosen.id.split(":")[0] as "disk" | "mountpoint", chosen.id.slice(chosen.id.indexOf(":") + 1)] : ["disk" as const, ""];
  const rawInUse = !!chosen?.disk && (!!chosen.disk.used || !!chosen.disk.pool_name);
  const running = job?.status === "running";

  const poll = useCallback(() => {
    if (job?.status === "running")
      api<BenchJob>(`/pve/disks/benchmark/${job.id}`).then((j) => {
        setJob(j);
        if (j.status !== "running") loadHistory();
      }, () => {});
  }, [job, loadHistory]);
  usePoll(poll, 1000);

  const start = (profiles: BenchProfile[], confirmed = false) => {
    if (mode === "readwrite" && targetType === "disk" && !confirmed) return setConfirmRaw(profiles);
    setConfirmRaw(null);
    return run(async () =>
      setJob(
        await api<BenchJob>("/pve/disks/benchmark", {
          method: "POST",
          json: {
            target_type: targetType,
            target: targetPath,
            mode,
            test_size_mb: size,
            passes,
            profiles,
            ...(confirmed && { confirm_device: targetPath }),
          },
        }),
      ),
    );
  };

  const maxOf = (rw: "read" | "write") => {
    const vals = (job?.steps ?? []).map((s) => s[rw]?.[unit] ?? 0).filter(Boolean);
    return unit === "lat_us" ? Math.min(...vals, Infinity) : Math.max(0, ...vals);
  };
  const [maxR, maxW] = [maxOf("read"), maxOf("write")];
  const stepOf = (p: BenchProfile) => job?.steps.find((s) => s.profile === p);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Gauge size={16} className="text-sky-300" />
        <h3 className="mr-auto text-sm font-semibold text-slate-100">Storage benchmark</h3>
        <GlassButton size="xs" variant="ghost" onClick={() => showGuide("storage-benchmark")}>
          <BookOpen size={12} /> How do I read the results?
        </GlassButton>
        <Segmented value={unit} onChange={setUnit} options={(Object.keys(UNIT_LABEL) as Unit[]).map((u) => ({ id: u, label: UNIT_LABEL[u] }))} />
      </div>

      <div className="glass-soft flex flex-wrap items-end gap-2 rounded-2xl p-3">
        <Field label="Target drive or pool / dataset" className="min-w-[220px] flex-1">
          <GlassSelect className="w-full" value={chosen?.id ?? ""} disabled={running} onChange={(e) => setTarget(e.target.value)}>
            <optgroup label="Physical drives">
              {targets.filter((t) => t.disk).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Pools, datasets & folders">
              {targets.filter((t) => !t.disk).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          </GlassSelect>
        </Field>
        <Field label="Test size">
          <GlassSelect value={size} disabled={running} onChange={(e) => setSize(Number(e.target.value))}>
            <option value={256}>256 MiB</option>
            <option value={1024}>1 GiB</option>
            <option value={4096}>4 GiB</option>
          </GlassSelect>
        </Field>
        <Field label="Passes">
          <GlassSelect value={passes} disabled={running} onChange={(e) => setPasses(Number(e.target.value))}>
            {[1, 3, 5].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </GlassSelect>
        </Field>
        <Field label="Mode">
          <Segmented
            value={mode}
            onChange={(m) => (setMode(m), setError(""))}
            options={[
              { id: "readonly", label: <span className="inline-flex items-center gap-1"><ShieldCheck size={12} /> Safe Read-Only</span> },
              { id: "readwrite", label: "Read + Write" },
            ]}
          />
        </Field>
        {running ? (
          <GlassButton variant="danger" size="md" onClick={() => run(async () => setJob(await api<BenchJob>(`/pve/disks/benchmark/${job!.id}`, { method: "DELETE" })))}>
            <Square size={14} /> Stop
          </GlassButton>
        ) : (
          <GlassButton
            variant="primary"
            size="md"
            disabled={busy || !chosen || (mode === "readwrite" && rawInUse)}
            onClick={() => start(PROFILES.map((p) => p.id))}
          >
            <Play size={14} /> Start All
          </GlassButton>
        )}
      </div>

      {mode === "readwrite" && (
        <p className={`text-[11px] ${rawInUse ? "text-amber-300" : "text-slate-400"}`}>
          {targetType === "mountpoint"
            ? "Writes a temporary .solardeck-bench.tmp file in this folder and deletes it when the run ends. Your files are not touched."
            : rawInUse
              ? `${targetPath} is in use (${chosen?.disk?.pool_name ? `ZFS pool ${chosen.disk.pool_name}` : chosen?.disk?.used}). Raw write tests would destroy it, so only Safe Read-Only is allowed. To test writes, pick the pool's mountpoint instead.`
              : `Write tests on a raw disk overwrite its first ${size} MiB. Only use this on an empty disk.`}
        </p>
      )}
      <Notice error={error || (job?.status === "error" ? (job.error ?? "Benchmark failed") : undefined)} />

      {running && job && (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>
              {job.phase ?? "Starting"}
              {job.passes > 1 && job.pass ? ` · pass ${job.pass}/${job.passes}` : ""}
            </span>
            <span>
              {job.done_steps}/{job.total_steps} tests
            </span>
          </div>
          <Bar value={((job.done_steps ?? 0) / (job.total_steps || 1)) * 100} />
        </div>
      )}

      <div className="grid grid-cols-[minmax(110px,150px)_1fr_1fr] gap-2">
        <span />
        <span className="text-center text-xs font-semibold text-slate-300">Read [{UNIT_LABEL[unit]}]</span>
        <span className="text-center text-xs font-semibold text-slate-300">Write [{UNIT_LABEL[unit]}]</span>
        {PROFILES.map((p) => {
          const s = stepOf(p.id);
          return (
            <div key={p.id} className="contents">
              <GlassButton
                className="h-full !justify-start !rounded-xl font-mono"
                title={p.hint}
                disabled={busy || running || !chosen || (mode === "readwrite" && rawInUse)}
                onClick={() => start([p.id])}
              >
                {p.label}
              </GlassButton>
              <Cell m={s?.read} unit={unit} max={maxR} active={running && s?.status === "running read"} />
              <Cell m={s?.write} unit={unit} max={maxW} active={running && s?.status === "running write"} />
            </div>
          );
        })}
      </div>
      {job && (
        <p className="text-[11px] text-slate-500">
          {job.label} · {job.mode === "readonly" ? "read-only" : "read + write"} · {job.test_size_mb >= 1024 ? `${job.test_size_mb / 1024} GiB` : `${job.test_size_mb} MiB`} ·{" "}
          {job.passes} pass(es), best result shown
        </p>
      )}

      <section>
        <h4 className="mb-2 text-xs font-semibold text-slate-200">Saved benchmark results</h4>
        {history.length === 0 ? (
          <p className="text-xs text-slate-500">Finished runs appear here so you can compare drives and pools side by side.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[11px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="py-1.5 font-medium">Target</th>
                  <th className="px-2 font-medium">Date</th>
                  {PROFILES.map((p) => (
                    <th key={p.id} className="px-2 text-right font-medium">
                      {p.label}
                      <span className="block font-normal text-slate-500">R / W {UNIT_LABEL[unit]}</span>
                    </th>
                  ))}
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className={`border-t border-white/5 ${job?.id === h.id ? "bg-white/[0.05]" : ""}`}>
                    <td className="py-1.5">
                      <span className="text-slate-100">{h.label}</span>
                      <span className="ml-1.5">
                        <GlassBadge tone={h.mode === "readonly" ? "success" : "info"}>{h.mode === "readonly" ? "RO" : "RW"}</GlassBadge>
                      </span>
                    </td>
                    <td className="px-2 text-slate-400">{new Date(h.started_at * 1000).toLocaleString()}</td>
                    {PROFILES.map((p) => {
                      const s = h.steps.find((x) => x.profile === p.id);
                      return (
                        <td key={p.id} className="px-2 text-right font-mono tabular-nums text-slate-200">
                          {fmt(s?.read, unit)} <span className="text-slate-500">/</span> {fmt(s?.write, unit)}
                        </td>
                      );
                    })}
                    <td className="px-2 text-right">
                      <GlassButton size="xs" variant="ghost" disabled={running} onClick={() => setJob(h)}>
                        Show
                      </GlassButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmModal
        open={!!confirmRaw}
        onClose={() => setConfirmRaw(null)}
        onConfirm={() => confirmRaw && start(confirmRaw, true)}
        title="Write benchmark on a raw disk"
        confirmLabel="Overwrite and benchmark"
        expect={targetPath}
        busy={busy}
        message={
          <p>
            Write tests overwrite the first {size} MiB of <span className="font-mono">{targetPath}</span>. Any partition table or data on it is destroyed.
          </p>
        }
      />
    </div>
  );
}
