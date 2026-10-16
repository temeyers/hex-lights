"""Render ha/hex_wall.generated.yaml (light group + coordinate-driven effect
scripts). The math mirrors tools/effects.js / effects.json, sampled every
`step` seconds with a matching light transition."""
import json

EFFECTS = ["solid", "breathe", "rainbow_sweep", "ripple", "spiral", "sparkle"]

# ---- Firmware interface: ALL names in one spot (PROPOSED to Hardware, 2026-10-16).
# Override any key with layout.json "ha": {...}. {node} = hex_NN (tiles.csv row, 01 = master), {master} = master node.
INTERFACE = {
    "light": "light.{node}_light",                 # template: light name "Light"
    "led_count_number": "number.{node}_led_count",  # per-tile runtime LED count (proposed)
    "fx_action": "esphome.{master}_set_wall_fx",    # proposed v2 action on any tile
    "legacy_action": "esphome.{master}_set_wall_effect",  # existing action
    "layout_bulk_action": "esphome.{master}_set_layout_bulk",
    "hex_layout_action": "esphome.{master}_set_hex_layout",  # (hex_num, q, r, rotation, order)
    "sync_leader_binary": "binary_sensor.{node}_sync_leader",
    # Hardware 85cf36d: per-tile runtime ceiling (0-100 %, restored) and 1200 mA budget switch
    "max_brightness_number": "number.{node}_max_brightness",
    "current_limit_switch": "switch.{node}_current_limit",
    # Hardware-confirmed: text_sensor "Displayed color" '#RRGGBB' @1-2 Hz
    "displayed_color_sensor": "sensor.{node}_displayed_color",
    # light RGB readback = rgb_color attribute of the tile light (no separate sensor)
    "light_rgb_attribute": "rgb_color",
    "light_effect": "HexSync",
    # master-only firmware entities (Hardware df1ad9b); the service above stays the primary path
    "wall_speed_number": "number.{master}_wall_speed",      # 0..10000 milli-cycles/s
    "wall_effect_select": "select.{master}_wall_effect",
    "wall_palette_select": "select.{master}_wall_palette",
    "wall_axis_select": "select.{master}_wall_wipe_axis",  # x|y|ring|angle
    # true once Hardware's firmware with set_wall_fx(..., axis) is flashed (axis then REQUIRED):
    # pass axis (0 x, 1 y, 2 ring, 3 angle) on the service call and skip the select.
    "wallFxAxisArg": False,
    # Sync mode (Hardware d3aeb8b): select on the master only (internal on other tiles)
    "sync_mode_select": "select.{master}_sync_mode",
    "sync_mode_wireless": "Wireless (ESP-NOW)",
    "sync_mode_jumper": "Jumper wire",
    # per-tile diagnostics; sync_source states: "espnow" | "jumper" | "jumper-lost"
    "sync_source_sensor": "sensor.{node}_sync_source",
    "sync_jitter_sensor": "sensor.{node}_sync_pulse_jitter",
    "sync_offset_sensor": "sensor.{node}_sync_pulse_offset",
    "sync_lost_state": "jumper-lost",
    "notifyService": "notify.notify",
}
LED_COUNT_RANGE = (1, 60)          # firmware number range
MAX_START_DELAY_MS = 10000         # firmware cap
# our name -> HexSync id (firmware names: 1 radial_wave, 3 pulse; 7-10 firmware-only)
# Firmware effect names exactly as hexsync FX_NAMES (input_select.hex_wall_fx options).
WALL_FX = {"solid": 0, "radial_wave": 1, "rainbow_sweep": 2, "pulse": 3,
           "chase": 4, "wipe": 5, "rainbow_flow": 6, "random_ripple": 7,
           "twinkle": 8, "color_cycle": 9, "snake": 10}
# our effects.json names -> firmware names
FX_ALIASES = {"ripple": "radial_wave", "breathe": "pulse"}
AXES = ["x", "y", "ring", "angle"]
PALETTES = ["rainbow", "ocean", "sunset", "forest", "fire", "mono", "light color"]  # ids 0-6 (Hardware 7dfa536)


def _num(desc, lo, hi, step, default, unit=None):
    sel = {"number": {"min": lo, "max": hi, "step": step, "mode": "box"}}
    if unit:
        sel["number"]["unit_of_measurement"] = unit
    return {"description": desc, "example": str(default), "default": default, "selector": sel}


def _rgb(desc, default):
    return {"description": desc, "example": ", ".join(map(str, default)), "default": list(default),
            "selector": {"color_rgb": {}}}


def _sel(desc, options, default):
    return {"description": desc, "example": default, "default": default,
            "selector": {"select": {"options": list(options)}}}


def _txt(desc, example=""):
    return {"description": desc, "example": example, "selector": {"text": {}}}


def fields_yaml(fields):
    """HA script `fields:` as a one-line JSON (valid YAML) mapping."""
    return json.dumps(fields, separators=(", ", ": "))


def render(d, node, light_entity):
    tiles = d["tiles"]
    ents = [light_entity(d, t) for t in tiles]
    master = next(t for t in tiles if t["isMaster"])
    action = f"esphome.{node(d, master)}_set_wall_effect"
    data = [{"e": light_entity(d, t), "id": str(t["id"]), "x": t["x"], "y": t["y"], "q": t["q"],
             "r": t["r"], "ring": t["ring"], "angle": t["angle"], "i": t["index"],
             "ringU": round(t["ring"] / max(1, max(x["ring"] for x in tiles)), 4),
             "angleU": round(t["angle"] / 360, 4)} for t in tiles]
    tj = json.dumps(data, separators=(",", ":"))
    J = json.dumps
    loop = "{{ is_state('input_select.hex_wall_effect', '%s') }}"
    def stop_others(me):
        return J({"action": "script.turn_off", "target": {"entity_id": [f"script.hex_wall_{e}" for e in EFFECTS if e != me]}})
    hue_loop = lambda name, hue_expr: f"""
  hex_wall_{name}:
    alias: Hex wall {name.replace('_', ' ')}
    mode: restart
    fields: {fields_yaml(dict(speed=_num("cycles/s (see effects.json)", 0, 5, 0.01, 0.25 if name == 'rainbow_sweep' else 0.2, "cycles/s"), step=_num("seconds per update", 0.2, 10, 0.1, 1, "s"), **({"axis": _sel("sweep axis", AXES, "x")} if name == 'rainbow_sweep' else {})))}
    variables:
      tiles: {tj}
      sp: "{{{{ speed | default({0.25 if name == 'rainbow_sweep' else 0.2}) | float }}}}"
      dt: "{{{{ step | default(1) | float }}}}"
      ax: "{{{{ axis | default('x') }}}}"
    sequence:
      - {stop_others(name)}
      - variables: {{t0: "{{{{ as_timestamp(now()) }}}}"}}
      - repeat:
          while: "{loop % name}"
          sequence:
            - variables: {{t: "{{{{ as_timestamp(now()) - t0 + dt }}}}"}}
            - repeat:
                for_each: "{{{{ tiles }}}}"
                sequence:
                  - action: light.turn_on
                    target: {{entity_id: "{{{{ repeat.item.e }}}}"}}
                    data:
                      transition: "{{{{ dt }}}}"
                      brightness: 255
                      hs_color: ["{{{{ ({hue_expr}) % 360 }}}}", 100]
            - delay: {{seconds: "{{{{ dt }}}}"}}"""
    out = f"""# GENERATED by tools/gen_tiles.py from layout.json - do not edit.
# Home Assistant package: copy (or symlink) next to ha/packages/hex_wall.yaml.
# Light entities follow esphome/templates/tile-common.yaml (name: Light) -> light.hex_<id>_light.
# Synced (ESP-NOW HexSync) effects go through {action} on the master tile.
light:
  - platform: group
    name: Hex Wall
    unique_id: hex_wall_all
    entities:
{chr(10).join('      - ' + e for e in ents)}

script:
  hex_wall_synced:
    alias: Hex wall synced effect (HexSync, ESP-NOW)
    mode: restart
    fields: {fields_yaml(dict(effect=_sel("HA effect name (mapped to HexSync id)", ["solid", "ripple", "rainbow_sweep", "breathe"], "solid"), hue=_num("0-255", 0, 255, 1, 18), saturation=_num("0-255", 0, 255, 1, 215), value=_num("0-255", 0, 255, 1, 255), speed=_num("milli-cycles per second", 0, 10000, 10, 500), scale=_num("tiles per cycle x100", 1, 2000, 1, 300)))}
    variables:
      codes: {{solid: 0, ripple: 1, rainbow_sweep: 2, breathe: 3}}
    sequence:
      - {J({"action": "script.turn_off", "target": {"entity_id": [f"script.hex_wall_{e}" for e in EFFECTS]}})}
      - action: {action}
        data:
          effect: "{{{{ codes[effect] }}}}"
          hue: "{{{{ hue | default(18) | int }}}}"
          saturation: "{{{{ saturation | default(215) | int }}}}"
          value: "{{{{ value | default(255) | int }}}}"
          speed: "{{{{ speed | default(500) | int }}}}"
          scale: "{{{{ scale | default(300) | int }}}}"
      - action: light.turn_on
        target: {{entity_id: light.hex_wall}}
        data: {{effect: HexSync}}

  hex_wall_tile_pulse:
    alias: Hex wall tile pulse (internal)
    mode: parallel
    max: 128
    fields: {fields_yaml(dict(entity={"description": "tile light", "example": "light.hex_01_light", "selector": {"entity": {"domain": "light"}}}, delay_ms=_num("delay before the pulse", 0, 60000, 1, 0, "ms"), color=_rgb("pulse colour", [40, 120, 255]), up_s=_num("fade-in", 0, 10, 0.05, 0.5, "s"), down_s=_num("fade-out", 0, 10, 0.05, 0.5, "s")))}
    sequence:
      - delay: {{milliseconds: "{{{{ delay_ms | int }}}}"}}
      - action: light.turn_on
        target: {{entity_id: "{{{{ entity }}}}"}}
        data: {{rgb_color: "{{{{ color }}}}", brightness: 255, transition: "{{{{ up_s }}}}"}}
      - delay: {{seconds: "{{{{ up_s }}}}"}}
      - action: light.turn_on
        target: {{entity_id: "{{{{ entity }}}}"}}
        data: {{brightness: 1, transition: "{{{{ down_s }}}}"}}

  hex_wall_solid:
    alias: Hex wall solid color
    mode: restart
    fields: {fields_yaml(dict(color=_rgb("wall colour", [255, 140, 40])))}
    sequence:
      - {stop_others('solid')}
      - action: light.turn_on
        target: {{entity_id: light.hex_wall}}
        data: {{effect: None, rgb_color: "{{{{ color | default([255,140,40]) }}}}", brightness: 255, transition: 1}}

  hex_wall_breathe:
    alias: Hex wall breathe
    mode: restart
    fields: {fields_yaml(dict(color=_rgb("breathe colour", [255, 140, 40]), periodS=_num("breath period", 0.5, 30, 0.5, 4, "s")))}
    variables:
      c: "{{{{ color | default([255,140,40]) }}}}"
      half: "{{{{ (periodS | default(4) | float) / 2 }}}}"
    sequence:
      - {stop_others('breathe')}
      - repeat:
          while: "{loop % 'breathe'}"
          sequence:
            - action: light.turn_on
              target: {{entity_id: light.hex_wall}}
              data: {{rgb_color: "{{{{ c }}}}", brightness: 255, transition: "{{{{ half }}}}"}}
            - delay: {{seconds: "{{{{ half }}}}"}}
            - action: light.turn_on
              target: {{entity_id: light.hex_wall}}
              data: {{brightness: 1, transition: "{{{{ half }}}}"}}
            - delay: {{seconds: "{{{{ half }}}}"}}
{hue_loop('rainbow_sweep', "repeat.item[{'ring': 'ringU', 'angle': 'angleU'}.get(ax, ax)] * 360 + t * sp * 360")}
{hue_loop('spiral', "repeat.item.angle + repeat.item.ring * 30 + t * sp * 360")}

  hex_wall_ripple:
    alias: Hex wall ripple
    mode: restart
    fields: {fields_yaml(dict(color=_rgb("ripple colour", [40, 120, 255]), speed=_num("rings per second", 0.1, 10, 0.1, 2, "rings/s"), origin=_sel("ripple origin tile id (default: master)", [str(t["id"]) for t in tiles], str(master["id"]))))}
    variables:
      tiles: {tj}
      c: "{{{{ color | default([40,120,255]) }}}}"
      sp: "{{{{ speed | default(2) | float }}}}"
      o: "{{{{ (tiles | selectattr('id', 'eq', origin | default('{master['id']}')) | list + [tiles[{master['index']}]])[0] }}}}"
      dists: >-
        {{%- set ns = namespace(d=[]) -%}}
        {{%- for tt in tiles -%}}
        {{%- set dq = tt.q - o.q -%}}{{%- set dr = tt.r - o.r -%}}
        {{%- set ns.d = ns.d + [((dq | abs) + (dr | abs) + ((dq + dr) | abs)) // 2] -%}}
        {{%- endfor -%}}{{{{ ns.d }}}}
      period: "{{{{ ((dists | max) + 2) / sp }}}}"
    sequence:
      - {stop_others('ripple')}
      - action: light.turn_on
        target: {{entity_id: light.hex_wall}}
        data: {{rgb_color: "{{{{ c }}}}", brightness: 1}}
      - repeat:
          while: "{loop % 'ripple'}"
          sequence:
            - repeat:
                for_each: "{{{{ tiles }}}}"
                sequence:
                  - action: script.turn_on
                    target: {{entity_id: script.hex_wall_tile_pulse}}
                    data:
                      variables:
                        entity: "{{{{ repeat.item.e }}}}"
                        delay_ms: "{{{{ (dists[repeat.index - 1] / sp * 1000) | int }}}}"
                        color: "{{{{ c }}}}"
                        up_s: "{{{{ 1 / sp }}}}"
                        down_s: "{{{{ 1 / sp }}}}"
            - delay: {{seconds: "{{{{ period }}}}"}}

  hex_wall_sparkle:
    alias: Hex wall sparkle
    mode: restart
    fields: {fields_yaml(dict(color=_rgb("sparkle colour", [255, 255, 255]), density=_num("fraction of tiles lit per step", 0, 1, 0.01, 0.15), step=_num("seconds per update", 0.1, 10, 0.1, 0.5, "s")))}
    variables:
      tiles: {tj}
      c: "{{{{ color | default([255,255,255]) }}}}"
      dens: "{{{{ density | default(0.15) | float }}}}"
      dt: "{{{{ step | default(0.5) | float }}}}"
    sequence:
      - {stop_others('sparkle')}
      - repeat:
          while: "{loop % 'sparkle'}"
          sequence:
            - repeat:
                for_each: "{{{{ tiles }}}}"
                sequence:
                  - action: light.turn_on
                    target: {{entity_id: "{{{{ repeat.item.e }}}}"}}
                    data:
                      rgb_color: "{{{{ c }}}}"
                      transition: "{{{{ dt / 2 }}}}"
                      brightness: "{{{{ 255 if range(1000) | random < dens * 1000 else 1 }}}}"
            - delay: {{seconds: "{{{{ dt }}}}"}}
"""
    out += wall_block(d, node, master)
    return "\n".join(l.rstrip() for l in out.splitlines() if l.strip() != "") + "\n"


def wall_block(d, node, master):
    I = {**INTERFACE, **(d.get("ha") or {})}
    J = json.dumps
    mnode = node(d, master)
    fx_action = I["fx_action"].format(master=mnode)
    axis_sel = I["wall_axis_select"].format(master=mnode)
    if I["wallFxAxisArg"]:
        amap = "{" + ", ".join(f"'{a}': {i}" for i, a in enumerate(AXES)) + "}"
        axis_arg = ("\n          axis: \"{{ " + amap
                    + ".get(states('input_select.hex_wall_axis'), 0) }}\"")
        axis_select = ""
    else:
        axis_arg = ""
        axis_select = f"""
      - if: "{{{{ has_value('{axis_sel}') }}}}"
        then:
          - action: select.select_option
            continue_on_error: true
            target: {{entity_id: {axis_sel}}}
            data: {{option: "{{{{ states('input_select.hex_wall_axis') }}}}"}}"""
    numbers = [I["led_count_number"].format(node=node(d, t)) for t in d["tiles"]]
    per_tile = {I["led_count_number"].format(node=node(d, t)): t["leds"] for t in d["tiles"]
                if "ledCount" in t}
    eff = I["light_effect"]
    tn = [node(d, t) for t in d["tiles"]]
    want_mode = I["sync_mode_jumper"] if (d.get("sync") or {}).get("mode") == "jumper" else I["sync_mode_wireless"]
    src = [I["sync_source_sensor"].format(node=n) for n in tn]
    mode_sel = I["sync_mode_select"].format(master=mnode)
    sync_auto = f"""
  - id: hex_wall_sync_jumper_lost
    alias: Hex wall - jumper sync lost
    mode: single
    max_exceeded: silent
    triggers:
      - trigger: state
        entity_id: {J(src)}
        to: {J(I["sync_lost_state"])}
        for: {{seconds: 15}}
    conditions:
      - condition: state
        entity_id: {mode_sel}
        state: {J(I["sync_mode_jumper"])}
    actions:
      - action: {I["notifyService"]}
        data:
          title: Hex wall sync
          message: >-
            {{{{ state_attr(trigger.entity_id, 'friendly_name') or trigger.entity_id }}}} lost the
            jumper-wire sync pulse (falling back to the ESP-NOW clock). Check the GPIO12 wire.
      - delay: {{minutes: 10}}
"""
    mb = [I["max_brightness_number"].format(node=n) for n in tn]
    cl = [I["current_limit_switch"].format(node=n) for n in tn]
    limit_scripts = f"""
  hex_wall_max_brightness_apply:
    alias: Hex wall push max brightness to tiles
    variables:
      targets: {J(mb)}
      v: "{{{{ states('input_number.hex_wall_max_brightness') | int(100) }}}}"
    sequence:
      - repeat:
          for_each: "{{{{ targets | select('has_value') | list }}}}"
          sequence:
            - action: number.set_value
              continue_on_error: true
              target: {{entity_id: "{{{{ repeat.item }}}}"}}
              data: {{value: "{{{{ v }}}}"}}
  hex_wall_current_limit_apply:
    alias: Hex wall push current limit to tiles
    variables:
      targets: {J(cl)}
    sequence:
      - variables:
          live: "{{{{ targets | select('has_value') | list }}}}"
      - if: "{{{{ live | length > 0 }}}}"
        then:
          - if: "{{{{ is_state('input_boolean.hex_wall_current_limit', 'on') }}}}"
            then:
              - action: switch.turn_on
                target: {{entity_id: "{{{{ live }}}}"}}
            else:
              - action: switch.turn_off
                target: {{entity_id: "{{{{ live }}}}"}}
"""
    limit_autos = """
  - id: hex_wall_max_brightness_changed
    alias: Hex wall - max brightness changed
    mode: restart
    triggers:
      - trigger: state
        entity_id: input_number.hex_wall_max_brightness
    actions:
      - delay: {seconds: 1}
      - action: script.hex_wall_max_brightness_apply
  - id: hex_wall_current_limit_changed
    alias: Hex wall - current limit changed
    mode: restart
    triggers:
      - trigger: state
        entity_id: input_boolean.hex_wall_current_limit
    actions:
      - action: script.hex_wall_current_limit_apply
"""
    sync_script = limit_scripts + f"""
  hex_wall_sync_mode_apply_layout:
    alias: Hex wall set sync mode from layout.json ({want_mode})
    sequence:
      - action: select.select_option
        target: {{entity_id: {mode_sel}}}
        data: {{option: {J(want_mode)}}}
"""
    return f"""{sync_script}
  hex_wall_fx_apply:
    alias: Hex wall apply synced effect
    mode: restart
    variables:
      fx_ids: {J(WALL_FX)}
      pal_ids: {J({p: i for i, p in enumerate(PALETTES)})}
      fx: "{{{{ states('input_select.hex_wall_fx') }}}}"
    sequence:
      - if: "{{{{ fx == 'off' }}}}"
        then:
          - action: light.turn_off
            target: {{entity_id: light.hex_wall}}
          - stop: "off"
      - action: {fx_action}
        continue_on_error: true
        data:
          effect: "{{{{ fx_ids[fx] }}}}"
          palette: "{{{{ pal_ids[states('input_select.hex_wall_palette')] }}}}"
          speed: "{{{{ [[(states('input_number.hex_wall_speed') | float(1) * 1000) | int, 0] | max, 10000] | min }}}}"
          scale: 100
          hue: 18
          saturation: 215
          value: 255
          start_delay_ms: {min(300, MAX_START_DELAY_MS)}{axis_arg}{axis_select}
      - action: light.turn_on
        target: {{entity_id: light.hex_wall}}
        data: {{effect: {eff}}}
  hex_wall_led_count_apply:
    alias: Hex wall push LED count to tiles
    variables:
      targets: {J(numbers)}
      overrides: {J(per_tile)}
      n: "{{{{ states('input_number.hex_wall_led_count') | int(44) }}}}"
    sequence:
      - repeat:
          for_each: "{{{{ targets | select('has_value') | list }}}}"
          sequence:
            - action: number.set_value
              target: {{entity_id: "{{{{ repeat.item }}}}"}}
              data: {{value: "{{{{ overrides.get(repeat.item, n) }}}}"}}
# ---- Whole-wall (HexSync v2) effects. Interface names: tools/gen_ha.py INTERFACE.
input_select:
  hex_wall_fx:
    name: Hex wall synced effect
    options: {J(["off"] + list(WALL_FX))}
    initial: "off"
  hex_wall_palette:
    name: Hex wall palette
    options: {J(PALETTES)}
    initial: rainbow
  hex_wall_axis:
    name: Hex wall wipe/sweep axis
    options: {J(AXES)}
    initial: x
input_number:
  hex_wall_speed:
    name: Hex wall speed
    min: 0
    max: 10
    step: 0.05
    initial: 1
    mode: slider
  hex_wall_max_brightness:
    name: Hex wall max brightness
    min: 0
    max: 100
    step: 1
    initial: 100
    unit_of_measurement: "%"
    mode: slider
  hex_wall_led_count:
    name: Hex wall LEDs per tile
    min: {LED_COUNT_RANGE[0]}
    max: {min(LED_COUNT_RANGE[1], d["led"].get("maxCount", d["led"]["count"]))}
    step: 1
    initial: {d["led"]["count"]}
    mode: box

automation:
  - id: hex_wall_fx_changed
    alias: Hex wall - synced effect / palette / speed changed
    mode: restart
    triggers:
      - trigger: state
        entity_id: [input_select.hex_wall_fx, input_select.hex_wall_palette, input_select.hex_wall_axis, input_number.hex_wall_speed]
    actions:
      - delay: {{milliseconds: 300}}
      - action: script.hex_wall_fx_apply
  - id: hex_wall_led_count_changed
    alias: Hex wall - LED count changed
    mode: restart
    triggers:
      - trigger: state
        entity_id: input_number.hex_wall_led_count
    actions:
      - delay: {{seconds: 1}}
      - action: script.hex_wall_led_count_apply
{sync_auto}{limit_autos}
group:
  hex_wall_displayed_colors:
    name: Hex wall displayed colours
    entities: {J([I["displayed_color_sensor"].format(node=n) for n in tn])}

input_boolean:
  hex_wall_current_limit:
    name: Hex wall current limit (1200 mA per tile)
    initial: false
"""


def render_dashboard(d, node):
    """Lovelace dashboard (YAML mode) with wall controls + per-tile sync diagnostics."""
    I = {**INTERFACE, **(d.get("ha") or {})}
    master = next(t for t in d["tiles"] if t["isMaster"])
    m = node(d, master)
    rows = []
    for t in d["tiles"]:
        n = node(d, t)
        rows.append({"type": "glance", "title": f"Hex {n[4:]} ({t.get('name') or t['id']})", "show_name": True,
                     "entities": [{"entity": I["sync_source_sensor"].format(node=n), "name": "Source"},
                                  {"entity": I["sync_jitter_sensor"].format(node=n), "name": "Jitter"},
                                  {"entity": I["sync_offset_sensor"].format(node=n), "name": "Offset"},
                                  {"entity": I["sync_leader_binary"].format(node=n), "name": "Leader"},
                                  {"entity": I["max_brightness_number"].format(node=n), "name": "Max %"},
                                  {"entity": I["current_limit_switch"].format(node=n), "name": "Limit"},
                                  {"entity": I["displayed_color_sensor"].format(node=n), "name": "Shown"}]})
    dash = {"title": "Hex Wall", "views": [{"title": "Wall", "path": "hex-wall", "cards": [
        {"type": "entities", "title": "Wall", "entities": [
            "light.hex_wall", "input_select.hex_wall_fx", "input_select.hex_wall_palette",
            "input_select.hex_wall_axis", "input_number.hex_wall_speed", "input_number.hex_wall_led_count",
            "input_number.hex_wall_max_brightness", "input_boolean.hex_wall_current_limit",
            I["sync_mode_select"].format(master=m)]},
        {"type": "vertical-stack", "cards": rows},
        {"type": "entities", "title": "Light RGB readback (rgb_color)", "entities": [
            {"type": "attribute", "entity": I["light"].format(node=node(d, t)), "attribute": I["light_rgb_attribute"],
             "name": f"Hex {node(d, t)[4:]}"} for t in d["tiles"]]}]}]}
    return "# GENERATED by tools/gen_tiles.py from layout.json - do not edit.\n" + json.dumps(dash, indent=1) + "\n"


def render_editor_entities(d, node):
    """out/ha_entities.json: per-tile HA entity ids for the layout editor."""
    I = {**INTERFACE, **(d.get("ha") or {})}
    tiles = {}
    for t in d["tiles"]:
        n = node(d, t)
        tiles[str(t["id"])] = {"node": n, "hexNN": n[4:],
                               "light": I["light"].format(node=n),
                               "displayedColor": I["displayed_color_sensor"].format(node=n),
                               "lightRgb": {"entity": I["light"].format(node=n),
                                            "attribute": I["light_rgb_attribute"]},
                               "maxBrightness": I["max_brightness_number"].format(node=n),
                               "syncSource": I["sync_source_sensor"].format(node=n)}
    return json.dumps({"groups": {"displayedColor": "group.hex_wall_displayed_colors"},
                       "tiles": tiles}, indent=2) + "\n"


def render_recorder(d, node):
    I = {**INTERFACE, **(d.get("ha") or {})}
    g = lambda k: I[k].format(node="hex_*")
    return f"""# GENERATED by tools/gen_tiles.py - do not edit.
# Separate package so it can be dropped if configuration.yaml (or another package)
# already defines recorder: exclude: - HA packages can't merge a duplicate 'exclude'
# key. In that case add these globs to your existing recorder: exclude: entity_globs.
recorder:
  exclude:
    entity_globs:
      - {g("displayed_color_sensor")}
"""
