import { APPS, APP_IDS, type AppId } from "../apps/registry";
import { CATEGORIES, MODULES, MODULE_IDS, type CategoryId, type ModuleId } from "../apps/settings/modules";
import { en, type TKey } from "../i18n/en";
import type { Capabilities } from "../store/capabilitiesStore";

/*
 * One registry behind the TopBar Global Search, the Help & Support manual and the generated docs/ folder
 * (scripts/generate-support-docs.mjs imports this file from the dev server). Apps, categories and sub-modules come
 * from apps/registry.ts and apps/settings/modules.ts; only their help texts and the inner controls are written here.
 */

export type Translate = (key: TKey) => string;
type Cap = keyof Pick<Capabilities, "supports_zfs" | "supports_bios_manager" | "supports_apt_repos">;

/** Where a search result or an "Open" button goes. */
export type NavTarget =
  | { kind: "app"; appId: AppId }
  | { kind: "settings"; category?: CategoryId; module?: ModuleId; tab?: string; anchor?: string }
  | { kind: "help"; article: string; section?: string; term?: string };

/** Settings sub-sub-module: a tab, panel or key control inside a sub-module. */
export interface Control {
  id: string;
  categoryId: CategoryId;
  moduleId: ModuleId;
  /** Inner tab of the sub-module (ModuleBody passes it on as the panel's initial tab). */
  tabId?: string;
  /** DOM anchor: `data-anchor` value, else the card whose heading reads one of `headings`. */
  anchorId: string;
  headings?: string[];
  /** A translated heading to look for (the card title follows the interface language). */
  headingKey?: TKey;
  titleKey: TKey;
  description: string;
  keywords: string;
  steps: string[];
  tips?: string[];
  /** Captured by the screenshot script (major screens only; the rest reuse their sub-module's picture). */
  shot?: boolean;
  requires?: Cap;
}

export interface ArticleSection {
  sectionId: string;
  subTitle: string;
  bodyText: string;
  steps: string[];
  tips: string[];
  screenshotPath?: string;
}

export type ArticleCategory = "apps" | CategoryId;

export interface Article {
  articleId: string;
  mainTitle: string;
  category: ArticleCategory;
  relatedAppId?: AppId;
  relatedCategoryId?: CategoryId;
  relatedModuleId?: ModuleId;
  relatedSubSectionId?: string;
  screenshotPath: string;
  target: NavTarget;
  keywords: string;
  sections: ArticleSection[];
  requires?: Cap;
}

const shot = (slug: string) => `/docs/screenshots/${slug}.png`;

/* ---------------- Authored help texts ---------------- */

interface Doc {
  intro: string;
  steps: string[];
  tips?: string[];
  keywords: string;
}

export const APP_DOCS: Partial<Record<AppId, Doc>> = {
  settings: {
    intro: "Settings is the hub for every system, storage, security, network and hypervisor option. Five main categories hold the sub-modules; each sub-module opens the screens it owns.",
    steps: [
      "Open Settings from the Dock, the App Gallery or the TopBar search.",
      "Type in the search field at the top to filter sub-modules, or click a tile.",
      "Inside a sub-module, use the left tree to jump to another one and the breadcrumb to go back to all settings.",
      "Press “? Guide” in the breadcrumb for a step-by-step tour of the current screen.",
    ],
    tips: ["The language buttons next to the search field switch the whole desktop between English, Nederlands, Deutsch, Español and Français."],
    keywords: "settings preferences configuration control panel options hub system",
  },
  compute: {
    intro: "Compute Manager lists every virtual machine and container with live status, and creates, starts, stops, edits and opens the console of each one.",
    steps: [
      "Press “New VM” or “New Container” to start the guided wizard.",
      "Use the play, stop and restart buttons on a row to control a guest.",
      "Click a guest's name to open its settings drawer: CPU, memory, disks, network cards, snapshots and passthrough devices.",
      "Press Console (VMs) or Shell (containers) to see the screen or get a root prompt.",
    ],
    tips: ["Install media lives in the ISO & Template Library; download an ISO there before creating a VM."],
    keywords: "vm virtual machine container lxc guest create start stop console snapshot compute",
  },
  files: {
    intro: "File Station browses the folders on your storage: upload, download, rename, move and delete files from the browser.",
    steps: ["Pick a storage location in the left sidebar.", "Double-click a folder to open it; use the path bar to go back.", "Drag files onto the window or press Upload to add them.", "Right-click a file for rename, download and delete."],
    tips: ["Folders you share with the network are managed in Settings › Storage & Data › Shared Folders & SMB."],
    keywords: "files folders browse upload download explorer file manager documents",
  },
  appcenter: {
    intro: "App Center installs ready-made applications (media servers, ad blockers, home automation and more) into their own container with one click.",
    steps: ["Browse the categories or search for an app.", "Open an app card and review the suggested resources.", "Press Deploy and wait until the job log says done.", "Open the address shown on the deployment card to use the app."],
    tips: ["Tick Storage when the app should see your files."],
    keywords: "app center store install deploy one click media docker apps marketplace",
  },
  "local-ai": {
    intro: "Local AI Studio downloads AI models and runs them on your own hardware, with a private chat to test them. Nothing leaves your server.",
    steps: ["Open the model library and download a model that fits your GPU memory.", "Start a new chat and pick the model at the top.", "Add custom instructions to shape the answers."],
    tips: ["GPU assignment and the model storage folder are in Settings › Hypervisor & Runtime › Local AI Runtime."],
    keywords: "ai llm model chat gpu local private assistant inference studio",
  },
  terminal: {
    intro: "Terminal opens an instant root command line on the host and on its containers, right in the browser.",
    steps: ["Open Terminal from the Dock or the terminal icon in the TopBar.", "Choose the host or a running container.", "Type commands; copy and paste work as usual."],
    tips: ["Commands on the host affect every guest. Take a snapshot before risky changes."],
    keywords: "terminal shell command line root ssh console cli bash",
  },
  help: {
    intro: "Help & Support holds this manual, an offline “Ask” search, one-click problem fixes, BIOS guides, tutorials and the FAQ.",
    steps: ["Pick Manual to read the illustrated guide for every app and setting.", "Use the filter field above the article tree to find a topic.", "Press “Open This Setting / App →” in an article to jump straight to that screen.", "Fix problems runs a health check and fixes common issues for you."],
    keywords: "help support manual documentation guide tutorial faq fix troubleshoot",
  },
};

/** A new app without its own entry still gets an article from its registry description. */
const appDoc = (id: AppId): Doc => APP_DOCS[id] ?? { intro: APPS[id].desc, steps: [], keywords: id };

export const MODULE_DOCS: Record<ModuleId, Doc> = {
  "general-appearance": {
    intro: "Personalize the desktop: themes, light and dark mode, wallpapers, language, widgets, the Dock and the desktop layout.",
    steps: ["Pick a theme in the Theme Gallery and choose Dark, Light or Auto.", "Scroll down to set the language, widgets, layout and Dock behaviour."],
    keywords: "appearance theme dark light mode wallpaper language dock widgets layout personalize look",
  },
  "hardware-gpu": {
    intro: "See the CPU, memory, GPUs, PCIe and IOMMU groups and network adapters of the host, and switch the GPU driver mode.",
    steps: ["Read the CPU and memory cards for model, cores, temperature and usage.", "In GPU & Drivers, choose between host use and passthrough to a VM."],
    keywords: "hardware gpu cpu memory pcie iommu passthrough driver graphics card nic",
  },
  "bios-firmware": {
    intro: "Check whether a newer BIOS exists for your motherboard, read the recommended BIOS settings for virtualization and take the guide along on your phone.",
    steps: ["Read the detected motherboard and BIOS version.", "Open a guide card for the setting you need (virtualization, IOMMU, power).", "Press the QR button and scan it with your phone to read the steps while you are in the BIOS."],
    keywords: "bios uefi firmware motherboard update virtualization iommu qr phone",
    tips: ["The QR guide works offline: the text is inside the code."],
  },
  "resource-monitor": {
    intro: "Live CPU, memory, network, GPU and temperature telemetry of the host.",
    steps: ["Performance shows live graphs for CPU, memory and network.", "GPU & Sensors shows GPU load, video engines and temperatures."],
    keywords: "monitor cpu ram memory network usage graphs temperature sensors live telemetry performance",
  },
  "software-updates": {
    intro: "Keep SolarDeck and the operating system up to date, choose package sources, roll back a release and report bugs.",
    steps: ["SolarDeck Updates checks for a new release and installs it.", "OS Repositories chooses the package sources.", "OS Updates lists and installs pending operating system packages."],
    keywords: "update upgrade release version rollback downgrade repository packages bug report",
  },
  "system-services": {
    intro: "Start, stop, restart and enable the background services of the host and of deployed apps.",
    steps: ["Find a service in the list (filter by name).", "Use the buttons on its row to start, stop, restart or enable it at boot."],
    keywords: "services daemons systemd start stop restart enable boot background",
  },
  "automation-alerts": {
    intro: "Send alerts to chat, webhook and email channels and build no-code rules that react to server events.",
    steps: ["Set up at least one notification channel and press Test.", "Create a rule: pick a trigger, a condition and an action.", "Check the Execution Log to see when rules fired."],
    keywords: "automation alerts notifications rules triggers webhook email smtp chat no-code",
  },
  "host-power": {
    intro: "Reboot or shut down the host, see its uptime and open the host console.",
    steps: ["Press Reboot or Shut down in the Power card and confirm.", "Running guests are stopped cleanly first."],
    keywords: "power reboot restart shutdown uptime host console",
  },
  "storage-zfs": {
    intro: "Manage ZFS pools (single, mirror, RAIDZ), datasets and volumes, snapshots and schedules, disk SMART health and benchmarks.",
    steps: ["Overview shows capacity and health of every pool.", "ZFS Pools creates a pool from free disks.", "Disks & SMART shows health per disk; Benchmark measures speed."],
    keywords: "storage zfs pool raidz mirror dataset volume zvol snapshot disk smart benchmark capacity",
  },
  "backup-restore": {
    intro: "Back up virtual machines and containers to archives, schedule backups and restore any point in time.",
    steps: ["Press Back Up Now and choose the guests and the target storage.", "Create a schedule under Schedules for automatic backups.", "Select an archive and press Restore to bring a guest back."],
    keywords: "backup restore archive schedule retention point in time recovery",
  },
  "shared-folders": {
    intro: "Share folders with every computer and phone on your network over SMB, with per-user permissions.",
    steps: ["Press New shared folder, choose a path and a name.", "Add share users under Users and give them read or write access.", "Connect from another computer with the address shown on the share card."],
    keywords: "share smb samba network folder nas permissions users file sharing",
  },
  "iso-templates": {
    intro: "Download and upload bootable ISO images, cloud images and container templates used by the VM and container wizards.",
    steps: ["Paste a download link and press Download, or upload a file from your computer.", "Container templates can be downloaded from the template list."],
    keywords: "iso image template cloud image installer download upload container template",
  },
  "users-roles": {
    intro: "Local users, groups, roles, permissions, resource pools, API tokens and authentication realms.",
    steps: ["Create a user under Users and add it to a group.", "Give the user or group a role on a path under Permissions.", "Create API tokens for scripts and integrations."],
    keywords: "users groups roles permissions acl pools api tokens realms accounts access",
  },
  "security-2fa": {
    intro: "Change the admin password, turn on TOTP two-factor authentication with recovery codes and manage active sessions.",
    steps: ["Change the password in the first card.", "Press Enable 2FA, scan the QR code with an authenticator app and confirm a code.", "Store the recovery codes somewhere safe."],
    keywords: "security password 2fa totp two factor authenticator recovery codes sessions login",
  },
  "security-posture": {
    intro: "A live 0–100 security score with kernel and SSH hardening checks and one-click remediation.",
    steps: ["Read the score and the list of checks.", "Press Fix on a failed check to apply the recommended hardening.", "Export the report for your records."],
    keywords: "security posture score hardening ssh kernel audit compliance remediation",
  },
  "audit-logs": {
    intro: "A tamper-evident, hash-chained audit log of every administrative action, and the host's system logs.",
    steps: ["Audit Log lists who did what and when.", "Press Verify to check the hash chain has not been altered.", "Host Logs shows the system journal."],
    keywords: "audit log logs journal history integrity hash chain tamper events",
  },
  "network-switch": {
    intro: "A visual virtual switch: VLANs as color-coded cards, drag-and-drop patching of ports, virtual NICs, host IP settings and a DHCP server per VLAN. Changes are applied with a 60-second rollback guard.",
    steps: ["Visual Switch shows every switch with its physical and virtual ports.", "Drag a port onto a VLAN card to patch it; drop it on the trunk zone to carry several VLANs.", "Press Apply safely, then Keep Settings within 60 seconds."],
    tips: ["Without confirmation the previous network configuration comes back by itself, so a wrong address cannot lock you out."],
    keywords: "network switch bridge vlan nic virtual nic ip address dhcp trunk port patch panel",
  },
  "network-topology": {
    intro: "An interactive live map of the host, its switches, guests and VPN connections.",
    steps: ["Drag to pan and scroll to zoom.", "Click a node to see its details and open the screen that owns it."],
    keywords: "topology map network diagram graph live nodes",
  },
  "dns-dhcp": {
    intro: "A local DNS resolver with ad blocking and custom records, and the network-wide DHCP server.",
    steps: ["DNS & AdBlock turns on the resolver and the block lists.", "DHCP hands out addresses to the whole network; add static leases there."],
    keywords: "dns adblock ad blocking resolver records dhcp leases addresses",
  },
  "domains-certs": {
    intro: "Local domain names and TLS certificates (Let's Encrypt or your own) for the web interface.",
    steps: ["Add a domain under Domains.", "Request or upload a certificate under Certificates."],
    keywords: "domain certificate tls ssl https lets encrypt acme",
  },
  "firewall-forwarding": {
    intro: "Firewall rules for the host and guests, and NAT port forwarding from the internet to a guest.",
    steps: ["Firewall Rules: add allow or deny rules per port and source.", "Port Forwarding: send an outside port to a guest's address."],
    keywords: "firewall rules ports nat port forwarding router allow deny",
  },
  "wireguard-vpn": {
    intro: "A WireGuard VPN server for remote access, with peers and QR codes for phones, plus a client to join another VPN.",
    steps: ["Turn on the server and add a peer per device.", "Scan the peer's QR code with the WireGuard app on your phone."],
    keywords: "vpn wireguard remote access peer qr phone tunnel",
  },
  "hypervisor-defaults": {
    intro: "Default CPU, memory and disk profiles for new VMs and containers, the default storage target and nested virtualization.",
    steps: ["Adjust the VM and container profiles.", "Choose the default storage target.", "Turn on nested virtualization if guests run their own hypervisor."],
    keywords: "hypervisor defaults profile cpu memory disk nested virtualization storage target",
  },
  "local-ai-runtime": {
    intro: "Which GPU runs the AI models, the AI model service and where models are stored.",
    steps: ["Pick the GPU under GPU assignment.", "Choose a model storage folder with enough space."],
    keywords: "ai runtime gpu model storage service inference",
  },
};

type C = Omit<Control, "categoryId" | "moduleId" | "anchorId"> & { anchorId?: string };
const c = (moduleId: ModuleId, items: C[]): Control[] =>
  items.map((x) => ({ ...x, moduleId, categoryId: MODULES[moduleId].cat, anchorId: x.anchorId ?? x.id }));

/** Every Settings sub-sub-module, tab and key control, in Settings order. */
export const CONTROLS: Control[] = [
  ...c("general-appearance", [
    { id: "theme-studio", titleKey: "kb.theme-studio", headings: ["Theme Gallery"], shot: true, description: "Choose, create, import and export desktop themes, and switch between Dark, Light and Auto mode.", keywords: "theme studio gallery dark light auto mode colors accent style import export", steps: ["Click a theme card to apply it.", "Use the Dark / Light / Auto switch at the top of the gallery.", "Press New theme to edit colors, style and wallpapers, then Save."], tips: ["Export a theme as a file to use it on another server."] },
    { id: "wallpapers", titleKey: "kb.wallpapers", headings: ["Wallpapers"], description: "Pick or upload the desktop wallpaper for dark and light mode.", keywords: "wallpaper background image desktop picture", steps: ["Open a theme in the editor.", "Choose a wallpaper or upload your own image."] },
    { id: "language", titleKey: "common.language", headingKey: "common.language", description: "Switch the whole interface between English, Nederlands, Deutsch, Español and Français.", keywords: "language translation english dutch german spanish french locale", steps: ["Click a language in the Language card. The change is immediate."] },
    { id: "desktop-widgets", titleKey: "kb.desktop-widgets", headingKey: "cp.desktop", description: "Show or hide the live widgets on the desktop and customize which ones appear.", keywords: "widgets desktop cards clock cpu storage", steps: ["Turn Show desktop widgets on or off.", "Press Customize widgets to add, remove and arrange them."] },
    { id: "desktop-layout", titleKey: "kb.desktop-layout", headings: ["Desktop Layout"], description: "Choose between the Dock with TopBar and the taskbar layout, and set icon sizes.", keywords: "layout taskbar dock topbar icons size", steps: ["Pick a layout and an icon size in Desktop Layout."] },
    { id: "dock", titleKey: "kb.dock", headings: ["Dock"], description: "Dock magnification and auto-hide.", keywords: "dock magnification auto hide icons", steps: ["Choose a magnification strength.", "Turn on auto-hide to give open apps more room."] },
  ]),
  ...c("hardware-gpu", [
    { id: "cpu-memory", titleKey: "kb.cpu-memory", headings: ["CPU", "Memory"], description: "Processor model, cores, temperature and memory modules of the host.", keywords: "cpu processor cores threads temperature memory ram modules", steps: ["Read the CPU and Memory cards at the top of Hardware & GPU."] },
    { id: "gpu-drivers", titleKey: "kb.gpu-drivers", headings: ["GPU & Drivers"], shot: true, description: "Every GPU with its IOMMU group, and the driver mode: used by the host or passed through to a VM.", keywords: "gpu graphics card driver passthrough iommu vfio host mode", steps: ["Find your GPU in the GPU & Drivers card.", "Choose Passthrough to give it to a VM, or Host to use it on the server.", "Reboot when asked."], tips: ["IOMMU must be enabled in the BIOS; see BIOS & Firmware."] },
    { id: "motherboard", titleKey: "kb.motherboard", headings: ["System & Motherboard"], description: "Motherboard model, BIOS version and system details.", keywords: "motherboard board system vendor model bios version", steps: ["Read the System & Motherboard card."] },
    { id: "network-adapters", titleKey: "kb.network-adapters", headings: ["Network interfaces"], description: "Physical network adapters with link speed and driver.", keywords: "nic network adapter ethernet link speed driver", steps: ["Read the Network interfaces card at the bottom."] },
  ]),
  ...c("bios-firmware", [
    { id: "bios-update", titleKey: "kb.bios-update", headings: ["Your motherboard"], requires: "supports_bios_manager", description: "Detects your motherboard and BIOS version and checks whether a newer BIOS is available, with a verified download.", keywords: "bios update check version download verified firmware", steps: ["Read the detected board and version in Your motherboard.", "Press Check for update and follow the download link when one is found."], tips: ["Never turn the server off while a BIOS is flashing."] },
    { id: "bios-guides", titleKey: "kb.bios-guides", requires: "supports_bios_manager", shot: true, description: "Step-by-step guides for the BIOS settings that matter (virtualization, IOMMU, power) with a QR code to read them on your phone.", keywords: "bios guide virtualization vt-x iommu qr mobile phone settings optimize", steps: ["Open the guide for the setting you need.", "Press the QR button and scan it with your phone.", "Reboot into the BIOS and follow the steps on your phone."] },
  ]),
  ...c("resource-monitor", [
    { id: "live-performance", titleKey: "kb.live-performance", tabId: "performance", description: "Live graphs of CPU, memory and network use.", keywords: "performance graphs cpu memory network live usage", steps: ["Open Resource Monitor; Performance is the first tab."] },
    { id: "gpu-sensors", titleKey: "kb.gpu-sensors", tabId: "hardware", description: "GPU load, video engines and temperature sensors.", keywords: "gpu sensors temperature thermal fans video engine", steps: ["Click GPU & Sensors at the top of Resource Monitor."] },
  ]),
  ...c("software-updates", [
    { id: "solardeck-updates", titleKey: "set.view.solardeck", tabId: "solardeck", shot: true, description: "Check for and install a new SolarDeck release; the update runs in the background and the page reloads when done.", keywords: "solardeck update release install upgrade check", steps: ["Press Check now.", "Press Install update when a new version is shown."] },
    { id: "update-preferences", titleKey: "upd.schedule.title", tabId: "solardeck", headingKey: "upd.schedule.title", description: "Manual or automatic scheduled updates: background checks every 1, 6, 12 or 24 hours, and a daily, weekly or monthly install time.", keywords: "automatic updates preferences schedule manual daily weekly monthly time background check", steps: ["Choose Automatic Scheduled Updates.", "Pick the frequency, day and time, then press Save Schedule."] },
    { id: "version-history", titleKey: "kb.version-history", tabId: "solardeck", headings: ["Version History & Downgrade"], description: "Earlier releases with their notes, and a one-click downgrade.", keywords: "version history downgrade rollback previous release", steps: ["Pick an earlier version and press Install to roll back."] },
    { id: "bug-report", titleKey: "top.reportBug", tabId: "solardeck", headings: ["Report a Bug"], description: "Send a bug report with system details attached.", keywords: "bug report problem issue feedback", steps: ["Describe what happened and press Send."] },
    { id: "os-repositories", titleKey: "set.view.repos", tabId: "repos", requires: "supports_apt_repos", description: "Choose the operating system package sources.", keywords: "repositories package sources apt enterprise community", steps: ["Turn the sources you want on or off and press Save."] },
    { id: "os-updates", titleKey: "set.view.packages", tabId: "packages", description: "Pending operating system package updates.", keywords: "os updates packages upgrade security patches", steps: ["Press Refresh, then Install all."] },
  ]),
  ...c("system-services", [
    { id: "service-manager", titleKey: "kb.service-manager", headings: ["System services"], description: "The background services of the host and deployed apps with start, stop, restart and enable at boot.", keywords: "service manager systemd daemon unit restart enable", steps: ["Filter the list by name.", "Use the row buttons to control a service."] },
  ]),
  ...c("automation-alerts", [
    { id: "notification-channels", titleKey: "kb.notification-channels", description: "Chat, webhook and SMTP email channels that receive alerts.", keywords: "notification channels chat webhook email smtp alerts bot", steps: ["Fill in a channel's details and switch it on.", "Press Test to send a test message."] },
    { id: "automation-rules", titleKey: "kb.automation-rules", shot: true, description: "No-code rules: when a trigger fires and the condition holds, run an action or send an alert.", keywords: "automation rules triggers conditions actions no-code if then", steps: ["Press New rule.", "Choose a trigger (for example a pool degraded or high CPU), a condition and an action.", "Save the rule and switch it on."] },
    { id: "execution-log", titleKey: "auto.logs", headingKey: "auto.logs", description: "When each rule ran and what it did.", keywords: "execution log rule history fired", steps: ["Scroll to the Execution Log at the bottom of Automation & Alerts."] },
  ]),
  ...c("host-power", [
    { id: "power-actions", titleKey: "kb.power-actions", headings: ["Power"], description: "Reboot or shut down the host safely.", keywords: "reboot shutdown power off restart host", steps: ["Press Reboot or Shut down and confirm."], tips: ["Guests with autostart come back on by themselves after a reboot."] },
  ]),
  ...c("storage-zfs", [
    { id: "storage-overview", titleKey: "kb.storage-overview", tabId: "overview", description: "Capacity and health of every pool and storage at a glance.", keywords: "storage overview capacity usage health", steps: ["Open Storage & ZFS Pools; Overview is the first tab."] },
    { id: "zfs-pools", titleKey: "kb.zfs-pools", tabId: "pools", shot: true, requires: "supports_zfs", description: "Create ZFS pools (single, mirror, RAIDZ1/2/3), see their vdevs, scrub and replace disks.", keywords: "zfs pool create raidz mirror vdev scrub replace disk redundancy", steps: ["Press Create pool.", "Pick the free disks and a layout (mirror or RAIDZ).", "Name the pool and press Create."], tips: ["A mirror survives all but one disk failing; RAIDZ1 survives one disk failure."] },
    { id: "zfs-datasets", titleKey: "kb.zfs-datasets", tabId: "datasets", requires: "supports_zfs", description: "Datasets (filesystems) and ZVOLs (block volumes) with compression and quotas.", keywords: "dataset zvol volume filesystem compression quota", steps: ["Press Create, choose Dataset or ZVOL, and set its options."] },
    { id: "disks-smart", titleKey: "kb.disks-smart", tabId: "disks", shot: true, description: "Every physical disk with SMART health, temperature and wipe or initialize tools.", keywords: "disks smart health temperature wipe initialize drive hdd ssd nvme", steps: ["Click a disk to see its SMART attributes.", "Use Wipe only on disks that hold no data you need."] },
    { id: "disk-benchmark", titleKey: "kb.disk-benchmark", tabId: "benchmark", shot: true, description: "Measure the read and write speed and IOPS of a disk or pool.", keywords: "benchmark speed iops read write fio test performance", steps: ["Choose a target and a test profile.", "Press Run and wait for the results."] },
    { id: "zfs-snapshots", titleKey: "kb.zfs-snapshots", tabId: "snapshots", shot: true, description: "ZFS snapshots and automatic snapshot schedules with retention.", keywords: "zfs snapshots schedule retention rollback restore point", steps: ["Press Take snapshot to save the current state.", "Add a schedule to take snapshots automatically.", "Use Rollback to return a dataset to a snapshot."] },
    { id: "storage-backends", titleKey: "kb.storage-backends", tabId: "backends", description: "The storage locations the hypervisor uses for disks, ISOs and backups.", keywords: "storage backends targets directory nfs locations", steps: ["Review the list of storage locations and what each one holds."] },
  ]),
  ...c("backup-restore", [
    { id: "backup-archives", titleKey: "kb.backup-archives", tabId: "backups", description: "Every backup archive with restore and delete.", keywords: "backup archives restore delete back up now", steps: ["Press Back Up Now for an immediate backup.", "Select an archive and press Restore."] },
    { id: "backup-schedules", titleKey: "kb.backup-schedules", tabId: "schedules", shot: true, description: "Automatic backup schedules with retention.", keywords: "backup schedule automatic retention daily weekly", steps: ["Press New schedule.", "Pick the guests, the time and how many backups to keep."] },
  ]),
  ...c("shared-folders", [
    { id: "smb-shares", titleKey: "kb.smb-shares", tabId: "shares", description: "SMB shared folders visible to every computer and phone on the network.", keywords: "smb shares shared folders network samba", steps: ["Press New shared folder and choose a path.", "Copy the address on the card to connect from another computer."] },
    { id: "share-users", titleKey: "kb.share-users", tabId: "users", description: "Users that can connect to the shared folders, with read or write access.", keywords: "share users smb accounts access read write", steps: ["Add a user with a password.", "Give the user access on each share."] },
  ]),
  ...c("users-roles", [
    { id: "users", titleKey: "kb.users", tabId: "users", description: "Local user accounts.", keywords: "users accounts create add login", steps: ["Press Add user, fill in the name and password."] },
    { id: "groups", titleKey: "kb.groups", tabId: "groups", description: "Groups that bundle users.", keywords: "groups members", steps: ["Create a group and add users to it."] },
    { id: "roles", titleKey: "kb.roles", tabId: "roles", description: "Roles: named sets of privileges.", keywords: "roles privileges rights", steps: ["Use a built-in role or create one with the privileges you need."] },
    { id: "permissions", titleKey: "kb.permissions", tabId: "acl", description: "Who has which role on which path.", keywords: "permissions acl access control path role", steps: ["Press Add, choose the path, the user or group and the role."] },
    { id: "resource-pools", titleKey: "kb.resource-pools", tabId: "pools", description: "Resource pools group guests and storage for permissions.", keywords: "resource pools groups guests", steps: ["Create a pool and add guests and storage to it."] },
    { id: "api-tokens", titleKey: "kb.api-tokens", tabId: "tokens", description: "API tokens for scripts and integrations.", keywords: "api tokens automation integration scripts keys", steps: ["Press Add token, choose the user and copy the secret right away."], tips: ["The secret is shown only once."] },
    { id: "realms", titleKey: "kb.realms", tabId: "realms", description: "Authentication realms (local, LDAP, OpenID).", keywords: "realms authentication ldap openid sso directory", steps: ["Add a realm and set it as default if users should sign in with it."] },
  ]),
  ...c("security-2fa", [
    { id: "admin-password", titleKey: "kb.admin-password", headings: ["Change password for"], description: "Change the administrator password.", keywords: "admin password change", steps: ["Type the current and the new password twice, then press Save."] },
    { id: "totp-2fa", titleKey: "sec.2faTitle", headingKey: "sec.2faTitle", shot: true, description: "TOTP two-factor authentication with an authenticator app and one-time recovery codes.", keywords: "2fa totp two factor authenticator app recovery codes otp", steps: ["Press Enable 2FA.", "Scan the QR code with an authenticator app.", "Type the 6-digit code to confirm and save the recovery codes."], tips: ["Each recovery code works once if you lose your phone."] },
    { id: "active-sessions", titleKey: "sec.sessionsTitle", headingKey: "sec.sessionsTitle", description: "Every signed-in browser with a button to sign it out.", keywords: "sessions signed in browsers sign out revoke", steps: ["Press Sign out next to a session you do not recognize."] },
  ]),
  ...c("security-posture", [
    { id: "posture-score", titleKey: "sec.postureTitle", headingKey: "sec.postureTitle", description: "The 0–100 score, every hardening check and one-click fixes.", keywords: "posture score hardening checks fix ssh kernel", steps: ["Press Fix next to a failed check.", "Press Re-scan to update the score."] },
  ]),
  ...c("audit-logs", [
    { id: "audit-log", titleKey: "sec.auditTitle", tabId: "audit", description: "Hash-chained log of every administrative action with integrity verification and export.", keywords: "audit log hash chain verify integrity export tamper", steps: ["Filter by user or action.", "Press Verify to check the chain."] },
    { id: "host-logs", titleKey: "set.view.hostLogs", tabId: "hostLogs", description: "The host's system journal.", keywords: "host logs journal syslog system", steps: ["Pick a time range and filter the journal."] },
  ]),
  ...c("network-switch", [
    { id: "visual-switch", titleKey: "set.view.vswitch", tabId: "vswitch", shot: true, description: "Every virtual switch as a rack faceplate with its ports, IP address and VLAN-aware badge.", keywords: "visual switch bridge faceplate ports link speed", steps: ["Click a port to open the Port Inspector.", "Press Edit IP / Switch to change addresses."] },
    { id: "vlan-patch-panel", anchorId: "vlan-lanes", titleKey: "kb.vlan-patch-panel", tabId: "vswitch", headingKey: "vsw.lanes", shot: true, description: "Color-coded VLAN cards; drag a port onto a card to make it an access port, or onto the trunk zone to carry several VLANs.", keywords: "vlan patch panel drag drop trunk access port tagged untagged cables", steps: ["Press + VLAN to add a VLAN card.", "Drag a port onto the card.", "Press Apply safely and confirm with Keep Settings."] },
    { id: "per-vlan-dhcp", anchorId: "vlan-lanes", titleKey: "kb.per-vlan-dhcp", tabId: "vswitch", headingKey: "vsw.lanes", description: "An isolated DHCP server per VLAN with gateway, range, DNS, lease time and static reservations.", keywords: "dhcp vlan server range gateway leases reservation static ip", steps: ["Open a VLAN card's DHCP & IP button.", "Set the gateway, range and DNS servers and switch DHCP on.", "Pin a live lease to make it a static reservation."] },
    { id: "virtual-nics", titleKey: "kb.virtual-nics", tabId: "vswitch", description: "Add, edit and remove guest network cards and host VLAN interfaces.", keywords: "virtual nic network card guest mac vlan tag bandwidth", steps: ["Press + Add Virtual NIC on a switch.", "Choose the guest, VLAN tag and adapter model."] },
    { id: "host-interfaces", titleKey: "set.view.hostNet", tabId: "hostNet", description: "The host's network interfaces and DNS servers.", keywords: "host interfaces ip address dns gateway", steps: ["Open the Host Interfaces tab next to Visual Switch."] },
  ]),
  ...c("network-topology", [
    { id: "topology-map", titleKey: "kb.topology-map", shot: true, description: "The live map of the host, switches, guests and VPN peers.", keywords: "topology map live diagram graph nodes", steps: ["Click a node for details.", "Use the buttons on a node to open the screen that manages it."] },
  ]),
  ...c("dns-dhcp", [
    { id: "dns-adblock", titleKey: "net.dns", tabId: "dns", description: "Local DNS resolver with ad-blocking lists and custom DNS records.", keywords: "dns adblock block lists records resolver", steps: ["Switch the resolver on.", "Add block lists and custom records."] },
    { id: "dhcp-server", titleKey: "kb.dhcp-server", tabId: "dhcp", description: "The network-wide DHCP server with leases and static reservations.", keywords: "dhcp server leases reservations range", steps: ["Set the range and gateway and switch DHCP on."] },
  ]),
  ...c("domains-certs", [
    { id: "local-domains", titleKey: "net.domains", tabId: "domains", description: "Local domain names for the web interface and services.", keywords: "domains local hostname dns names", steps: ["Add a domain and point it to a service."] },
    { id: "tls-certificates", titleKey: "net.certs", tabId: "certs", description: "Let's Encrypt and custom TLS certificates.", keywords: "certificates tls ssl https lets encrypt acme upload", steps: ["Request a Let's Encrypt certificate or upload your own."] },
  ]),
  ...c("firewall-forwarding", [
    { id: "firewall-rules", titleKey: "set.view.firewall", tabId: "firewall", description: "Allow and deny rules for the host and guests.", keywords: "firewall rules allow deny ports", steps: ["Press Add rule, choose direction, port and source."] },
    { id: "port-forwarding", titleKey: "set.view.forwarding", tabId: "forwarding", description: "Forward an outside port to a guest (NAT).", keywords: "port forwarding nat router outside inside", steps: ["Press Add, enter the outside port, the guest address and port."] },
  ]),
  ...c("wireguard-vpn", [
    { id: "wg-server", titleKey: "net.wg", tabId: "wg", description: "The WireGuard VPN server and its peers.", keywords: "wireguard server peers vpn qr", steps: ["Switch the server on.", "Add a peer and scan its QR code with your phone."] },
    { id: "wg-client", titleKey: "net.wgc", tabId: "wgc", description: "Connect the host to another WireGuard VPN.", keywords: "wireguard client connect tunnel", steps: ["Paste the configuration you received and press Connect."] },
  ]),
  ...c("hypervisor-defaults", [
    { id: "vm-profile", titleKey: "kb.vm-profile", headings: ["Virtual machine profile"], description: "Default cores, memory and disk size for new VMs.", keywords: "vm profile default cores memory disk", steps: ["Change the numbers; the VM wizard starts with them."] },
    { id: "container-profile", titleKey: "kb.container-profile", headings: ["Container profile"], description: "Default cores, memory and disk size for new containers.", keywords: "container profile default cores memory disk", steps: ["Change the numbers; the container wizard starts with them."] },
    { id: "storage-target", titleKey: "kb.storage-target", headings: ["Storage target"], description: "The storage new guest disks go to by default.", keywords: "default storage target disk location", steps: ["Pick the storage in the list."] },
    { id: "nested-virtualization", titleKey: "kb.nested-virtualization", headings: ["Nested virtualization"], description: "Let guests run their own hypervisor.", keywords: "nested virtualization guest hypervisor vt-x", steps: ["Switch nested virtualization on and restart the affected VMs."] },
  ]),
  ...c("local-ai-runtime", [
    { id: "ai-gpu", titleKey: "kb.ai-gpu", tabId: "hardware", description: "Which GPU runs the AI models.", keywords: "ai gpu assignment compute cuda", steps: ["Pick the GPU and press Save."] },
    { id: "ai-storage", titleKey: "kb.ai-storage", tabId: "storage", description: "Where AI models are stored.", keywords: "ai model storage folder path disk space", steps: ["Choose a folder with enough space for the models."] },
  ]),
];

/* ---------------- Articles (derived) ---------------- */

export const slug = {
  app: (id: AppId) => `app-${id}`,
  category: (id: CategoryId) => `settings-${id}`,
  module: (id: ModuleId) => `settings-${id}`,
  control: (x: Control) => `settings-${x.moduleId}--${x.id}`,
};

const openSteps = (tr: Translate, cat: CategoryId, mod?: ModuleId, ctl?: Control) => {
  const path = [tr("app.settings"), tr(`set.cat.${cat}`), mod && tr(`set.mod.${mod}`)].filter(Boolean).join(" › ");
  const tab = ctl?.tabId ? ` and pick ${tr(ctl.titleKey)}` : "";
  return `Open ${path}${tab} (or press “Open This Setting / App →” above).`;
};

/** Every Help & Support article: one per app, Settings category, sub-module and sub-sub-module. */
export function buildArticles(tr: Translate = (k) => en[k]): Article[] {
  const out: Article[] = [];
  for (const id of APP_IDS) {
    const d = appDoc(id);
    out.push({
      articleId: slug.app(id),
      mainTitle: tr(`app.${id}`),
      category: "apps",
      relatedAppId: id,
      screenshotPath: shot(slug.app(id)),
      target: { kind: "app", appId: id },
      keywords: d.keywords,
      sections: [{ sectionId: "overview", subTitle: "Overview", bodyText: d.intro, steps: d.steps, tips: d.tips ?? [] }],
    });
  }
  for (const cat of CATEGORIES) {
    const mods = MODULE_IDS.filter((m) => MODULES[m].cat === cat);
    out.push({
      articleId: slug.category(cat),
      mainTitle: tr(`set.cat.${cat}`),
      category: cat,
      relatedCategoryId: cat,
      screenshotPath: shot(slug.category(cat)),
      target: { kind: "settings", category: cat },
      keywords: mods.join(" "),
      sections: [
        { sectionId: "overview", subTitle: "Overview", bodyText: tr(`set.catDesc.${cat}`), steps: [openSteps(tr, cat)], tips: [] },
        ...mods.map((m) => ({ sectionId: m, subTitle: tr(`set.mod.${m}`), bodyText: MODULE_DOCS[m].intro, steps: MODULE_DOCS[m].steps, tips: MODULE_DOCS[m].tips ?? [], screenshotPath: shot(slug.module(m)) })),
      ],
    });
  }
  for (const m of MODULE_IDS) {
    const d = MODULE_DOCS[m];
    const cat = MODULES[m].cat;
    const ctls = CONTROLS.filter((x) => x.moduleId === m);
    out.push({
      articleId: slug.module(m),
      mainTitle: tr(`set.mod.${m}`),
      category: cat,
      relatedCategoryId: cat,
      relatedModuleId: m,
      screenshotPath: shot(slug.module(m)),
      target: { kind: "settings", module: m },
      keywords: d.keywords,
      requires: m === "bios-firmware" ? "supports_bios_manager" : undefined,
      sections: [
        { sectionId: "overview", subTitle: "Overview", bodyText: d.intro, steps: [openSteps(tr, cat, m), ...d.steps], tips: d.tips ?? [] },
        ...ctls.map((x) => ({ sectionId: x.id, subTitle: tr(x.titleKey), bodyText: x.description, steps: x.steps, tips: x.tips ?? [], screenshotPath: x.shot ? shot(slug.control(x)) : undefined })),
      ],
    });
    // Each sub-module's control articles follow it (the Manual tree nests them).
    for (const x of ctls) out.push({
      articleId: slug.control(x),
      mainTitle: tr(x.titleKey),
      category: x.categoryId,
      relatedCategoryId: x.categoryId,
      relatedModuleId: x.moduleId,
      relatedSubSectionId: x.id,
      screenshotPath: shot(x.shot ? slug.control(x) : slug.module(x.moduleId)),
      target: controlTarget(x),
      keywords: x.keywords,
      requires: x.requires,
      sections: [{ sectionId: "how-to", subTitle: `Using ${tr(x.titleKey)}`, bodyText: x.description, steps: [openSteps(tr, x.categoryId, x.moduleId, x), ...x.steps], tips: x.tips ?? [] }],
    });
  }
  return out;
}

export const controlTarget = (x: Control): NavTarget => ({ kind: "settings", module: x.moduleId, tab: x.tabId, anchor: x.anchorId });

/** The headings `pulseAnchor` looks for to find a control's card, in English and the interface language. */
export const controlHeadings = (module: ModuleId, anchor: string, tr: Translate): string[] => {
  const x = CONTROLS.find((y) => y.moduleId === module && y.anchorId === anchor);
  return x ? [...(x.headings ?? []), ...(x.headingKey ? [tr(x.headingKey), en[x.headingKey]] : [])] : [];
};

/* ---------------- Global search (7 tiers) ---------------- */

export const TIERS = ["apps", "categories", "modules", "controls", "articles", "subtitles", "body"] as const;
export type Tier = (typeof TIERS)[number];

export interface Hit {
  key: string;
  tier: Tier;
  title: string;
  /** Breadcrumb, parent article or snippet. */
  subtitle: string;
  /** Character range of the match inside `subtitle` (body snippets), for highlighting. */
  mark?: [number, number];
  appId?: AppId;
  moduleId?: ModuleId;
  categoryId?: CategoryId;
  target: NavTarget;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
/** Every query word appears somewhere in `hay`. */
const hasAll = (words: string[], hay: string) => words.every((w) => hay.includes(w));
/** Lower is better: title starts with the query, then the title contains it, then elsewhere. */
const rankOf = (q: string, title: string) => (norm(title).startsWith(q) ? 0 : norm(title).includes(q) ? 1 : 2);

function snippet(text: string, words: string[]): { text: string; mark?: [number, number] } {
  const n = norm(text);
  const w = words.find((x) => n.includes(x)) ?? "";
  const i = n.indexOf(w);
  if (i < 0) return { text: text.slice(0, 90) };
  const start = Math.max(0, i - 40);
  const pre = start > 0 ? "…" : "";
  const body = text.slice(start, i + w.length + 60);
  return { text: `${pre}${body}${start + body.length < text.length ? "…" : ""}`, mark: [pre.length + i - start, pre.length + i - start + w.length] };
}

/** Search the registry; groups come back in the mandatory tier order, empty groups omitted. */
export function searchKnowledge(query: string, tr: Translate, caps?: Partial<Capabilities>, limit = 6): { tier: Tier; hits: Hit[]; total: number }[] {
  const q = norm(query.trim());
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const ok = (r?: Cap) => !r || !caps || caps[r] !== false;
  const crumb = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" › ");
  const groups: Record<Tier, (Hit & { rank: number })[]> = { apps: [], categories: [], modules: [], controls: [], articles: [], subtitles: [], body: [] };
  const add = (h: Hit, hay: string) => hasAll(words, norm(hay)) && groups[h.tier].push({ ...h, rank: rankOf(q, h.title) });

  for (const id of APP_IDS) {
    const title = tr(`app.${id}`);
    add({ key: `app:${id}`, tier: "apps", title, subtitle: tr(`appDesc.${id}`), appId: id, target: { kind: "app", appId: id } }, `${title} ${APPS[id].title} ${tr(`appDesc.${id}`)} ${appDoc(id).keywords} ${id}`);
  }
  for (const cat of CATEGORIES) {
    const title = tr(`set.cat.${cat}`);
    add({ key: `cat:${cat}`, tier: "categories", title, subtitle: crumb(tr("app.settings"), title), categoryId: cat, target: { kind: "settings", category: cat } }, `${title} ${en[`set.cat.${cat}`]} ${tr(`set.catDesc.${cat}`)} ${cat}`);
  }
  for (const m of MODULE_IDS) {
    if (m === "bios-firmware" && !ok("supports_bios_manager")) continue;
    const title = tr(`set.mod.${m}`);
    const cat = MODULES[m].cat;
    add({ key: `mod:${m}`, tier: "modules", title, subtitle: crumb(tr("app.settings"), tr(`set.cat.${cat}`), title), moduleId: m, target: { kind: "settings", module: m } }, `${title} ${en[`set.mod.${m}`]} ${tr(`set.modDesc.${m}`)} ${MODULE_DOCS[m].keywords} ${m}`);
  }
  for (const x of CONTROLS) {
    if (!ok(x.requires)) continue;
    const title = tr(x.titleKey);
    add(
      { key: `ctl:${x.moduleId}:${x.id}`, tier: "controls", title, subtitle: crumb(tr("app.settings"), tr(`set.cat.${x.categoryId}`), tr(`set.mod.${x.moduleId}`), title), moduleId: x.moduleId, target: controlTarget(x) },
      `${title} ${en[x.titleKey]} ${x.description} ${x.keywords} ${x.id}`,
    );
  }
  for (const a of buildArticles(tr)) {
    if (!ok(a.requires)) continue;
    const help = (section?: string): NavTarget => ({ kind: "help", article: a.articleId, section, term: query.trim() });
    add({ key: `art:${a.articleId}`, tier: "articles", title: a.mainTitle, subtitle: crumb(tr("app.help"), a.category === "apps" ? tr("kb.group.apps") : tr(`set.cat.${a.category}`)), target: help() }, `${a.mainTitle} ${a.keywords}`);
    for (const s of a.sections) {
      add({ key: `sub:${a.articleId}:${s.sectionId}`, tier: "subtitles", title: s.subTitle, subtitle: a.mainTitle, target: help(s.sectionId) }, s.subTitle);
      const text = [s.bodyText, ...s.steps, ...s.tips].join(" ");
      if (!hasAll(words, norm(text))) continue;
      const sn = snippet(text, words);
      groups.body.push({ key: `body:${a.articleId}:${s.sectionId}`, tier: "body", title: `${a.mainTitle} › ${s.subTitle}`, subtitle: sn.text, mark: sn.mark, target: help(s.sectionId), rank: 2 });
    }
  }
  return TIERS.filter((t) => groups[t].length).map((t) => ({ tier: t, total: groups[t].length, hits: groups[t].sort((a, b) => a.rank - b.rank).slice(0, limit) }));
}
