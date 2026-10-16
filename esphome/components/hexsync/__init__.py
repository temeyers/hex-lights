"""hexsync: ESP-NOW broadcast effect sync for hex light tiles (ESP32, esp-idf)."""
import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID
from esphome.core import CORE
from esphome import pins

CODEOWNERS = []
DEPENDENCIES = ["wifi", "esp32"]

hexsync_ns = cg.esphome_ns.namespace("hexsync")
HexSync = hexsync_ns.class_("HexSync", cg.Component)

CONF_TILE_ID = "tile_id"
CONF_Q = "q"
CONF_R = "r"
CONF_ROTATION = "rotation"
CONF_ORDER = "order"
CONF_LED_COUNT = "led_count"
CONF_SYNC_PIN = "sync_pin"
CONF_SYNC_MODE_DEFAULT = "sync_mode_default"
CONF_PRIORITY = "leader_priority"
CONF_STATIC_LEADER = "static_leader"
CONF_BUDGET = "tile_budget_ma"
CONF_MA_PER_LED = "ma_per_led_full_white"
CONF_MAX_SCALE = "hard_max_scale"
CONF_BEACON = "beacon_interval"
CONF_TIMEOUT = "leader_timeout"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(HexSync),
        cv.Required(CONF_TILE_ID): cv.int_range(min=1, max=250),
        cv.Required(CONF_Q): cv.int_range(min=-50, max=50),
        cv.Required(CONF_R): cv.int_range(min=-50, max=50),
        cv.Optional(CONF_ROTATION, default=0): cv.int_range(min=0, max=359),
        # Lower number wins leader election. Default = tile_id.
        cv.Optional(CONF_ORDER, default=-1): cv.int_range(min=-1, max=254),
        cv.Optional(CONF_LED_COUNT, default=44): cv.int_range(min=1, max=60),
        cv.Optional(CONF_SYNC_PIN, default="GPIO12"): pins.internal_gpio_output_pin_number,
        cv.Optional(CONF_SYNC_MODE_DEFAULT, default="wireless"): cv.one_of("wireless", "jumper", lower=True),
        cv.Optional(CONF_PRIORITY): cv.int_range(min=1, max=250),
        # If set, only this tile_id may lead (no failover).
        cv.Optional(CONF_STATIC_LEADER, default=0): cv.int_range(min=0, max=250),
        # Firmware current budget for the strip on this tile (ESTIMATED model).
        cv.Optional(CONF_BUDGET, default=1500): cv.int_range(min=100, max=5000),
        cv.Optional(CONF_MA_PER_LED, default=60.0): cv.positive_float,
        # First-boot ceiling for the current model; the HA "Max brightness" number overrides it at runtime.
        cv.Optional(CONF_MAX_SCALE, default=1.0): cv.float_range(min=0.05, max=1.0),
        cv.Optional(CONF_BEACON, default="100ms"): cv.positive_time_period_milliseconds,
        cv.Optional(CONF_TIMEOUT, default="1500ms"): cv.positive_time_period_milliseconds,
    }
).extend(cv.COMPONENT_SCHEMA)


def _is_esp_idf():
    # CORE.using_esp_idf was removed in ESPHome 2026.x; fall back to the esp32 framework type.
    v = getattr(CORE, "using_esp_idf", None)
    if v is not None:
        return bool(v)
    try:
        from esphome.components.esp32 import get_esp32_variant  # noqa: F401
        from esphome.const import CONF_FRAMEWORK, CONF_TYPE
        fw = CORE.config.get("esp32", {}).get(CONF_FRAMEWORK, {}).get(CONF_TYPE)
        if fw is not None:
            return fw in ("esp-idf", "esp_idf")
    except Exception:
        pass
    return getattr(CORE, "target_framework", "") in ("esp-idf", "esp_idf")


def _final(config):
    if not _is_esp_idf():
        raise cv.Invalid("hexsync requires the esp-idf framework")
    return config


FINAL_VALIDATE_SCHEMA = _final


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    cg.add(var.set_tile(config[CONF_TILE_ID], config[CONF_Q], config[CONF_R], config[CONF_ROTATION],
                          config[CONF_ORDER] if config[CONF_ORDER] >= 0 else config[CONF_TILE_ID] - 1))
    cg.add(var.set_default_led_count(config[CONF_LED_COUNT]))
    cg.add(var.set_sync_pin(config[CONF_SYNC_PIN]))
    cg.add(var.set_sync_mode_default(1 if config[CONF_SYNC_MODE_DEFAULT] == "jumper" else 0))
    cg.add(var.set_priority(config.get(CONF_PRIORITY, config[CONF_TILE_ID])))
    cg.add(var.set_static_leader(config[CONF_STATIC_LEADER]))
    cg.add(var.set_budget(config[CONF_BUDGET], config[CONF_MA_PER_LED], config[CONF_MAX_SCALE]))
    cg.add(var.set_timing(config[CONF_BEACON].total_milliseconds, config[CONF_TIMEOUT].total_milliseconds))
