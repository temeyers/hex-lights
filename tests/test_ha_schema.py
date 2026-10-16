"""Validate the HA package FILES ON DISK the way Home Assistant loads them.

1. Copy ha/packages/*.yaml + ha/hex_wall.generated.yaml into a temp config dir with
   `homeassistant: packages: !include_dir_named packages` (HA loader: homeassistant.util.yaml).
2. Run HA's own config check (homeassistant.helpers.check_config.async_check_ha_config_file),
   which performs the real package merge (homeassistant.config.merge_packages_config) and the
   script / automation / input_* integration validation. Any error, or any ERROR log line from
   those integrations (e.g. "Script ... could not be validated and has been disabled"), fails.
3. Every expected script must be present in the validated result (HA drops disabled ones).

Skipped without the `homeassistant` package. Tested with HA 2026.2.3 / Python 3.13:
    uv venv --python 3.13 --managed-python /tmp/havenv
    uv pip install --python /tmp/havenv/bin/python homeassistant pyyaml pytest
    /tmp/havenv/bin/python -m pytest tests
Point HEX_HA_DIR at another ha/ directory to check that instead (used for before/after proofs).
"""
import asyncio
import glob
import logging
import os
import shutil
import tempfile

import pytest

pytest.importorskip("homeassistant")
from homeassistant import loader  # noqa: E402
from homeassistant.core import HomeAssistant  # noqa: E402
from homeassistant.helpers.check_config import async_check_ha_config_file  # noqa: E402
from homeassistant.util.yaml import load_yaml  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(__file__))
HA_DIR = os.environ.get("HEX_HA_DIR", os.path.join(ROOT, "ha"))


EXPECTED_SCRIPTS = sorted(set(load_yaml(os.path.join(HA_DIR, "hex_wall.generated.yaml"))["script"])
                          | set(load_yaml(os.path.join(HA_DIR, "packages", "hex_wall.yaml"))["script"]))


def make_config_dir():
    d = tempfile.mkdtemp(prefix="hexha-")
    os.makedirs(os.path.join(d, "packages"))
    for f in glob.glob(os.path.join(HA_DIR, "packages", "*.yaml")):
        shutil.copy(f, os.path.join(d, "packages", os.path.basename(f)))
    # package names must be slugs: hex_wall.generated.yaml -> hex_wall_generated.yaml
    shutil.copy(os.path.join(HA_DIR, "hex_wall.generated.yaml"), os.path.join(d, "packages", "hex_wall_generated.yaml"))
    with open(os.path.join(d, "configuration.yaml"), "w") as f:
        f.write("homeassistant:\n  packages: !include_dir_named packages\n")
    return d


class Grab(logging.Handler):
    def __init__(self):
        super().__init__(logging.ERROR); self.msgs = []
    def emit(self, r):
        if r.name.startswith(("homeassistant.components", "homeassistant.config", "homeassistant.helpers")):
            self.msgs.append(f"{r.name}: {r.getMessage()}")


def check(d):
    grab = Grab(); logging.getLogger().addHandler(grab)
    async def run():
        hass = HomeAssistant(d)
        loader.async_setup(hass)
        try:
            res = await async_check_ha_config_file(hass)
            merged = res.get("script") or {}   # already validated by HA's script integration
            bad = [f"script {n}: missing (disabled?)" for n in EXPECTED_SCRIPTS if n not in merged]
            return [f"{e.domain}: {e.message}" for e in res.errors], bad, merged
        finally:
            await hass.async_stop(force=True)
    try:
        errors, bad, merged = asyncio.run(run())
    finally:
        logging.getLogger().removeHandler(grab)
    return errors, bad, grab.msgs, merged


def test_files_on_disk_load_with_ha_yaml_loader():
    for f in glob.glob(os.path.join(HA_DIR, "packages", "*.yaml")) + [os.path.join(HA_DIR, "hex_wall.generated.yaml"),
                                                                      os.path.join(HA_DIR, "hex_wall_dashboard.generated.yaml")]:
        assert isinstance(load_yaml(f), dict), f


def test_ha_package_load_and_validation():
    errors, bad, logs, merged = check(make_config_dir())
    assert errors == [] and bad == [] and logs == [], "\n".join(errors + bad + logs)
    sel = merged["hex_wall_solid"]["fields"]["color"]["selector"]
    assert "color_rgb" in (sel if isinstance(sel, dict) else sel.serialize()["selector"]), sel


def test_dashboard_structure():
    dash = load_yaml(os.path.join(HA_DIR, "hex_wall_dashboard.generated.yaml"))
    assert dash["views"] and all("type" in c for v in dash["views"] for c in v["cards"])
