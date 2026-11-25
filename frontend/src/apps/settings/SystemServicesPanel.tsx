import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { Card } from "../ControlPanelApp";
import { GlassBadge, GlassButton, GlassInput, Notice } from "../../components/ui/GlassKit";

interface Unit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

const tone = (a: string) => (a === "active" ? "success" : a === "failed" ? "danger" : "neutral");

/** Settings > Hypervisor & Runtime > System Services: systemd services on the host. Start / stop / restart asks for step-up confirmation. */
export default function SystemServicesPanel() {
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const load = useCallback(() => api<Unit[]>("/system/services").then(setUnits), []);
  const { busy, error, notice, run } = useRunner();
  useEffect(() => void run(load), [run, load]);
  const act = (u: string, action: "start" | "stop" | "restart") =>
    run(() => api(`/system/services/${encodeURIComponent(u)}/${action}`, { method: "POST" }).then(load), `${u}: ${action} done.`);

  const term = q.trim().toLowerCase();
  const shown = (units ?? []).filter((u) => (all || u.active !== "inactive") && (!term || `${u.unit} ${u.description}`.toLowerCase().includes(term)));
  return (
    <Card
      title="System services"
      action={
        <GlassButton size="xs" variant="ghost" onClick={() => run(load)} disabled={busy} aria-label="Refresh">
          <RefreshCw size={12} />
        </GlassButton>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <GlassInput placeholder="Filter services..." value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show inactive
        </label>
        <span className="text-[11px] text-slate-500">{units ? `${shown.length} of ${units.length}` : "Loading…"}</span>
      </div>
      <Notice error={error} notice={notice} />
      <div className="mt-2 max-h-[60vh] overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1.5">Service</th>
              <th className="px-2">State</th>
              <th className="px-2 max-md:hidden">Description</th>
              <th className="w-28" />
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.unit} className="border-t border-white/5">
                <td className="py-1.5 font-mono text-slate-100">{u.unit}</td>
                <td className="px-2">
                  <GlassBadge tone={tone(u.active)}>{`${u.active} · ${u.sub}`}</GlassBadge>
                </td>
                <td className="truncate px-2 text-slate-400 max-md:hidden">{u.description}</td>
                <td className="whitespace-nowrap text-right">
                  {u.active === "active" ? (
                    <>
                      <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => act(u.unit, "restart")} aria-label={`Restart ${u.unit}`} title="Restart">
                        <RotateCcw size={12} />
                      </GlassButton>
                      <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => act(u.unit, "stop")} aria-label={`Stop ${u.unit}`} title="Stop">
                        <Square size={12} />
                      </GlassButton>
                    </>
                  ) : (
                    <GlassButton size="xs" variant="ghost" disabled={busy} onClick={() => act(u.unit, "start")} aria-label={`Start ${u.unit}`} title="Start">
                      <Play size={12} />
                    </GlassButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
