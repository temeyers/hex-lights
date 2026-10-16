# Hex tile firmware (ESPHome 2025.9.3)

Design and power plan: `../DESIGN.md`. Only tested so far with `esphome config`
(all 20 tiles) and `esphome compile` (hex-01). **Not yet run on hardware.**

## Setup
```bash
python3 -m venv ~/esphome-venv && ~/esphome-venv/bin/pip install -r requirements.txt
cp templates/secrets.yaml.example templates/secrets.yaml   # gitignored; fill in real values
python3 tools/gen_tiles.py           # regenerates tiles/hex-NN.yaml from tiles.csv
```
`secrets.yaml` must live in `templates/` (ESPHome looks next to the file that uses `!secret`).
Generate the API key with the command in the example file.

## First flash (USB, once per tile)
1. **Turn the 5 V bus off** (or disconnect the tile drop) before plugging USB.
2. Connect the S3 Super Mini by USB-C. If it doesn't show up, hold **BOOT**, tap **RESET**, release BOOT.
3. ```bash
   ~/esphome-venv/bin/esphome run tiles/hex-01.yaml --device /dev/ttyACM0   # macOS: /dev/cu.usbmodem*
   ```
   Tip: label each board with its tile id before mounting it.

## After that: OTA
```bash
~/esphome-venv/bin/esphome run tiles/hex-01.yaml --device hex-01.local
# all tiles:
for f in tiles/hex-*.yaml; do ~/esphome-venv/bin/esphome run "$f" --no-logs --device OTA; done
```
OTA uses `ota_password` from secrets.yaml. Then adopt each tile in HA
(Settings → Devices → ESPHome, it's auto-discovered; paste the API key).

## Try it
HA → Developer tools → Actions:
```yaml
action: esphome.hex_01_set_wall_effect
data: {effect: 1, hue: 160, saturation: 255, value: 200, speed: 400, scale: 300}
```
Effects (v2): 0 solid, 1 radial_wave, 2 rainbow_sweep, 3 pulse, 4 chase, 5 wipe,
6 rainbow_flow, 7 random_ripple, 8 twinkle, 9 color_cycle, 10 snake.
Preferred service:
```yaml
action: esphome.hex_01_set_wall_fx
data: {effect: 5, palette: 2, speed: 300, scale: 100, hue: 18, saturation: 215, value: 255, start_delay_ms: 300, axis: 0}
```
Or use the master's Wall effect / Wall palette / Wall speed / Wall wipe axis entities.
Each tile's **LED count** number (1-60, default 44) changes the active LEDs without reflashing. Then turn the 20 lights on with effect **HexSync**.

## Tuning
Per-tile substitutions (in tiles.csv → generator, or the shared defaults in `templates/tile-common.yaml`):
`led_pin` (GPIO13), `num_leds` (44), `max_scale`/`max_scale_pct` (0.55 hard ceiling),
`tile_budget_ma` (1200), `static_leader` (0 = auto failover), `rotation`.

## Changing the layout without reflashing
Each tile has Grid q / Grid r / Rotation / Chase order number entities. Or push the
whole wall from the master:
```yaml
action: esphome.hex_01_set_layout_bulk
data: {layout: "<contents of layout_bulk.txt>"}
```
Check each tile's **Layout** sensor to confirm; resend single tiles with
`esphome.hex_01_set_hex_layout`. Details: DESIGN.md → Runtime layout.

## Optional: jumper-wire sync
Default is **Wireless (ESP-NOW)**, and then GPIO12 is never touched. To use a wire:
1. Join all tiles' GPIO12 through a 330 Ω resistor each onto one shared line, plus a shared GND,
   and one 4.7 kΩ pull-up to 3.3 V (or rely on the internal pull-ups for short runs).
2. On the master, set **Sync mode** (`select.hex_01_sync_mode`) to `Jumper wire`.
3. Check each tile's **Sync source** sensor reads `jumper` and **Sync pulse jitter** is small.
   `jumper-lost` means no pulses for >1 s; it falls back to ESP-NOW automatically.
Set it back to `Wireless (ESP-NOW)` to release the pin. Different pin or first-boot mode for the whole wall:
`python3 tools/gen_tiles.py --sync-pin GPIO12 --sync-mode wireless` (writes `sync_pin` and `sync_mode_default`
into every tile; the mode saved on a tile wins after its first boot).
See DESIGN.md → Sync mode.

## ESPHome version compatibility

Validated (`esphome config` + `esphome compile` on tiles/hex-01.yaml) with **2025.9.3** and **2026.9.1** (HA add-on).

- `hexsync` no longer uses `CORE.using_esp_idf` (removed in 2026.x); it falls back to the `esp32: framework: type`.
- The LED strip keeps `rgb_order: GRB`, because 2025.9.x rejects `channel_colors`. 2026.x accepts it with a deprecation warning, and the option is removed in 2027.3.0. Switch to `channel_colors: GRB` once 2025.9 support is dropped.
- 2026.x rejects an all-zeros `api_key`. Use a real key: `openssl rand -base64 32`.
- If you build with both versions on one machine, give them separate PlatformIO dirs, for example `PLATFORMIO_CORE_DIR=~/.platformio-esphome2025`. Otherwise the 2026 ESP-IDF package breaks 2025 builds (`esp_driver_bitscrambler`).

## Rename to hex-NN (device names, entities, services)

Devices are now `hex-01`..`hex-20` (friendly name `Hex 01`.., fallback AP `hex-01`..). The axial ids (c0, r1-e, ...) stay internal (q/r substitutions, a comment in each file).
Entity ids follow suit: for example `light.hex_c0_light` becomes `light.hex_01_light`, and `esphome.hex_c0_set_wall_fx` becomes `esphome.hex_01_set_wall_fx`.
The layout service is now `set_hex_layout(hex_num, q, r, rotation, order)`, renamed from `set_tile_layout(tile_id, ...)`.

**Hex 01 was already flashed as hex-c0.** It still answers on `hex-c0.local` until it runs the new firmware. For that one OTA:
1. In `tiles/hex-01.yaml`, uncomment the block at the bottom (`wifi: use_address: hex-c0.local`).
2. `esphome run tiles/hex-01.yaml`. It uploads to hex-c0.local and reboots as hex-01.
3. Comment the block out again. Re-running gen_tiles.py restores it commented out.
4. In HA, the old `hex-c0` device goes offline. Delete it and adopt `hex-01`, which comes with new entity ids. Then update any dashboards or automations.
