import { useEffect, useRef, useState } from "react";
import { Plus, RotateCw } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../lib/api";
import { useRunner } from "../../lib/hooks";
import { useTranslation } from "../../i18n";
import { GlassBadge, GlassButton, Notice } from "../ui/GlassKit";

type State = "connecting" | "connected" | "closed";
const TONE = { connecting: "info", connected: "success", closed: "neutral" } as const;

/** Out-of-band serial console of a guest: stays usable when a VM's display goes to a passed-through GPU. */
export default function SerialConsole({ guestType, guestId }: { guestType: "qemu" | "lxc"; guestId: number }) {
  const { t } = useTranslation();
  const el = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>("connecting");
  const [detail, setDetail] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [restart, setRestart] = useState(false);
  const { busy, error, notice, run } = useRunner();

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    setState("connecting");
    setDetail("");
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", theme: { background: "#05070d" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/compute/${guestType}/${guestId}/serial`, "binary");
    ws.binaryType = "arraybuffer";
    const enc = new TextEncoder();
    const send = (m: string) => ws.readyState === WebSocket.OPEN && ws.send(m);
    // Same framing as the terminal proxy: "0:<bytes>:<data>" input, "1:<cols>:<rows>:" resize, "2" keepalive.
    const resize = () => {
      fit.fit();
      send(`1:${term.cols}:${term.rows}:`);
    };
    ws.onopen = () => {
      setState("connected");
      resize();
      term.focus();
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = (e) => {
      setState("closed");
      setDetail(e.reason);
    };
    const input = term.onData((d) => send(`0:${enc.encode(d).length}:${d}`));
    const ro = new ResizeObserver(resize);
    ro.observe(node);
    const ping = setInterval(() => send("2"), 30000);
    return () => {
      clearInterval(ping);
      ro.disconnect();
      input.dispose();
      ws.onclose = null; // a reconnect must not see the old socket's close
      ws.close();
      term.dispose();
    };
  }, [guestType, guestId, attempt]);

  const enable = () =>
    run(() => api<{ restart_needed: boolean }>(`/oob/serial/qemu/${guestId}/enable`, { method: "POST" }).then((r) => setRestart(r.restart_needed)), t("serial.added"));

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-400">{t("serial.hint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <GlassBadge tone={TONE[state]}>{t(`serial.${state}`)}</GlassBadge>
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-500">{detail}</span>
        {guestType === "qemu" && (
          <GlassButton size="xs" disabled={busy} onClick={enable}>
            <Plus size={12} /> {t("serial.addPort")}
          </GlassButton>
        )}
        <GlassButton size="xs" disabled={state === "connecting"} onClick={() => setAttempt((n) => n + 1)}>
          <RotateCw size={12} /> {t("serial.reconnect")}
        </GlassButton>
      </div>
      <Notice error={error} notice={notice && (restart ? t("serial.restartNeeded") : notice)} />
      <div ref={el} className="h-80 overflow-hidden rounded-xl bg-[#05070d] p-1" />
    </div>
  );
}
