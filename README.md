# Hex Lights

About 20 3D-printed hexagon tiles, each driven by an ESP32-S3 Super Mini with about 44 WS2812B LEDs, controlled through ESPHome and Home Assistant. The tiles sync with each other over ESP-NOW, with no data wires between them.

Work in progress.

## Layout format (`layout.json` is canonical; `layout.yaml` with the same shape is accepted)
```
{"version": 1, "name": "Hex Wall",
 "hex": {"orientation": "pointy|flat", "sizeMm": 100},
 "led": {"pin": "GPIO13", "type": "WS2812", "order": "GRB", "count": 44,
         "budgetMa": 1200, "maxScale": 0.55},          (budgetMa/maxScale optional)
 "master": "c0",
 "tiles": [{"id": "c0", "name": "Center", "mac": "AA:..", "q": 0, "r": 0, "rot": 0,
            "ledCount": 44, "pin": "GPIO13", "priority": 1}]}  (name/mac/rot/ledCount/pin/priority optional)
```
- `id` is a slug (`[a-z0-9-]`) or a MAC. `q`,`r` are axial coords, `s=-q-r`, and `rot` is 0-5.
- Validation: version 1, 1-64 tiles, unique ids and coords, exactly one master that is a tile id. Pins must be `GPIO<n>` and must not be GPIO0/3/45/46 (strapping), 19/20 (USB), 22-37 (flash/PSRAM or not broken out) or 48 (onboard RGB). Islands the master can't reach through neighbours give a warning.
- `out/layout.json` adds these fields to each tile: `s ring x y angle index isMaster leds neighbors`. `out/neighbors.json` is `{id:[ids]}`.
- **`esphome/tiles.csv` can be generated from layout.json**: `--emit-csv [PATH]`, default `out/tiles.csv`. A test checks that it matches Hardware's CSV.

## Run (workflow)
1. Edit `layout.json` (canonical).
2. `python3 tools/gen_tiles.py --emit-csv esphome/tiles.csv` writes the CSV plus `out/layout.json`, `out/neighbors.json` and `ha/hex_wall.generated.yaml`.
3. `python3 esphome/tools/gen_tiles.py $(python3 tools/gen_tiles.py --print-hw-args)` runs Hardware's generator with the wall-wide `--sync-pin`/`--sync-mode` from layout.json `sync`. It writes `esphome/tiles/hex-NN.yaml`, the only tile YAML set.
4. `cp secrets.example.yaml esphome/tiles/secrets.yaml`, fill it in (it's gitignored), then `esphome config esphome/tiles/hex-01.yaml`.

Other flags: `--check` (exit 1 if stale), `--secrets-template`, `--tile-yaml` (opt-in: also writes `esphome/generated/<id>.yaml` straight from layout.json with the full map below), `--pin-leader` (with `--tile-yaml`: static_leader = the master's tile_num). Tests: `python -m pytest tests && node tests/effects.test.mjs`.

Leader: hexsync picks the **lowest** `leader_priority` (1-250). Hardware's generator defaults it to tile_num, so **keep the master as the first tile** in layout.json (validation warns otherwise). `static_leader` stays "0" (automatic failover).

## Substitution map (layout.json -> Hardware template)
| template | from |
|---|---|
| tile_id | tile.id (a MAC id becomes lowercase hex) |
| tile_num | layout index + 1 |
| q, r | tile.q, tile.r |
| rotation | tile.rot |
| led_pin | tile.pin or led.pin |
| num_leds | tile.ledCount or led.count |
| static_leader | "0" (failover); master tile_num with `--pin-leader` |
| leader_priority | tile.priority, else 1 for the master and tile_num + 1 for the others |
| tile_budget_ma | led.budgetMa (otherwise the template default 1200) |
| max_scale, max_scale_pct | led.maxScale (optional; the template default is now 1.0 = full output, and `max_scale_pct` is ignored. Runtime ceiling: `number.hex_NN_max_brightness`) |

device_name and friendly_name are not emitted: the template derives them from the row number (`hex-${hex_nn}`, `Hex ${hex_nn}`, e.g. hex-01 / Hex 01). The axial id stays internal.

## Effects / Home Assistant
`effects.json` is the catalogue, and `tools/effects.js` has `frame(effect, params, tiles, tMs)`. HA: install `ha/packages/hex_wall.yaml` and `ha/hex_wall.generated.yaml` in HA `packages/`. Tile lights are `light.hex_NN_light`, and the group is `light.hex_wall`.
- Synced (ESP-NOW HexSync) path: `script.hex_wall_synced` calls `esphome.hex_<master>_set_wall_effect`, then `light.turn_on effect: HexSync` on the group. It maps solid->0 solid, ripple->1 radial wave, rainbow_sweep->2 rainbow sweep, breathe->3 pulse. It's used when `input_boolean.hex_wall_use_sync` is on.
- Spiral and sparkle (or anything when sync is off) fall back to the per-tile HA scripts. Those use the effects.js formulas, sampled every `step` s. Ripple uses per-tile delays by hex distance, and sparkle uses HA `random`.

## Whole-wall effects + runtime LED count (v2, PROPOSED interface, not yet verified on hardware)
- New effects: `chase` (tile to tile in index/order), `wipe` (axis x|y|ring|angle), `rainbow_flow`. Palettes: rainbow, ocean, sunset, forest, fire, mono, light color (id 6: shades of the master light colour, 25-100 %). Every effect takes `speed`, and most take `palette`. Formulas are in `effects.json`, and `tools/effects.js` has `frame()` (`{id:[r,g,b]}`) plus `frameLeds()` (`{id:[[r,g,b] x leds]}`, where `leds` is the tile's `leds`, default 44).
- HexSync ids (Hardware df1ad9b): 0 solid, 1 radial_wave (our ripple), 2 rainbow_sweep, 3 pulse (our breathe), 4 chase, 5 wipe, 6 rainbow_flow, 7 random_ripple, 8 twinkle, 9 color_cycle, 10 snake (7-10 firmware-only, not in effects.js). Axis is sent via `select.hex_01_wall_wipe_axis`; speed is capped at 10000, start delay at 10 s.
- HA (generated): `input_select.hex_wall_fx`, `input_select.hex_wall_palette`, `input_number.hex_wall_speed` (cycles/s; sent as milli-cycles), `input_number.hex_wall_led_count` (default `led.count`). These call `esphome.hex_<master>_set_wall_fx` and set the per-tile `number.hex_NN_led_count`. Every firmware name is in `INTERFACE` in `tools/gen_ha.py`, and `layout.json` `"ha": {...}` can override any of them.
- Generator (`--tile-yaml` only): `num_leds` = compile-time max (`led.maxCount`, 60), `rotation` = rot × 60 degrees (also in the emitted CSV), and `led_count` = runtime default. tiles.csv is unchanged.

### set_wall_fx axis argument (`wallFxAxisArg`)
Hardware's newer firmware signature is `set_wall_fx(effect, palette, speed, scale, hue, saturation, value, start_delay_ms, axis)`, with axis 0 x, 1 y, 2 ring, 3 angle. Once it's flashed, **axis is required**. Set `"ha": {"wallFxAxisArg": true}` in layout.json and regenerate. HA then passes `axis` from `input_select.hex_wall_axis` on every call and skips `select.hex_01_wall_wipe_axis`. With the default (`false`), no axis argument is sent and the select is set instead, which matches older firmware.

### tiles.csv order column
`--emit-csv` writes `id,q,r,rot` (it matches the committed file). Add `--csv-order` to also write `order` (empty = Hardware's default of row − 1). Hardware's generator reads it.

### Sync mode (Hardware d3aeb8b)
- `select.hex_01_sync_mode` (master only) has the options `Wireless (ESP-NOW)` (default) and `Jumper wire` (GPIO12, `sync.pin`). The generator rejects a sync pin equal to the LED pin (GPIO13) or to any tile's pin.
- Per tile: `sensor.hex_NN_sync_source` (`espnow` | `jumper` | `jumper-lost`), `sensor.hex_NN_sync_pulse_jitter` (µs), `sensor.hex_NN_sync_pulse_offset` (ms).
- Automation `hex_wall_sync_jumper_lost` alerts when any tile is `jumper-lost` for 15 s while the mode is `Jumper wire`. It notifies `notifyService` (default `notify.notify`), which you can override with `"ha": {"notifyService": "notify.mobile_app_x"}`. After an alert it waits 10 minutes before alerting again.
- Dashboard: `ha/hex_wall_dashboard.generated.yaml` is a Lovelace dashboard in YAML mode. It has the wall controls, the sync mode select and a sync glance card for each tile.
- **Canonical layout key** (Front End's editor writes it, d55afb4): top-level `"sync": {"mode": "wireless"|"jumper", "pin": "GPIO<n>"}`. It's left out when it's the default (wireless, GPIO12). The pin is read from `sync.pin`, then the legacy `led.syncPin`, then GPIO12. It's validated like the LED pin and must not equal the LED pin or any tile's pin.
- **sync_pin / sync_mode_default reach the firmware** through Hardware's generator flags (`--print-hw-args` prints them) or through `--tile-yaml`.
- **sync.mode:** the firmware sets the mode from `sync_mode_default` on first boot and restores the saved mode from flash after that. `script.hex_wall_sync_mode_apply_layout` is only needed to change the mode later to match layout.json.

### Hex NN names (Hardware 9b55813)
HA entities and services use `hex_NN`, where NN is the tile's 2-digit 1-based row in tiles.csv (= layout.json order): c0 = 01 … r3-a = 20. The master is `hex_01`. Keep it first in layout.json, because Hardware's template exposes the wall controls only on row 1. Services: `esphome.hex_01_set_wall_fx`, `_set_wall_effect`, `_set_layout_bulk`, `_set_hex_layout(hex_num, q, r, rotation, order)`. The leader binary sensor is `binary_sensor.hex_NN_sync_leader`. All of these names are in `INTERFACE` (tools/gen_ha.py).

### Max brightness / current limit (Hardware 85cf36d)
Each tile has `number.hex_NN_max_brightness` (0-100 %, default 100, restored after reboot) and `switch.hex_NN_current_limit` (default off; on = 1200 mA budget per tile). Wall-wide helpers `input_number.hex_wall_max_brightness` and `input_boolean.hex_wall_current_limit` push to every tile that has the entity whenever they change. Both appear on the dashboard for each tile. `max_scale_pct` is no longer generated.

### Displayed colour (Hardware-confirmed)
- Per tile: `sensor.hex_NN_displayed_color` (an ESPHome text_sensor "Displayed color", `#RRGGBB`, 1–2 Hz). There's no separate RGB sensor: the light readback is the `rgb_color` attribute of `light.hex_NN_light`.
- **For the layout editor:** `group.hex_wall_displayed_colors`, plus `out/ha_entities.json` (tile id → node/hexNN/light/displayedColor/`lightRgb: {entity, attribute: rgb_color}`/...). The dashboard shows the displayed colour on each tile card and has a "Light RGB readback" card of `rgb_color` attribute rows.
- **Recorder:** `ha/packages/hex_wall_recorder.yaml` excludes `sensor.hex_*_displayed_color` with `entity_globs`. **Caveat:** HA packages can't merge a duplicate key, so if `configuration.yaml` or another package already has `recorder: exclude:`, HA rejects this package ("duplicate key 'exclude'"). In that case delete this file and add the glob to your existing `recorder: exclude: entity_globs:`. A `recorder:` block that has no `exclude:` (for example only `purge_keep_days`) merges fine.

### "Light color" wall palette (firmware, hexsync v3)

`select.hex_01_wall_palette` has a 7th option, `light color` (palette id 6, also accepted by `set_wall_fx`). Every wall effect then uses shades (25–100 %) of the master light's chosen colour (`light.hex_01_light`) instead of a preset palette, and it follows the HA colour picker live. The master reads the colour it was *asked* for (`remote_values`, read-only, never written back) and sends it to every tile in the hexsync packet, rate-limited to 10 per second. The packet is now v3 (40 bytes: v2 plus `rgb[3]` and a reserved byte). v3 tiles still accept 36-byte v2 BEACON/SET packets and keep their last colour. v2 tiles ignore v3 packets and log a warning, so OTA every tile to the same build. Back End: add `"light color"` to `PALETTES` in `tools/gen_ha.py` to expose it on `input_select.hex_wall_palette`.

### HA schema validation
`tests/test_ha_schema.py` checks every generated and static script, helper and automation against Home Assistant's real schemas (`SCRIPT_ENTITY_SCHEMA`, input_* `CONFIG_SCHEMA`, `cv.TRIGGER_SCHEMA`/`SCRIPT_SCHEMA`/`CONDITIONS_SCHEMA`). They run inside an unstarted HomeAssistant instance, because template checks need one. Without `homeassistant` installed the test is skipped. To run it: `uv venv --python 3.13 --managed-python /tmp/havenv && uv pip install --python /tmp/havenv/bin/python homeassistant pyyaml pytest && /tmp/havenv/bin/python -m pytest tests` (tested with HA 2026.2.3).
`input_select.hex_wall_fx` options are the firmware effect names exactly (hexsync `FX_NAMES`): solid, radial_wave, rainbow_sweep, pulse, chase, wipe, rainbow_flow, random_ripple, twinkle, color_cycle, snake. Our effects.json `ripple`/`breathe` correspond to `radial_wave`/`pulse` (`FX_ALIASES`).
