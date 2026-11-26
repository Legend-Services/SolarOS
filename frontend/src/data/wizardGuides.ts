import type { AppId } from "../apps/registry";
import { edition } from "@edition";
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
      body: "This is your server's desktop. Every app has an icon here — click one to open it (prefer double-click? Change it under Settings → General & Appearance). The glass cards on the right are live widgets showing CPU, memory, storage health and running machines.",
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
        "Change Dock size and spacing in View Options or Settings → General & Appearance.",
      ],
      action: { label: "Open General & Appearance", app: "controlpanel", intent: "appearance" },
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
      "Switch to GPU & Sensors to see graphics card load and drive temperatures.",
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
      "Use Grouped | Flat List to sort machines by network, VLAN, lab and your own groups, or see one plain list.",
    ],
    action: { label: "Create a Virtual Machine", app: "compute", intent: "vm" },
    related: ["compute-vm-vs-ct", "compute-create", "compute-groups", "compute-passthrough", "compute-wireframe"],
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
    what: "App Center installs ready-made apps like Jellyfin, Immich, AdGuard Home, Portainer CE and Local AI Studio, each in its own container, with sensible CPU, memory and disk sizes already filled in. Docker Engine & Compose, SMB file sharing and the reverse proxy are built in (Compute › Docker, Settings › Storage & Data › Shared Folders & SMB, Settings › Network & Services › Reverse Proxy & SSL), so they are not in the catalog.",
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
    related: ["net-dns", "net-dhcp", "net-wireguard", "net-certs", "net-reverse-proxy"],
  }),
  datacenter: guide({
    id: "datacenter",
    app: "datacenter",
    title: "Users & Roles Guide",
    blurb: "Users, permissions, firewall and logs.",
    what: "Users & Roles (in Settings) is the advanced control room for {platform} itself: user accounts, groups and roles, who may do what, API tokens, the firewall, and system logs.",
    when: [
      "Giving a friend access to just one VM.",
      "Blocking traffic to a machine with a firewall rule.",
      "Reading logs to find out why something failed.",
    ],
    how: [
      "Users: add a person and set their password.",
      `Permissions: grant a role (for example ${edition.vmUserRole}) on a path such as /vms/101.`,
      "Firewall: add rules for the whole cluster, the host or a single guest.",
      "Logs: read the system journal and task history.",
    ],
    tip: "The SolarDeck service user and its token are protected so you can't lock yourself out by accident.",
    action: { label: "Open Users & Roles", app: "datacenter" },
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
  settings: guide({
    id: "settings",
    app: "settings",
    title: "Settings Guide",
    blurb: "Every system, storage, security, network and hypervisor setting in one place.",
    what: "Settings is the one place to configure SolarDeck and the host. Five categories (System, Storage & Data, Privilege & Security, Network & Services, Hypervisor & Runtime) appear as five large cards on the All Settings page: click a card to open that category with its own sidebar. System opens on Info, the overview of the OS, updates, power and hardware.",
    when: [
      "Changing the theme, wallpaper, Dock or language.",
      "Creating a ZFS pool, a share or a backup schedule.",
      "Turning on two-factor login or checking the security score.",
      "Installing SolarDeck or host updates, or rebooting the host.",
    ],
    how: [
      "Type in Filter settings to search every sub-module of every category, then click a result or press Enter to open the first match.",
      "Inside a category the sidebar lists only that category's sub-modules; use the breadcrumb (← All Settings › Category › Sub-module) to go back.",
      "The ? Guide button in the breadcrumb opens the guide for the sub-module you are in.",
      "The CPU, memory and pool pills in the top bar open Resource Monitor and Storage & ZFS Pools directly.",
    ],
    action: { label: "Open System Info", app: "settings", intent: "system-info" },
    related: ["features-services", "server-setup", "desktop-tour", "security-hardening", "security-modules", "net-reverse-proxy", "dr-321", "users-roles"],
  }),
  controlpanel: guide({
    id: "controlpanel",
    app: "controlpanel",
    title: "Settings Guide",
    blurb: "Security, network, appearance, hardware and power.",
    what: "Settings holds the settings for SolarDeck and the host: security and two-factor login, network, appearance and desktop layout, hardware and GPU drivers, and system updates.",
    when: [
      "Changing your password or turning on two-factor login.",
      "Installing NVIDIA, Intel or AMD graphics drivers.",
      "Making desktop icons bigger or switching to List View.",
      "Updating SolarDeck to the newest version.",
    ],
    how: [
      "Security Posture & Hardening: check the security score. Security & 2FA: change the admin password, set up 2FA and sign out other devices. Audit & System Logs: read the audit log. Add more {platform} users and roles in Users & Roles.",
      "Hardware, GPU & BIOS → GPU & Drivers: pick your card's vendor and press Install.",
      "General & Appearance: themes, Light / Dark Mode, wallpapers, Grid/List view, icon size, spacing and Dock.",
      "System → Info: Check for Updates, or System Services & Repositories → SolarDeck Updates for the schedule and history. To go back to an older version, redeploy that release with deploy.sh.",
      "To report a bug, use Help & Support → Ask, then open an issue on the project's GitHub page with what you saw.",
    ],
    action: { label: "Open General & Appearance", app: "controlpanel", intent: "appearance" },
    related: ["security-hardening"],
  }),
  system: guide({
    id: "system",
    app: "system",
    title: "System Services & Repositories Guide",
    blurb: "Package sources and host updates.",
    what: "System Services & Repositories (in Settings) manages where the host gets its software (package repositories) and installs {platform} and operating system updates.",
    when: [
      "Updates fail with an error like 401 Unauthorized (the Enterprise source needs a paid subscription).",
      "Installing security updates for the host.",
    ],
    how: [
      "Repositories: turn off Enterprise and turn on No-Subscription if you don't have a subscription.",
      "Updates: press Refresh, review the list, then Upgrade.",
      "Reboot from Settings → System → Info if a new kernel was installed.",
    ],
    action: { label: "Open System Services & Repositories", app: "settings", intent: "system-services" },
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
  architect: guide({
    id: "architect",
    app: "architect",
    title: "Network Architect Guide",
    blurb: "See your whole setup as a live blueprint and find every device on a network.",
    what: "Network Architect draws your server (or every host of your cluster), its network ports, the router, virtual switches, VLANs, isolated labs and all VMs and containers as one schematic. Click any network to zoom in, scan it, and see every phone, printer, camera or computer on it with the services it offers.",
    cards: [
      { title: "Blueprint", body: "Tiers from top to bottom: the internet with your gateways and physical switch neighbors, the host or cluster with its network ports, virtual switches, VLANs and labs, then your VMs and containers with their IP addresses in a row below the network they hang from. Green DHCP and DNS badges show which networks hand out addresses and resolve names." },
      { title: "Network drill-down", body: "The router, DHCP server, DNS server, this host and your guests sit around the network hub. When more than six other devices are found they are grouped into one Other Devices (+N) hub so the picture stays readable." },
      { title: "Device scan", body: "Scan Network Now pings the subnet from the host, reads the ARP and DHCP tables, asks for names (reverse DNS and mDNS) and checks a list of common service ports without logging in to anything." },
    ],
    when: [
      "You want to know what is on a network before you change it.",
      "Finding the IP address of a printer, camera or smart-home device.",
      "Checking which VLANs have DHCP and DNS, and which guests are connected where.",
    ],
    how: [
      "Open Network Architect from the App Gallery or Settings → Network & Services → Network Topology.",
      "Start on the Overview: every network, VLAN, lab and custom group is one card. Drag to pan, scroll or use − and + to zoom, and Fit to Screen to see everything again.",
      "Zoom in over a card, or click it, to open its network view, then click Scan Network Now.",
      "Click Other Devices (+N) or Show Devices to search and filter what was found; click the port pills of a device to see what each open port is for.",
    ],
    tip: "A network can only be scanned when the host has an address on it: give the switch or VLAN a host address in Network & Virtual Switch first.",
    action: { label: "Open Network Architect", app: "architect" },
    related: ["architect-semantic-zoom"],
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
    id: "compute-groups",
    app: "compute",
    title: "Smart Compute Groups",
    blurb: "Sort machines by network, VLAN, lab or your own groups and power a whole group at once.",
    what: "In the Grouped view, every virtual switch, VLAN and isolated lab becomes a group holding the machines plugged into it. You can add Custom Groups of any machines you like. Machines on no named network land in Ungrouped, so none are hidden.",
    cards: [
      { title: "Network Groups", body: "Made for you from your switches, VLANs and labs. They show the subnet and whether DHCP is on, and update by themselves when you move a network card." },
      { title: "Custom Groups", body: "Any machines you pick, for example everything that makes up one app. Link one to a network to show that network's adapters on it." },
      { title: "Multi-homed machines", body: "A machine on two networks shows up in both groups, each time with the network card and IP address it uses there, plus a 2 Networks badge listing all its groups." },
    ],
    when: ["You run many machines and want to see them per network.", "Starting or stopping everything that belongs to one app or lab.", "Finding which machines can reach a VLAN."],
    how: [
      "Open Compute Manager and pick Grouped in the toolbar.",
      "Press + Create Group and tick the machines; a machine on a named VLAN or lab fills in the name and color for you.",
      "Use Assign to Group… on any machine to add it to or remove it from custom groups.",
      "Press Start Group or Stop Group on a group to power all its members.",
    ],
    tip: "Network groups follow your network cards, so they cannot be edited; make a custom group linked to the network instead.",
    action: { label: "Open Compute Manager", app: "compute" },
  }),
  guide({
    id: "architect-semantic-zoom",
    app: "architect",
    title: "Semantic Zoom in Network Architect",
    blurb: "Go from the whole environment to one network to one device by zooming.",
    what: "Network Architect draws less detail when you zoom out and more when you zoom in, so a big setup stays readable.",
    cards: [
      { title: "1 · Overview", body: "Hosts, network ports, virtual switches and one card per network, VLAN, lab and custom group with its subnet, DHCP and DNS badges, node count and discovered device count." },
      { title: "2 · Network or group", body: "Zoom in past 75 % over a card or click it: the router, DHCP and DNS servers, this host and every member, each with the network card it uses there." },
      { title: "3 · Machine or device", body: "Click a VM or container for its hardware and console drawer, or Other Devices (+N) for the searchable device explorer with open ports explained." },
    ],
    when: ["Getting the big picture of a large network.", "Checking one VLAN without the rest in the way.", "Looking up a single device's address and open ports."],
    how: [
      "Open Network Architect; it starts on the Overview.",
      "Scroll in over a card or click it to open that network or group.",
      "Click a machine or the Other Devices hub to inspect it.",
      "Click Overview in the floating bar, or zoom back out, to return; Fit to Screen shows everything again.",
    ],
    tip: "The same groups appear as pills in Settings → Network & Services → Virtual Switch & VLANs; click one to jump straight into it here.",
    action: { label: "Open Network Architect", app: "architect" },
  }),
  guide({
    id: "compute-wireframe",
    app: "compute",
    title: "Wireframe Node Architecture & Hardware ID Overrides",
    blurb: "Inspect and edit a VM or container as a schematic computer.",
    what: "Every VM and container window has a Form View and a Wireframe Architecture view. The wireframe draws the guest as a computer case with its network cards, PCIe cards, peripherals and drives, connected by lines to the switch or VLAN each network card is plugged into, to an isolated lab when it is in one, and to the host (or cluster hosts) it runs on.",
    cards: [
      { title: "Click to inspect", body: "Click any device in the case to open the Hardware Device Inspector: name, MAC address with a randomizer, driver model, slot, vendor and device ID, serial number, link and speed." },
      { title: "Guest Device Manager name", body: "Give a virtual capture card or webcam the name the guest's own device list should show (for example Studio HDMI Capture Pro). Fields marked Visible in guest reach the guest; others are SolarDeck labels." },
      { title: "Re-patch in one click", body: "Click a network line or switch node to move that network card to another virtual switch, physical bridge, router, VLAN or isolated lab immediately." },
    ],
    when: [
      "You want to see at a glance how a guest is wired.",
      "Changing a MAC address, NIC model, VLAN or speed limit.",
      "Moving a guest into or out of an isolated lab.",
    ],
    how: [
      "Open Compute Manager, click a VM or container and switch to Wireframe Architecture at the top.",
      "Click a device to inspect it; edit the fields and click Save & Apply.",
      "Click a line or switch node, pick the new switch, VLAN or lab and click Apply Now.",
      "Check the host node on the right: Standalone Mode shows the host and its address, Cluster Mode the preferred active host, standby hosts, ZFS sync interval and floating VIPs.",
    ],
    tip: "Changing the model or MAC of a running VM's network card applies after the guest restarts on some platforms; the camera's new name appears once no program in the guest holds the camera open.",
    action: { label: "Open Compute Manager", app: "compute" },
  }),
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
      "For GPUs, switch the card to passthrough mode in Settings → Hardware, GPU & BIOS → GPU & Drivers.",
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
      "Settings → Storage & ZFS Pools → Disks & SMART: make sure the new drives show Unused (wipe them if they held old data).",
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
      "Settings → Storage & ZFS Pools → Disks & SMART: green PASSED is good; FAILED means replace the drive soon.",
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
      "Settings → Storage & ZFS Pools → ZFS Pools: find the drive marked FAULTED, DEGRADED or with errors.",
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
      "Settings → Storage & ZFS Pools → Disks & SMART → Scan Drive on the drive.",
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
      "Settings → Storage & ZFS Pools → Benchmark: pick a drive or a pool folder.",
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
      "Settings → Network Topology → DNS & AdBlock: press Install if asked.",
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
    id: "net-vlan-templates",
    app: "settings",
    title: "Splitting Your Network with VLAN Templates",
    blurb: "Six ready-made VLANs, from Management to a DMZ, and how each one keeps traffic apart.",
    what: "A VLAN splits one physical network into separate virtual networks. Each VLAN is its own Layer-2 broadcast domain, identified by an 802.1Q tag on every frame, with its own Layer-3 subnet (10.10.<ID>.0/24) and the host as gateway. Firewall zone rules then decide which VLANs may talk to the internet (WAN), the main LAN and Management.",
    cards: [
      { title: "10 · Management", body: "Hypervisor, BMC/IPMI and switch management. Only trusted admin workstations may connect in." },
      { title: "20 · IoT Devices", body: "Smart home devices and their broadcast/mDNS chatter. Internet or MQTT broker yes, Management or personal PCs no." },
      { title: "30 · Guest Network", body: "Visitors get their own DHCP pool and DNS and internet only; east-west and LAN traffic is dropped." },
      { title: "40 · Lab", body: "Experimental DHCP servers, gateways and packet captures without IP conflicts on your main network." },
      { title: "50 · Cameras", body: "High-bitrate RTSP/ONVIF streams stay inside the VLAN and talk only to the local NVR, usually without internet." },
      { title: "60 · DMZ", body: "A screened buffer subnet for internet-facing services such as a reverse proxy, web server, mail relay or game server; a compromised guest cannot pivot into Management or storage." },
    ],
    when: ["Smart home gadgets or cameras should not see your PCs.", "Guests need Wi-Fi without access to your files.", "You publish a service to the internet and want it fenced off."],
    how: [
      "Settings → Network & Services → Virtual Switch & VLANs: press + Create New VLAN.",
      "Hover a template to read what it is for and how it works, then click it to fill in the ID, name, host IP, description and color.",
      "Press Save and apply the staged change; drag ports or guest network cards onto the new VLAN card.",
      "Add matching zones and rules in Firewall & Zones so the VLAN can only reach what its template describes.",
    ],
    tip: "A VLAN on its own only separates broadcast domains; the firewall rules between zones are what stop traffic from crossing.",
    action: { label: "Open Virtual Switch & VLANs", app: "settings", intent: { module: "network-switch", tab: "vswitch" } },
  }),
  guide({
    id: "osi-explorer",
    app: "compute",
    title: "Learning the 7 OSI Layers with the OSI Architecture Explorer",
    blurb: "See which of the seven network layers every guest, card, switch, service and app works on, with live values and troubleshooting tips.",
    what: "The OSI model splits network communication into seven layers. L1 Physical carries bits over a cable or virtual cable. L2 Data Link delivers frames by MAC address (switches, VLAN tags). L3 Network routes packets by IP address (routers, NAT). L4 Transport moves segments between TCP/UDP ports. L5 Session keeps conversations open, L6 Presentation encrypts them with TLS, and L7 Application is the web page, API or DNS lookup itself. The OSI Architecture view highlights the layers a component works on and shows its live MAC, VLAN, IP, port and TLS values on the right layer.",
    cards: [
      { title: "Layers 1–2: link and switching", body: "Physical ports, bonds, vNICs, veth pairs and virtual switches. Link down? Check the cable or the virtual switch attachment." },
      { title: "Layer 3: addresses and routing", body: "IP addresses, subnets, gateways, NAT and the WireGuard tunnel. Link up but no ping? Check the subnet, gateway and firewall rules." },
      { title: "Layer 4: ports", body: "TCP and UDP ports: DNS on 53, DHCP on 67/68, WireGuard on 51820, web on 80/443. Ping works but the service is silent? Check the port and its firewall rule." },
      { title: "Layers 5–7: sessions, TLS and apps", body: "Logins, WebSockets, certificates and the app itself. The reverse proxy works on all four upper layers at once." },
    ],
    when: ["You are new to networking and want to see how traffic moves through your server.", "Something does not connect and you want to find the layer where it breaks.", "You want to understand how an App Center app is reachable from your browser."],
    how: [
      "Open a VM or container and choose OSI Architecture next to Form View and Wireframe Architecture.",
      "Pick the guest's overall stack or one of its network adapters, drives, peripherals or GPUs.",
      "Click any layer to open its learning card: what the layer does, what happens in this component, and a troubleshooting tip.",
      "In Network Architect, turn on OSI Architecture and click any node; in Network & Services, open Show OSI Architecture; in App Center, press OSI Architecture on an app.",
    ],
    tip: "Troubleshoot from the bottom up: confirm Layer 1 (link up), then Layer 2 (right switch and VLAN), Layer 3 (IP and gateway), Layer 4 (port open) and only then the app.",
    action: { label: "Open Compute", app: "compute" },
  }),
  guide({
    id: "net-wireguard",
    app: "netservices",
    title: "Setting Up WireGuard VPN",
    blurb: "Reach home securely from your phone.",
    what: "WireGuard creates an encrypted tunnel from your phone or laptop back to your home network, so you can use your server and block ads while away — without exposing anything else to the internet.",
    when: ["Opening File Station or Jellyfin from a hotel or mobile data.", "Using public Wi-Fi safely."],
    how: [
      "Settings → WireGuard VPN: press Install.",
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
      `Add your domain (for example ${edition.hostExample}) and press Order.`,
      "Or choose Custom certificate and paste your certificate and private key.",
      "Reload the page using the domain name; the padlock should appear.",
    ],
    action: { label: "Open Certificates", app: "netservices", intent: "certs" },
  }),
  guide({
    id: "security-hardening",
    app: "controlpanel",
    title: "Security Hardening & Two-Factor Sign-In",
    blurb: "Raise your security score and lock the front door.",
    what: "The administrator controls the whole server, so the sign-in deserves the strongest protection; give other people their own limited account under Users & Roles. Security & Hardening gives you a score from 0 to 100, fixes host settings with one click and keeps a tamper-evident record of every sign-in and destructive action.",
    cards: [
      { title: "Two-factor sign-in", body: "A 6-digit code from your phone is needed besides the password. Eight recovery codes get you in if the phone is lost." },
      { title: "Confirm before destroying", body: "Wiping a disk, destroying a pool, deleting a VM or opening a root shell asks for your password again (valid for 5 minutes)." },
      { title: "Host hardening", body: "Kernel protections, key-only SSH, a default-deny firewall and automatic security updates." },
      { title: "Audit log", body: "Every entry is linked to the one before it by a fingerprint, so any edit or deletion shows up when you press Verify Hash Chain." },
    ],
    when: ["Right after installing, before the server is reachable from other networks.", "When the score shows Action Recommended.", "After a phone, laptop or password may have been exposed."],
    how: [
      "Settings → Security & 2FA: look at the score and the checklist.",
      "Press Apply Recommended Hardening; follow the live log until it finishes.",
      "Two-Factor Authentication → Set Up 2FA: scan the QR code, enter the code, then download the recovery codes and keep them somewhere safe.",
      "Active Sessions: revoke devices you don't recognise, or Revoke All Other Sessions.",
      "Audit Log: filter by event, press Verify Hash Chain and export JSON or CSV for your records.",
    ],
    tip: "SSH passwords stay on until someone has an SSH key on the server, so the hardening never locks you out. Lost your phone and recovery codes? Use [2] Reset Administrator on the server's own screen.",
    action: { label: "Open Security & Hardening", app: "controlpanel", intent: "security" },
  }),
  guide({
    id: "net-reverse-proxy",
    app: "settings",
    title: "Publishing Apps with the Reverse Proxy & SSL",
    blurb: "Open your apps under your own domain names, with HTTPS and an optional 2FA gate.",
    what: "The reverse proxy gives each VM, container or app its own address like ai.home.lan or media.example.net, adds HTTPS, and can ask visitors to sign in to SolarDeck first. It can also forward raw TCP and UDP ports, for example for a game server.",
    cards: [
      { title: "Private root CA", body: "One click creates your own certificate authority; install its certificate on your devices once and every certificate it signs is trusted." },
      { title: "Let's Encrypt", body: "Free public certificates, renewed automatically 30 days before they expire." },
      { title: "2FA gate", body: "Visitors who are not signed in to SolarDeck are sent to its sign-in (with your two-factor code) before they see the app." },
      { title: "Isolated container", body: "The recommended mode runs the proxy in its own hardened container, which you can pin to a DMZ VLAN." },
    ],
    when: ["You want to reach an app by name instead of IP and port.", "Browsers warn that a connection is not private.", "An app has no login of its own and must not be open to everyone."],
    how: [
      "Turn the module on; keep Isolated Container (Recommended) and pick the DMZ if you have one.",
      "SSL Certificates: create the private root CA and download it, or request a Let's Encrypt certificate.",
      "Proxy Hosts: add the domain, pick the VM, container or app, choose the certificate and switch on the 2FA gate if needed.",
      "Point the domain at SolarDeck in your DNS (Settings → DNS, AdBlock & DHCP can do this for local names).",
    ],
    tip: "Every change is tested before it goes live; a mistake never takes the other sites down.",
    action: { label: "Open Reverse Proxy & SSL", app: "settings", intent: "reverse-proxy" },
  }),
  guide({
    id: "security-modules",
    app: "settings",
    title: "Security-by-Design Modules",
    blurb: "Choose where each optional feature runs and which network it may reach.",
    what: "Optional features such as the reverse proxy, offsite backups or NFS can each be switched on or off, run in an isolated container or directly on the host, and be pinned to the management network, a VLAN, the DMZ or an isolated lab. Pinned modules get firewall rules that allow only their own service ports.",
    when: ["Before exposing a service to the internet.", "When you want a feature off entirely until you need it.", "To keep a service away from your management network."],
    how: [
      "Settings → Security-by-Design Modules lists every module.",
      "Turn a module on with its switch.",
      "Pick Isolated Container where available (recommended for anything reachable from outside).",
      "Choose the network, pick the switch and VLAN, and press Apply.",
    ],
    action: { label: "Open Security-by-Design Modules", app: "settings", intent: "platform-modules" },
  }),
  guide({
    id: "dr-321",
    app: "settings",
    title: "Disaster Recovery & the 3-2-1 Backup Rule",
    blurb: "Three copies, two kinds of storage, one far away — and proof that they restore.",
    what: "Disaster Recovery keeps an encrypted snapshot of SolarDeck's own configuration, copies your backups to an offsite target (S3-compatible storage, SFTP or WebDAV) and regularly proves a backup really boots by restoring it into an air-gapped sandbox.",
    when: ["Right after setting up your network, shares and proxy.", "Before major changes or hardware swaps.", "To be sure a backup works before you need it."],
    how: [
      "Create a host snapshot with a long passphrase and keep the passphrase somewhere safe.",
      "Add an offsite target and press Sync now.",
      "Pick a backup under Sandbox Restore Verification and press Verify in sandbox.",
    ],
    tip: "Without the passphrase a host snapshot cannot be opened — not even by SolarDeck.",
    action: { label: "Open Backups & Disaster Recovery", app: "settings", intent: { module: "backup-restore", tab: "dr" } },
  }),
  guide({
    id: "users-roles",
    app: "settings",
    title: "Accounts for Family, Friends and Colleagues",
    blurb: "Give people their own sign-in with only the rights they need.",
    what: "Besides the administrator, SolarDeck accounts can be operators (day-to-day management), seat users (only their own Seat VM, its console and USB ports) or viewers (read-only).",
    when: ["Someone else should start their gaming or work VM without seeing the rest.", "A helper manages VMs but must not change security settings.", "You want to show the dashboard without risk."],
    how: [
      "Turn the Users & Roles module on.",
      "Add an account, choose a role and a strong password.",
      "For a seat user, select the VMs and seats they may use.",
    ],
    action: { label: "Open Users & Roles", app: "settings", intent: { module: "users-roles", tab: "accounts" } },
  }),
  guide({
    id: "features-services",
    app: "settings",
    title: "Features & Services: Keep Your Interface Clean",
    blurb: "Hide what this server does not use, bring it back any time.",
    what: "Every optional feature has its own switch. A feature you turn off disappears from the Settings sidebar, its inner tabs, the TopBar search and the desktop. Its saved settings stay, so turning it back on restores everything.",
    cards: [
      { title: "Sub-features", body: "WireGuard VPN has separate switches for the server (remote access in) and the client (tunnels out). Per-VLAN DHCP Servers sit under Virtual Switch." },
      { title: "Background services", body: "Turning off WireGuard, per-VLAN DHCP or UPS monitoring pauses that service; turning it on starts it again. Configuration files are never deleted." },
      { title: "Always there", body: "General & Appearance, Users & Roles, System Services & Repositories and Features & Services itself cannot be hidden." },
    ],
    when: ["The sidebar shows things you never use.", "You set up a dedicated storage, gateway or AI box.", "Someone new should not be overwhelmed."],
    how: [
      "Open Settings › Features & Services.",
      "Flip switches, or press a quick preset such as Minimal Core or Home & Media Server.",
      "Press Re-run Setup Wizard to choose server roles again.",
    ],
    action: { label: "Open Features & Services", app: "settings", intent: "features-services" },
    related: ["server-setup", "desktop-tour"],
  }),
  guide({
    id: "server-setup",
    app: "settings",
    title: "Guided Server Setup Wizard",
    blurb: "Pick server roles on visual cards and set everything up in one go.",
    what: "The wizard opens on the first sign-in of a new installation. You tick one or more server roles on wireframe cards, choose Standalone Server or Cluster Host, fine-tune single services, tick apps to install, and press Setup My Server. A live progress card runs from 0 to 100 %.",
    cards: [
      { title: "Roles", body: "Storage & Media, Virtualization Host, Multi-Seat Gaming, High-Availability Cluster, Network Gateway & VPN, AI Compute and Other Services. Combine as many as you like." },
      { title: "Apps", body: "Tick Local AI Studio, Jellyfin, Immich, AdGuard Home or Portainer CE; each card shows its CPU, memory and disk needs. Docker Engine, file sharing and the reverse proxy are built-in services you switch on under Customize Services." },
      { title: "Finish", body: "The finish screen shows the server address, roles and apps. Cluster Host opens cluster setup next." },
    ],
    when: ["Right after installing.", "The server takes on a new job.", "You want to start over with a clean selection."],
    how: [
      "Open Settings › Features & Services and press Re-run Setup Wizard.",
      "Tick roles and the topology, press Next (or Customize Services).",
      "Tick apps, check the summary and decide whether to skip the desktop tour.",
      "Press Setup My Server and wait for the finish screen.",
    ],
    tip: "On the first run, Skip Setup & Use Defaults keeps every feature on.",
    action: { label: "Open Features & Services", app: "settings", intent: "features-services" },
    related: ["features-services", "desktop-tour"],
  }),
  guide({
    id: "desktop-tour",
    app: "help",
    title: "Interactive Desktop Tour",
    blurb: "Five speech balloons that show where everything lives.",
    what: "The tour points at the real desktop: the search bar, the system tray and Task Center, the widgets, the Dock or taskbar with your apps, and Settings › Features & Services. Each balloon has Back, Next and Skip Guide.",
    when: ["You just set up the server.", "Someone new uses the desktop.", "You forgot where something is."],
    how: [
      "Open Help & Support and press Start tour (or the ? menu in the top bar › Interactive Desktop Tour).",
      "Read the balloon and press Next, or Skip Guide to stop at any moment.",
    ],
    action: { label: "Open Help & Support", app: "help" },
    related: ["features-services", "server-setup"],
  }),
];

export const GUIDES: Record<string, Guide> = Object.fromEntries([WELCOME, ...Object.values(APP_GUIDES), ...SUB_GUIDES].map((g) => [g.id, g]));
