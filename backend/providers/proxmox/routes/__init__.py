"""HTTP routes of the Proxmox driver, mounted by app.main (through providers.registry) ahead of the shared routers."""
from . import (access, apps, automation, backups, console, datacenter, guest_hardware, guests, local_ai, net_certs,
               provisioning, storage, system, tasks)

ROUTERS = [m.router for m in (guests, console, tasks, apps, system, storage, provisioning, backups, access, datacenter,
                              net_certs, guest_hardware, local_ai, automation)]
