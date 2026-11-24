import type { AppId } from "../apps/registry";
import type { Intents } from "../lib/stores";

/* Plain-English, jargon-free guides for every app and major workflow, shown by GuidedWizardModal.
   "{platform}" is replaced with the active hypervisor's label (capabilitiesStore) when a guide is shown. */

export interface GuideAction {
  label: string;
  app: AppId;
  /** Deep link inside the app (tab or creation dialog), see useIntent. */
  intent?: Intents[keyof Intents];
}

export interface GuideStep {
  title: string;
  body?: string;
  bullets?: string[];
  numbered?: string[];
  cards?: { title: string; body: string }[];
  tip?: string;
  /** Rendered as a "Show Me" button on this step. */
  action?: GuideAction;
}

export interface Guide {
  id: string;
  app: AppId;
  title: string;
  blurb: string;
  steps: GuideStep[];
  /** Sub-wizards offered on the last step. */
  related?: string[];
}

/** Standard 4-step guide: What It Does → When To Use It → How To Use It → Try It Now. */
function guide(g: {
  id: string;
  app: AppId;
  title: string;
  blurb: string;
  what: string;
  cards?: GuideStep["cards"];
  when: string[];
  how: string[];
  tip?: string;
  action: GuideAction;
  related?: string[];
}): Guide {
  return {
    id: g.id,
    app: g.app,
    title: g.title,
    blurb: g.blurb,
    related: g.related,
    steps: [
      { title: "What It Does", body: g.what, cards: g.cards },
      { title: "When To Use It", bullets: g.when },
      { title: "How To Use It", numbered: g.how, tip: g.tip },
      {
        title: "Try It Now",
        body: "You're ready. The button below takes you straight to the right place so you can do it yourself while these steps are fresh. You can reopen this guide any time with the ? Guide button in the window's title bar.",
        action: g.action,
      },
    ],
  };
}

export const WELCOME: Guide = {
  id: "welcome",
  app: "help",
  title: "Welcome to SolarDeck",
  blurb: "A quick tour of your new server desktop.",
  steps: [
    {
      title: "Your Desktop & Widgets",
      body: "This is your server's desktop. Every app has an icon here — click one to open it (prefer double-click? Change it under Control Panel → Appearance & Themes). The glass cards on the right are live widgets showing CPU, memory, storage health and running machines.",
      bullets: [
        "Right-click empty space for quick actions like New Virtual Machine or View Options.",
        "Use View Options (the grid icon in the top bar) to switch between Grid and List, and to change icon size and spacing.",
        "Windows can be dragged, resized, snapped to screen edges and maximized with a double-click on the title bar.",
      ],
    },
    {
      title: "Dock & App Launcher",
      body: "The Dock at the bottom keeps your favourite apps one click away. Icons grow as your mouse passes over them. A dot under an icon means the app is open.",
      bullets: [
        "Click the four-squares button at the left of the Dock to open the App Gallery: every app, with search, categories, sorting and drag-and-drop ordering.",
        "Right-click a Dock icon to keep it in the Dock or remove it. Drag icons to reorder them.",
        "Change Dock size and spacing in View Options or Control Panel → Appearance & Themes.",
      ],
      action: { label: "Open Appearance & Themes", app: "controlpanel", intent: "appearance" },
    },
    {
      title: "Instant Passwordless Host Shell",
      body: "Need the command line? The terminal button in the top bar opens a root shell on your {platform} host instantly — no password or SSH setup. Container shells open the same way from Compute Manager.",
      tip: "The shell has full root power. Only run commands you understand.",
      action: { label: "Open Host Shell", app: "terminal" },
    },
    {
      title: "Spotlight Search (Ctrl+K / Cmd+K)",
      body: "Press Ctrl+K (or Cmd+K) or click the magnifying glass in the top bar to search everything: apps, virtual machines, containers, storage, shares and settings. Press Enter to jump straight there.",
    },
    {
      title: "Built-in App Guides",
      body: "Every app window has a ? Guide button in its title bar. It opens a step-by-step guide for that app in plain English, with a Show Me button that takes you to the right spot. You can replay this tour any time from the Help menu (? in the top bar).",
      action: { label: "Open Help & Support", app: "help" },
    },
  ],
};

/** One main guide per app: opened by the ? Guide button in that app's title bar. */
export const APP_GUIDES: Record<AppId, Guide> = {
  monitor: guide({
    id: "monitor",
    app: "monitor",
    title: "Resource Monitor Guide",
    blurb: "Read CPU, memory, network, GPU and temperature graphs.",
    what: "Resource Monitor shows how hard your server is working right now and over the last couple of minutes. It updates every two seconds.",
    cards: [
      { title: "CPU %", body: "How busy the processor is. Short spikes are normal; staying above 90% means the server is overloaded." },
      { title: "Memory & ZFS cache", body: "ZFS borrows free memory as a read cache (ARC) to speed up disks. It hands memory back when apps need it, so high usage is usually fine." },
      { title: "Network", body: "Data coming in and going out of the server, averaged over one minute." },
      { title: "GPU & drives", body: "NVIDIA, Intel and AMD graphics usage, video memory and temperatures. Drives above about 55 °C deserve better cooling." },
    ],
    when: [
      "Your server or a VM feels slow and you want to know why.",
      "Checking that a media server is using the graphics card for video transcoding.",
      "Making sure disks and the GPU stay cool during a long job.",
    ],
    how: [
      "Open Resource Monitor from the Desktop or Dock.",
      "The Performance tab shows CPU, memory and network graphs.",
      "Switch to Hardware & GPU to see graphics card load and drive temperatures.",
      "Yellow and red numbers mean something is running hot or full.",
    ],
    action: { label: "Open Resource Monitor", app: "monitor" },
  }),
  compute: guide({
    id: "compute",
    app: "compute",
    title: "Compute Manager Guide",
    blurb: "Run virtual machines and containers.",
    what: "Compute Manager lists every virtual machine (VM) and container on the server. You can start, stop and open their screens, change their CPU and memory, and create new ones with a wizard.",
    when: [
      "Running Windows or another full operating system on your server (a VM).",
      "Running lightweight Linux services like Pi-hole or a web server (a container).",
      "Restarting a machine that stopped responding.",
    ],
    how: [
      "Click Create VM or Create Container at the top.",
      "Follow the wizard: name, installation image, disk, CPU, memory and network.",
      "Press Start, then Console to see the machine's screen.",
      "Click a machine's name or Edit to change its hardware, snapshots or passthrough devices.",
      "Use the Grid | List switch to see machines as cards or as a detailed table.",
    ],
    action: { label: "Create a Virtual Machine", app: "compute", intent: "vm" },
    related: ["compute-vm-vs-ct", "compute-create", "compute-passthrough"],
  }),
  storage: guide({
    id: "storage",
    app: "storage",
    title: "Storage & ZFS Guide",
    blurb: "Pools, datasets, disk health and snapshots.",
    what: "Storage & ZFS manages your hard drives and SSDs. ZFS combines drives into a pool that protects your data, checks it for silent corruption, and can take instant snapshots.",
    when: [
      "You installed new drives and want to use them.",
      "You want a safe place for media, documents or backups.",
      "Checking whether a drive is wearing out.",
    ],
    how: [
      "Open Disks & SMART to see every drive and its health.",
      "Use ZFS Pools → Create pool to combine empty drives.",
      "Add Volumes & Datasets to organize the pool into folders such as media or backups.",
      "Set automatic snapshots under Snapshots & Schedules.",
    ],
    action: { label: "Create a ZFS Pool", app: "storage", intent: "pool" },
    related: ["storage-raid", "storage-pool", "storage-smart", "storage-replace-disk", "storage-disk-tests", "storage-benchmark"],
  }),
  files: guide({
    id: "files",
    app: "files",
    title: "File Station Guide",
    blurb: "Upload, organize and download files.",
    what: "File Station is a file manager for your server's storage, mounted at /mnt/storage. Every ZFS dataset you map shows up here as a folder.",
    when: [
      "Copying photos or movies onto the server from your browser.",
      "Organizing media folders before pointing Jellyfin at them.",
      "Downloading a file from the server to your computer.",
    ],
    how: [
      "Pick a folder in the tree on the left.",
      "Drag files from your computer into the window to upload them.",
      "Use New Folder to keep things organized.",
      "Select a file to rename, download or delete it.",
    ],
    tip: "Deleting in File Station is permanent unless the folder is shared with the recycle bin turned on.",
    action: { label: "Open File Station", app: "files" },
  }),
  appcenter: guide({
    id: "appcenter",
    app: "appcenter",
    title: "App Center Guide",
    blurb: "One-click installs of popular self-hosted apps.",
    what: "App Center installs ready-made apps like Jellyfin, Docker, AdGuard Home and Ollama, each in its own container, with sensible CPU, memory and disk sizes already filled in.",
    when: [
      "You want a media server, ad blocker or local AI without typing commands.",
      "Trying an app safely: removing its container removes it completely.",
    ],
    how: [
      "Browse by category or search by name.",
      "Click Install and review the name, resources and options.",
      "Turn on storage mounts if the app needs your files (for example Jellyfin and your media folder).",
      "Turn on hardware video acceleration (iGPU) for media servers so videos play smoothly without maxing the CPU.",
      "Watch the progress, then open the app's web address shown at the end.",
    ],
    action: { label: "Open App Center", app: "appcenter" },
  }),
  backup: guide({
    id: "backup",
    app: "backup",
    title: "Backup Center Guide",
    blurb: "Protect VMs and containers with backups.",
    what: "Backup Center makes complete copies of your virtual machines and containers (using the {platform} backup tool). If something breaks, you can restore the machine exactly as it was.",
    when: [
      "Before a risky change such as a big update inside a VM.",
      "Every night, automatically, so you never lose more than a day.",
      "After a mistake: restore yesterday's copy.",
    ],
    how: [
      "Click Back Up Now, pick the machines and a storage location, and start.",
      "In Schedules, add a job (for example every night at 02:00) and how many copies to keep.",
      "To undo a mistake, find the backup in the list and click Restore.",
    ],
    tip: "Keep backups on a different drive or pool from the machines themselves, so one failed drive can't take both.",
    action: { label: "Back Up Now", app: "backup", intent: "now" },
  }),
  shares: guide({
    id: "shares",
    app: "shares",
    title: "Network Shares Guide",
    blurb: "Share folders with your computers and phones.",
    what: "Network Shares turns folders on your server into network drives (SMB) that Windows, Linux and phone file apps can open like a local folder.",
    when: [
      "Saving documents from your laptop straight to the server.",
      "Playing movies from the server on a TV or phone app.",
      "Giving each family member their own private folder.",
    ],
    how: [
      "In Users, add a share user with a password.",
      "In Shared Folders, click Create share and pick (or create) a ZFS folder.",
      "Choose which users may access it and whether it is read-only.",
      "Windows: open File Explorer and type the \\\\server\\share address shown on the card.",
      "Linux: open the smb:// address in your file manager. Phones: add an SMB location in your file app.",
    ],
    action: { label: "Create a Share", app: "shares", intent: "create" },
  }),
  netservices: guide({
    id: "netservices",
    app: "netservices",
    title: "Network & Services Guide",
    blurb: "DNS, ad blocking, DHCP, VPN and certificates.",
    what: "Network & Services turns your server into the brain of your home network: it can answer name lookups (DNS), block ads for every device, hand out IP addresses (DHCP), run a WireGuard VPN, forward ports and manage HTTPS certificates.",
    when: [
      "Blocking ads and trackers on every device, even smart TVs.",
      "Reaching your server securely from your phone when away from home.",
      "Giving devices fixed addresses or friendly names like nas.home.",
    ],
    how: [
      "Pick a service on the left: DNS & AdBlock, DHCP, WireGuard, Router & NAT or Certificates.",
      "Install the service if asked (one click).",
      "Turn it on and fill in the few settings shown.",
      "Use the step-by-step guides below for each service.",
    ],
    action: { label: "Open DNS & AdBlock", app: "netservices", intent: "dns" },
    related: ["net-dns", "net-dhcp", "net-wireguard", "net-certs"],
  }),
  datacenter: guide({
    id: "datacenter",
    app: "datacenter",
    title: "Datacenter Guide",
    blurb: "Users, permissions, firewall and logs.",
    what: "Datacenter is the advanced control room for {platform} itself: user accounts, groups and roles, who may do what, API tokens, the firewall, and system logs.",
    when: [
      "Giving a friend access to just one VM.",
      "Blocking traffic to a machine with a firewall rule.",
      "Reading logs to find out why something failed.",
    ],
    how: [
      "Users: add a person and set their password.",
      "Permissions: grant a role (for example PVEVMUser) on a path such as /vms/101.",
      "Firewall: add rules for the whole cluster, the host or a single guest.",
      "Logs: read the system journal and task history.",
    ],
    tip: "The SolarDeck service user and its token are protected so you can't lock yourself out by accident.",
    action: { label: "Open Datacenter", app: "datacenter" },
  }),
  terminal: guide({
    id: "terminal",
    app: "terminal",
    title: "Host Shell Guide",
    blurb: "A root command line on your server.",
    what: "Host Shell opens a command line on the {platform} host as the root (administrator) user, with no password prompt. It's the same as plugging a keyboard into the server.",
    when: [
      "Following a tutorial that asks you to run a command.",
      "Checking things quickly, like disk space (df -h) or running processes (htop).",
    ],
    how: [
      "Click the terminal icon in the top bar or open Host Shell from the Dock.",
      "Type a command and press Enter.",
      "Paste with Ctrl+Shift+V (or right-click). Close the window when you're done.",
    ],
    tip: "Root can change or delete anything. If you're unsure what a command does, look it up first.",
    action: { label: "Open Host Shell", app: "terminal" },
  }),
  help: guide({
    id: "help",
    app: "help",
    title: "Help & Support Guide",
    blurb: "Find answers and fix problems automatically.",
    what: "Help & Support answers questions in plain words, checks your server for common problems and can fix many of them for you. It also has BIOS guides, tutorials and an FAQ.",
    when: [
      "Something doesn't work and you don't know why.",
      "You want to use a graphics card in a VM and need BIOS settings.",
      "Learning a new feature step by step.",
    ],
    how: [
      "Type your question in Ask & search, for example \"block ads on my network\".",
      "Open Fix problems and press Fix it for me on any red or yellow item.",
      "Use BIOS & firmware for exact menu paths on your motherboard.",
      "Replay the Welcome Tour from the ? menu in the top bar.",
    ],
    action: { label: "Run a Health Check", app: "help", intent: "fix" },
  }),
  controlpanel: guide({
    id: "controlpanel",
    app: "controlpanel",
    title: "Control Panel Guide",
    blurb: "Users, drivers, layout, updates and bug reports.",
    what: "Control Panel holds the settings for SolarDeck and the host: security and two-factor login, network, appearance and desktop layout, hardware and GPU drivers, and system updates.",
    when: [
      "Changing your password or turning on two-factor login.",
      "Installing NVIDIA, Intel or AMD graphics drivers.",
      "Making desktop icons bigger or switching to List View.",
      "Updating SolarDeck to the newest version.",
    ],
    how: [
      "User & Security: change the admin password, set up 2FA, check the root bridge. Add more {platform} users and roles in Datacenter.",
      "Hardware & System → GPU & Drivers: pick your card's vendor and press Install.",
      "Appearance & Themes: themes, Light / Dark Mode, wallpapers, Grid/List view, icon size, spacing and Dock.",
      "System & Power → SolarDeck Update: check for and install updates. To go back to an older version, redeploy that release with deploy.sh.",
      "To report a bug, use Help & Support → Ask, then open an issue on the project's GitHub page with what you saw.",
    ],
    action: { label: "Open Appearance & Themes", app: "controlpanel", intent: "appearance" },
  }),
  system: guide({
    id: "system",
    app: "system",
    title: "System Guide",
    blurb: "Package sources and host updates.",
    what: "System manages where the host gets its software (package repositories) and installs {platform} and operating system updates.",
    when: [
      "Updates fail with an error like 401 Unauthorized (the Enterprise source needs a paid subscription).",
      "Installing security updates for the host.",
    ],
    how: [
      "Repositories: turn off Enterprise and turn on No-Subscription if you don't have a subscription.",
      "Updates: press Refresh, review the list, then Upgrade.",
      "Reboot from Control Panel → System & Power if a new kernel was installed.",
    ],
    action: { label: "Open System", app: "system" },
  }),
  "local-ai": guide({
    id: "local-ai",
    app: "local-ai",
    title: "Local AI Guide",
    blurb: "Run ChatGPT-style AI models privately on your own GPU.",
    what: "Local AI manages your Local AI Studio container: it downloads open AI models, shows whether each one fits in your graphics card's memory (VRAM), switches between GPU and CPU, and has a built-in chat to test them. Nothing you type leaves your server.",
    cards: [
      { title: "VRAM fit", body: "Green means the whole model fits in GPU memory and runs at full speed. Amber is a tight fit. Hybrid means part of it runs on the CPU, which is much slower." },
      { title: "Model sizes", body: "The number with a B is billions of parameters. Bigger is smarter but needs more memory: a 24 GB card like the RTX 3090 runs models up to about 32B at full speed." },
      { title: "API for other apps", body: "Copy the OpenAI-compatible address from Settings → Hardware into any tool that supports a custom OpenAI endpoint." },
    ],
    when: [
      "You want a private assistant for writing, coding or questions about your documents.",
      "Trying new open models the day they are released.",
      "Pointing coding tools or home automation at an AI that runs on your own hardware.",
    ],
    how: [
      "Install Local AI Studio from App Center → AI & Compute and pick your GPU in the hardware picker.",
      "Open Local AI → Settings → Download models, search or filter by category, and click Download Model.",
      "Back in the chat, pick the model under the message box and start typing; each reply shows its tokens per second.",
      "Use Settings → Installed models to unload a model from VRAM or delete it, and Settings → Storage to move your models to another disk.",
    ],
    tip: "Turn on KV Cache Quantization in Settings → Hardware to fit longer conversations into the same VRAM.",
    action: { label: "Open Local AI", app: "local-ai" },
  }),
  console: guide({
    id: "console",
    app: "console",
    title: "Console Guide",
    blurb: "See and control a VM or container.",
    what: "A console window shows a virtual machine's screen (like a monitor plugged into it) or a container's command line.",
    when: ["Installing an operating system in a new VM.", "Fixing a machine whose network isn't working yet."],
    how: [
      "Start the machine in Compute Manager.",
      "Click Console for the screen or Shell for a command line.",
      "Click inside the window to type; close the window to disconnect (the machine keeps running).",
    ],
    action: { label: "Open Compute Manager", app: "compute" },
  }),
};

/** Sub-wizards for key workflows (linked from app guides, empty states and creation dialogs). */
const SUB_GUIDES: Guide[] = [
  guide({
    id: "compute-vm-vs-ct",
    app: "compute",
    title: "VMs vs. Containers Explained",
    blurb: "Which one should you pick?",
    what: "Both run software in its own isolated box, but they work differently.",
    cards: [
      { title: "Container (LXC)", body: "Shares the host's Linux engine. Starts in seconds, uses very little memory. Linux only. Great for most self-hosted apps." },
      { title: "Virtual Machine (VM)", body: "A complete pretend computer with its own operating system. Runs Windows, any Linux or BSD. Needs more memory. Can own a whole graphics card." },
    ],
    when: [
      "Pick a container for Pi-hole, Jellyfin, Docker, web servers and databases.",
      "Pick a VM for Windows, gaming or GPU passthrough, a firewall like OPNsense, or anything that needs its own kernel.",
      "Not sure? Start with a container — it's lighter and easy to delete.",
    ],
    how: [
      "Open Compute Manager.",
      "Click Create Container for Linux services, or Create VM for a full operating system.",
      "Containers need a template, VMs need an ISO: download either in ISO & Templates.",
    ],
    action: { label: "Create a Container", app: "compute", intent: "lxc" },
  }),
  guide({
    id: "compute-create",
    app: "compute",
    title: "Creating Your First VM or Container",
    blurb: "From zero to a running machine.",
    what: "The creation wizard asks a few simple questions and builds the machine for you with safe defaults.",
    when: ["Setting up a new service or operating system.", "Testing something without touching your existing machines."],
    how: [
      "Download an installer: Compute Manager → ISO & Templates → download an ISO (for a VM) or a template (for a container).",
      "Click Create VM or Create Container and give it a name.",
      "Pick the ISO or template you downloaded.",
      "Choose a disk size (32 GB is plenty for most Linux; 64 GB+ for Windows).",
      "Choose CPU cores and memory (2 cores and 2 GB is a good start).",
      "Leave networking on DHCP unless you need a fixed address, review, and press Create.",
      "Start it and open Console to finish installing the operating system.",
    ],
    tip: "Windows 11 needs TPM and Secure Boot: the wizard adds both automatically when you choose Windows.",
    action: { label: "Create a Virtual Machine", app: "compute", intent: "vm" },
  }),
  guide({
    id: "compute-passthrough",
    app: "compute",
    title: "GPU, USB & Audio Device Passthrough",
    blurb: "Give a VM a real graphics card or USB device.",
    what: "Passthrough hands a physical device — a graphics card, USB stick, game controller or sound card — directly to one VM, as if it were plugged into that machine.",
    cards: [
      { title: "IOMMU", body: "A CPU feature (Intel VT-d / AMD-Vi) that safely walls off devices. It must be on in the BIOS and on the host. Help & Support can turn on the host part for you." },
      { title: "IOMMU groups", body: "Devices that can't be separated travel together. A graphics card usually comes with its HDMI audio — pass both." },
    ],
    when: [
      "Gaming or video editing in a Windows VM with a real GPU.",
      "Using a USB Zigbee/Z-Wave stick in a Home Assistant VM.",
      "Giving a VM a dedicated sound card or USB drive.",
    ],
    how: [
      "Turn on VT-d / AMD-Vi (IOMMU) in the BIOS: Help & Support → BIOS & firmware shows the exact menu.",
      "Run Help & Support → Fix problems: if IOMMU is off on the host, press Fix it for me and reboot.",
      "For GPUs, switch the card to passthrough mode in Control Panel → Hardware & System → GPU & Drivers.",
      "Shut down the VM, open Compute Manager → Edit → Hardware, and Add PCI/GPU device or Add USB device.",
      "Tick \"include audio\" for GPUs, then start the VM and install the device's drivers inside it.",
    ],
    tip: "A device passed to a VM disappears from the host and other VMs until you remove it again.",
    action: { label: "Open Compute Manager", app: "compute" },
  }),
  guide({
    id: "storage-raid",
    app: "storage",
    title: "ZFS RAID Levels Made Simple",
    blurb: "Single, Mirror, RAIDZ1 or RAIDZ2?",
    what: "A RAID level decides how your drives share the work and how many can fail before data is lost.",
    cards: [
      { title: "Single", body: "1+ drives, all space usable, no protection. If a drive dies, the pool is lost. Only for scratch data." },
      { title: "Mirror", body: "2 drives (or more) holding identical copies. Half the space, survives one drive failing. Fast and simple." },
      { title: "RAIDZ1", body: "3+ drives, one drive's worth of space used for protection. Survives one failure. Good balance for home media." },
      { title: "RAIDZ2", body: "4+ drives, two drives' worth for protection. Survives two failures at once. Best for large or important pools." },
    ],
    when: [
      "Two drives: Mirror.",
      "Three or four drives of media you can re-download: RAIDZ1.",
      "Five or more drives, or irreplaceable photos: RAIDZ2.",
      "RAID is not a backup: still keep backups of important data elsewhere.",
    ],
    how: [
      "Use drives of the same size: the pool treats every drive as big as the smallest one.",
      "Open Create pool and tick the drives you want.",
      "Pick the RAID level; the dialog shows the usable space before you confirm.",
    ],
    action: { label: "Create a ZFS Pool", app: "storage", intent: "pool" },
  }),
  guide({
    id: "storage-pool",
    app: "storage",
    title: "Creating a ZFS Pool & Dataset",
    blurb: "Turn empty drives into organized storage.",
    what: "A pool combines drives into one big protected space. Datasets are folders inside the pool, each with its own settings like quotas and compression.",
    when: ["You added new empty drives.", "You want separate areas for media, documents and backups."],
    how: [
      "Storage & ZFS → Disks & SMART: make sure the new drives show Unused (wipe them if they held old data).",
      "ZFS Pools → Create pool: name it (for example tank), tick the drives, pick a RAID level, Create.",
      "Volumes & Datasets → Create: pick the pool, name the dataset (for example tank/media).",
      "Leave \"make available in File Station\" on, so it appears under /mnt/storage.",
      "Share it with Network Shares or point App Center apps at it.",
    ],
    tip: "Creating a pool erases the selected drives. Double-check the drive names before you confirm.",
    action: { label: "Create a ZFS Pool", app: "storage", intent: "pool" },
  }),
  guide({
    id: "storage-smart",
    app: "storage",
    title: "Checking Disk Health & Automatic Snapshots",
    blurb: "Catch failing drives early and undo mistakes.",
    what: "SMART is a health report built into every drive. Snapshots are instant, space-saving copies of a dataset you can roll back to.",
    when: ["A drive makes noise or the server feels slow.", "Protecting documents against accidental deletion or ransomware."],
    how: [
      "Storage & ZFS → Disks & SMART: green PASSED is good; FAILED means replace the drive soon.",
      "Click Inspect SMART for temperature, power-on hours, life used and error counters. Rising reallocated or media errors are a warning sign.",
      "Snapshots & Schedules → Add schedule: pick a dataset, Hourly/Daily/Weekly, and how many to keep.",
      "To undo a mistake, find the snapshot and press Roll back.",
    ],
    tip: "Rolling back discards everything written after that snapshot.",
    action: { label: "Open Disks & SMART", app: "storage", intent: "disks" },
  }),
  guide({
    id: "storage-replace-disk",
    app: "storage",
    title: "Replacing a Failing Drive in a RAID Pool",
    blurb: "Take a bad drive offline, swap it and let ZFS rebuild.",
    what: "In a mirror or RAIDZ pool, every piece of data also lives on the other drives. When one drive fails you take it Offline, swap in a new one, and ZFS copies (resilvers) the missing data onto it while the pool keeps working.",
    cards: [
      { title: "Set Offline", body: "ZFS stops using the drive so it can be unplugged safely. Refused if it would take the pool down." },
      { title: "Replace Disk", body: "Points ZFS at the new drive and starts the rebuild, with a progress bar on the pool." },
    ],
    when: [
      "A pool shows DEGRADED or FAULTED.",
      "A drive has numbers in its Read, Write or Cksum error columns.",
      "A SMART test or surface scan reported failures.",
    ],
    how: [
      "Storage & ZFS → ZFS Pools: find the drive marked FAULTED, DEGRADED or with errors.",
      "Note its serial number (Disks & SMART → List view shows it next to the device).",
      "Press Set Offline and confirm.",
      "Remove the drive with that serial and insert the new one (shut down first if your bays are not hot-swap).",
      "Press Refresh, then Replace Disk, pick the new drive, type its device path and start.",
      "Wait for the resilver bar to reach 100% and the pool to show ONLINE, then run a Scrub.",
    ],
    tip: "The new drive must be at least as large as the old one. On the boot pool, keep 'Copy the old disk's partition layout' switched on.",
    action: { label: "Open ZFS Pools", app: "storage", intent: "pools" },
  }),
  guide({
    id: "storage-disk-tests",
    app: "storage",
    title: "SMART Short Test vs. Extended Test vs. Surface Scan",
    blurb: "Three ways to check a drive, from quick to thorough.",
    what: "All three tests only read. They are safe on drives that are in use, and you can abort them at any time.",
    cards: [
      { title: "SMART Short Test (~2 min)", body: "The drive checks its electronics, heads and a sample of the surface." },
      { title: "SMART Extended Test", body: "The drive reads its whole surface by itself. Minutes on SSDs, hours on large hard disks." },
      { title: "Read-Only Surface Scan", body: "The server reads every sector and counts errors. It also catches cable and USB-adapter problems." },
    ],
    when: [
      "Short: a drive suddenly feels slow or shows a warning.",
      "Extended: before trusting a used drive, or when problems continue after a passing short test.",
      "Surface scan: to find exactly how many bad sectors a drive has.",
    ],
    how: [
      "Storage & ZFS → Disks & SMART → Scan Drive on the drive.",
      "Pick a test. You can close the window; it keeps running on the server.",
      "Watch the progress bar and estimated time, or press Abort.",
      "Read the result in the SMART self-test history: 'Completed without error' is good.",
    ],
    tip: "Any read failure or growing bad-block count means: back up now and plan to replace the drive.",
    action: { label: "Open Disks & SMART", app: "storage", intent: "disks" },
  }),
  guide({
    id: "storage-benchmark",
    app: "storage",
    title: "Reading Storage Benchmark Results",
    blurb: "What SEQ1M and RND4K mean, and what good numbers look like.",
    what: "The Benchmark tab runs four classic tests and shows read and write speed for each. Sequential tests measure big files; random 4K tests measure the many tiny requests that VMs and databases make.",
    cards: [
      { title: "SEQ1M Q8T1 / SEQ128K Q32T1", body: "Big files in order: copying videos, backups, ISO downloads. The headline MB/s." },
      { title: "RND4K Q32T1", body: "Many small random requests at once, like several busy VMs." },
      { title: "RND4K Q1T1", body: "One small request at a time: how snappy a single VM feels." },
    ],
    when: ["Comparing an NVMe drive with a hard-disk pool.", "Checking a new drive delivers its rated speed.", "Finding out why VMs feel slow."],
    how: [
      "Storage & ZFS → Benchmark: pick a drive or a pool folder.",
      "Keep Safe Read-Only for drives in use; Read + Write on a folder uses a temporary file that is deleted afterwards.",
      "Press Start All, or run a single row.",
      "Switch between MB/s, IOPS and Latency µs (lower latency is better).",
      "Compare runs in Saved Benchmark Results.",
    ],
    tip: "Rough guide: NVMe 2000–7000 MB/s sequential, SATA SSD about 550, a hard disk 150–250 but only about 1 MB/s at RND4K Q1T1. On ZFS, small writes are buffered in memory, so pool write results can look faster than the drives.",
    action: { label: "Open Benchmark", app: "storage", intent: "benchmark" },
  }),
  guide({
    id: "net-dns",
    app: "netservices",
    title: "Setting Up DNS & Network-Wide Ad Blocking",
    blurb: "Block ads on every device in your home.",
    what: "Your server answers every \"where is this website?\" question for your network (DNS). With AdBlock on, it simply refuses to answer for known ad and tracker domains, so ads vanish everywhere — phones, TVs and consoles included.",
    when: ["Removing ads from smart TVs and apps that ad blockers can't reach.", "Giving devices friendly names like nas.home."],
    how: [
      "Network & Services → DNS & AdBlock: press Install if asked.",
      "Turn on the DNS server and pick an upstream provider (for example Cloudflare or Quad9).",
      "Turn on AdBlocker and choose block lists (StevenBlack is a good start).",
      "In your router's settings, set the DHCP DNS server to this server's IP address.",
      "Reconnect a device and visit an ad-heavy site to check. Whitelist any site that breaks.",
    ],
    action: { label: "Open DNS & AdBlock", app: "netservices", intent: "dns" },
  }),
  guide({
    id: "net-dhcp",
    app: "netservices",
    title: "Configuring DHCP & Router Port Forwarding",
    blurb: "Hand out addresses and open ports safely.",
    what: "DHCP gives every device on your network an IP address automatically. Port forwarding lets the internet reach one specific service inside your network.",
    when: [
      "Your router's DHCP is limited and you want reservations (fixed addresses).",
      "Making a game server or website reachable from outside.",
    ],
    how: [
      "Turn off DHCP on your router first — two DHCP servers on one network cause conflicts.",
      "DHCP tab: Install, choose the address range (for example .100 to .200), gateway and DNS, then enable.",
      "Add reservations so servers and printers always get the same IP.",
      "Router & NAT: add a port forward (protocol, outside port, inside IP and port).",
      "Also forward the same port on your internet router to this server.",
    ],
    tip: "Only forward what you need. For private access from outside, a VPN is safer than opening ports.",
    action: { label: "Open DHCP", app: "netservices", intent: "dhcp" },
  }),
  guide({
    id: "net-wireguard",
    app: "netservices",
    title: "Setting Up WireGuard VPN",
    blurb: "Reach home securely from your phone.",
    what: "WireGuard creates an encrypted tunnel from your phone or laptop back to your home network, so you can use your server and block ads while away — without exposing anything else to the internet.",
    when: ["Opening File Station or Jellyfin from a hotel or mobile data.", "Using public Wi-Fi safely."],
    how: [
      "Network & Services → WireGuard Server: press Install.",
      "Keep the suggested port (51820) and VPN subnet, then Enable.",
      "On your internet router, forward UDP port 51820 to this server.",
      "Add a peer for each device (for example phone) and click its QR code button.",
      "Install the WireGuard app on the phone, tap Add tunnel → Scan QR code, and switch it on.",
    ],
    tip: "Laptops can download the .conf file instead of scanning a QR code.",
    action: { label: "Open WireGuard Server", app: "netservices", intent: "wg" },
  }),
  guide({
    id: "net-certs",
    app: "netservices",
    title: "Installing Free Let's Encrypt or Custom SSL Certificates",
    blurb: "Get the padlock and remove browser warnings.",
    what: "A certificate proves your server is really yours and encrypts traffic (HTTPS). Let's Encrypt issues free certificates automatically; you can also upload one you bought.",
    when: ["Your browser warns \"connection not private\".", "You have a domain name pointing at your server."],
    how: [
      "Certificates tab: add an ACME account with your email (Let's Encrypt).",
      "If your server isn't reachable from the internet, add a DNS plugin for your domain provider (for example Cloudflare API token).",
      "Add your domain (for example pve.example.com) and press Order.",
      "Or choose Custom certificate and paste your certificate and private key.",
      "Reload the page using the domain name; the padlock should appear.",
    ],
    action: { label: "Open Certificates", app: "netservices", intent: "certs" },
  }),
];

export const GUIDES: Record<string, Guide> = Object.fromEntries([WELCOME, ...Object.values(APP_GUIDES), ...SUB_GUIDES].map((g) => [g.id, g]));
