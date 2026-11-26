import type { Edition } from "../types";

/** SolarDeck for Proxmox VE: the desktop in an LXC container on a Proxmox VE host. */
export const edition: Edition = {
  id: "proxmox",
  product: (driver) =>
    driver === "native_ubuntu"
      ? { name: "SolarOS", short: "SolarOS", slug: "solaros" }
      : { name: "SolarDeck for Proxmox VE", short: "SolarDeck", slug: "solardeck-proxmox" },
  defaultDriver: "proxmox",
  platformLabel: "Proxmox VE",
  platform: "Proxmox",
  host: "the Proxmox host",
  platformApi: "the Proxmox API",
  trademarkNotice:
    "SolarDeck is an independent open-source project and is not affiliated with or endorsed by Proxmox Server Solutions GmbH. Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.",
  legacyStorageKeys: {
    "proxmoxos-prefs": "solardeck-prefs",
    "proxmoxos-dock": "solardeck-dock",
    "proxmoxos-layout": "solardeck-layout",
    "proxmoxos-wizard": "solardeck-wizard",
    "proxmoxos.seenAlerts": "solardeck.seenAlerts",
  },

  updatesIntro: "Both editions (SolarDeck for Proxmox VE and SolarOS) update from the same branch. ",
  hostHelperNote: " Host helper changes still need install.sh on the Proxmox host.",
  networkReadOnlyNote: "Read-only view. Network changes are made in the Proxmox web UI so a typo cannot cut off access to the host.",
  isoDeployNote: (
    <>
      {" "}and <span className="font-mono">--deploy-to-pve</span> on a Proxmox VE host
    </>
  ),

  kernelHeaders: "Proxmox kernel headers",
  firmwarePackage: "pve-firmware",
  firmwareSource: "Proxmox (pve-firmware)",

  subscriptionWarning: (
    <>
      The Enterprise repository only works with a Proxmox subscription. Without one, <b>apt update</b> fails. Disable the Enterprise repositories and add{" "}
      <b>No-Subscription</b> below.
    </>
  ),
  addRepositoryTitle: "Add a Proxmox repository",

  bridgePrefix: "vmbr",
  hostExample: "pve.example.com",
  certNodeLabel: "Apply to the Proxmox node (port 8006)",
  certApplyNote: "The key is checked against the certificate before anything is changed. Applying to the node restarts pveproxy (the Proxmox web UI reconnects).",

  localRealm: "pve",
  vmUserRole: "PVEVMUser",
  serviceUserFallback: "pve-desktop@pve",
  realmsNote: "Realms (LDAP, AD, OpenID) are configured in the Proxmox web UI.",
  webUiPort: "8006",
  destPortHint: "22, 80:443, 8006,5900",
  firewallLockout: (
    <>
      The inbound policy will drop traffic and no enabled rule accepts SSH (22) or the Proxmox web UI (8006). You may lose access to the host and to SolarDeck.
      Add an ACCEPT rule for <span className="font-mono">8006</span> and <span className="font-mono">22</span> first.
    </>
  ),

  bootMirrorNote: (
    <>
      {" "}On a boot mirror, also run <span className="font-mono">proxmox-boot-tool format</span>{" "}
      and <span className="font-mono">init</span> on the new EFI partition so the server can boot from it.
    </>
  ),
  diskTuningRulesFile: "/etc/udev/rules.d/69-proxmoxos-disk-tuning.rules",
  calendarHint: 'Proxmox syntax, e.g. "sat 04:30"',
  versionLabel: "PVE",

  help: {
    tutorials: {
      "replace-raid-disk": {
        id: "replace-raid-disk",
        title: "Replace a failing disk in a ZFS mirror or RAIDZ pool",
        category: "Storage & files",
        minutes: 6,
        keywords: "replace failing broken dead disk drive raid mirror raidz degraded faulted offline hot swap resilver pool errors",
        intro: "A redundant pool (mirror, RAID10, RAIDZ) keeps working when one disk fails. Swap the bad disk while the server keeps running and ZFS rebuilds its data onto the new one.",
        steps: [
          { text: "Open ZFS Pools. A failing disk shows DEGRADED or FAULTED, or has numbers in the Read / Write / Cksum columns.", link: { app: "storage", intent: "pools" } },
          { text: "Note the failing disk's name, then find its serial number in Disks & SMART (List view shows Device & By-ID next to the serial). The serial is printed on the disk's label.", link: { app: "storage", intent: "disks" } },
          { text: "Back in ZFS Pools, press Set Offline on that disk and confirm. ZFS stops using it; the pool keeps running from the other disks. The button is disabled when removing the disk would take the pool down." },
          { text: "Remove the disk with the matching serial and insert the new one. Hot-swap bays allow this while the server runs; otherwise shut down first (the disk stays offline)." },
          { text: "Press Refresh, then Replace Disk on the offline member. Pick the new drive (it must be at least as large as the old one), type its device path to confirm and start." },
          { text: "ZFS resilvers: the pool card shows a progress bar. When it reaches 100% and the pool is ONLINE again, you are protected again. Run a Scrub afterwards to double-check." },
          { text: "Boot pool (rpool)? Keep 'Copy the old disk's partition layout' switched on so the new disk gets the same partitions, then make it bootable with proxmox-boot-tool format and init on its EFI partition." },
        ],
      },
      https: {
        id: "https",
        title: "Get a padlock (HTTPS certificate)",
        category: "Network & internet",
        minutes: 6,
        keywords: "https ssl tls certificate lets encrypt acme padlock secure domain",
        intro: "A certificate removes browser security warnings.",
        steps: [
          { text: "Open Settings → Network & Services → Domains & Certificates.", link: { app: "netservices" } },
          { text: "Let's Encrypt: register an account, add your domain (and a DNS plugin if the host isn't reachable from the internet) and press Order." },
          { text: "Own certificate: paste the certificate and private key and apply them to Proxmox and/or SolarDeck." },
        ],
      },
      users: {
        id: "users",
        title: "Give other people access (users, groups and permissions)",
        category: "Security & users",
        minutes: 4,
        keywords: "user users account group role permission acl access family colleague token api pool",
        intro: "Proxmox users can log in to the Proxmox web UI with only the rights you give them.",
        steps: [
          { text: "Open Settings → Privilege & Security → Users & Roles → Users and press 'Add user' (realm 'pve', set a password).", link: { app: "datacenter" } },
          { text: "Optional: put users in a Group and VMs in a Pool to manage many at once." },
          { text: "Settings → Privilege & Security → Users & Roles → Permissions → Add: choose the user or group, a path (e.g. /vms/101 or /pool/family) and a role such as PVEVMUser." },
        ],
      },
      firewall: {
        id: "firewall",
        title: "Turn on the firewall safely",
        category: "Security & users",
        minutes: 4,
        keywords: "firewall rule block allow port security incoming",
        intro: "The Proxmox firewall filters traffic to the host and to each VM.",
        steps: [
          { text: "Open Settings → Network & Services → Firewall & Port Forwarding.", link: { app: "datacenter" } },
          { text: "First add rules that ALLOW TCP 8006 (Proxmox), 22 (SSH) and 80/443 (SolarDeck) from your network." },
          { text: "Only then enable the firewall. SolarDeck warns you if you are about to lock yourself out." },
        ],
      },
      updates: {
        id: "updates",
        title: "Update the server and SolarDeck",
        category: "System & updates",
        minutes: 3,
        keywords: "update upgrade apt packages security patch new version solardeck repository 401 enterprise",
        intro: "There are two kinds of updates: the Proxmox host itself and the SolarDeck desktop.",
        fix: "repos",
        steps: [
          { text: "Host: open Settings → System → System Services & Repositories → OS Updates, press Refresh, then Upgrade.", link: { app: "system" } },
          { text: "Seeing '401 Unauthorized'? Your server uses the paid Enterprise source — the Help Center fix switches to the free one." },
          { text: "SolarDeck: Settings → System → Info → 'Check for Updates'.", link: { app: "controlpanel", intent: "power" } },
        ],
      },
    },
    faqs: {
      password: { q: "I forgot the SolarDeck password. What now?", a: "On the Proxmox host, run: pct exec <container-id> -- grep ADMIN_PASSWORD /opt/proxmox-os/backend/.env — or set a new one in that file and restart the backend (systemctl restart proxmox-os-backend inside the container).", keywords: "forgot password reset login locked out" },
      "2fa": { q: "I lost my 2FA phone and can't sign in.", a: "On the Proxmox host run: pct exec <container-id> -- rm /opt/proxmox-os/backend/data/security.json — this turns 2FA off. Set it up again afterwards.", keywords: "2fa lost phone code locked out authenticator" },
      "repo-401": { q: "Updates fail with '401 Unauthorized'.", a: "The paid Enterprise update source is enabled without a subscription. Use Fix problems → 'Update sources' to switch to the free No-Subscription source in one click.", keywords: "update 401 unauthorized enterprise repository apt error" },
      break: { q: "Will SolarDeck break my Proxmox server?", a: "SolarDeck uses the official Proxmox API and standard tools. Risky actions always ask for confirmation, and every Help Center fix shows exactly what it changes and how to undo it.", keywords: "safe break damage risk" },
      "web-ui": { q: "Can I still use the normal Proxmox web interface?", a: "Yes. Open https://<host-ip>:8006. Both work side by side.", keywords: "proxmox web ui 8006 normal interface both" },
      "more-help": { q: "How do I get more help?", a: "Run Fix problems first. For anything else, the Proxmox forum (forum.proxmox.com) and documentation (pve.proxmox.com/wiki) are excellent.", keywords: "help support forum contact more" },
    },
  },
};
