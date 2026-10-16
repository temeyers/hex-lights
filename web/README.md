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
  "led":  { "pin": 5, "type": "WS2812", "order": "GRB", "count": 36 },
  "master": "<tile id>",
  "tiles": [ { "id": "hex-01", "name": "Centre"?, "mac": "aa:bb:cc:dd:ee:01"?, "q": 0, "r": 0, "rot": 0-5, "ledCount": 42? } ] }
```
- Axial coords (q,r). `id` is a slug (`a-z0-9-_`) or a MAC. Tile `ledCount` overrides `led.count`.
- ids and (q,r) pairs must be unique; master must be an existing id. The editor flags these, plus missing IDs and bad MACs.
- Export writes exactly these keys (optional ones omitted when empty). No derived fields.
- Autosave: localStorage key `hexlights.layout.v1` (same JSON).

## Effect preview (local simulation only, no Home Assistant calls)
Loads `../effects.json` (params with type/min/max/default; accepts `{effects:{name:{params}}}`, `{name:{params}}` or
`[{name,params}]`) and `../tools/effects.js` (CommonJS, `module.exports.frame`). If missing, falls back to `effects.js` here.
Signature: `frame(effect, params, tiles, tMs) -> {tileId:[r,g,b]}`. Effects: solid{color}, breathe{color,periodS},
rainbow_sweep{speed,axis}, ripple{color,speed,origin}, spiral{speed}, sparkle{color,density}.
Tiles passed to frame carry derived fields: `x,y` (hex centre normalised 0..1 over the wall's bounding box), `ring`
(hex distance from the master, or the first tile when none), `angle` (around the master, 0..1 of a turn, atan2 in screen
coords where y points down, 0 = to the right), `index` (array order), and `ledCount` resolved. Back End's derivation should match;
`angle` units are an assumption. Brightness and preview speed are applied by the page, not by frame().
