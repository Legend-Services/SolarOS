import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, Bell, CheckCircle2, Info } from "lucide-react";
import { api } from "../lib/api";
import type { Alert, Severity } from "../lib/types";
import { useDismiss, usePoll } from "../lib/hooks";

const SEEN_KEY = "solardeck.seenAlerts";

const STYLE: Record<Severity, { icon: typeof Info; tone: string }> = {
  critical: { icon: AlertOctagon, tone: "text-rose-400" },
  warning: { icon: AlertTriangle, tone: "text-amber-400" },
  info: { icon: Info, tone: "text-sky-400" },
};

const readSeen = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
  } catch {
    return [];
  }
};

export default function NotificationPopover({ up = false }: { up?: boolean }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [seen, setSeen] = useState<string[]>(readSeen);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const load = useCallback(() => {
    api<{ alerts: Alert[] }>("/notifications").then((r) => setAlerts(r.alerts), () => {});
  }, []);
  usePoll(load, 30000);

  // Opening the popover marks everything shown as read; only ids still active are kept.
  useEffect(() => {
    if (!open) return;
    const ids = alerts.map((a) => a.id);
    setSeen(ids);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
    } catch {
      /* private mode: unread state just isn't remembered */
    }
  }, [open, alerts]);

  const unread = alerts.filter((a) => !seen.includes(a.id));
  const worst = unread.some((a) => a.severity === "critical") ? "bg-rose-500" : unread.some((a) => a.severity === "warning") ? "bg-amber-500" : "bg-sky-500";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center rounded-md p-1 text-slate-200 hover:bg-white/10"
        aria-expanded={open}
        aria-label={unread.length ? `${unread.length} unread notification(s)` : "Notifications"}
        title="Notifications"
      >
        <Bell size={15} />
        {unread.length > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 rounded-full px-1 text-[9px] leading-tight text-white ${worst}`}>{unread.length}</span>
        )}
      </button>
      {open && (
        <div className={`glass absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-[min(24rem,calc(100vw-1rem))] rounded-xl p-2 shadow-2xl`}>
          <div className="flex items-center justify-between px-2 pb-2 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
            <span>Notifications</span>
            <span>{alerts.length ? `${alerts.length} active` : "All clear"}</span>
          </div>
          <ul className="max-h-[60vh] space-y-1 overflow-auto">
            {alerts.length === 0 && (
              <li className="flex flex-col items-center gap-2 px-2 py-6 text-center text-slate-400">
                <CheckCircle2 size={22} className="text-emerald-400" />
                System is healthy. No active alerts.
              </li>
            )}
            {alerts.map((a) => {
              const { icon: Icon, tone } = STYLE[a.severity];
              return (
                <li key={a.id} className="flex gap-2 rounded-lg bg-white/5 px-2 py-2">
                  <Icon size={15} className={`mt-0.5 shrink-0 ${tone}`} />
                  <div className="min-w-0">
                    <p className="text-slate-100">{a.title}</p>
                    <p className="text-[11px] break-words text-slate-400">{a.message}</p>
                  </div>
                  <span className={`ml-auto shrink-0 self-start text-[10px] uppercase ${tone}`}>{a.severity}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
