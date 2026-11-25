import type { ReactNode } from "react";
import type { Faq, Tutorial } from "../apps/help/content";

/** Product branding; logos live at /brand/<slug>-logo.svg, -logo-light.svg and -mark.svg. */
export interface Product {
  name: string;
  short: string;
  slug: string;
}

/**
 * Everything that differs between the editions built from this codebase. Vite aliases `@edition` to
 * src/editions/<VITE_EDITION>/edition (see vite.config.ts). A `null` text hides the element that shows it.
 */
export interface Edition {
  id: string;
  /** Branding for the reported hypervisor driver (capabilities.driver). */
  product: (driver: string) => Product;
  /** Capabilities used until /system/capabilities answers. */
  defaultDriver: string;
  platformLabel: string;
  /** Short platform name inside sentences ("… will not show it again"). */
  platform: string;
  /** The host inside sentences, e.g. "on <host>", "<host>'s IP address". */
  host: string;
  /** What the hardware inventory falls back to without the SSH bridge. */
  platformApi: string;
  trademarkNotice: string | null;
  /** localStorage keys copied once to their new name before the stores hydrate. */
  legacyStorageKeys: Record<string, string>;

  /* Settings → updates and network */
  updatesIntro: string;
  /** Appended to the updates note when the host helper is not updated in place. */
  hostHelperNote: string;
  networkReadOnlyNote: string;
  /** Appended to the installer ISO build hint ("… for an unattended VM test entry<note>."). */
  isoDeployNote: ReactNode | null;

  /* Hardware */
  kernelHeaders: string;
  firmwarePackage: string;
  /** Where the GPU firmware comes from ("The GuC/HuC firmware comes with …"). */
  firmwareSource: string;

  /* System */
  subscriptionWarning: ReactNode | null;
  addRepositoryTitle: string;

  /* Network & Services */
  bridgePrefix: string;
  hostExample: string;
  certNodeLabel: string | null;
  certApplyNote: string;

  /* Datacenter */
  localRealm: string;
  vmUserRole: string;
  serviceUserFallback: string;
  realmsNote: string | null;
  webUiPort: string;
  destPortHint: string;
  firewallLockout: ReactNode;

  /* Storage, backups, monitor */
  bootMirrorNote: ReactNode | null;
  diskTuningRulesFile: string;
  calendarHint: string;
  versionLabel: string;

  /** Help Center: replaces (or with null removes) shared tutorials and FAQs by id. */
  help: { tutorials: Record<string, Tutorial | null>; faqs: Record<string, Faq | null> };
}
