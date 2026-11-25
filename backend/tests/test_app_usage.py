"""App usage counters + Phase 16 layout prefs self-check. Run: python -m tests.test_app_usage"""
import tempfile
from pathlib import Path

from fastapi import HTTPException

from app import system, system_extra
from app.config import settings

with tempfile.TemporaryDirectory() as d:
    settings.app_usage_file = Path(d) / "sub" / "app_usage.json"
    assert system_extra.get_app_usage() == {}
    rec = system_extra.UsageRecord(app_id="files")
    assert system_extra.record_app_usage(rec)["launch_count"] == 1
    r = system_extra.record_app_usage(rec)
    assert r["launch_count"] == 2 and r["last_opened_at"].endswith("Z")
    assert system_extra.get_app_usage()["files"]["launch_count"] == 2
    settings.app_usage_file.write_text("{broken")
    assert system_extra.get_app_usage() == {}
    assert system_extra.record_app_usage(rec)["launch_count"] == 1
    assert system_extra.reset_app_usage() == {} and system_extra.get_app_usage() == {}
    try:
        system_extra.UsageRecord(app_id="../etc")
        raise AssertionError("bad app id accepted")
    except ValueError:
        pass

    settings.preferences_file = Path(d) / "user_preferences.json"
    layout = system.put_preferences({"layout": {"iconSize": 56}})["layout"]
    assert layout["showDesktopIcons"] is False and layout["gallerySortMode"] == "custom" and layout["galleryAppOrder"] == []
    for bad in ({"gallerySortMode": "random"}, {"galleryAppOrder": ["Bad Id"]}, {"showDesktopIcons": "yes please"}):
        try:
            system.put_preferences({"layout": bad})
            raise AssertionError(f"invalid layout accepted: {bad}")
        except HTTPException as e:
            assert e.status_code == 422
print("app usage OK")
