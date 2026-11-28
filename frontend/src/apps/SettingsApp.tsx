import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useCapabilities } from "../store/capabilitiesStore";
import { useFeatures, useVisibility } from "../store/featureStore";
import { FEATURE_KEYS, on } from "../data/features";
import { useWizard } from "../store/wizardStore";
import { api } from "../lib/api";
import { bytes } from "../lib/format";
import { useIntentFor, useTelemetry, zfsHealth } from "../lib/stores";
import { useUpdateStore } from "../store/updateStore";
import { pulseAnchor } from "../lib/hooks";
import { controlHeadings } from "../data/knowledgeRegistry";
import type { SystemInfo } from "../lib/types";
import { LANGS, isLang, useTranslation, type TKey } from "../i18n";
import { GlassInput } from "../components/ui/GlassKit";
import { CATEGORIES, CATEGORY_META, MODULES, MODULE_IDS, settingsModule, settingsTab, type CategoryId, type ModuleId } from "./settings/modules";
import { Appearance, BugReportCard, NetworkSection, Security, UpdatesSection, WithSystemInfo } from "./ControlPanelApp";
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
import InstalledAppsPanel from "./settings/InstalledAppsPanel";
import SystemServicesPanel from "./settings/SystemServicesPanel";
import VisualSwitchStudio from "../components/network/VisualSwitchStudio";
import LabSandboxPanel from "../components/compute/LabSandbox";
import MultiSeatStudio from "../components/compute/MultiSeatStudio";
import ClusterManagerPanel from "../components/cluster/ClusterManagerPanel";
import { PlatformModulesOverview, SecurityModuleHeader, type ModuleKey } from "../components/ui/SecurityModuleHeader";
import ReverseProxyStudio from "./settings/ReverseProxyStudio";
import DisasterRecoveryPanel from "./settings/DisasterRecoveryPanel";
import PowerUpsPanel from "./settings/PowerUpsPanel";
import OutOfBandPanel from "./settings/OutOfBandPanel";
import UsersRolesPanel from "./settings/UsersRolesPanel";
import FirewallIdsPanel from "./settings/FirewallIdsPanel";
import StorageProtocolsPanel from "./settings/StorageProtocolsPanel";
import ImageHubPanel from "../components/compute/ImageHubPanel";
import FeaturesServicesPanel from "../components/settings/FeaturesServicesPanel";
import SystemInfoPanel from "../components/settings/SystemInfoPanel";

const TREE_KEY = "solardeck-settings-tree-width";
const TREE_DEFAULT = 240, TREE_MIN = 160, TREE_MAX = 480;
const clampTree = (w: number) => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, w)));

const pad = (n: ReactNode) => <div className="h-full space-y-4 overflow-auto p-4 pb-10" data-settings-body>{n}</div>;
/** An optional Security-by-Design module: its header (on/off, runtime, network), then the panel while it is on. */
const gated = (module: ModuleKey, body: ReactNode) => pad(<SecurityModuleHeader module={module}>{() => body}</SecurityModuleHeader>);

/** A module made of several existing panels: a small tab row above the active one. */
function Views({ module, views: all, initial, fallback = 0 }: { module: ModuleId; views: [TKey, ReactNode][]; initial?: string; fallback?: number }) {
  const { t } = useTranslation();
  // Tabs of features switched off in Features & Services are left out.
  const tab = useVisibility().tab;
  const views = all.filter(([k]) => tab(module, k.slice("set.view.".length)));
  // A deep link to an inner tab of one view (not a view itself) opens `fallback`, the view that owns those tabs.
  const [i, setI] = useState(() => {
    const hit = views.findIndex(([k]) => k === `set.view.${initial}`);
    return hit >= 0 ? hit : initial ? fallback : 0;
  });
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
function ModuleBody({ id, tab }: { id: ModuleId; tab?: string }) {
  // `tab` comes from a search / Help deep link: the inner tab to show first (each panel checks it against its own tabs).
  const initialTab = tab as never;
  const caps = useCapabilities((s) => s.capabilities);
  const vis = useVisibility();
  const docker = useFeatures((s) => on(s.enabled, "docker_engine"));
  switch (id) {
    case "system-info":
      return pad(<SystemInfoPanel />);
    case "general-appearance":
      return pad(<Appearance />);
    case "features-services":
      return pad(<FeaturesServicesPanel />);
    case "hardware-gpu":
      return (
        <Views
          module={id}
          initial={tab}
          views={[
            ["set.view.gpu", pad(<HardwarePanel />)],
            ...(caps.supports_bios_manager ? ([["set.view.bios", <div className="h-full overflow-auto p-4" data-settings-body><Bios focus={null} /></div>]] as [TKey, ReactNode][]) : []),
            ["set.view.multiseat", pad(<MultiSeatStudio />)],
          ]}
        />
      );
    case "resource-monitor":
      return <ResourceMonitor initialTab={initialTab} />;
    case "system-services":
      return (
        <Views
          module={id}
          initial={tab}
          views={[
            [
              "set.view.services",
              pad(
                <>
                  {docker && (
                    <div data-anchor="docker-engine">
                      <SecurityModuleHeader module="docker_engine" />
                    </div>
                  )}
                  <SystemServicesPanel />
                </>,
              ),
            ],
            ["set.view.solardeck", pad(<><UpdatesSection /><BugReportCard /></>)],
            ...(caps.supports_apt_repos ? ([["set.view.repos", pad(<Repositories />)]] as [TKey, ReactNode][]) : []),
            ["set.view.packages", pad(<Updates />)],
          ]}
        />
      );
    case "power-ups":
      return gated("ups_power", <PowerUpsPanel />);
    case "storage-zfs":
      return <StorageManager initialTab={initialTab} />;
    case "backup-restore":
      return <Views module={id} initial={tab} views={[["set.view.backups", <BackupCenterApp initialTab={initialTab} />], ["set.view.dr", gated("offsite_backup", <DisasterRecoveryPanel />)]]} />;
    case "shared-folders":
      return (
        <Views
          module={id}
          initial={tab}
          views={[
            ["set.view.smb", <SharesManager initialTab={initialTab} />],
            ["set.view.protocols", gated("storage_protocols", <StorageProtocolsPanel view="protocols" />)],
            ["set.view.snapfiles", gated("storage_protocols", <StorageProtocolsPanel view="snapshots" />)],
            ["set.view.usb", gated("storage_protocols", <StorageProtocolsPanel view="usb" />)],
          ]}
        />
      );
    case "iso-templates":
      return <Views module={id} initial={tab} views={[["set.view.isos", <div className="h-full overflow-auto"><IsoLibrary /></div>], ["set.view.images", gated("image_hub", <ImageHubPanel />)]]} />;
    case "users-roles":
      return (
        <Views
          module={id}
          initial={tab}
          fallback={1}
          views={[
            ["set.view.accounts", gated("rbac_users", <UsersRolesPanel />)],
            ["set.view.hostUsers", <DatacenterApp initialTab={initialTab} tabs={["users", "groups", "roles", "acl", "pools", ...(vis.tab(id, "tokens") ? (["tokens"] as const) : []), "realms"]} />],
          ]}
        />
      );
    case "platform-modules":
      return pad(<PlatformModulesOverview />);
    case "security-2fa":
      return pad(<WithSystemInfo>{(info) => <Security info={info} />}</WithSystemInfo>);
    case "security-posture":
      return pad(<PostureCard />);
    case "audit-logs":
      return <Views module={id} initial={tab} views={[["set.view.audit", pad(<AuditLogCard />)], ["set.view.hostLogs", <DatacenterApp tabs={["logs"]} />]]} />;
    case "network-switch":
      return (
        <Views
          module={id}
          initial={tab}
          views={[
            ["set.view.vswitch", <VisualSwitchStudio />],
            ["set.view.labs", pad(<LabSandboxPanel />)],
            ["set.view.hostNet", pad(<WithSystemInfo>{(info) => <NetworkSection info={info} />}</WithSystemInfo>)],
          ]}
        />
      );
    case "network-topology":
      return <NetworkServicesApp tabs={["topology"]} />;
    case "dns-dhcp":
      return <NetworkServicesApp initialTab={initialTab} tabs={["dns", "dhcp"]} />;
    case "domains-certs":
      return <NetworkServicesApp initialTab={initialTab} tabs={["domains", "certs"]} />;
    case "reverse-proxy":
      return gated("reverse_proxy", <ReverseProxyStudio initialTab={tab} />);
    case "firewall-ids":
      return <Views module={id} initial={tab} views={[["set.view.zones", gated("vlan_firewall", <FirewallIdsPanel view="zones" />)], ["set.view.ids", gated("vlan_firewall", <FirewallIdsPanel view="ids" />)]]} />;
    case "firewall-forwarding":
      return <Views module={id} initial={tab} views={[["set.view.firewall", <DatacenterApp tabs={["firewall"]} />], ["set.view.forwarding", <NetworkServicesApp tabs={["router"]} />]]} />;
    case "wireguard-vpn":
      return <NetworkServicesApp initialTab={initialTab} tabs={(["wg", "wgc"] as const).filter((x) => vis.tab(id, x))} />;
    case "automation-alerts":
      return pad(<AutomationPanel />);
    case "hypervisor-defaults":
      return pad(<HypervisorDefaultsPanel />);
    case "installed-apps":
      return pad(<InstalledAppsPanel />);
    case "local-ai-runtime":
      return <LocalAiApp initialTab={tab === "storage" ? "storage" : "hardware"} embedded />;
    case "cluster-ha":
      return <Views module={id} initial={tab} views={[["set.view.cluster", pad(<ClusterManagerPanel />)], ["set.view.oob", gated("oob_bmc", <OutOfBandPanel />)]]} />;
  }
}

/** Live status dot on a tile, where one makes sense. */
function useDots(): Partial<Record<ModuleId, string>> {
  const health = zfsHealth(useTelemetry((s) => s.storage));
  const update = useUpdateStore((s) => s.updateAvailable);
  return {
    "storage-zfs": health === "ONLINE" ? "bg-emerald-400" : health === "N/A" || health === "—" ? "" : "bg-rose-400",
    "system-info": update ? "bg-amber-400" : "bg-emerald-400",
  };
}

function HostSummary({ query, setQuery, onEnter }: { query: string; setQuery: (q: string) => void; onEnter: () => void }) {
  const { t, language, setLanguage } = useTranslation();
  const platform = useCapabilities((s) => s.capabilities.platform_label);
  const memory = useTelemetry((s) => s.overview?.memory.total);
  const version = useUpdateStore((s) => s.version);
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

/** "14 / 28 Active" on the Features & Services tile; a compact "14/28" in the narrow sidebar. */
function FeatureCount({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  const enabled = useFeatures((s) => s.enabled);
  const n = FEATURE_KEYS.filter((k) => on(enabled, k)).length;
  const full = t("feat.count", { n, total: FEATURE_KEYS.length });
  if (compact) return <span title={full} aria-label={full} className="shrink-0 rounded-full bg-cyan-400/15 px-2 py-0.5 text-[11px] leading-none font-semibold text-cyan-200 tabular-nums">{n}/{FEATURE_KEYS.length}</span>;
  return <span className="shrink-0 rounded-full bg-cyan-400/15 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-200 tabular-nums">{full}</span>;
}

function Tile({ id, onOpen, dot }: { id: ModuleId; onOpen: () => void; dot?: string }) {
  const { t } = useTranslation();
  const m = MODULES[id];
  const Icon = m.icon;
  return (
    <button
      onClick={onOpen}
      title={t(`set.modDesc.${id}`)}
      className="glass-soft relative flex items-center gap-3 rounded-2xl p-3 text-left transition-[background-color,border-color,box-shadow,transform,scale,opacity] hover:bg-white/[0.08] active:scale-[0.98]"
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] bg-gradient-to-br text-white shadow-lg shadow-black/30 ${m.tint}`}>
        <Icon size={19} />
      </span>
      <span className="min-w-0 text-xs font-medium leading-snug text-slate-100">
        {t(`set.mod.${id}`)}
        {id === "features-services" && <span className="mt-1 block"><FeatureCount /></span>}
      </span>
      {dot && <span className={`absolute top-2 right-2 h-2 w-2 rounded-full ${dot}`} aria-hidden />}
    </button>
  );
}

/** A main category on the All Settings landing page: one large card that opens the category's first sub-module. */
function CategoryCard({ id, onOpen }: { id: CategoryId; onOpen: () => void }) {
  const { t } = useTranslation();
  const { icon: Icon, tint } = CATEGORY_META[id];
  return (
    <button
      onClick={onOpen}
      data-anchor={`cat-${id}`}
      className="glass-soft group flex w-full items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left transition-[background-color,border-color,box-shadow,transform,scale,opacity] hover:bg-white/[0.08] active:scale-[0.99]"
    >
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg shadow-black/30 ${tint}`}>
        <Icon size={22} />
      </span>
      <span className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-white">{t(`set.cat.${id}`)}</h3>
        <p className="mt-0.5 text-xs leading-snug text-slate-400">{t(`set.catDesc.${id}`)}</p>
      </span>
      <ChevronRight size={18} className="shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-slate-300" />
    </button>
  );
}

/** Settings: one hub for every OS, storage, security, network and hypervisor setting. */
export default function SettingsApp() {
  const { t } = useTranslation();
  const showGuide = useWizard((s) => s.show);
  const loadRelease = useUpdateStore((s) => s.load);
  const dots = useDots();
  const [module, setModule] = useState<ModuleId | null>(null);
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState(true);
  const [treeW, setTreeW] = useState(() => clampTree(Number(localStorage.getItem(TREE_KEY)) || TREE_DEFAULT));
  const resizeTree = (w: number) => {
    const v = clampTree(w);
    setTreeW(v);
    localStorage.setItem(TREE_KEY, String(v));
  };
  const dragTree = (e: ReactPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = treeW;
    const move = (ev: PointerEvent) => resizeTree(w0 + ev.clientX - x0);
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up), (document.body.style.cursor = ""));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
  };
  // The last deep link: which module's inner tab to open, and what to highlight once it renders.
  const [nav, setNav] = useState<{ n: number; module?: ModuleId; tab?: string; anchor?: string }>({ n: 0 });
  const root = useRef<HTMLDivElement>(null);

  const vis = useVisibility();
  const available = MODULE_IDS.filter((id) => vis.module(id));
  const inCat = (c: CategoryId) => available.filter((id) => MODULES[id].cat === c);

  useIntentFor("settings", (v) => {
    // Retired sub-module ids (old links) resolve to the module and inner tab that replaced them.
    const m = settingsModule("settings", v);
    const tab = (typeof v === "object" && v.tab) || settingsTab("settings", v);
    // A category link opens that category's first sub-module (System opens Info).
    const target = m ?? (typeof v === "object" && v.category ? inCat(v.category)[0] : undefined) ?? null;
    setModule(target);
    setQuery("");
    setNav((p) => ({ ...(typeof v === "object" ? v : {}), module: target ?? undefined, tab, n: p.n + 1 }));
  });
  useEffect(() => {
    if (nav.n && nav.module && nav.anchor) pulseAnchor(root.current, nav.anchor, controlHeadings(nav.module, nav.anchor, t), "[data-settings-body]");
  }, [nav.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadRelease, [loadRelease]);

  const q = query.trim().toLowerCase();
  const matches = (id: ModuleId) => `${t(`set.mod.${id}`)} ${t(`set.modDesc.${id}`)} ${t(`set.cat.${MODULES[id].cat}`)} ${id}`.toLowerCase().includes(q);

  if (module && available.includes(module)) {
    const cat = MODULES[module].cat;
    return (
      <div ref={root} className="flex h-full flex-col">
        <h2 className="border-b border-white/10 px-3 py-2 text-center text-sm font-semibold text-white">{t(`set.cat.${cat}`)}</h2>
        <nav className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5 text-xs" aria-label="Breadcrumb">
          <button onClick={() => setTree((v) => !v)} className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200 max-sm:hidden" aria-label={t("set.toggleTree")} title={t("set.toggleTree")}>
            {tree ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <button onClick={() => setModule(null)} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-200 hover:bg-white/10">
            <ChevronLeft size={14} /> {t("set.all")}
          </button>
          <ChevronRight size={12} className="text-slate-600" />
          <button onClick={() => setModule(inCat(cat)[0])} className="rounded-md px-1.5 py-1 text-slate-400 hover:bg-white/10 hover:text-slate-200">{t(`set.cat.${cat}`)}</button>
          <ChevronRight size={12} className="text-slate-600" />
          <span className="min-w-0 font-semibold text-white" aria-current="page">{t(`set.mod.${module}`)}</span>
          <button onClick={() => showGuide(MODULES[module].guide)} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-slate-300 hover:bg-white/10">
            <CircleHelp size={13} /> {t("set.guide")}
          </button>
        </nav>
        <div className="flex min-h-0 flex-1">
          {tree && (
            <aside style={{ width: treeW }} className="shrink-0 overflow-auto bg-black/20 p-2 pb-8 max-sm:hidden" aria-label={t(`set.cat.${cat}`)}>
              {inCat(cat).map((id) => {
                const Icon = MODULES[id].icon;
                return (
                  <button
                    key={id}
                    onClick={() => setModule(id)}
                    aria-current={id === module}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${id === module ? "bg-white/12 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
                  >
                    <Icon size={13} className="shrink-0" /> <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">{t(`set.mod.${id}`)}</span>
                    {id === "features-services" && <FeatureCount compact />}
                    {dots[id] && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dots[id]}`} aria-hidden />}
                  </button>
                );
              })}
            </aside>
          )}
          {tree && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("set.resizeTree")}
              title={t("set.resizeTree")}
              aria-valuenow={treeW}
              aria-valuemin={TREE_MIN}
              aria-valuemax={TREE_MAX}
              tabIndex={0}
              onPointerDown={dragTree}
              onDoubleClick={() => resizeTree(TREE_DEFAULT)}
              onKeyDown={(e) => (e.key === "ArrowLeft" ? resizeTree(treeW - 16) : e.key === "ArrowRight" ? resizeTree(treeW + 16) : undefined)}
              className="w-1.5 shrink-0 cursor-col-resize touch-none border-l border-white/10 transition-colors hover:bg-sky-400/30 focus-visible:bg-sky-400/50 focus-visible:outline-none max-sm:hidden"
            />
          )}
          <div className="min-w-0 flex-1">
            <ModuleBody key={`${module}:${nav.n}`} id={module} tab={nav.module === module ? nav.tab : undefined} />
          </div>
        </div>
      </div>
    );
  }

  const hits = q ? available.filter(matches) : [];
  return (
    <div ref={root} className="h-full overflow-auto pb-8">
      <HostSummary query={query} setQuery={setQuery} onEnter={() => hits[0] && setModule(hits[0])} />
      {q ? (
        <div className="mt-4 grid grid-cols-2 gap-2 px-4 sm:grid-cols-3 xl:grid-cols-4">
          {hits.map((id) => (
            <Tile key={id} id={id} dot={dots[id]} onOpen={() => setModule(id)} />
          ))}
          {!hits.length && <p className="col-span-full py-8 text-center text-sm text-slate-400">{t("set.noMatch")}</p>}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3 px-4">
          {CATEGORIES.filter((c) => inCat(c).length).map((c) => (
            <CategoryCard key={c} id={c} onOpen={() => setModule(inCat(c)[0])} />
          ))}
        </div>
      )}
    </div>
  );
}
