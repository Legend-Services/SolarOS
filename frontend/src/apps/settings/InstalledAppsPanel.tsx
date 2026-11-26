import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card } from "../ControlPanelApp";
import { GlassBadge, GlassButton, Notice } from "../../components/ui/GlassKit";
import { InstanceRow, UninstallInstanceModal, useAppInstances } from "../../components/AppInstances";
import type { AppInstance } from "../../lib/types";
import { useTranslation } from "../../i18n";

/** Settings > Hypervisor & Runtime > Installed Apps & Instances: every App Center instance, grouped by app. */
export default function InstalledAppsPanel() {
  const { t } = useTranslation();
  const { instances, error, reload } = useAppInstances();
  const [removing, setRemoving] = useState<AppInstance | null>(null);
  const groups = new Map<string, AppInstance[]>();
  for (const i of instances ?? []) groups.set(i.app_name, [...(groups.get(i.app_name) ?? []), i]);

  return (
    <Card
      title={t("inst.settingsTitle")}
      action={
        <GlassButton size="xs" variant="ghost" onClick={reload} aria-label={t("common.refresh")}>
          <RefreshCw size={12} />
        </GlassButton>
      }
    >
      <Notice error={error} />
      {!instances && !error && <p className="text-xs text-slate-400">{t("common.loading")}</p>}
      {instances?.length === 0 && <p className="text-xs text-slate-400">{t("inst.empty")}</p>}
      <div className="space-y-4">
        {[...groups].map(([name, list]) => (
          <section key={name} aria-label={name}>
            <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-white">
              {name}
              <GlassBadge tone="success">{list.length === 1 ? t("inst.installed") : t("inst.count", { count: list.length })}</GlassBadge>
            </h4>
            <div className="space-y-1.5">
              {list.map((i) => (
                <InstanceRow key={i.instance_id} inst={i} onUninstall={setRemoving} openLabel={t("inst.openApp")} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <UninstallInstanceModal instance={removing} onClose={() => setRemoving(null)} />
    </Card>
  );
}
