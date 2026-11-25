import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useCapabilities } from "../store/capabilitiesStore";
import { useWizard } from "../store/wizardStore";
import { api } from "../lib/api";
import { bytes } from "../lib/format";
import { useIntentFor, useRelease, useTelemetry, zfsHealth } from "../lib/stores";
import type { SystemInfo } from "../lib/types";
import { LANGS, isLang, useTranslation, type TKey } from "../i18n";
import { GlassInput } from "../components/ui/GlassKit";
import { CATEGORIES, CATEGORY_META, MODULES, MODULE_IDS, type CategoryId, type ModuleId } from "./settings/modules";
import { Appearance, BugReportCard, NetworkSection, PowerSection, Security, UpdatesSection, WithSystemInfo } from "./ControlPanelApp";
import { AuditLogCard, PostureCard } from "./security/SecurityCenter";
import { Repositories, Updates } from "./SystemApp";
import { Bios } from "./HelpCenterApp";
import HardwarePanel from "./HardwarePanel";
import ResourceMonitor from "./ResourceMonitor";
import StorageManager from "./StorageManager";
import BackupCenterApp from "./BackupCenterApp";
import SharesManager from "./SharesManager";
import IsoLibrary from "./IsoLibrary";
import DatacenterApp from "./DatacenterApp";
import NetworkServicesApp from "./NetworkServicesApp";
import AutomationPanel from "./AutomationPanel";
import LocalAiApp from "./LocalAiApp";
import HypervisorDefaultsPanel from "./settings/HypervisorDefaultsPanel";
import SystemServicesPanel from "./settings/SystemServicesPanel";

const pad = (n: ReactNode) => <div className="h-full space-y-4 overflow-auto p-4">{n}</div>;

/** A module made of several existing panels: a small tab row above the active one. */
function Views({ views }: { views: [TKey, ReactNode][] }) {
  const { t } = useTranslation();
  const [i, setI] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-white/10 px-3 py-1.5">
        {views.map(([label], n) => (
          <button
            key={label}
            onClick={() => setI(n)}
            aria-current={i === n}
            className={`rounded-lg px-3 py-1 text-xs transition ${i === n ? "bg-white/12 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{views[i]?.[1]}</div>
    </div>
  );
}

/** Each sub-module reuses the existing panels and apps, so every API call they make stays the same. */
function ModuleBody({ id }: { id: ModuleId }) {
  const caps = useCapabilities((s) => s.capabilities);
  switch (id) {
    case "general-appearance":
      return pad(<Appearance />);
    case "hardware-gpu":
      return pad(<HardwarePanel />);
    case "bios-firmware":
      return pad(<Bios focus={null} />);
    case "resource-monitor":
      return <ResourceMonitor />;
    case "software-updates":
      return (
        <Views
          views={[
            ["set.view.solardeck", pad(<><UpdatesSection /><BugReportCard /></>)],
            ...(caps.supports_apt_repos ? ([["set.view.repos", pad(<Repositories />)]] as [TKey, ReactNode][]) : []),
            ["set.view.packages", pad(<Updates />)],
          ]}
        />
      );
    case "host-power":
      return pad(<WithSystemInfo>{(info) => <PowerSection info={info} />}</WithSystemInfo>);
    case "storage-zfs":
      return <StorageManager />;
    case "backup-restore":
      return <BackupCenterApp />;
    case "shared-folders":
      return <SharesManager />;
    case "iso-templates":
      return <div className="h-full overflow-auto"><IsoLibrary /></div>;
    case "users-roles":
      return <DatacenterApp />;
    case "security-2fa":
      return pad(<WithSystemInfo>{(info) => <Security info={info} />}</WithSystemInfo>);
    case "security-posture":
      return pad(<PostureCard />);
    case "audit-logs":
      return <Views views={[["set.view.audit", pad(<AuditLogCard />)], ["set.view.hostLogs", <DatacenterApp initialTab="logs" />]]} />;
    case "network-switch":
      return pad(<WithSystemInfo>{(info) => <NetworkSection info={info} />}</WithSystemInfo>);
    case "network-topology":
      return <NetworkServicesApp />;
    case "firewall-forwarding":
      return <Views views={[["set.view.firewall", <DatacenterApp initialTab="firewall" />], ["set.view.forwarding", <NetworkServicesApp initialTab="router" />]]} />;
    case "wireguard-vpn":
      return <NetworkServicesApp initialTab="wg" />;
    case "automation-alerts":
      return pad(<AutomationPanel />);
    case "hypervisor-defaults":
      return pad(<HypervisorDefaultsPanel />);
    case "local-ai-runtime":
      return <LocalAiApp initialTab="hardware" />;
    case "system-services":
      return pad(<SystemServicesPanel />);
  }
}

/** Live status dot on a tile, where one makes sense. */
function useDots(): Partial<Record<ModuleId, string>> {
  const health = zfsHealth(useTelemetry((s) => s.storage));
  const update = useRelease((s) => s.update);
  return {
    "storage-zfs": health === "ONLINE" ? "bg-emerald-400" : health === "N/A" || health === "—" ? "" : "bg-rose-400",
    "software-updates": update ? "bg-amber-400" : "bg-emerald-400",
  };
}

function HostSummary({ query, setQuery, onEnter }: { query: string; setQuery: (q: string) => void; onEnter: () => void }) {
  const { t, language, setLanguage } = useTranslation();
  const platform = useCapabilities((s) => s.capabilities.platform_label);
  const memory = useTelemetry((s) => s.overview?.memory.total);
  const version = useRelease((s) => s.version);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    api<SystemInfo>("/system/info").then(setInfo, () => {});
  }, []);
  const facts: [TKey, ReactNode][] = [
    ["set.host.hostname", info?.node],
    ["set.host.platform", platform],
    ["set.host.cpu", info?.cpu_model],
    ["set.host.memory", memory ? bytes(memory) : null],
    ["set.host.release", version && `v${version}`],
  ];
  return (
    <div className="glass-soft mx-4 mt-4 rounded-2xl p-4">
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t(k)}</div>
            <div className="truncate text-sm text-slate-100" title={typeof v === "string" ? v : undefined}>{v || "—"}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <GlassInput
            autoFocus
            className="w-full pl-8"
            placeholder={t("set.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onEnter()}
            aria-label={t("set.search")}
          />
        </div>
        <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label={t("common.language")}>
          {LANGS.map((l) => (
            <button
              key={l.id}
              onClick={() => isLang(l.id) && setLanguage(l.id)}
              aria-pressed={language === l.id}
              title={l.label}
              className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase ${language === l.id ? "bg-white/15 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              {l.id}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ id, onOpen, dot }: { id: ModuleId; onOpen: () => void; dot?: string }) {
  const { t } = useTranslation();
  const m = MODULES[id];
  const Icon = m.icon;
  return (
    <button
      onClick={onOpen}
      title={t(`set.modDesc.${id}`)}
      className="glass-soft relative flex items-center gap-3 rounded-2xl p-3 text-left transition hover:bg-white/[0.08] active:scale-[0.98]"
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] bg-gradient-to-br text-white shadow-lg shadow-black/30 ${m.tint}`}>
        <Icon size={19} />
      </span>
      <span className="min-w-0 text-xs font-medium leading-snug text-slate-100">{t(`set.mod.${id}`)}</span>
      {dot && <span className={`absolute top-2 right-2 h-2 w-2 rounded-full ${dot}`} aria-hidden />}
    </button>
  );
}

/** Settings: one hub for every OS, storage, security, network and hypervisor setting. */
export default function SettingsApp() {
  const { t } = useTranslation();
  const caps = useCapabilities((s) => s.capabilities);
  const showGuide = useWizard((s) => s.show);
  const loadRelease = useRelease((s) => s.load);
  const dots = useDots();
  const [module, setModule] = useState<ModuleId | null>(null);
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState(true);
  useIntentFor("settings", setModule);
  useEffect(loadRelease, [loadRelease]);

  const available = MODULE_IDS.filter((id) => id !== "bios-firmware" || caps.supports_bios_manager);
  const q = query.trim().toLowerCase();
  const matches = (id: ModuleId) =>
    !q || `${t(`set.mod.${id}`)} ${t(`set.modDesc.${id}`)} ${t(`set.cat.${MODULES[id].cat}`)} ${id}`.toLowerCase().includes(q);
  const inCat = (c: CategoryId) => available.filter((id) => MODULES[id].cat === c);

  if (module) {
    const cat = MODULES[module].cat;
    return (
      <div className="flex h-full flex-col">
        <nav className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 text-xs" aria-label="Breadcrumb">
          <button onClick={() => setTree((v) => !v)} className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200 max-sm:hidden" aria-label={t("set.toggleTree")} title={t("set.toggleTree")}>
            {tree ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <button onClick={() => setModule(null)} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-200 hover:bg-white/10">
            <ChevronLeft size={14} /> {t("set.all")}
          </button>
          <ChevronRight size={12} className="text-slate-600" />
          <span className="text-slate-400">{t(`set.cat.${cat}`)}</span>
          <ChevronRight size={12} className="text-slate-600" />
          <span className="truncate font-semibold text-white">{t(`set.mod.${module}`)}</span>
          <button onClick={() => showGuide(MODULES[module].guide)} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-slate-300 hover:bg-white/10">
            <CircleHelp size={13} /> {t("set.guide")}
          </button>
        </nav>
        <div className="flex min-h-0 flex-1">
          {tree && (
            <aside className="w-52 shrink-0 overflow-auto border-r border-white/10 bg-black/20 p-2 max-sm:hidden">
              {CATEGORIES.map((c) => (
                <div key={c} className="mb-2">
                  <p className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t(`set.cat.${c}`)}</p>
                  {inCat(c).map((id) => {
                    const Icon = MODULES[id].icon;
                    return (
                      <button
                        key={id}
                        onClick={() => setModule(id)}
                        aria-current={id === module}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${id === module ? "bg-white/12 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
                      >
                        <Icon size={13} className="shrink-0" /> <span className="truncate">{t(`set.mod.${id}`)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </aside>
          )}
          <div className="min-w-0 flex-1">
            <ModuleBody key={module} id={module} />
          </div>
        </div>
      </div>
    );
  }

  const first = available.find(matches);
  return (
    <div className="h-full overflow-auto pb-4">
      <HostSummary query={query} setQuery={setQuery} onEnter={() => first && setModule(first)} />
      <div className="mt-4 space-y-3 px-4">
        {CATEGORIES.map((c) => {
          const mods = inCat(c).filter(matches);
          if (!mods.length) return null;
          const { icon: Icon, tint } = CATEGORY_META[c];
          return (
            <section key={c} className="grid gap-3 border-b border-white/5 pb-3 md:grid-cols-[240px_1fr]">
              <div className="flex gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg shadow-black/30 ${tint}`}>
                  <Icon size={20} />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white">{t(`set.cat.${c}`)}</h3>
                  <p className="line-clamp-2 text-[11px] leading-snug text-slate-400">{t(`set.catDesc.${c}`)}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {mods.map((id) => (
                  <Tile key={id} id={id} dot={dots[id]} onOpen={() => setModule(id)} />
                ))}
              </div>
            </section>
          );
        })}
        {!first && <p className="py-8 text-center text-sm text-slate-400">{t("set.noMatch")}</p>}
      </div>
    </div>
  );
}
