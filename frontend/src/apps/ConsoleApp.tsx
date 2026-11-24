import { useEffect, useRef, useState } from "react";
import { Expand, Keyboard, RotateCw } from "lucide-react";
import RFB from "@novnc/novnc";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import type { ConsoleTarget } from "../lib/types";
import { useTelemetry } from "../lib/stores";

type Status = "connecting" | "connected" | "disconnected" | "error";

const BADGE: Record<Status, string> = {
  connecting: "bg-amber-400/15 text-amber-300",
  connected: "bg-emerald-400/15 text-emerald-300",
  disconnected: "bg-slate-400/15 text-slate-300",
  error: "bg-rose-500/15 text-rose-300",
};

const wsUrl = (kind: "vnc" | "terminal", t: ConsoleTarget, session: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws/${kind}/${t.type}/${t.vmid}?session=${encodeURIComponent(session)}`;

export default function ConsoleApp({ params }: { params?: ConsoleTarget }) {
  const t = params!;
  const frame = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [detail, setDetail] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = screen.current!;
    let cancelled = false;
    let cleanup = () => {};
    el.replaceChildren();
    setStatus("connecting");
    setDetail("");

    (async () => {
      try {
        if (t.mode === "vnc") {
          const { session, password } = await api<{ session: string; password: string }>(`/v1/guests/${t.type}/${t.vmid}/vnc`, { method: "POST" });
          if (cancelled) return;
          const r = new RFB(el, wsUrl("vnc", t, session), { credentials: { password }, wsProtocols: ["binary"] });
          r.scaleViewport = true;
          r.background = "#05070d";
          r.addEventListener("connect", () => setStatus("connected"));
          r.addEventListener("credentialsrequired", () => r.sendCredentials({ password }));
          r.addEventListener("securityfailure", (e) => setDetail((e as CustomEvent).detail?.reason || "VNC security failure"));
          r.addEventListener("disconnect", (e) => setStatus((e as CustomEvent).detail?.clean ? "disconnected" : "error"));
          rfb.current = r;
          cleanup = () => {
            rfb.current = null;
            r.disconnect();
          };
        } else {
          // Host shells open a root PTY over the SSH bridge directly; guests get a single-use session first.
          const url =
            t.type === "node"
              ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws/host-shell`
              : wsUrl("terminal", t, (await api<{ session: string }>(`/v1/guests/${t.type}/${t.vmid}/terminal`, { method: "POST" })).session);
          if (cancelled) return;
          const term = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            theme: { background: "#05070d" },
          });
          const fit = new FitAddon();
          term.loadAddon(fit);
          term.open(el);
          const ws = new WebSocket(url, "binary");
          ws.binaryType = "arraybuffer";
          const enc = new TextEncoder();
          const send = (m: string) => ws.readyState === WebSocket.OPEN && ws.send(m);
          // Terminal proxy framing: "0:<bytes>:<data>" input, "1:<cols>:<rows>:" resize, "2" keepalive.
          const resize = () => {
            fit.fit();
            send(`1:${term.cols}:${term.rows}:`);
          };
          ws.onopen = () => {
            setStatus("connected");
            resize();
            term.focus();
          };
          ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
          ws.onclose = (e) => {
            setStatus(e.code === 1000 || e.code === 1005 ? "disconnected" : "error");
            if (e.reason) setDetail(e.reason);
          };
          const input = term.onData((d) => send(`0:${enc.encode(d).length}:${d}`));
          const ro = new ResizeObserver(resize);
          ro.observe(el);
          const ping = setInterval(() => send("2"), 30000);
          cleanup = () => {
            clearInterval(ping);
            ro.disconnect();
            input.dispose();
            ws.close();
            term.dispose();
          };
        }
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setDetail((e as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [t.type, t.vmid, t.mode, attempt]);

  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen());

  return (
    <div ref={frame} className="flex h-full flex-col bg-[#05070d]">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-slate-900/80 px-3 py-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${BADGE[status]}`}>{status}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
          {detail || (t.type === "node" ? `root@${t.name} · host shell (SSH key bridge)` : `${t.mode === "vnc" ? "noVNC" : "Shell"} · ${t.type === "qemu" ? "VM" : "LXC"} ${t.vmid}`)}
        </span>
        {t.mode === "vnc" && (
          <button className="btn" disabled={status !== "connected"} onClick={() => rfb.current?.sendCtrlAltDel()} title="Send Ctrl+Alt+Del">
            <Keyboard size={12} /> Ctrl+Alt+Del
          </button>
        )}
        <button className="btn" onClick={() => setAttempt((n) => n + 1)} title="Reconnect">
          <RotateCw size={12} /> Reconnect
        </button>
        <button className="btn" onClick={fullscreen} title="Toggle fullscreen" aria-label="Toggle fullscreen">
          <Expand size={12} />
        </button>
      </div>
      <div ref={screen} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}

/** "Host Shell" app: an instant root prompt on the host over the SSH key bridge. */
export function HostShell() {
  const node = useTelemetry((s) => s.overview?.node) ?? "host";
  return <ConsoleApp params={{ type: "node", vmid: 0, name: node, mode: "shell" }} />;
}
