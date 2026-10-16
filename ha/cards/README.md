# Quins Room Hex cards

- `hex-layout-card.js` – our honeycomb card (`/config/www/hex-layout-card/`, resource `?v=4`).
  Tap a hex = make it the panel target (`input_select.hex_wall_target`; tap the selected hex again = All),
  double-tap = on/off, hold = more-info. The selected hex is outlined in white; the `⏻` chip toggles the target.
  Fill/glow come from `sensor.hex_NN_displayed_color` (normalized), falling back to the light colour.
- `quins_room_hex_cards.yaml` – the control panel. It only uses package entities:
  - `input_select.hex_wall_target` – All + every flashed Hex NN (refreshed by `automation.hex_wall_target_options`).
  - `light.hex_target` – brightness/colour of the target (All = `light.hex_wall`).
  - `switch.hex_target_manual_color` – manual colour on the target (All = every tile's switch).
  - `input_select.hex_wall_fx` / `_palette` / `_axis`, `input_number.hex_wall_speed` – applied to the target by
    `script.hex_wall_fx_apply`; re-synced from the target when it changes (guarded by `input_boolean.hex_wall_syncing`).

Adding Hex 03..20: flash the tile, place it in the layout card's editor. No card edits.
