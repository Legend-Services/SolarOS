"""Clean 501 answers for API paths of the other edition that SolarOS does not have (the desktop may still call them)."""
from fastapi import APIRouter, Depends, HTTPException

from app.auth import require_user

router = APIRouter(dependencies=[Depends(require_user)], tags=["native_ubuntu"])

# "METHOD path" of every such route; same paths as before, so clients get 501 instead of 404.
NOT_AVAILABLE = """
DELETE /api/net/certs/acme/accounts/{name}
DELETE /api/net/certs/acme/plugins/{pid}
DELETE /api/v1/access/tokens/{userid}/{tokenid}
DELETE /api/v1/firewall/cluster/aliases/{name}
DELETE /api/v1/firewall/cluster/ipsets/{name}
DELETE /api/v1/firewall/cluster/ipsets/{name}/entry
DELETE /api/v1/firewall/{scope}/rules/{pos}
DELETE /api/v1/storage-config/{storage}
GET /api/net/certs
GET /api/v1/firewall/cluster/aliases
GET /api/v1/firewall/cluster/ipsets
GET /api/v1/firewall/cluster/ipsets/{name}
GET /api/v1/firewall/{scope}/options
GET /api/v1/storage-config
GET /api/v1/storage-scan/{kind}
POST /api/ai/storage
POST /api/net/certs/acme/accounts
POST /api/net/certs/acme/order
POST /api/net/certs/acme/plugins
POST /api/system/repositories/add
POST /api/system/repositories/toggle
POST /api/v1/access/tokens
POST /api/v1/disks/directory
POST /api/v1/disks/lvm
POST /api/v1/firewall/cluster/aliases
POST /api/v1/firewall/cluster/ipsets
POST /api/v1/firewall/cluster/ipsets/{name}
POST /api/v1/firewall/{scope}/rules
POST /api/v1/storage-config
PUT /api/net/certs/acme/domains
PUT /api/v1/firewall/{scope}/options
PUT /api/v1/firewall/{scope}/rules/{pos}
PUT /api/v1/storage-config/{storage}
""".split("\n")


async def not_available():
    raise HTTPException(501, "Not available on SolarOS")


for _line in filter(None, NOT_AVAILABLE):
    _method, _path = _line.split(" ", 1)
    router.add_api_route(_path, not_available, methods=[_method], name=f"not_available_{_method.lower()}")
