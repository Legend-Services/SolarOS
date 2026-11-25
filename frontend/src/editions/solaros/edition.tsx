import type { Edition } from "../types";

/** SolarOS: the standalone hypervisor OS (Ubuntu, libvirt/QEMU-KVM, Incus, OpenZFS) with SolarDeck as its web UI. */
export const edition: Edition = {
  id: "solaros",
  product: () => ({ name: "SolarOS", short: "SolarOS", slug: "solaros" }),
  defaultDriver: "native_ubuntu",
  platformLabel: "SolarOS",
  platform: "SolarOS",
  host: "the host",
  platformApi: "the hypervisor",
  trademarkNotice: null,
  legacyStorageKeys: {},

  updatesIntro: "",
  hostHelperNote: "",
  networkReadOnlyNote: "Read-only view, so a typo cannot cut off access to the host.",
  isoDeployNote: null,

  kernelHeaders: "the kernel headers",
  firmwarePackage: "linux-firmware",
  firmwareSource: "linux-firmware",

  subscriptionWarning: null,
  addRepositoryTitle: "Add a repository",

  bridgePrefix: "br",
  hostExample: "server.example.com",
  certNodeLabel: null,
  certApplyNote: "The key is checked against the certificate before anything is changed.",

  localRealm: "local",
  vmUserRole: "VMUser",
  serviceUserFallback: "",
  realmsNote: null,
  webUiPort: "443",
  destPortHint: "22, 80:443, 5900",
  firewallLockout: (
    <>
      The inbound policy will drop traffic and no enabled rule accepts SSH (22) or SolarDeck (443). You may lose access to the host and to SolarDeck.
      Add an ACCEPT rule for <span className="font-mono">443</span> and <span className="font-mono">22</span> first.
    </>
  ),

  bootMirrorNote: null,
  diskTuningRulesFile: "/etc/udev/rules.d/",
  calendarHint: 'e.g. "sat 04:30"',
  versionLabel: "Platform",

  help: { tutorials: {}, faqs: {} },
};
