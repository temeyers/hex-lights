"""Validate generated HA YAML against Home Assistant's real schemas (needs `homeassistant`).

Skipped when homeassistant isn't importable. Tested with HA 2026.2.3 on Python 3.13:
    uv venv --python 3.13 --managed-python /tmp/havenv
    uv pip install --python /tmp/havenv/bin/python homeassistant pyyaml pytest
    /tmp/havenv/bin/python -m pytest tests
Schemas run inside a real (unstarted) HomeAssistant instance, because template validation needs one.
"""
import asyncio
import os
import tempfile
import pytest
import yaml

pytest.importorskip("homeassistant")
from homeassistant.core import HomeAssistant  # noqa: E402
from homeassistant.components.script.config import SCRIPT_ENTITY_SCHEMA  # noqa: E402
from homeassistant.components.input_select import CONFIG_SCHEMA as INPUT_SELECT  # noqa: E402
from homeassistant.components.input_number import CONFIG_SCHEMA as INPUT_NUMBER  # noqa: E402
from homeassistant.components.input_boolean import CONFIG_SCHEMA as INPUT_BOOLEAN  # noqa: E402
from homeassistant.helpers import config_validation as cv  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(__file__))
FILES = ["ha/hex_wall.generated.yaml", "ha/packages/hex_wall.yaml"]


def with_hass(fn):
    async def run():
        hass = HomeAssistant(tempfile.mkdtemp())
        try:
            fn()
        finally:
            await hass.async_stop(force=True)
    asyncio.run(run())


def load(f):
    return yaml.safe_load(open(os.path.join(ROOT, f)))


SCRIPTS = [(f"{f}:{n}", c) for f in FILES for n, c in (load(f).get("script") or {}).items()]


@pytest.mark.parametrize("conf", [c for _, c in SCRIPTS], ids=[n for n, _ in SCRIPTS])
def test_script_schema(conf):
    with_hass(lambda: SCRIPT_ENTITY_SCHEMA(conf))   # fields + selectors + sequence + variables


@pytest.mark.parametrize("f", FILES)
def test_helpers_schema(f):
    h = load(f)
    def check():
        for key, schema in (("input_select", INPUT_SELECT), ("input_number", INPUT_NUMBER),
                            ("input_boolean", INPUT_BOOLEAN)):
            if key in h:
                schema({key: h[key]})
    with_hass(check)


@pytest.mark.parametrize("f", FILES)
def test_automation_structure(f):
    def check():
        for a in load(f).get("automation") or []:
            cv.TRIGGER_SCHEMA(a["triggers"])
            cv.SCRIPT_SCHEMA(a["actions"])
            for c in a.get("conditions") or []:
                cv.CONDITIONS_SCHEMA([c])
    with_hass(check)


def test_old_bug_is_caught():
    """The pre-fix example (list) must fail HA's schema."""
    bad = {"sequence": [], "fields": {"color": {"example": [255, 140, 40]}}}
    def check():
        with pytest.raises(Exception, match="string"):
            SCRIPT_ENTITY_SCHEMA(bad)
    with_hass(check)
