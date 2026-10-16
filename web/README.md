# Hex lights layout editor (static, ES5, no build, no CDN)

Open via any static server rooted at `/workspace/hex-lights` (e.g. `python3 -m http.server 8411` there, then
http://localhost:8411/web/). Serving from the parent dir lets the page find Back End's `../effects.json` and
`../tools/effects.js`. It also works from `file://`, but then it always uses the local effects.

Files: `index.html`, `app.css` (glass look copied from laundromat-web lg.css, not linked), `app.js` (editor, pan/zoom/pinch,
panels, preview), `layout-format.js` (ONLY place that serializes/parses/validates), `effects.js` (local fallback effects),
`test.js` (Playwright check: `NODE_PATH=/tmp/pw/node_modules node test.js`, needs the server on :8411).

## Layout format v1 (adopted by Back End; canonical file /workspace/hex-lights/layout.json)
```
{ "version": 1, "name": "Living room",
  "hex":  { "orientation": "pointy" | "flat", "sizeMm": 100 },
  "led":  { "pin": "GPIO13", "type": "WS2812", "order": "GRB", "count": 44 },
  "master": "<tile id>",
  "tiles": [ { "id": "hex-01", "name": "Centre"?, "mac": "aa:bb:cc:dd:ee:01"?, "q": 0, "r": 0, "rot": 0-5, "ledCount": 42? } ] }
```
- Axial coords (q,r). `id` is a slug (`a-z0-9-_`) or a MAC. Tile `ledCount` overrides `led.count`.
- ids and (q,r) pairs must be unique; master must be an existing id. The editor flags these, plus missing IDs and bad MACs.
- `led.pin` is a string `GPIO<n>` (a bare number is converted). Unknown keys Back End uses (e.g. `led.budgetMa`, `led.maxScale`, tile `pin`/`priority`) are preserved on import/export; derived out/ fields are dropped.
- Export writes exactly these keys (optional ones omitted when empty). No derived fields.
- Autosave: localStorage key `hexlights.layout.v1` (same JSON).

## Effect preview (local simulation only, no Home Assistant calls)
Loads `../effects.json` (params with type/min/max/default; accepts `{effects:{name:{params}}}`, `{name:{params}}` or
`[{name,params}]`) and `../tools/effects.js` (CommonJS, `module.exports.frame`). If missing, falls back to `effects.js` here.
Signature: `frame(effect, params, tiles, tMs) -> {tileId:[r,g,b]}`. Effects: solid{color}, breathe{color,periodS},
rainbow_sweep{speed,axis}, ripple{color,speed,origin}, spiral{speed}, sparkle{color,density}.
Tiles passed to frame carry the same derived fields as `tools/gen_tiles.py` (verified equal to out/layout.json for the 20-tile
reference layout): unit-hex pixel math (pointy x=√3(q+r/2), y=1.5r; flat x=1.5q, y=√3(q/2+r)); `x,y` normalised 0..1 per axis
(single row/column = 0.5); `ring` = hex distance from master; `angle` = degrees 0-360 from master, 0 = right, clockwise on
screen (y down), master 0; `index`; `isMaster`; `leds`. Back End's `tools/effects.js` is an ES module and is loaded with dynamic
`import()`; colour params are `[r,g,b]` arrays. Brightness and preview speed are applied by the page, not by frame().

## Hardware runtime layout (DESIGN.md "Runtime layout")
Per tile in the Tile panel: **Grid q / r** (−50..50; this *is* the axial position), **Rotation (°)** 0–359,
**Chase order** 0–254 (default = tile index). Ranges, duplicate (q,r) and duplicate effective chase orders are flagged.

**Rotation mapping (layout.json stays compatible):** `rot` (0–5) is unchanged and always written as
the nearest 60° step (`rot = round(deg/60) mod 6`). Degrees = `rot × 60` unless the tile has the optional
`rotationDeg` (0–359), which is written only when the degrees are not exactly `rot × 60`. `order` is written
only when set explicitly. Both are extra tile keys that `gen_tiles.py` passes through without complaint.
Note: `gen_tiles.py` currently feeds `rot` (0–5) straight into the firmware's degree substitution `rotation`;
it should send `rotationDeg` if present, else `rot*60`. Harmless today because every default tile has rot 0.

## Hardware push panel (generate only — nothing is sent)
Builds `tile_id:q:r:rotation:order;…` where `tile_id` = 1-based row in `../esphome/tiles.csv`, matched by tile id,
then by MAC (a `mac` column if tiles.csv has one, or a MAC-style id). Unknown tiles, out-of-range values or
duplicate orders block the string and the Copy buttons, because a single bad entry makes the tile reject it all.
YAML snippets for `esphome.hex_NN (master row)_set_layout_bulk` and per-tile `..._set_hex_layout` (node name from the
master id, `hex_01` for the default layout). If tiles.csv can't be fetched, paste it into the panel.
For Back End's default layout, the output equals `esphome/layout_bulk.txt`.

## Effects (wall effects, 5dd5427)
Controls are built from effects.json: colour → colour picker, number → slider, enum → menu (wipe's axis x|y|ring|angle),
`palette` → swatch picker with gradients sampled from Back End's `pal()`, tileId → tile menu. The preview uses `frameLeds()`
when exported and draws each tile's `leds` as dots around the edge, offset by its rotation. Otherwise it falls back to `frame()`.
Tiles passed in also carry `order` and `rotation` (degrees). The local `effects.js` fallback mirrors chase, wipe,
rainbow_flow and the palettes.

## Firmware limits and wall effect (Hardware hexsync v2)
- LED count: `led.count` and tile `ledCount` must be 1–60 (`number.hex_<id>_led_count`). Higher values are flagged, not clamped.
- Push tab → **Wall effect**: YAML for `esphome.hex_NN (master row)_set_wall_fx(effect, palette, speed, scale, hue, saturation, value, start_delay_ms)`
  built from the current preview. effect = effects.json `hexsyncId` (fallback table 0 solid … 10 snake). palette = index 0–5.
  speed = cycles/s ×1000 (breathe: 1000/periodS), capped 0–10000. scale ×100 (chase tail, rainbow_flow scale), else 100.
  hue/sat 0–255 from the colour; value = round(colourV × preview brightness), 0–255 (no colour → V 255). start_delay_ms capped at 10000. Effects without an id (spiral, sparkle)
  disable the snippet and show a message. The axis for wipe and rainbow_sweep (x, y, ring, angle) is `select.hex_01_wall_wipe_axis`, not a service field.
- Preview source **Firmware reference** uses `../esphome/tools/effects-ref.js` `frame(P, tiles, tMs, ledCount)`. Tiles get numeric
  ids from tiles.csv rows. It's called once with the largest led count, then sliced per tile. firmwareOnly effects (random_ripple,
  twinkle, color_cycle, snake) always preview through it.

## Sync mode (DESIGN.md "Sync mode: Wireless (default) or Jumper wire", d3aeb8b)
- **Storage:** DESIGN.md/layout.json define no key, so the editor uses an optional top-level
  `"sync": {"mode": "wireless" | "jumper", "pin": "GPIO<n>"}`. It's written only when not the default (wireless, GPIO12), so Back End's
  layout.json round-trips unchanged. gen_tiles.py `validate()` accepts it and `derive()` copies it through (checked). It does not yet
  feed the `sync_pin` substitution. On the device the mode is the master's `select.hex_01_sync_mode`
  (`Wireless (ESP-NOW)` / `Jumper wire`) and sync_pin is a compile-time substitution (default GPIO12).
- **Sync pin** uses the same rule as the data pin (`GPIO<n>`, not 0/3/45/46 strapping, 19/20 USB, 48 RGB LED, same as gen_tiles
  `check_pin`), and is flagged if it equals the LED data pin.
- **Wiring panel** (Layout tab, Jumper only): one shared SYNC line + GND bus, a 330 Ω series resistor at each tile, one 4.7 kΩ
  pull-up to 3.3 V, pin = sync_pin. Matches DESIGN.md. Its only nuance: the 4.7 kΩ is "optional" (internal ~45 kΩ pull-ups for short lines [EST]).
- **Sync source badge** (grid `W`/`J`, `·L` = expected leader; tile panel): *expected* value only. Wireless → `espnow`, Jumper →
  `jumper` (the leader also reports `jumper`). The live value, including `jumper-lost`, comes from `sensor.hex_<id>_sync_source` in HA, which the editor doesn't read.
  The expected leader is the master (gen_tiles gives it leader_priority 1); failover can move it.
- **Push YAML** adds a `select.select_option` on `select.hex_01_sync_mode`. Wall-fx YAML is unchanged (the mode isn't a set_wall_fx field).

## Hex NN naming (branch web-hex-nn, matches Hardware 9b55813)
- A hex is shown as **Hex NN**, where NN is its 1-based row in `esphome/tiles.csv` (c0 = Hex 01 … r3-a = Hex 20). The layout id/name is
  shown second. Hexes missing from tiles.csv show `Hex ?`.
- HA ids use `hex_NN_*`: `sensor.hex_NN_sync_source`, `binary_sensor.hex_NN_sync_leader`, `select.hex_01_sync_mode`,
  `select.hex_01_wall_wipe_axis`. The service prefix comes from the **master's tiles.csv row** (`hex_01`), not its id. Push is blocked if the master isn't in tiles.csv.
- Services: `esphome.hex_01_set_layout_bulk`, `esphome.hex_01_set_hex_layout(hex_num, q, r, rotation, order)`,
  `esphome.hex_01_set_wall_fx(effect, palette, speed, scale, hue, saturation, value, start_delay_ms, axis)`. `axis` (0 x, 1 y, 2 ring,
  3 angle) is a required argument in 9b55813's template, so the snippet always includes it.
- UI text says "hex" everywhere ("Add hex", "Hex panel", "LEDs per hex", "Master hex", …). The file format keeps `tiles`, `ledCount`
  and the code identifiers. New hexes get ids `h1`, `h2`, … (previously `tile-N`).

## Live (Home Assistant) preview source (read-only)
Preview source **Live (Home Assistant)**: enter the HA URL and a long-lived access token, then Connect. The token is kept only in this tab's
`sessionStorage` (`hexlights.ha`). It's never in localStorage, the repo or logs. Websocket only (`<url>/api/websocket`), no REST. The editor
sends only `auth` and one `subscribe_entities` filtered to the ids below. No service calls and no history: live state only, since the sensor isn't recorded.
- Ids derived from `esphome/tiles.csv` (NN = row): primary `sensor.hex_NN_displayed_color` (`#RRGGBB`, ESPHome text_sensor → HA
  `sensor` domain; `group.hex_wall_displayed_colors` lists them). Fallback when the sensor is missing / `unavailable` / `unknown` / not
  `#RRGGBB`: `light.hex_NN_light` `rgb_color` × `brightness`/255 (off = black). No `sensor.hex_NN_light_rgb`, no `out/ha_entities.json`.
- Each hex gets a marker: **S** = sensor, **L** = light fallback, **–** = no data. The status line shows connected, the counts, auth failures and disconnects.
- Browser websockets aren't subject to HA's CORS. REST would need `http: cors_allowed_origins: [http://<host>:<port>]` (the editor's origin)
  in HA's configuration. An **https** editor page cannot connect to **http** HA (mixed content). The UI reports this as a connection error instead of trying.
