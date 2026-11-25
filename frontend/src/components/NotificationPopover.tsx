import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, Bell, CheckCircle2, Info, LoaderCircle } from "lucide-react";
import { api } from "../lib/api";
import type { Alert, HostTask, Severity } from "../lib/types";
import { useDismiss, usePoll } from "../lib/hooks";
import { useTranslation } from "../i18n";
import { TaskCenterPanel } from "./TaskCenter";

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

type Tab = "notifications" | "tasks";

/** Bell: notifications and the Task Center as two tabs. The badge counts unread alerts; a pulsing dot means tasks are running. */
export default function NotificationPopover({ up = false }: { up?: boolean }) {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [tasks, setTasks] = useState<HostTask[]>([]);
  const [seen, setSeen] = useState<string[]>(readSeen);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("notifications");
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const load = useCallback(() => {
    api<{ alerts: Alert[] }>("/notifications").then((r) => setAlerts(r.alerts), () => {});
  }, []);
  usePoll(load, 30000);
  const loadTasks = useCallback(() => {
    api<HostTask[]>("/v1/tasks").then(setTasks).catch(() => {});
  }, []);
  usePoll(loadTasks, open && tab === "tasks" ? 3000 : 8000);

  // Viewing the notifications tab marks everything shown as read; only ids still active are kept.
  useEffect(() => {
    if (!open || tab !== "notifications") return;
    const ids = alerts.map((a) => a.id);
    setSeen(ids);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
    } catch {
      /* private mode: unread state just isn't remembered */
    }
  }, [open, tab, alerts]);

  const unread = alerts.filter((a) => !seen.includes(a.id));
  const running = tasks.filter((x) => x.state === "running").length;
  const worst = unread.some((a) => a.severity === "critical") ? "bg-rose-500" : unread.some((a) => a.severity === "warning") ? "bg-amber-500" : "bg-sky-500";
  const label = [unread.length ? t("notif.unread", { count: unread.length }) : t("notif.title"), running ? t("notif.tasksRunning", { count: running }) : ""]
    .filter(Boolean)
    .join(", ");
  const tabs: [Tab, string, number][] = [
    ["notifications", t("notif.title"), unread.length],
    ["tasks", t("notif.tasks"), running],
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center rounded-md p-1 text-slate-200 hover:bg-white/10"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <Bell size={15} />
        {unread.length > 0 && <span className={`absolute -top-0.5 -right-0.5 rounded-full px-1 text-[9px] leading-tight text-white ${worst}`}>{unread.length}</span>}
        {running > 0 && (
          <span className="absolute -right-0.5 -bottom-0.5 flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
          </span>
        )}
      </button>
      {open && (
        <div className={`glass absolute ${up ? "bottom-full mb-5 bg-slate-950/90" : "top-8"} right-0 w-[min(26rem,calc(100vw-1rem))] rounded-xl p-2 shadow-2xl`}>
          <div className="mb-2 flex items-center gap-1" role="tablist">
            {tabs.map(([id, name, n]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${tab === id ? "bg-white/12 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
              >
                {id === "tasks" && running > 0 && <LoaderCircle size={11} className="animate-spin text-sky-300" />}
                {name}
                {n > 0 && <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums">{n}</span>}
              </button>
            ))}
            <span className="ml-auto px-2 text-[10px] tracking-wide text-slate-500 uppercase">
              {tab === "notifications"
                ? alerts.length
                  ? t("notif.active", { count: alerts.length })
                  : t("notif.allClear")
                : running
                  ? t("notif.running", { count: running })
                  : t("notif.idle")}
            </span>
          </div>
          {tab === "tasks" ? (
            <TaskCenterPanel tasks={tasks} reload={loadTasks} />
          ) : (
            <ul className="max-h-[60vh] space-y-1 overflow-auto">
              {alerts.length === 0 && (
                <li className="flex flex-col items-center gap-2 px-2 py-6 text-center text-slate-400">
                  <CheckCircle2 size={22} className="text-emerald-400" />
                  {t("notif.healthy")}
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
          )}
        </div>
      )}
    </div>
  );
}
