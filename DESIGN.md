# Hex Lights – design

20 hexagon tiles (layout in `layout.json`, axial q,r, pointy-top), each an
**ESP32-S3 Super Mini** driving **44 × WS2812B** (880 LEDs total).
No data wires between tiles; shared 5 V power. Firmware: ESPHome + a custom
`hexsync` external component (ESP-NOW broadcast) — all under `esphome/`.

Legend: **[EST]** = estimate/datasheet-typical, not measured.
**[UNVERIFIED]** = needs hardware to confirm. Nothing here has run on a real tile yet.

---

## 1. Architecture

```
 Home Assistant ──(native API, Wi-Fi, per tile)──► every tile: light entity + sensors
       │
       └─ action esphome.hex_<id>_set_wall_effect (call on ANY tile)
                         │
                         ▼
   tile receiving it ──ESP-NOW broadcast HX_SET (×3)──► all tiles
   leader tile ───────ESP-NOW broadcast HX_BEACON every 100 ms──► all tiles
                         (effect clock + full current parameters)
   every tile: renders the effect locally at ~60 fps from
               (shared effect clock, params, own q,r, LED index)
```

**Why it stays in sync without streaming frames:** tiles never receive pixels.
They share a clock and a parameter set, and each computes its own 44 pixels as a
pure function of `(clock, params, q, r, led_index)`. A lost packet does not glitch
anything; the next beacon repairs state. Frame streaming (880 px × 60 fps over
ESP-NOW) was rejected: ~158 kB/s of broadcast on a shared channel is fragile.

### Components
| Piece | File |
|---|---|
| Shared package | `esphome/templates/tile-common.yaml` |
| Per-tile configs (generated) | `esphome/tiles/tile_01..20.yaml` |
| Tile list (id,q,r,rot) | `esphome/tiles.csv` (exported from `layout.json`) |
| Generator | `esphome/tools/gen_tiles.py` |
| Sync component | `esphome/components/hexsync/{__init__.py,hexsync.h,hexsync.cpp}` |
| Secrets template | `esphome/templates/secrets.yaml.example` (real `secrets.yaml` is gitignored) |

### Packet format v2 (`HxPacket`, 36 bytes, little-endian, packed)
`HX_VERSION = 2`. Packets with any other version (incl. v1) are ignored with a
rate-limited log line (`ignoring hexsync v1 packet`). All tiles must run v2 firmware.

| off | field | notes |
|---|---|---|
| 0 | `magic` u16 `0x5848` "HX" | |
| 2 | `version` u8 = 1 | reject other versions |
| 3 | `type` u8 | 1 BEACON (leader, periodic) / 2 SET (parameter change) |
| 4 | `sender` u8 | tile_num 1..20 |
| 5 | `priority` u8 | lower wins election (default = tile_num) |
| 6 | `seq` u16 | per-sender; wrap-safe `(int16)(seq-last) <= 0` → drop dupes/reordered beacons |
| 8 | `clock_ms` u32 | sender's effect clock at send |
| 12 | `gen` u32 | parameter generation; higher replaces lower |
| 16 | `effect,hue,sat,value` u8×4 | |
| 20 | `speed` u16 | milli-cycles/s |
| 22 | `scale` u16 | tiles per cycle ×100 |
| 24 | `channel` u8 | sender Wi-Fi channel (mismatch warning) |
| 25 | `palette` u8 | v2: 0 rainbow 1 ocean 2 sunset 3 forest 4 fire 5 mono |
| 26 | `axis` u8 | v2: wipe/sweep axis 0 x 1 y 2 ring 3 angle |
| 27 | `flags` u8 | v2: 0 |
| 28 | `start_ms` u32 | v2: phase origin on the shared clock; `t = clock_ms − start_ms` (held at 0 until reached) |
| 32 | `seed` u32 | v2: leader's random seed (random_ripple origin, twinkle); followers adopt the leader's |

Every packet carries the full parameter set, so tiles that boot late catch up
within one beacon.

### Time sync
`effect_clock = millis() + offset`. On each accepted leader beacon a sample
`clock_ms − local_rx_ms + 1 ms` **[EST airtime]** is taken. Latency only ever
makes a sample *late*, so the tile keeps the **largest** recent sample and
decays it by 1 ms per beacon to follow crystal drift (ESP32 crystal ~±10–40 ppm
**[EST]** → ≤4 ms/100 s drift, corrected every 100 ms). Jumps >50 ms (leader
change/reboot) re-lock. Expected tile-to-tile error 1–3 ms **[UNVERIFIED]** — far
below one frame (16.7 ms), so it's invisible.

### Leader election / failover
- Default: automatic. The lowest `leader_priority` heard within `leader_timeout`
  (1.5 s) leads; the centre tile `c0` is tile 1 so it's preferred.
- If the leader goes silent for 1.5 s, the best remaining tile takes over and
  keeps the clock running (it already holds the synced clock, so no visual jump).
- Static option: set substitution `static_leader: "1"` → only tile 1 ever leads.
- Parameter changes (`gen`) are accepted from any tile, so HA can call the
  action on any tile, not just the leader.

### Wi-Fi channel matching
ESP-NOW is sent on the STA interface, so it uses the AP's current channel. All
tiles join the same SSID → same channel. The component inits ESP-NOW only after
Wi-Fi is connected, re-reads the channel each loop and logs a warning if a peer
reports a different one. Caveats **[UNVERIFIED]**: mesh/multi-AP setups where
tiles join different APs on different channels **will break sync** — pin the
tiles to one AP/BSSID or use a single channel across APs. `power_save_mode: none`
is set because modem sleep drops broadcasts.

### Runtime layout (no reflash) – interface for Back End / Front End
q, r, rotation and chase order are **live values** inside hexsync, saved to flash
(NVS, debounced 1 s). The compile-time substitutions (`q`, `r`, `rotation`,
`order`, default order = tile_num − 1) are only first-boot defaults.

**Tile identity:** `tile_id` = `tile_num` = 1-based row in `esphome/tiles.csv`
(c0 = 1, r1-e = 2 … r3-a = 20). It's fixed at compile time; position is not.

**HA entities per tile** (node `hex-<id>`, e.g. `hex-c0`):
- `number.hex_<id>_grid_q`, `number.hex_<id>_grid_r` (−50..50),
  `number.hex_<id>_rotation` (0..359 °), `number.hex_<id>_chase_order` (0..254), entity_category config.
  Writing one changes and saves that tile only. They're template numbers polled
  every 2 s; persistence is done in hexsync rather than `restore_value`
  (ESPHome doesn't allow `restore_value` with a lambda) – same behaviour.
- Ack/diagnostics: `sensor.hex_<id>_layout` text `"id:q:r:rot:order"`,
  `sensor.hex_<id>_layout_generation`, `sensor.hex_<id>_neighbors` text `"2,7,19"`,
  `sensor.hex_<id>_peers_seen`.

**Services** (exposed on every tile; call them on the master `hex-c0`):
```yaml
action: esphome.hex_c0_set_tile_layout
data: {tile_id: 5, q: -1, r: 0, rotation: 60, order: 4}

action: esphome.hex_c0_set_layout_bulk
data: {layout: "1:0:0:0:0;2:1:0:0:1;3:1:-1:0:2"}
```
Bulk grammar: `entry (";" entry)*`, `entry = tile_id ":" q ":" r ":" rotation ":" order`,
decimal ints, whitespace and a trailing `;` allowed. Ranges: tile_id 1..250, q/r
−50..50, order 0..254, rotation taken mod 360. Any bad entry rejects the whole
string (nothing sent; logged warning). `tools/gen_tiles.py` writes the full
default string to `esphome/layout_bulk.txt` (235 chars for 20 tiles).

**HX_LAYOUT packet** (type 3): 12-byte header + `count` × 6-byte entries, max 39
entries per packet (larger bulks are split). Sent 3× (broadcast has no retries).
| off | field |
|---|---|
| 0 | magic u16 0x5848, 2 version u8 =1, 3 type u8 =3 |
| 4 | sender u8, 5 count u8, 6 seq u16, 8 gen u32 (layout generation = sender effect clock ms) |
| 12+6k | tile_id u8, q i8, r i8, rotation u16 (deg), order u8 |

Each tile applies only the entry with its own tile_id, saves it, and sets
`layout_gen = gen`. Re-sending identical values is harmless (idempotent).

**HX_STATUS packet** (type 4, 20 bytes, every ~2 s + immediately after a layout
change = the **ack**): magic u16, version u8, type u8 =4, sender u8, q i8, r i8,
order u8, rotation u16, seq u16, layout_gen u32, leader u8, neighbors u8, led_count u8 (v2), reserved u8.
Tiles use it to keep a live peer table (dropped after 10 s of silence).

**How the editor confirms:** after pushing, read each tile's `Layout` text sensor
(or `Layout generation`) via HA/API; it updates within ~5 s **[EST, sensor poll
interval]**. If a tile still shows old values after ~10 s, resend its entry with
`set_tile_layout` (ESP-NOW broadcast can drop packets). HA sees the ack through
each tile's own API; tiles don't relay other tiles' status to HA.

**Neighbors** are recomputed from live (q,r): a peer is a neighbor if its
position is one of the 6 axial offsets (+1,0) (+1,−1) (0,−1) (−1,0) (−1,+1) (0,+1).
There are no compile-time neighbor lists anywhere.

### Wall effects v2 (matches Back End `effects.json` / `tools/gen_ha.py`)
Service on the master: `esphome.hex_c0_set_wall_fx(effect, palette, speed, scale, hue, saturation, value, start_delay_ms)`
(speed milli-cycles/s, scale ×100, hue/sat/value 0–255, start_delay_ms 0–10000 → `start_ms = clock + delay`).
Legacy `esphome.hex_c0_set_wall_effect` still works (keeps palette, starts now).

| id | name | notes |
|---|---|---|
| 0 | solid | hsv(hue,sat) × value |
| 1 | radial_wave | = effects.json "ripple" from the master (q,r = 0,0) |
| 2 | rainbow_sweep | palette over normalized x (or y) |
| 3 | pulse | = effects.json "breathe" |
| 4 | chase | tile-to-tile by chase order, tail = scale/100 tiles |
| 5 | wipe | axis x / y / ring / angle (Wall wipe axis select) |
| 6 | rainbow_flow | u = ((x+y)/2)·scale − t·speed |
| 7 | random_ripple | ring from a random tile each period; origin = tiles sorted by id [hash01(seed,k)·N] |
| 8 | twinkle | per-LED, deterministic from seed; density = scale/1000 |
| 9 | color_cycle | each tile = pal(order/N + t·speed) |
| 10 | snake | chase + the head's live neighbours glow at 25 % |

All tiles compute from the **live** layout (self + peers heard in 10 s): N, x/y normalized to
the live bounding box of tile centres, ring/angle from (0,0). Effects 0–7, 9, 10 are tile-level
(every LED the same, as effects.json v1); twinkle is per-LED. Exact math: `esphome/tools/effects-ref.js`.
Assumption **[verify with Back End]**: their `x,y` in out/layout.json are normalized centre
coordinates of the same pointy-top layout; if not, previews differ slightly.

**Shared controls on the master** (internal on other tiles): `number.hex_c0_wall_speed`,
`select.hex_c0_wall_effect` (names above), `select.hex_c0_wall_palette`,
`select.hex_c0_wall_wipe_axis`. They call the same `set_wall_fx` path.

**LED count:** `number.hex_<id>_led_count` ("LED count", 1..60, default 44, saved in flash).
The strip allocates 60 pixels; only the first N render, the rest stay black; the current
budget counts only N.

### Older per-LED notes
Tile centre: `x = √3·(q + r/2)`, `y = 1.5·r` (tile units). The 44 LEDs are assumed
evenly spaced around the tile edge at radius 0.45, offset by `rotation`.
- `1` **Radial wave** – brightness `sin(2π(d/scale − t·speed))`, d = distance from centre.
- `2` **Rainbow sweep** – hue follows `x/scale − t·speed`, sweeping left→right.
- `3` **Pulse** – whole wall breathes in unison (sync test).
- `4` **Chase** – one lit tile walks the wall in `order`, `speed` = tiles/s ×1000.
- `0` **Solid**.

### HA integration
Each tile: `light.hex_<id>_light` (effects: HexSync, local rainbow), estimated
current, sync offset, leader id, "is leader", Wi-Fi signal. Wall control:
```yaml
action: esphome.hex_c0_set_wall_effect
data: {effect: 1, hue: 160, saturation: 255, value: 200, speed: 400, scale: 300}
```
then turn all lights on with effect `HexSync` (the action already does this for the
tile it's called on; group the 20 lights in HA for on/off/brightness).

### RMT driver on the S3 with 44 LEDs
`esp32_rmt_led_strip` (ESPHome 2025.9.3, esp-idf 5.4.2) compiled for 44 LEDs.
44 × 24 bit × 1.25 µs ≈ 1.3 ms per frame + 280 µs reset — trivial at 60 fps.
The driver builds the whole frame in RAM and the RMT encoder streams it, so
LED count isn't limited by RMT memory blocks. If you see flicker while Wi-Fi is
busy **[UNVERIFIED]**, set `use_dma: true` on the light (S3 supports RMT DMA) or
raise `rmt_symbols`. Expect it to be fine; this is a common, light load.

### S3 Super Mini pin notes
- LED data: **GPIO4** (substitution `led_pin`).
- Avoid: GPIO0/3/45/46 (strapping), GPIO19/20 (native USB), GPIO48 (onboard WS2812
  RGB LED on most S3 Super Minis **[verify on your board]**).
- Flash 4 MB (some have 2 MB PSRAM; unused). Board profile `esp32-s3-devkitc-1`.

### Variant background (short)
| Board | Notes |
|---|---|
| C3 Super Mini | single RISC-V core, cheapest, weak antenna on many clones, 2 RMT TX ch |
| **S3 Super Mini (chosen)** | dual core, 4 RMT TX + DMA, native USB, more RAM; slightly more power |
| C6 Super Mini | Wi-Fi 6 + Thread/Zigbee; ESPHome support newer, fewer users |

---

## 2. ESPHome+hexsync vs plain WLED

| | ESPHome + hexsync (this repo) | WLED + UDP sync / ESP-NOW sync | WLED + DDP/E1.31 from a host |
|---|---|---|---|
| Effort | High: custom C++, untested on hardware | **Lowest**: flash, configure in web UI | Medium: needs a host (LedFx/xLights/HA add-on) always running |
| HA | Native API, per-tile entities, custom wall action | Official WLED integration, good, per-tile | Same as WLED, but effects come from host |
| Spatial (hex-aware) effects across tiles | **Yes**, computed on each tile from q,r | **No** – each tile runs the same 1D effect; sync aligns params/timebase, not geometry. 2D matrix doesn't span devices | Yes, host maps 880 px in 2D |
| Sync quality | Shared clock, ~1–3 ms **[UNVERIFIED]** | UDP sync: typically good, effect timebase sync; Wi-Fi multicast/broadcast jitter 5–50 ms **[EST]**. WLED 0.15+ has an ESP-NOW sync option **[verify for your WLED version]** | Depends on host and Wi-Fi; 20 unicast streams, 10–50 ms jitter **[EST]**, drops show as stutter |
| Works without a PC | Yes | Yes | No |
| Effects library | 4 (write more in C++) | 100+ effects, palettes, presets | Whatever host offers (audio-reactive etc.) |

**Recommendation:** ESPHome + hexsync for this wall (Terry has confirmed ESPHome).
It's the only option that gives hex-aware effects across the wall with no host PC
and native HA entities. Be honest about the trade-off: WLED is much less work and
has far more effects. If identical per-tile effects in sync are good enough, WLED +
sync is the pragmatic choice and is the fallback if hexsync misbehaves on hardware.

---

## 3. Power plan (880 × WS2812B, 20 tiles × 44)

### Current
| Case | Per tile | Wall (20) |
|---|---|---|
| Full white, uncapped (60 mA/LED **[EST, datasheet-typical]**) | 2.64 A | **52.8 A / 264 W** |
| Hard firmware cap `color_correct 55%` | 1.45 A | 29 A |
| hexsync effect budget (`tile_budget_ma 1200`) | ≤1.2 A | ≤24 A |
| Typical radial wave / rainbow (44 LEDs) at value ~180 **[EST 15–30 % of full white]** | 0.4–0.8 A | 8–16 A |
| LED idle quiescent ~0.6–1 mA/LED **[EST]** | ~40 mA | ~0.9 A (even when "off") |
| ESP32-S3, Wi-Fi on, no power save: ~100 mA avg, ~350 mA peaks **[EST]** | 0.1–0.35 A | 2–7 A peak |

**Design load (capped): ~29 A LEDs + ~3 A boards/idle ≈ 32 A [EST].**

### Firmware limits (two layers, both in `tile-common.yaml`)
1. `color_correct: [55%,55%,55%]` – hard per-channel ceiling on **everything** the
   light shows, including solid colours from HA → max ~1.45 A/tile **[EST]**.
2. `hexsync` `tile_budget_ma: 1200` – each frame estimates current
   (`Σ(r+g+b)/765 × 60 mA × 0.55`) and scales the frame down if it exceeds the budget.
   Exposed as the "Effect current estimate" sensor. **Model is linear and
   unmeasured; check with a clamp meter and adjust.**
   (ESPHome's `power_supply` component only switches an enable pin; it is not a
   current limit, so it's not used.)

### Supply options
| Option | Notes |
|---|---|
| **A. 1× 5 V 60 A (300 W) Meanwell-class** | Covers even uncapped 52.8 A + boards at ~95 %; with caps you run at ~55 %. Simplest. **Recommended.** |
| B. 1× 5 V 40 A (200 W) | Enough for the capped design (32 A ≈ 80 %), **no** headroom if the cap is removed/buggy. Fuses protect wiring, not the PSU's sustained overload. |
| C. 2× 5 V 30 A, each feeds 10 tiles | Split bus, grounds tied, **never parallel the +5 V outputs**. Redundancy, smaller units. |
| D. 12 V bus + 5 V buck per tile | 12 V current ≈ 32 A × 5/12 / 0.9 ≈ **15 A [EST]** → thinner wire, less drop. Cost/space/heat of 20 bucks (≥3 A each, plus regulation noise on tile). Worth it for long runs (>3 m) or if drop is a problem; **overkill for one compact wall**. |

Set the 5 V PSU to ~5.1–5.2 V to absorb drop.

### Injection layout (option A; 4 branches × 5 tiles)
```
PSU 5V ──[MAIN fuse 60 A]── 10 AWG ── distribution bus (+5V / GND bars)
   ├─[10 A]─ 14 AWG branch 1 ─┬─[3 A]─20 AWG─ tile c0
   │                          ├─[3 A]─ tile r1-e … (5 tiles)
   ├─[10 A]─ branch 2 (5 tiles)
   ├─[10 A]─ branch 3 (5 tiles)
   └─[10 A]─ branch 4 (5 tiles)
```
- Each tile gets its own drop from a branch (star/daisy taps), fused 3 A.
- Inside a tile, feed +5 V/GND to **both ends** of the 44-LED strip (it's a loop
  around the hex, so join the ends to the same tap).
- Main fuse sized to the PSU/wire: 60 A for option A with 10 AWG (or 8 AWG if the
  main run is >1 m); 40 A for option B.
- Branch fuse 10 A: capped branch ≈ 5 × 1.45 + 5 × 0.15 ≈ 8 A **[EST]**. An uncapped
  full-white branch (13.2 A+) will blow it – that's intended.
- Tile fuse 3 A fast blade (ATM mini) – uncapped tile max ≈ 2.64 + 0.35 ≈ 3.0 A,
  capped ≈ 1.6 A. Polyfuses work but add resistance and trip slowly.

### Wire gauge and voltage drop (copper, round trip = 2× one-way) **[EST]**
| Run | Gauge | Ω/m | Length one-way | Current | Drop |
|---|---|---|---|---|---|
| PSU → bus | 10 AWG | 0.0033 | 0.5 m | 32 A | 0.11 V |
| Branch | 14 AWG | 0.0083 | 1.5 m | 8 A | 0.20 V |
| Branch (if 16 AWG) | 16 AWG | 0.0132 | 1.5 m | 8 A | 0.32 V |
| Tile drop | 20 AWG | 0.0333 | 0.3 m | 1.6 A | 0.03 V |
| Tile drop uncapped | 20 AWG | 0.0333 | 0.3 m | 3 A | 0.06 V |

Worst capped tile ≈ 5.15 − 0.34 ≈ **4.8 V** with 14 AWG branches. WS2812B is fine
at 4.5–5.3 V.

### Per-tile wiring
- **Capacitor:** 1000 µF / 10 V electrolytic + 100 nF across +5 V/GND at the strip input.
- **Data:** S3 GPIO4 → **330 Ω series resistor** at the strip DIN, wire < 10 cm.
  WS2812B at 5 V wants VIH ≥ 0.7 × VDD = 3.5 V; 3.3 V usually works but is marginal.
  **Recommended:** a 74AHCT1G125 (or SN74AHCT125) powered from 5 V as a level shifter;
  cheap and removes the doubt. Alternative hack: power the first LED through a
  diode (~4.3 V) so 3.3 V is a valid high.
- Board power: Super Mini 5V pin from the fused tile tap, GND common with strip.
  **Don't plug USB while the bus is live** unless you've confirmed the board has a
  VBUS diode **[verify on your board]**; for the first USB flash, keep the bus off.

---

## 4. Latency – what can't be verified without hardware
- ESP-NOW broadcast 28 B at 1 Mbps: ~0.5–2 ms per packet incl. stack **[UNVERIFIED]**.
- Broadcast loss on a busy channel: a few % **[UNVERIFIED]**; mitigated by 3× SET burst + 100 ms beacons.
- HA action → visible change on the wall: ~20–80 ms **[UNVERIFIED]** (API + ESP-NOW + next frame).
- Tile-to-tile clock error: 1–3 ms **[UNVERIFIED]**; check by filming the Pulse effect at 240 fps.
- Render time for 44 LEDs with `sinf`/HSV: well under 1 ms on the S3 **[EST]**.
