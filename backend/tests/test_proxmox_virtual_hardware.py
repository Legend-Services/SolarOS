"""Virtual Hardware on Proxmox VE: `args` fragments and TPM storage. Run: python -m tests.test_proxmox_virtual_hardware"""
import os
import tempfile

os.environ.update(STORAGE_ROOT=tempfile.mkdtemp(), ADMIN_USERNAME="admin", ADMIN_PASSWORD="pw", JWT_SECRET="x" * 32)

from providers.proxmox import virtual_hardware as pv  # noqa: E402

user = "-cpu host,+kvm_pv_unhalt -smbios type=1,serial=ABC"
a = pv.args_add(user, pv.arg_fragment({"id": "a1b2c3", "type": "sas_hba", "options": {"model": "megasas"}}))
nv = pv.arg_fragment({"id": "eeeeee", "type": "virtual_nvme", "options": {"serial": "SD1"}}, "/var/lib/vz/images/101/x.raw")
a = pv.args_add(a, nv)
assert "-device megasas,id=vhwa1b2c3" in a and "serial=SD1,id=vhweeeeee" in a
assert pv.args_remove(a, "vhweeeeee") == user + " -device megasas,id=vhwa1b2c3"
assert pv.args_remove(pv.args_remove(a, "vhweeeeee"), "vhwa1b2c3") == user
assert pv.args_remove("", "vhwx") == "" and pv.args_add("", "-device sb16,id=vhwx") == "-device sb16,id=vhwx"
assert pv.boot_storage({"ide2": "local:iso/x.iso,media=cdrom", "scsi0": "fast-zfs:vm-101-disk-0,size=32G"}) == "fast-zfs"
assert pv.boot_storage({}) == "local-lvm"
print("proxmox virtual hardware ok")
