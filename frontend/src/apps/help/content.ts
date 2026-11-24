import type { AppId } from "../registry";
import type { Intents } from "../../lib/stores";

/** Where a "Show me" button goes: an app, optionally a section / wizard inside it (see useIntent). */
export interface HelpLink {
  app: AppId;
  intent?: Intents[keyof Intents];
  label?: string;
}

export interface Tutorial {
  id: string;
  title: string;
  category: Category;
  minutes: number;
  keywords: string;
  intro: string;
  steps: { text: string; link?: HelpLink }[];
  /** Diagnostic fix that helps with this task (Help Center → Fix problems). */
  fix?: string;
}

export interface Faq {
  q: string;
  a: string;
  keywords: string;
  link?: HelpLink;
}

export const CATEGORIES = ["Getting started", "Virtual machines & containers", "Storage & files", "Backups", "Network & internet", "Graphics cards", "Security & users", "System & updates"] as const;
export type Category = (typeof CATEGORIES)[number];

export const TUTORIALS: Tutorial[] = [
  {
    id: "tour",
    title: "Find your way around the desktop",
    category: "Getting started",
    minutes: 2,
    keywords: "start begin tour dock launchpad spotlight search window desktop how use new beginner",
    intro: "ProxmoxOS works like a Mac or Windows desktop for your server. Every tool is an app in a window.",
    steps: [
      { text: "The bar at the bottom is the Dock. Click an icon to open that app; click it again to hide the window." },
      { text: "The grid button on the far left of the Dock opens Launchpad: every app, with a search box." },
      { text: "Press ⌘K (Mac) or Ctrl+K (Windows/Linux) anywhere to search apps, VMs, containers, folders and settings." },
      { text: "Drag a window by its title bar. Drag it to the left/right edge to fill half the screen, or to the top to maximise." },
      { text: "Right-click the desktop for shortcuts such as 'New Virtual Machine' and 'Change Wallpaper'." },
      { text: "Open Resource Monitor to see CPU, memory, network and storage at a glance.", link: { app: "monitor" } },
    ],
  },
  {
    id: "create-vm",
    title: "Create a virtual machine (Windows, Ubuntu, …)",
    category: "Virtual machines & containers",
    minutes: 5,
    keywords: "vm virtual machine create new install windows linux ubuntu debian iso computer",
    intro: "A virtual machine (VM) is a complete computer running inside your server. You need an installer ISO first.",
    steps: [
      { text: "Get an installer: open ISO & Templates, paste the download link of the ISO (for example from ubuntu.com) and press Download.", link: { app: "compute", intent: "iso" } },
      { text: "Start the Create VM wizard.", link: { app: "compute", intent: "vm" } },
      { text: "General: type a name. OS: choose the ISO you downloaded and the operating system type (Windows 11 adds the required TPM automatically)." },
      { text: "Disk: pick a storage and a size (32 GB is enough for Linux, 64 GB or more for Windows)." },
      { text: "CPU & Memory: 2 cores and 4096 MB is a good start. You can change this later." },
      { text: "Review and press Create. When the log says TASK OK, press Start in Compute Manager, then Console to see the screen and install the OS." },
    ],
  },
  {
    id: "create-ct",
    title: "Create a lightweight Linux container (LXC)",
    category: "Virtual machines & containers",
    minutes: 3,
    keywords: "container lxc ct create linux lightweight template debian ubuntu alpine",
    intro: "Containers start in seconds and use very little memory. They run Linux only.",
    steps: [
      { text: "Download a template in ISO & Templates (tab 'Templates'), e.g. Debian 12.", link: { app: "compute", intent: "iso" } },
      { text: "Start the Create Container wizard.", link: { app: "compute", intent: "lxc" } },
      { text: "Choose the template, set a root password, disk size and memory, and DHCP for the network." },
      { text: "Press Create, then Start. Click 'Shell' to get a root prompt inside the container instantly — no login needed." },
    ],
  },
  {
    id: "console",
    title: "See a VM's screen or open a command line",
    category: "Virtual machines & containers",
    minutes: 1,
    keywords: "console screen shell terminal command line ssh root prompt novnc keyboard host",
    intro: "There are three kinds of command lines and screens in ProxmoxOS.",
    steps: [
      { text: "VM screen: in Compute Manager, click 'Console' on a running VM. Use the Ctrl+Alt+Del button for Windows logins.", link: { app: "compute" } },
      { text: "Container shell: click 'Shell' on a running container. You are root inside it immediately.", link: { app: "compute" } },
      { text: "Host Shell: the green terminal icon in the Dock or the top bar opens a root prompt on the Proxmox server itself. Be careful: commands here affect everything.", link: { app: "terminal" } },
    ],
  },
  {
    id: "apps",
    title: "Install a ready-made app (Plex, Home Assistant, …)",
    category: "Virtual machines & containers",
    minutes: 3,
    keywords: "app center install plex jellyfin home assistant nextcloud docker media one click",
    intro: "App Center installs popular apps into their own container with one click.",
    steps: [
      { text: "Open App Center and pick an app.", link: { app: "appcenter" } },
      { text: "Leave the defaults (they are sensible), tick 'Storage' if the app should see your files, and press Deploy." },
      { text: "Wait for 'done'. The app's address appears in the deployment card — click it to open the app." },
    ],
  },
  {
    id: "guest-edit",
    title: "Change a VM's memory, CPU, network or snapshots",
    category: "Virtual machines & containers",
    minutes: 2,
    keywords: "edit change memory ram cpu cores disk resize network nic snapshot cloud-init options hardware",
    intro: "Every VM and container has a settings drawer.",
    steps: [
      { text: "Open Compute Manager and click the guest's name (or 'Edit').", link: { app: "compute" } },
      { text: "Resources: cores, memory, disk size. Network: add or change network cards and VLANs. Snapshots: save a restore point before risky changes." },
      { text: "Changes marked PENDING apply after the VM is shut down and started again." },
    ],
  },
  {
    id: "zfs-pool",
    title: "Add new disks as a ZFS pool",
    category: "Storage & files",
    minutes: 4,
    keywords: "disk drive hdd ssd nvme zfs pool raid mirror raidz new add storage",
    intro: "A ZFS pool combines one or more disks into safe, self-healing storage.",
    steps: [
      { text: "Open Storage & ZFS → Disks to check your new disks are listed and healthy.", link: { app: "storage" } },
      { text: "Start Create ZFS Pool.", link: { app: "storage", intent: "pool" } },
      { text: "Choose a layout: Mirror (2 disks, survives 1 failure) or RAIDZ1 (3+ disks, survives 1 failure). Single has no protection." },
      { text: "Pick the disks — everything on them is erased — and press Create." },
    ],
  },
  {
    id: "share",
    title: "Share a folder with your PC, Mac or TV (SMB)",
    category: "Storage & files",
    minutes: 3,
    keywords: "share folder network smb samba windows mac tv nas time machine drive map",
    intro: "Network Shares makes a folder appear on other computers like a network drive.",
    steps: [
      { text: "Open Network Shares and press 'New share'. Let it create its own dataset.", link: { app: "shares" } },
      { text: "Add a share user with a password (the 'Users' section)." },
      { text: "On Windows open \\\\<ProxmoxOS-IP>\\<share>, on a Mac use Finder → Go → Connect to Server → smb://<ProxmoxOS-IP>/<share>." },
    ],
  },
  {
    id: "files",
    title: "Upload, download and organise files",
    category: "Storage & files",
    minutes: 1,
    keywords: "files upload download folder rename delete file station browse",
    intro: "File Station is a file manager for the storage on your server.",
    steps: [
      { text: "Open File Station.", link: { app: "files", intent: "/" } },
      { text: "Drag files from your computer into the window to upload. Right-click a file to rename, download or delete it." },
    ],
  },
  {
    id: "storage-backends",
    title: "Use a NAS or extra disk as Proxmox storage (NFS, SMB, LVM, directory)",
    category: "Storage & files",
    minutes: 3,
    keywords: "nfs cifs smb nas storage add directory lvm thin mount iso backup location",
    intro: "Proxmox can keep VM disks, ISOs and backups on many kinds of storage.",
    steps: [
      { text: "Open Storage & ZFS → Storage backends → Add storage.", link: { app: "storage" } },
      { text: "Pick the type: NFS or CIFS/SMB for a NAS, Directory for a mounted folder, LVM/ZFS for local disks." },
      { text: "Fill in the server and choose the export/share from the list, tick what it may hold (Backups, ISO images, Disk images) and save." },
    ],
  },
  {
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
  {
    id: "disk-tests",
    title: "Check a disk's health: SMART Short Test, Extended Test and Surface Scan",
    category: "Storage & files",
    minutes: 3,
    keywords: "smart test short long extended surface scan badblocks bad sectors health check disk drive failing errors diagnose",
    intro: "Three tests, from quick to thorough. All are read-only and safe on disks that are in use.",
    steps: [
      { text: "Open Disks & SMART and press Scan Drive on the disk.", link: { app: "storage", intent: "disks" } },
      { text: "SMART Short Test (about 2 minutes): the drive checks its own electronics, heads and a small sample of the surface. Run it first whenever a disk seems slow or shows warnings." },
      { text: "SMART Extended Test (minutes on SSDs, several hours on large HDDs): the drive reads its entire surface internally. Use it before trusting a used disk or when the short test passes but problems continue." },
      { text: "Read-Only Surface Scan (hours): ProxmoxOS reads every sector from the server with badblocks and counts read errors. It also catches cable, controller and USB-bridge problems that the drive's own tests miss." },
      { text: "You can close the window while a test runs. Abort stops it at any time. Results appear in the SMART self-test history table." },
      { text: "Any 'read failure' result, a growing bad-block count or a rising Reallocated Sector count in Inspect SMART means: back up now and plan to replace the disk." },
    ],
  },
  {
    id: "storage-benchmark",
    title: "Benchmark your disks and pools (and read SEQ1M vs RND4K)",
    category: "Storage & files",
    minutes: 3,
    keywords: "benchmark speed test fast slow disk ssd nvme hdd pool mb/s iops latency seq1m rnd4k fio performance compare",
    intro: "The Benchmark tab measures how fast a drive or pool really is, with the four classic tests used by desktop disk benchmark tools.",
    steps: [
      { text: "Open Storage & ZFS → Benchmark.", link: { app: "storage", intent: "benchmark" } },
      { text: "Pick a drive or a pool/dataset folder. Safe Read-Only never writes and works on disks in use. Read + Write on a folder uses a temporary file that is deleted afterwards. Press Start All." },
      { text: "SEQ1M Q8T1 and SEQ128K Q32T1 are sequential: big files read or written in order (copying videos, backups, ISO downloads). This is the 'headline' MB/s number." },
      { text: "RND4K Q32T1 is many small random requests at once, like several busy VMs or a database. RND4K Q1T1 is one small request at a time: it decides how snappy a single VM or container feels." },
      { text: "Rough guide: NVMe SSDs reach 2000–7000 MB/s sequential and 40–90 MB/s RND4K Q1T1; SATA SSDs about 550 MB/s and 30–50 MB/s; a single hard disk 150–250 MB/s sequential but only about 1 MB/s RND4K. A RAIDZ of hard disks adds sequential speed, not random speed." },
      { text: "Switch the unit to IOPS (requests per second) or Latency µs (time per request, lower is better). Finished runs are saved below so you can compare your NVMe drives against your hard-disk pool. On a ZFS pool, small writes are first collected in memory, so RND4K write results there can look faster than the disks themselves." },
    ],
  },
  {
    id: "backup",
    title: "Back up and restore your VMs and containers",
    category: "Backups",
    minutes: 3,
    keywords: "backup restore vzdump schedule automatic recover lost undo",
    intro: "Backups are copies of a whole VM or container you can restore at any time.",
    fix: "backups",
    steps: [
      { text: "Open Backup Center → 'Backup Now' for a one-time backup of one or all guests.", link: { app: "backup" } },
      { text: "Under Schedules, create an automatic job (e.g. every Sunday 02:00, keep the last 4) — or let the Help Center do it for you." },
      { text: "To restore, pick an archive and press Restore. Use a new VM ID to keep the current one, or overwrite it." },
    ],
  },
  {
    id: "gpu-passthrough",
    title: "Give your graphics card to a VM (gaming, AI, video)",
    category: "Graphics cards",
    minutes: 10,
    keywords: "gpu graphics card nvidia rtx amd radeon passthrough vfio vm windows gaming iommu vt-d pci hdmi",
    intro: "Passthrough gives one VM full, native control of a graphics card. It takes three steps and one or two reboots.",
    fix: "iommu",
    steps: [
      { text: "Turn on IOMMU (VT-d). Help Center → Fix problems → 'Device passthrough (IOMMU / VT-d)' does it for you, and 'BIOS & firmware' shows how to enable VT-d in your BIOS (with a QR code for your phone).", link: { app: "help", intent: "fix" } },
      { text: "Switch the card to VM Passthrough Mode in Control Panel → Hardware & System → GPU & Drivers, then reboot the host.", link: { app: "controlpanel", intent: "hardware" } },
      { text: "Create the VM (or edit it) and add the card under Hardware & Passthrough. Keep 'Include HDMI audio' on; tick 'Primary GPU' to use the card's video outputs.", link: { app: "compute", intent: "vm" } },
      { text: "Start the VM and install the GPU driver inside it (e.g. NVIDIA's driver in Windows)." },
    ],
  },
  {
    id: "gpu-drivers",
    title: "Install graphics drivers on the host (CUDA, Quick Sync, ROCm)",
    category: "Graphics cards",
    minutes: 10,
    keywords: "driver nvidia cuda nvidia-smi intel quicksync quick sync transcoding amd rocm install gpu host container plex jellyfin",
    intro: "Use host drivers when containers (Plex, Jellyfin, AI tools) should share the card.",
    steps: [
      { text: "Open Control Panel → Hardware & System and scroll to GPU & Drivers.", link: { app: "controlpanel", intent: "hardware" } },
      { text: "Press the install button for your card (NVIDIA, Intel or AMD), confirm, and watch the live log." },
      { text: "Reboot the host when the log asks for it. The GPU card then shows live usage and temperature." },
    ],
  },
  {
    id: "adblock",
    title: "Block ads on every device in your home",
    category: "Network & internet",
    minutes: 5,
    keywords: "adblock ads block tracker dns pihole pi-hole adguard blocklist",
    intro: "The DNS AdBlocker filters ads and trackers for every device that uses your server as its DNS server.",
    steps: [
      { text: "Open Network & Services → DNS & AdBlock and press Install.", link: { app: "netservices" } },
      { text: "Choose the network bridge to listen on (your LAN, e.g. vmbr0), enable DNS and turn on the StevenBlack and OISD lists. Press 'Update now'." },
      { text: "In your router's settings, set the DNS server to the Proxmox host's IP address. Devices pick it up after reconnecting." },
    ],
  },
  {
    id: "vpn",
    title: "Reach your server from anywhere with WireGuard VPN",
    category: "Network & internet",
    minutes: 6,
    keywords: "vpn wireguard remote access phone away from home outside qr tunnel",
    intro: "A VPN lets your phone or laptop connect safely to your home network from anywhere.",
    steps: [
      { text: "Open Network & Services → WireGuard Server, press Install, then Enable.", link: { app: "netservices" } },
      { text: "Add a peer (one per device) and press the QR button." },
      { text: "Install the WireGuard app on your phone and scan the QR code." },
      { text: "In your internet router, forward UDP port 51820 to the Proxmox host's IP." },
    ],
  },
  {
    id: "port-forward",
    title: "Open a port / forward traffic to a VM",
    category: "Network & internet",
    minutes: 3,
    keywords: "port forward nat router dnat open port game server expose internet",
    intro: "Port forwarding sends traffic arriving at the host on a port to a VM or container.",
    steps: [
      { text: "Open Network & Services → Router & NAT.", link: { app: "netservices" } },
      { text: "Add a port forward: external port, the VM's IP address and port, and TCP/UDP. Press Apply." },
      { text: "If traffic comes from the internet, forward the same port in your home router to the Proxmox host." },
    ],
  },
  {
    id: "https",
    title: "Get a padlock (HTTPS certificate)",
    category: "Network & internet",
    minutes: 6,
    keywords: "https ssl tls certificate lets encrypt acme padlock secure domain",
    intro: "A certificate removes browser security warnings.",
    steps: [
      { text: "Open Network & Services → Certificates.", link: { app: "netservices" } },
      { text: "Let's Encrypt: register an account, add your domain (and a DNS plugin if the host isn't reachable from the internet) and press Order." },
      { text: "Own certificate: paste the certificate and private key and apply them to Proxmox and/or ProxmoxOS." },
    ],
  },
  {
    id: "2fa",
    title: "Protect your sign-in with a phone code (2FA)",
    category: "Security & users",
    minutes: 2,
    keywords: "2fa two factor totp authenticator security password login protect",
    intro: "With 2FA, a stolen password alone is not enough to sign in.",
    steps: [
      { text: "Open Control Panel → User & Security.", link: { app: "controlpanel", intent: "security" } },
      { text: "Press 'Set up 2FA', scan the QR code with an authenticator app and enter the 6-digit code." },
    ],
  },
  {
    id: "users",
    title: "Give other people access (users, groups and permissions)",
    category: "Security & users",
    minutes: 4,
    keywords: "user users account group role permission acl access family colleague token api pool",
    intro: "Proxmox users can log in to the Proxmox web UI with only the rights you give them.",
    steps: [
      { text: "Open Datacenter → Users and press 'Add user' (realm 'pve', set a password).", link: { app: "datacenter" } },
      { text: "Optional: put users in a Group and VMs in a Pool to manage many at once." },
      { text: "Datacenter → Permissions → Add: choose the user or group, a path (e.g. /vms/101 or /pool/family) and a role such as PVEVMUser." },
    ],
  },
  {
    id: "firewall",
    title: "Turn on the firewall safely",
    category: "Security & users",
    minutes: 4,
    keywords: "firewall rule block allow port security incoming",
    intro: "The Proxmox firewall filters traffic to the host and to each VM.",
    steps: [
      { text: "Open Datacenter → Firewall.", link: { app: "datacenter" } },
      { text: "First add rules that ALLOW TCP 8006 (Proxmox), 22 (SSH) and 80/443 (ProxmoxOS) from your network." },
      { text: "Only then enable the firewall. ProxmoxOS warns you if you are about to lock yourself out." },
    ],
  },
  {
    id: "updates",
    title: "Update the server and ProxmoxOS",
    category: "System & updates",
    minutes: 3,
    keywords: "update upgrade apt packages security patch new version proxmoxos repository 401 enterprise",
    intro: "There are two kinds of updates: the Proxmox host itself and the ProxmoxOS desktop.",
    fix: "repos",
    steps: [
      { text: "Host: open System → Updates, press Refresh, then Upgrade.", link: { app: "system" } },
      { text: "Seeing '401 Unauthorized'? Your server uses the paid Enterprise source — the Help Center fix switches to the free one." },
      { text: "ProxmoxOS: Control Panel → System & Power → 'Check & Install Updates'.", link: { app: "controlpanel", intent: "power" } },
    ],
  },
  {
    id: "hardware",
    title: "See what hardware is in your server",
    category: "System & updates",
    minutes: 1,
    keywords: "hardware cpu memory ram temperature sensors gpu disk nic motherboard bios inventory",
    intro: "Control Panel shows every component with temperatures and health.",
    steps: [{ text: "Open Control Panel → Hardware & System.", link: { app: "controlpanel", intent: "hardware" } }],
  },
  {
    id: "dock",
    title: "Personalise the Dock and wallpaper",
    category: "Getting started",
    minutes: 1,
    keywords: "dock icons size magnification auto hide pin unpin wallpaper appearance theme personalise",
    intro: "Make the desktop yours.",
    steps: [
      { text: "Right-click a Dock icon → 'Remove from Dock' or 'Keep in Dock'. Drag icons to reorder them." },
      { text: "Control Panel → Appearance & Dock: icon size, magnification, auto-hide and wallpaper.", link: { app: "controlpanel", intent: "appearance" } },
    ],
  },
  {
    id: "power",
    title: "Restart or shut down the server",
    category: "System & updates",
    minutes: 1,
    keywords: "reboot restart shutdown power off turn off",
    intro: "All VMs and containers stop when the server restarts.",
    steps: [{ text: "Control Panel → System & Power → Reboot host / Shut down host, and type the node name to confirm.", link: { app: "controlpanel", intent: "power" } }],
  },
];

export const FAQS: Faq[] = [
  { q: "I forgot the ProxmoxOS password. What now?", a: "On the Proxmox host, run: pct exec <container-id> -- grep ADMIN_PASSWORD /opt/proxmox-os/backend/.env — or set a new one in that file and restart the backend (systemctl restart proxmox-os-backend inside the container).", keywords: "forgot password reset login locked out" },
  { q: "I lost my 2FA phone and can't sign in.", a: "On the Proxmox host run: pct exec <container-id> -- rm /opt/proxmox-os/backend/data/security.json — this turns 2FA off. Set it up again afterwards.", keywords: "2fa lost phone code locked out authenticator" },
  { q: "Updates fail with '401 Unauthorized'.", a: "The paid Enterprise update source is enabled without a subscription. Use Fix problems → 'Update sources' to switch to the free No-Subscription source in one click.", keywords: "update 401 unauthorized enterprise repository apt error" },
  { q: "My VM doesn't start after adding a graphics card.", a: "Usually IOMMU is off or the card is still used by the host. Check Fix problems for an IOMMU warning, and switch the card to VM Passthrough Mode in Control Panel → Hardware & System, then reboot.", keywords: "gpu passthrough vm not start error iommu vfio", link: { app: "controlpanel", intent: "hardware" } },
  { q: "The VM console is black.", a: "The VM may be off or still booting. Start it in Compute Manager. With a passed-through 'Primary GPU' the picture goes to the card's own monitor output instead of the console.", keywords: "console black screen vnc nothing", link: { app: "compute" } },
  { q: "The container Shell button asks for nothing — is that safe?", a: "Yes, it opens a root shell over ProxmoxOS's own key. Only people signed in to ProxmoxOS can do this, so keep your password strong and 2FA on.", keywords: "shell container root login password safe security" },
  { q: "What is the difference between a VM and a container?", a: "A VM is a full computer (any OS, including Windows). A container shares the host's Linux kernel: much lighter and faster, Linux only.", keywords: "vm container difference lxc which choose" },
  { q: "How much RAM and CPU should I give a VM?", a: "Start with 2 cores and 4 GB for Linux, 4 cores and 8 GB for Windows. Watch Resource Monitor and adjust later in the guest's Resources tab.", keywords: "ram memory cpu cores how much size vm" },
  { q: "Where are my files stored?", a: "ZFS datasets on your data pools appear under /mnt/storage in File Station and can be shared with Network Shares.", keywords: "files where stored location storage path", link: { app: "files", intent: "/" } },
  { q: "My disk is almost full.", a: "Delete old snapshots (Storage & ZFS → Snapshots), old backups (Backup Center) and unused ISOs (Compute Manager → ISO & Templates), or add disks.", keywords: "disk full space capacity storage almost", link: { app: "storage" } },
  { q: "Ads still show after enabling the AdBlocker.", a: "Devices must use the Proxmox host as DNS server: set it in your router's DHCP settings and reconnect the devices. Browsers with 'secure DNS' (DoH) bypass it; turn that off.", keywords: "adblock ads still showing dns not working", link: { app: "netservices" } },
  { q: "My VPN connects but I can't reach anything.", a: "Forward UDP 51820 in your home router to the Proxmox host, and make sure the WAN interface in WireGuard Server settings is your LAN bridge (e.g. vmbr0).", keywords: "vpn wireguard connected no internet cannot reach", link: { app: "netservices" } },
  { q: "Will ProxmoxOS break my Proxmox server?", a: "ProxmoxOS uses the official Proxmox API and standard tools. Risky actions always ask for confirmation, and every Help Center fix shows exactly what it changes and how to undo it.", keywords: "safe break damage risk" },
  { q: "How do I update ProxmoxOS itself?", a: "Control Panel → System & Power → Check & Install Updates. Your settings are kept.", keywords: "update proxmoxos new version upgrade desktop", link: { app: "controlpanel", intent: "power" } },
  { q: "Can I still use the normal Proxmox web interface?", a: "Yes. Open https://<host-ip>:8006. Both work side by side.", keywords: "proxmox web ui 8006 normal interface both" },
  { q: "How do I get more help?", a: "Run Fix problems first. For anything else, the Proxmox forum (forum.proxmox.com) and documentation (pve.proxmox.com/wiki) are excellent.", keywords: "help support forum contact more" },
];
