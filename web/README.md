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
YAML snippets for `esphome.hex_<master>_set_layout_bulk` and per-tile `..._set_tile_layout` (node name from the
master id, `hex_c0` for the default layout). If tiles.csv can't be fetched, paste it into the panel.
For Back End's default layout, the output equals `esphome/layout_bulk.txt`.

## Effects (wall effects, 5dd5427)
Controls are built from effects.json: colour → colour picker, number → slider, enum → menu (wipe's axis x|y|ring|angle),
`palette` → swatch picker with gradients sampled from Back End's `pal()`, tileId → tile menu. The preview uses `frameLeds()`
when exported and draws each tile's `leds` as dots around the edge, offset by its rotation. Otherwise it falls back to `frame()`.
Tiles passed in also carry `order` and `rotation` (degrees). The local `effects.js` fallback mirrors chase, wipe,
rainbow_flow and the palettes.

## Firmware limits and wall effect (Hardware hexsync v2)
- LED count: `led.count` and tile `ledCount` must be 1–60 (`number.hex_<id>_led_count`). Higher values are flagged, not clamped.
- Push tab → **Wall effect**: YAML for `esphome.hex_<master>_set_wall_fx(effect, palette, speed, scale, hue, saturation, value, start_delay_ms)`
  built from the current preview. effect = effects.json `hexsyncId` (fallback table 0 solid … 10 snake). palette = index 0–5.
  speed = cycles/s ×1000 (breathe: 1000/periodS), capped 0–10000. scale ×100 (chase tail, rainbow_flow scale), else 100.
  hue/sat 0–255 from the colour; value = round(colourV × preview brightness), 0–255 (no colour → V 255). start_delay_ms capped at 10000. Effects without an id (spiral, sparkle)
  disable the snippet and show a message. The axis for wipe and rainbow_sweep (x, y, ring, angle) is `select.hex_c0_wall_wipe_axis`, not a service field.
- Preview source **Firmware reference** uses `../esphome/tools/effects-ref.js` `frame(P, tiles, tMs, ledCount)`. Tiles get numeric
  ids from tiles.csv rows. It's called once with the largest led count, then sliced per tile. firmwareOnly effects (random_ripple,
  twinkle, color_cycle, snake) always preview through it.
