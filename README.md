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

## Run
    python3 tools/gen_tiles.py [--secrets-template] [--emit-csv] [--check]
    python -m pytest tests && node tests/effects.test.mjs
    cp secrets.example.yaml esphome/generated/secrets.yaml   # fill in (gitignored)
    esphome config esphome/generated/c0.yaml

Tile configs go to `esphome/generated/<id>.yaml` (gitignored, one level below `esphome/` so the template's `../components` path resolves). Each one sets substitutions and includes `../templates/tile-common.yaml` (Hardware's template, the source of truth). Secrets are Hardware's shared names: `wifi_ssid wifi_password fallback_ap_password ota_password api_key`.

## Substitution map (layout.json -> Hardware template)
| template | from |
|---|---|
| tile_id | tile.id (a MAC id becomes lowercase hex) |
| tile_num | layout index + 1 |
| q, r | tile.q, tile.r |
| rotation | tile.rot |
| led_pin | tile.pin or led.pin |
| num_leds | tile.ledCount or led.count |
| static_leader | tile_num of `master` |
| leader_priority | tile.priority (otherwise the template default `${tile_num}`) |
| tile_budget_ma | led.budgetMa (otherwise the template default 1200) |
| max_scale, max_scale_pct | led.maxScale (otherwise the template default 0.55 / 55%) |

device_name and friendly_name are not emitted: the template derives them (`hex-${tile_id}`, `Hex ${tile_id}`).

## Effects / Home Assistant
`effects.json` is the catalogue, and `tools/effects.js` has `frame(effect, params, tiles, tMs)`. HA: install `ha/packages/hex_wall.yaml` and `ha/hex_wall.generated.yaml` in HA `packages/`. Tile lights are `light.hex_<id>_light`, and the group is `light.hex_wall`.
- Synced (ESP-NOW HexSync) path: `script.hex_wall_synced` calls `esphome.hex_<master>_set_wall_effect`, then `light.turn_on effect: HexSync` on the group. It maps solid->0 solid, ripple->1 radial wave, rainbow_sweep->2 rainbow sweep, breathe->3 pulse. It's used when `input_boolean.hex_wall_use_sync` is on.
- Spiral and sparkle (or anything when sync is off) fall back to the per-tile HA scripts. Those use the effects.js formulas, sampled every `step` s. Ripple uses per-tile delays by hex distance, and sparkle uses HA `random`.
