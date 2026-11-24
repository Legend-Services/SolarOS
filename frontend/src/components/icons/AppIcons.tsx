import { useId, type ReactNode } from "react";
import type { AppId } from "../../apps/registry";

/* Bespoke squircle app icons: multi-stop gradient body, glossy top reflection, inner rim shadow, white vector glyph. */

const SQUIRCLE = "M32 1.5C9.6 1.5 1.5 9.6 1.5 32S9.6 62.5 32 62.5 62.5 54.4 62.5 32 54.4 1.5 32 1.5Z";
const W = "#fff";

const ICONS: Record<AppId, { stops: [string, string, string]; glyph: ReactNode }> = {
  monitor: {
    stops: ["#7dd3fc", "#2563eb", "#1e1b8f"],
    glyph: (
      <>
        <rect x="13" y="16" width="38" height="28" rx="5" fill={W} fillOpacity=".16" stroke={W} strokeOpacity=".55" strokeWidth="1.5" />
        <path d="M17 34h7l4-9 6 15 4-10 3 4h6" fill="none" stroke={W} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="24" y="47" width="16" height="3" rx="1.5" fill={W} fillOpacity=".8" />
      </>
    ),
  },
  compute: {
    stops: ["#e879f9", "#7c3aed", "#3b0d8c"],
    glyph: (
      <>
        {[14, 27, 40].map((y, i) => (
          <g key={y}>
            <rect x="14" y={y} width="36" height="10" rx="3" fill={W} fillOpacity={0.95 - i * 0.18} />
            <circle cx="20" cy={y + 5} r="1.8" fill="#7c3aed" />
            <rect x="26" y={y + 4} width="18" height="2" rx="1" fill="#7c3aed" fillOpacity=".5" />
          </g>
        ))}
      </>
    ),
  },
  storage: {
    stops: ["#fde68a", "#f59e0b", "#b4410b"],
    glyph: (
      <>
        <path d="M16 20v24c0 3.9 7.2 7 16 7s16-3.1 16-7V20" fill={W} fillOpacity=".9" />
        <path d="M16 32c0 3.9 7.2 7 16 7s16-3.1 16-7" fill="none" stroke="#c2620c" strokeOpacity=".55" strokeWidth="2" />
        <ellipse cx="32" cy="20" rx="16" ry="7" fill={W} />
        <ellipse cx="32" cy="20" rx="10" ry="3.4" fill="#f59e0b" fillOpacity=".35" />
      </>
    ),
  },
  files: {
    stops: ["#6ee7b7", "#10b981", "#065f55"],
    glyph: (
      <>
        <path d="M12 21a4 4 0 0 1 4-4h9l4 4h19a4 4 0 0 1 4 4v3H12Z" fill={W} fillOpacity=".7" />
        <path d="M12 27h40v17a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4Z" fill={W} />
        <rect x="18" y="33" width="14" height="2.6" rx="1.3" fill="#10b981" fillOpacity=".6" />
      </>
    ),
  },
  appcenter: {
    stops: ["#f9a8d4", "#e11d48", "#7f1035"],
    glyph: (
      <>
        <rect x="14" y="14" width="15" height="15" rx="4.5" fill={W} />
        <rect x="35" y="14" width="15" height="15" rx="4.5" fill={W} fillOpacity=".7" />
        <rect x="14" y="35" width="15" height="15" rx="4.5" fill={W} fillOpacity=".7" />
        <path d="M42.5 36v13M36 42.5h13" stroke={W} strokeWidth="4" strokeLinecap="round" />
      </>
    ),
  },
  backup: {
    stops: ["#5eead4", "#0d9488", "#083d44"],
    glyph: (
      <>
        {/* Archive box with a circular restore arrow. */}
        <rect x="13" y="15" width="38" height="9" rx="3" fill={W} />
        <path d="M16 26h32v19a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4Z" fill={W} fillOpacity=".75" />
        <path d="M38.5 37.5a6.5 6.5 0 1 1-2-4.7" fill="none" stroke="#0d9488" strokeWidth="3" strokeLinecap="round" />
        <path d="m37.5 28.6.4 5.2-5.2.4" fill="none" stroke="#0d9488" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  shares: {
    stops: ["#67e8f9", "#0284c7", "#0b3a75"],
    glyph: (
      <>
        <path d="M32 22v10M32 32 19 42M32 32l13 10" stroke={W} strokeOpacity=".75" strokeWidth="3" strokeLinecap="round" />
        <circle cx="32" cy="19" r="7" fill={W} />
        <circle cx="18" cy="44" r="6" fill={W} fillOpacity=".9" />
        <circle cx="46" cy="44" r="6" fill={W} fillOpacity=".9" />
      </>
    ),
  },
  controlpanel: {
    stops: ["#a5b4fc", "#4f46e5", "#1e1a6e"],
    glyph: (
      <>
        {[
          [20, 26],
          [32, 40],
          [44, 22],
        ].map(([x, knob]) => (
          <g key={x}>
            <rect x={x - 1.5} y="14" width="3" height="36" rx="1.5" fill={W} fillOpacity=".45" />
            <circle cx={x} cy={knob} r="5.5" fill={W} />
            <circle cx={x} cy={knob} r="2" fill="#4f46e5" />
          </g>
        ))}
      </>
    ),
  },
  system: {
    stops: ["#cbd5e1", "#64748b", "#1e293b"],
    glyph: (
      <>
        <g fill={W}>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <rect key={a} x="29" y="12" width="6" height="10" rx="2" transform={`rotate(${a} 32 32)`} />
          ))}
        </g>
        <circle cx="32" cy="32" r="13" fill={W} />
        <circle cx="32" cy="32" r="5.5" fill="#64748b" />
      </>
    ),
  },
  netservices: {
    stops: ["#86efac", "#0ea5e9", "#1e3a8a"],
    glyph: (
      <>
        {/* Globe with a shield: DNS, VPN and router services. */}
        <circle cx="28" cy="30" r="15" fill="none" stroke={W} strokeWidth="2.6" />
        <ellipse cx="28" cy="30" rx="6.5" ry="15" fill="none" stroke={W} strokeOpacity=".75" strokeWidth="2" />
        <path d="M13.5 25h29M13.5 35h29" stroke={W} strokeOpacity=".75" strokeWidth="2" />
        <path d="M44 34l8 3v6c0 5-3.5 8-8 9.5-4.5-1.5-8-4.5-8-9.5v-6Z" fill={W} />
        <path d="m40.5 43.5 2.5 2.5 4.5-5" fill="none" stroke="#0ea5e9" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  datacenter: {
    stops: ["#fdba74", "#ea580c", "#7c1d0b"],
    glyph: (
      <>
        {/* Server racks with a key: permissions, firewall and logs. */}
        <rect x="12" y="13" width="26" height="38" rx="4" fill={W} fillOpacity=".9" />
        {[19, 28, 37].map((y) => (
          <g key={y}>
            <rect x="16" y={y} width="18" height="5" rx="1.5" fill="#ea580c" fillOpacity=".35" />
            <circle cx="31" cy={y + 2.5} r="1.3" fill="#ea580c" />
          </g>
        ))}
        <circle cx="45" cy="33" r="6.5" fill="none" stroke={W} strokeWidth="3" />
        <path d="M45 39.5V51m0-4h4m-4-4h3" stroke={W} strokeWidth="3" strokeLinecap="round" />
      </>
    ),
  },
  terminal: {
    stops: ["#4ade80", "#15803d", "#052e16"],
    glyph: (
      <>
        <rect x="11" y="15" width="42" height="34" rx="6" fill="#03140a" fillOpacity=".6" stroke={W} strokeOpacity=".55" strokeWidth="1.5" />
        <path d="m18 26 7 6-7 6" fill="none" stroke={W} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="29" y="36" width="15" height="3.4" rx="1.7" fill={W} />
        <circle cx="47" cy="20" r="2" fill="#86efac" />
      </>
    ),
  },
  help: {
    stops: ["#fef08a", "#f43f5e", "#7e1d6b"],
    glyph: (
      <>
        {/* Lifebuoy: help, support and automatic fixes. */}
        <circle cx="32" cy="32" r="17" fill="none" stroke={W} strokeWidth="9" />
        <g stroke="#f43f5e" strokeWidth="5" strokeLinecap="butt">
          <path d="M32 15v9M32 40v9M15 32h9M40 32h9" />
        </g>
        <circle cx="32" cy="32" r="7.5" fill={W} fillOpacity=".25" />
      </>
    ),
  },
  console: {
    stops: ["#94a3b8", "#334155", "#0f172a"],
    glyph: (
      <>
        <rect x="12" y="16" width="40" height="32" rx="5" fill="#0b1220" fillOpacity=".55" stroke={W} strokeOpacity=".5" strokeWidth="1.5" />
        <path d="m19 27 6 5-6 5" fill="none" stroke={W} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="29" y="36" width="12" height="3" rx="1.5" fill={W} />
      </>
    ),
  },
};

export function AppIcon({ id, size = 48, className = "" }: { id: AppId; size?: number; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const { stops, glyph } = ICONS[id];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={`shrink-0 drop-shadow-[0_6px_10px_rgba(0,0,0,0.35)] ${className}`} aria-hidden>
      <defs>
        <linearGradient id={`b${uid}`} x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor={stops[0]} />
          <stop offset=".55" stopColor={stops[1]} />
          <stop offset="1" stopColor={stops[2]} />
        </linearGradient>
        <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`i${uid}`} cx=".5" cy=".5" r=".62">
          <stop offset=".72" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".32" />
        </radialGradient>
        <filter id={`s${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.4" floodColor="#000" floodOpacity=".3" />
        </filter>
        <clipPath id={`c${uid}`}>
          <path d={SQUIRCLE} />
        </clipPath>
      </defs>
      <path d={SQUIRCLE} fill={`url(#b${uid})`} />
      <path d={SQUIRCLE} fill={`url(#i${uid})`} />
      <g filter={`url(#s${uid})`}>{glyph}</g>
      {/* Glass reflection on the upper half. */}
      <g clipPath={`url(#c${uid})`}>
        <ellipse cx="32" cy="6" rx="40" ry="26" fill={`url(#g${uid})`} opacity=".55" />
      </g>
      <path d={SQUIRCLE} fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1" />
    </svg>
  );
}
