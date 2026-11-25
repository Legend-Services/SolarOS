"""Backup & disaster recovery request models shared by the drivers (archives, immediate backups, restores, schedules)."""
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

from .storage_admin import STORAGE_RE


BACKUP_VOLID_RE = r"^[a-z][a-z0-9_.-]*:[^,\s]+$"
JOB_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"


# Calendar events ("daily", "sun 01:00", "mon..fri 02:30", "*-*-1 03:00"); the driver validates the details.
SCHEDULE_RE = r"^[A-Za-z0-9:*/,. -]{1,64}$"


Mode = Literal["snapshot", "suspend", "stop"]
Compress = Literal["zstd", "lzo", "gzip", "0"]


class RunBody(BaseModel):
    vmid: int | Literal["all"]
    storage: str = Field(pattern=STORAGE_RE)
    mode: Mode = "snapshot"
    compress: Compress = "zstd"


class RestoreBody(BaseModel):
    volid: str = Field(pattern=BACKUP_VOLID_RE, max_length=500)
    type: Literal["qemu", "lxc"]
    vmid: int = Field(ge=100, le=999_999_999)
    storage: str = Field(pattern=STORAGE_RE)
    force: bool = False  # overwrite an existing guest with this VMID


class ScheduleBody(BaseModel):
    schedule: str = Field(pattern=SCHEDULE_RE)
    storage: str = Field(pattern=STORAGE_RE)
    vmids: list[int] | Literal["all"] = "all"
    mode: Mode = "snapshot"
    compress: Compress = "zstd"
    keep_last: int = Field(7, ge=1, le=1000)
    enabled: bool = True
    comment: str = Field("", max_length=200, pattern=r"^[^\n\r]*$")


class ScheduleToggle(BaseModel):
    enabled: bool


def check_schedule(b: ScheduleBody) -> None:
    if b.vmids != "all" and not b.vmids:
        raise HTTPException(422, "Select at least one guest, or all")
