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
    assert system.put_preferences(prefs) == prefs
    assert system.get_preferences() == prefs
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
