"""Preferences store self-check. Run: python -m tests.test_preferences"""
import tempfile
from pathlib import Path

from fastapi import HTTPException

from app import system
from app.config import settings

with tempfile.TemporaryDirectory() as d:
    settings.preferences_file = Path(d) / "sub" / "user_preferences.json"
    assert system.get_preferences() == {}
    prefs = {"layout": {"desktopView": "list", "iconSize": 64}, "wizard": {"welcomeAuto": False}}
    placement = {"desktopAlignment": "left", "desktopVerticalAlign": "top", "desktopMaxColumns": "auto"}
    stored = {**prefs, "layout": {**prefs["layout"], **placement}}  # older clients omit placement: defaults filled in
    assert system.put_preferences(prefs) == stored
    assert system.get_preferences() == stored
    centered = {"layout": {"desktopAlignment": "center", "desktopVerticalAlign": "middle", "desktopMaxColumns": 6}}
    assert system.put_preferences(centered)["layout"]["desktopMaxColumns"] == 6
    assert system.get_preferences()["layout"]["desktopAlignment"] == "center"
    for bad in ({"desktopAlignment": "right"}, {"desktopMaxColumns": 9}, {"desktopMaxColumns": "6"}, {"desktopVerticalAlign": 1}):
        try:
            system.put_preferences({"layout": bad})
            raise AssertionError(f"invalid layout accepted: {bad}")
        except HTTPException as e:
            assert e.status_code == 422
    settings.preferences_file.write_text('{"layout": {"desktopMaxColumns": 99}}')  # hand-edited: returned as stored
    assert system.get_preferences() == {"layout": {"desktopMaxColumns": 99}}
    settings.preferences_file.write_text("[1, 2]")  # not an object: ignored
    assert system.get_preferences() == {}
    settings.preferences_file.write_text("{broken")
    assert system.get_preferences() == {}
    try:
        system.put_preferences({"x": "y" * (system.PREFS_MAX_BYTES + 1)})
        raise AssertionError("oversized preferences accepted")
    except HTTPException as e:
        assert e.status_code == 413
print("preferences OK")
