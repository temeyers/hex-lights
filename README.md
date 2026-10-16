# Hex Lights

About 20 3D-printed hexagon tiles, each driven by an ESP32-S3 Super Mini with about 44 WS2812B LEDs, controlled through ESPHome and Home Assistant. The tiles sync with each other over ESP-NOW, with no data wires between them.

Work in progress.

## Layout format (`layout.json` is canonical; `layout.yaml` with the same shape is accepted)
```
{"version": 1, "name": "Hex Wall",
 "hex": {"orientation": "pointy|flat", "sizeMm": 100},
 "led": {"pin": "GPIO4", "type": "WS2812", "order": "GRB", "count": 44,
         "budgetMa": 1200, "maxScale": 0.55},          (budgetMa/maxScale optional)
 "master": "c0",
 "tiles": [{"id": "c0", "name": "Center", "mac": "AA:..", "q": 0, "r": 0, "rot": 0,
            "ledCount": 44, "pin": "GPIO4", "priority": 1}]}  (name/mac/rot/ledCount/pin/priority optional)
```
- `id` is a slug (`[a-z0-9-]`) or a MAC. `q`,`r` are axial coords, `s=-q-r`, and `rot` is 0-5.
- Validation: version 1, 1-64 tiles, unique ids and coords, exactly one master that is a tile id. Pins must be `GPIO<n>` and must not be GPIO0/3/45/46 (strapping), 19/20 (USB) or 48 (onboard RGB). Islands the master can't reach through neighbours give a warning.
- `out/layout.json` adds these fields to each tile: `s ring x y angle index isMaster leds neighbors`. `out/neighbors.json` is `{id:[ids]}`.
- **`esphome/tiles.csv` can be generated from layout.json**: `--emit-csv [PATH]`, default `out/tiles.csv`. A test checks that it matches Hardware's CSV.

## Run (workflow)
1. Edit `layout.json` (canonical).
2. `python3 tools/gen_tiles.py --emit-csv esphome/tiles.csv` writes the CSV plus `out/layout.json`, `out/neighbors.json` and `ha/hex_wall.generated.yaml`.
3. `python3 esphome/tools/gen_tiles.py` is Hardware's generator. It writes `esphome/tiles/tile_NN.yaml`, the only tile YAML set.
4. `cp secrets.example.yaml esphome/tiles/secrets.yaml`, fill it in (it's gitignored), then `esphome config esphome/tiles/tile_01.yaml`.

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
| max_scale, max_scale_pct | led.maxScale (otherwise the template default 0.55 / 55%) |

device_name and friendly_name are not emitted: the template derives them (`hex-${tile_id}`, `Hex ${tile_id}`).

## Effects / Home Assistant
`effects.json` is the catalogue, and `tools/effects.js` has `frame(effect, params, tiles, tMs)`. HA: install `ha/packages/hex_wall.yaml` and `ha/hex_wall.generated.yaml` in HA `packages/`. Tile lights are `light.hex_<id>_light`, and the group is `light.hex_wall`.
- Synced (ESP-NOW HexSync) path: `script.hex_wall_synced` calls `esphome.hex_<master>_set_wall_effect`, then `light.turn_on effect: HexSync` on the group. It maps solid->0 solid, ripple->1 radial wave, rainbow_sweep->2 rainbow sweep, breathe->3 pulse. It's used when `input_boolean.hex_wall_use_sync` is on.
- Spiral and sparkle (or anything when sync is off) fall back to the per-tile HA scripts. Those use the effects.js formulas, sampled every `step` s. Ripple uses per-tile delays by hex distance, and sparkle uses HA `random`.

## Whole-wall effects + runtime LED count (v2, PROPOSED interface, not yet verified on hardware)
- New effects: `chase` (tile to tile in index/order), `wipe` (axis x|y|ring|angle), `rainbow_flow`. Palettes: rainbow, ocean, sunset, forest, fire, mono. Every effect takes `speed`, and most take `palette`. Formulas are in `effects.json`, and `tools/effects.js` has `frame()` (`{id:[r,g,b]}`) plus `frameLeds()` (`{id:[[r,g,b] x leds]}`, where `leds` is the tile's `leds`, default 44).
- HexSync ids: 0 solid, 1 ripple, 2 rainbow_sweep, 3 breathe, 4 chase, 5 wipe, 6 rainbow_flow.
- HA (generated): `input_select.hex_wall_fx`, `input_select.hex_wall_palette`, `input_number.hex_wall_speed` (cycles/s; sent as milli-cycles), `input_number.hex_wall_led_count` (default `led.count`). These call `esphome.hex_<master>_set_wall_fx` and set the per-tile `number.hex_<id>_led_count`. Every firmware name is in `INTERFACE` in `tools/gen_ha.py`, and `layout.json` `"ha": {...}` can override any of them.
- Generator (`--tile-yaml` only): `num_leds` = compile-time max (`led.maxCount`, default the count), and `led_count` = runtime default. tiles.csv is unchanged.
