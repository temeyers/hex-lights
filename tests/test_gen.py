import copy, json, os, subprocess, sys, pytest
HERE = os.path.dirname(__file__); ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import gen_tiles as g

def lay():
    return g.load_layout(os.path.join(ROOT, "layout.json"))

def test_example_valid_20():
    L = lay(); assert len(L["tiles"]) == 20 and g.validate(L) == []

@pytest.mark.parametrize("mut,msg", [
    (lambda L: L["tiles"].append(dict(L["tiles"][0], q=9)), "duplicate"),
    (lambda L: L["tiles"].append(dict(L["tiles"][1], id="zz")), "already used"),
    (lambda L: L.update(master="nope"), "master"),
    (lambda L: L.update(master=["c0", "r1-e"]), "master"),
    (lambda L: L.update(tiles=[]), "1-64"),
    (lambda L: L.update(tiles=[{"id": f"t{i}", "q": i, "r": 0} for i in range(65)]), "1-64"),
    (lambda L: L["tiles"][0].update(rot=6), "rot"),
    (lambda L: L["tiles"][0].update(id="Bad Id"), "bad tile id"),
    (lambda L: L["hex"].update(orientation="round"), "orientation"),
])
def test_validation_errors(mut, msg):
    L = lay(); mut(L)
    with pytest.raises(g.LayoutError, match=msg): g.validate(L)

def test_island_warns_and_mac_id():
    L = lay(); L["tiles"].append({"id": "AA:BB:CC:00:11:22", "q": 10, "r": 10})
    w = g.validate(L); assert w and "AA:BB:CC:00:11:22" in w[0]
    assert g.norm_id("AA:BB:CC:00:11:22") == "aabbcc001122"

def test_math():
    assert g.hex_distance((0, 0), (2, -1)) == 2 and g.hex_distance((-2, 2), (2, -2)) == 4
    x, y = g.axial_to_xy(1, 0, "pointy"); assert abs(x - 3 ** 0.5) < 1e-9 and y == 0
    x, y = g.axial_to_xy(1, 0, "flat"); assert x == 1.5
    d = g.derive(lay()); t = {t["id"]: t for t in d["tiles"]}
    assert all(0 <= v["x"] <= 1 and 0 <= v["y"] <= 1 and v["s"] == -v["q"] - v["r"] for v in t.values())
    assert t["c0"]["ring"] == 0 and t["r2-a"]["ring"] == 2 and t["r3-a"]["ring"] == 3
    assert t["r1-e"]["angle"] == 0.0 and t["r1-w"]["angle"] == 180.0
    assert sorted(t["c0"]["neighbors"]) == sorted(["r1-e","r1-ne","r1-nw","r1-w","r1-sw","r1-se"])
    assert t["r3-a"]["leds"] == 42 and t["c0"]["leds"] == 44
    for a, v in t.items():
        for n in v["neighbors"]: assert a in t[n]["neighbors"]

def test_generate_check_idempotent(tmp_path):
    (tmp_path / "layout.json").write_text(json.dumps(lay()))
    run = lambda *a: subprocess.run([sys.executable, os.path.join(ROOT, "tools/gen_tiles.py"), "--root", str(tmp_path), *a], capture_output=True, text=True)
    assert run("--check").returncode == 1
    assert run("--secrets-template").returncode == 0
    assert run("--check", "--secrets-template").returncode == 0
    assert not (tmp_path / "esphome/generated").exists()   # off by default
    assert run("--tile-yaml").returncode == 0 and run("--check", "--tile-yaml").returncode == 0
    y = (tmp_path / "esphome/generated/r1-e.yaml").read_text()
    assert "!include ../templates/tile-common.yaml" in y
    for k in ("wifi:", "api:", "ota:", "!secret"): assert k not in y
    s = (tmp_path / "secrets.example.yaml").read_text()
    for k in g.SECRETS_SHARED: assert f"{k}:" in s
    assert "api_key_" not in s
    (tmp_path / "esphome/generated/stale.yaml").write_text("x")
    assert run("--check", "--tile-yaml").returncode == 1 and run("--tile-yaml").returncode == 0 and not (tmp_path / "esphome/generated/stale.yaml").exists()

def test_yaml_layout_accepted(tmp_path):
    import yaml
    p = tmp_path / "layout.yaml"; p.write_text(yaml.safe_dump(lay()))
    assert g.validate(g.load_layout(str(p))) == []

def test_substitution_map():
    import yaml
    d = g.derive(lay()); t = {x["id"]: x for x in d["tiles"]}
    s = g.substitutions(d, t["r1-e"])
    assert s == {"hex_nn": "02", "tile_num": 2, "q": 1, "r": 0, "rotation": 0,
                 "order": 1, "wall_controls_internal": "true", "led_pin": "GPIO13", "sync_pin": "GPIO12", "sync_mode_default": "wireless", "num_leds": 60, "led_count": 44, "static_leader": 0, "leader_priority": 3}
    assert g.substitutions(d, t["c0"])["leader_priority"] == 1
    assert g.substitutions(d, t["r1-e"], pin_leader=True)["static_leader"] == 1
    assert g.substitutions(d, t["r3-a"])["led_count"] == 42 and g.substitutions(d, t["r3-a"])["num_leds"] == 60
    L = lay(); L["led"].update(budgetMa=900, maxScale=0.4); L["tiles"][1]["priority"] = 7
    s = g.substitutions(g.derive(L), g.derive(L)["tiles"][1])
    assert (s["tile_budget_ma"], s["max_scale"], s["leader_priority"]) == (900, 0.4, 7)
    assert "max_scale_pct" not in s
    assert g.light_entity(d, t["r1-e"]) == "light.hex_02_light"

@pytest.mark.parametrize("pin", ["GPIO0", "GPIO3", "GPIO45", "GPIO46", "GPIO19", "GPIO20", "GPIO48", "D4"])
def test_bad_pins(pin):
    L = lay(); L["led"]["pin"] = pin
    with pytest.raises(g.LayoutError): g.validate(L)
    L = lay(); L["tiles"][3]["pin"] = pin
    with pytest.raises(g.LayoutError): g.validate(L)

def test_good_tile_pin():
    L = lay(); L["tiles"][3]["pin"] = "GPIO5"; assert g.validate(L) == []
    assert g.substitutions(g.derive(L), g.derive(L)["tiles"][3])["led_pin"] == "GPIO5"

def test_csv_matches_hardware():
    want = open(os.path.join(ROOT, "esphome/tiles.csv")).read()
    assert g.tiles_csv(lay()) == want

def test_ha_entities():
    import yaml
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    ents = h["light"][0]["entities"]
    assert len(ents) == 20 and "light.hex_01_light" in ents and "light.hex_08_light" in ents
    assert "esphome.hex_01_set_wall_effect" in open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()

def test_master_not_first_warns():
    L = lay(); L["master"] = "r1-e"
    assert any("not the first tile" in w for w in g.validate(L))

def test_led_max_count():
    L = lay(); L["tiles"][2]["rot"] = 3; L["led"]["maxCount"] = 64; d = g.derive(L)
    assert g.substitutions(d, d["tiles"][2])["rotation"] == 180
    assert g.tiles_csv(L).splitlines()[3].endswith(",180")
    s = g.substitutions(d, d["tiles"][0]); assert (s["num_leds"], s["led_count"]) == (64, 44)
    L["led"]["maxCount"] = 10
    with pytest.raises(g.LayoutError, match="maxCount"): g.validate(L)

def test_ha_wall_interface():
    import yaml
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    assert "chase" in h["input_select"]["hex_wall_fx"]["options"]
    assert h["input_number"]["hex_wall_led_count"]["initial"] == 44
    assert h["input_number"]["hex_wall_led_count"]["max"] == 60
    txt = open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()
    assert "number.hex_01_led_count" in txt and "esphome.hex_01_set_wall_fx" in txt

def test_ha_yaml_no_duplicate_keys():
    import yaml
    class U(yaml.SafeLoader): pass
    def m(l, n, deep=False):
        ks = [l.construct_object(k) for k, _ in n.value]
        assert len(ks) == len(set(ks)), [k for k in ks if ks.count(k) > 1]
        return yaml.SafeLoader.construct_mapping(l, n, deep)
    U.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, m)
    for f in ("ha/hex_wall.generated.yaml", "ha/packages/hex_wall.yaml"):
        yaml.load(open(os.path.join(ROOT, f)), U)

def test_rotation_deg_and_order():
    L = lay(); L["tiles"][1].update(rot=2, rotationDeg=45, order=7); L["tiles"][2]["rot"] = 1
    assert g.validate(L) == []
    d = g.derive(L); t = d["tiles"]
    assert (g.substitutions(d, t[1])["rotation"], g.substitutions(d, t[2])["rotation"]) == (45, 60)
    assert (t[1]["order"], t[1]["rotationDeg"], t[3]["order"], t[3]["rotationDeg"]) == (7, 45, 3, 0)
    rows = g.tiles_csv(L).splitlines()
    assert rows[0] == "id,q,r,rot" and rows[2].endswith(",45") and rows[3].endswith(",60")

@pytest.mark.parametrize("field,val", [("rotationDeg", 360), ("rotationDeg", -1), ("rotationDeg", 1.5),
                                       ("rotationDeg", True), ("order", 255), ("order", -1), ("order", "3")])
def test_rotation_order_validation(field, val):
    L = lay(); L["tiles"][0][field] = val
    with pytest.raises(g.LayoutError, match=field): g.validate(L)

def test_ha_rainbow_axes():
    txt = open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()
    assert "ringU" in txt and "angleU" in txt

def test_hexsync_interface_matches_hardware():
    import json, yaml
    import gen_ha
    assert gen_ha.WALL_FX["radial_wave"] == 1 and gen_ha.WALL_FX["pulse"] == 3 and "ripple" not in gen_ha.WALL_FX
    assert gen_ha.FX_ALIASES == {"ripple": "radial_wave", "breathe": "pulse"}
    assert [gen_ha.WALL_FX[n] for n in ("random_ripple", "twinkle", "color_cycle", "snake")] == [7, 8, 9, 10]
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    assert set(gen_ha.WALL_FX) <= set(h["input_select"]["hex_wall_fx"]["options"])
    assert h["input_select"]["hex_wall_axis"]["options"] == ["x", "y", "ring", "angle"]
    n = h["input_number"]["hex_wall_led_count"]; assert (n["min"], n["max"], n["initial"]) == (1, 60, 44)
    txt = open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()
    assert "select.hex_01_wall_wipe_axis" in txt and "10000] | min" in txt
    cat = json.load(open(os.path.join(ROOT, "effects.json")))
    fo = {e["name"] for e in cat["effects"] if e.get("firmwareOnly")}
    assert fo == {"random_ripple", "twinkle", "color_cycle", "snake"}
    tpl = open(os.path.join(ROOT, "esphome/templates/tile-common.yaml")).read()
    if "set_wall_fx" in tpl:   # Hardware's template present: names must line up
        for k in ("effect", "palette", "speed", "scale", "hue", "saturation", "value", "start_delay_ms"):
            assert f"{k}: int" in tpl

def test_wall_fx_axis_arg():
    import yaml, gen_ha
    L = lay(); d = g.derive(L)
    off = gen_ha.render(d, g.node, g.light_entity)
    assert "select.hex_01_wall_wipe_axis" in off.split("hex_wall_led_count_apply")[0].split("hex_wall_fx_apply")[1]
    assert "axis: " not in off.split("hex_wall_fx_apply:")[1].split("hex_wall_led_count_apply")[0]
    L["ha"] = {"wallFxAxisArg": True}; d = g.derive(L)
    on = gen_ha.render(d, g.node, g.light_entity)
    block = on.split("hex_wall_fx_apply:")[1].split("hex_wall_led_count_apply")[0]
    assert "axis: \"{{ {'x': 0, 'y': 1, 'ring': 2, 'angle': 3}.get(states('input_select.hex_wall_axis'), 0) }}\"" in block
    assert "select.select_option" not in block
    yaml.safe_load(on)

def test_csv_order_opt_in(tmp_path):
    L = lay(); L["tiles"][2]["order"] = 9
    assert g.tiles_csv(L).splitlines()[0] == "id,q,r,rot"
    rows = g.tiles_csv(L, with_order=True).splitlines()
    assert rows[0] == "id,q,r,rot,order" and rows[3].endswith(",9") and rows[1].endswith(",0,")
    (tmp_path / "layout.json").write_text(json.dumps(L))
    run = lambda *a: subprocess.run([sys.executable, os.path.join(ROOT, "tools/gen_tiles.py"), "--root", str(tmp_path), *a], capture_output=True, text=True)
    assert run("--emit-csv", "c.csv").returncode == 0 and "order" not in (tmp_path / "c.csv").read_text()
    assert run("--emit-csv", "c.csv", "--csv-order").returncode == 0
    assert (tmp_path / "c.csv").read_text().startswith("id,q,r,rot,order")

def test_sync_pin_validation():
    L = lay(); assert g.validate(L) == []
    assert g.substitutions(g.derive(L), g.derive(L)["tiles"][0])["sync_pin"] == "GPIO12"
    L["led"]["syncPin"] = L["led"]["pin"]
    with pytest.raises(g.LayoutError, match="collides"): g.validate(L)
    L = lay(); L["tiles"][2]["pin"] = "GPIO12"
    with pytest.raises(g.LayoutError, match="sync pin"): g.validate(L)
    L = lay(); L["led"]["syncPin"] = "GPIO48"
    with pytest.raises(g.LayoutError, match="sync.pin"): g.validate(L)

def test_sync_key_canonical():
    import gen_ha
    L = lay(); L["led"]["syncPin"] = "GPIO11"; L["sync"] = {"mode": "jumper", "pin": "GPIO10"}
    assert g.validate(L) == [] and g.sync_pin_of(L) == "GPIO10"
    d = g.derive(L); assert g.substitutions(d, d["tiles"][0])["sync_pin"] == "GPIO10"
    del L["sync"]["pin"]; assert g.sync_pin_of(L) == "GPIO11"       # legacy fallback
    del L["led"]["syncPin"]; assert g.sync_pin_of(L) == "GPIO12"    # default
    out = gen_ha.render(g.derive(L), g.node, g.light_entity)
    assert 'option: "Jumper wire"' in out.split("hex_wall_sync_mode_apply_layout:")[1].split("hex_wall_fx_apply")[0]
    L["sync"] = {}
    out = gen_ha.render(g.derive(L), g.node, g.light_entity)
    assert 'option: "Wireless (ESP-NOW)"' in out.split("hex_wall_sync_mode_apply_layout:")[1].split("hex_wall_fx_apply")[0]
    for bad, msg in [({"mode": "wire"}, "sync.mode"), ({"pin": "GPIO13"}, "collides"), ({"pin": "GPIO19"}, "sync.pin")]:
        L = lay(); L["sync"] = bad
        with pytest.raises(g.LayoutError, match=msg): g.validate(L)
    L = lay(); L["sync"] = {"pin": "GPIO5"}; L["tiles"][1]["pin"] = "GPIO5"
    with pytest.raises(g.LayoutError, match="sync pin"): g.validate(L)

def test_sync_mode_ha():
    import yaml, gen_ha
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    a = next(x for x in h["automation"] if x["id"] == "hex_wall_sync_jumper_lost")
    ents = a["triggers"][0]["entity_id"]
    assert len(ents) == 20 and "sensor.hex_02_sync_source" in ents
    assert a["triggers"][0]["to"] == "jumper-lost"
    assert a["conditions"][0] == {"condition": "state", "entity_id": "select.hex_01_sync_mode", "state": "Jumper wire"}
    assert a["actions"][0]["action"] == "notify.notify"
    L = lay(); L["ha"] = {"notifyService": "notify.mobile_app_terry"}
    assert "action: notify.mobile_app_terry" in gen_ha.render(g.derive(L), g.node, g.light_entity)
    tpl = open(os.path.join(ROOT, "esphome/templates/tile-common.yaml")).read()
    for name in ("name: Sync source", "name: Sync pulse jitter", "name: Sync pulse offset", "name: Sync mode",
                 '"Wireless (ESP-NOW)", "Jumper wire"'):
        assert name in tpl, name
    cpp = open(os.path.join(ROOT, "esphome/components/hexsync/hexsync.cpp")).read()
    assert '"jumper-lost"' in cpp
    dash = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall_dashboard.generated.yaml")))
    txt = json.dumps(dash)
    assert "select.hex_01_sync_mode" in txt and "sensor.hex_08_sync_pulse_jitter" in txt and "sensor.hex_01_sync_pulse_offset" in txt

@pytest.mark.parametrize("pin", ["GPIO22", "GPIO30", "GPIO37"])
def test_flash_pins_rejected(pin):
    L = lay(); L["led"]["pin"] = pin
    with pytest.raises(g.LayoutError): g.validate(L)
    L = lay(); L["sync"] = {"pin": pin}
    with pytest.raises(g.LayoutError): g.validate(L)

def test_gpio21_and_38_ok():
    for pin in ("GPIO21", "GPIO38"):
        L = lay(); L["sync"] = {"pin": pin}; assert g.validate(L) == []

def test_print_hw_args(tmp_path):
    L = lay()
    assert g.hw_args(L) == "--sync-pin GPIO12 --sync-mode wireless"
    L["sync"] = {"mode": "jumper", "pin": "GPIO11"}
    (tmp_path / "layout.json").write_text(json.dumps(L))
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools/gen_tiles.py"), "--root", str(tmp_path), "--print-hw-args"],
                       capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout.strip() == "--sync-pin GPIO11 --sync-mode jumper"
    assert not (tmp_path / "out").exists()   # prints only, writes nothing
    d = g.derive(L); assert g.substitutions(d, d["tiles"][0])["sync_mode_default"] == "jumper"

def test_hex_nn_names():
    import yaml, gen_ha
    d = g.derive(lay()); t = {x["id"]: x for x in d["tiles"]}
    assert (g.node(d, t["c0"]), g.node(d, t["r1-e"]), g.node(d, t["r3-a"])) == ("hex_01", "hex_02", "hex_20")
    assert g.device_name(d, t["r3-a"]) == "hex-20" and g.light_entity(d, t["r2-a"]) == "light.hex_08_light"
    assert g.substitutions(d, t["c0"])["wall_controls_internal"] == "false"
    txt = open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()
    assert "hex_c0" not in txt and "esphome.hex_01_set_wall_fx" in txt and "light.hex_20_light" in txt
    dash = open(os.path.join(ROOT, "ha/hex_wall_dashboard.generated.yaml")).read()
    assert "binary_sensor.hex_05_sync_leader" in dash and "select.hex_01_sync_mode" in dash
    I = gen_ha.INTERFACE
    assert I["hex_layout_action"] == "esphome.{master}_set_hex_layout" and I["layout_bulk_action"].endswith("_set_layout_bulk")
    tpl = open(os.path.join(ROOT, "esphome/templates/tile-common.yaml")).read()
    if "hex_nn" in tpl:   # Hardware 9b55813 names
        for k in ("name: hex-${hex_nn}", "- action: set_hex_layout", "hex_num: int", "- action: set_layout_bulk",
                  "- action: set_wall_fx", "name: Sync leader", "name: Wall wipe axis", "name: Sync mode"):
            assert k in tpl, k
        assert "Sync leader (this tile)" not in tpl

def test_brightness_and_current_limit():
    import yaml
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    n = h["input_number"]["hex_wall_max_brightness"]
    assert (n["min"], n["max"], n["initial"]) == (0, 100, 100)
    assert "hex_wall_current_limit" in h["input_boolean"]
    sc = h["script"]
    b = json.dumps(sc["hex_wall_max_brightness_apply"]); c = json.dumps(sc["hex_wall_current_limit_apply"])
    assert "number.hex_01_max_brightness" in b and "number.hex_20_max_brightness" in b and "has_value" in b
    assert "switch.hex_07_current_limit" in c and "switch.turn_on" in c and "switch.turn_off" in c
    ids = {a["id"] for a in h["automation"]}
    assert {"hex_wall_max_brightness_changed", "hex_wall_current_limit_changed"} <= ids
    dash = open(os.path.join(ROOT, "ha/hex_wall_dashboard.generated.yaml")).read()
    assert "number.hex_03_max_brightness" in dash and "switch.hex_03_current_limit" in dash
    tpl = open(os.path.join(ROOT, "esphome/templates/tile-common.yaml")).read()
    if "name: Max brightness" in tpl:
        assert "name: Current limit" in tpl
    for f in ("esphome/generated",):
        pass

def test_displayed_color_editor_and_recorder():
    import yaml
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    grp = h["group"]["hex_wall_displayed_colors"]["entities"]
    assert len(grp) == 20 and grp[0] == "sensor.hex_01_displayed_color" and grp[-1] == "sensor.hex_20_displayed_color"
    assert "hex_wall_light_rgb" not in h["group"]
    dash = open(os.path.join(ROOT, "ha/hex_wall_dashboard.generated.yaml")).read()
    assert "sensor.hex_12_displayed_color" in dash and "light_rgb" not in dash
    rows = yaml.safe_load(dash)["views"][0]["cards"][-1]["entities"]
    assert rows[11] == {"type": "attribute", "entity": "light.hex_12_light", "attribute": "rgb_color", "name": "Hex 12"}
    ent = json.load(open(os.path.join(ROOT, "out/ha_entities.json")))
    assert ent["tiles"]["r1-e"]["displayedColor"] == "sensor.hex_02_displayed_color" and ent["tiles"]["c0"]["hexNN"] == "01"
    assert ent["groups"] == {"displayedColor": "group.hex_wall_displayed_colors"}
    assert ent["tiles"]["r1-e"]["lightRgb"] == {"entity": "light.hex_02_light", "attribute": "rgb_color"}
    rec = yaml.safe_load(open(os.path.join(ROOT, "ha/packages/hex_wall_recorder.yaml")))
    assert rec == {"recorder": {"exclude": {"entity_globs": ["sensor.hex_*_displayed_color"]}}}
    # main packages must not also define recorder (duplicate-key conflict in HA packages)
    for f in ("ha/hex_wall.generated.yaml", "ha/packages/hex_wall.yaml"):
        assert "recorder" not in yaml.safe_load(open(os.path.join(ROOT, f)))

def test_light_color_palette_removed_manual_color():
    import yaml, gen_ha
    assert "light color" not in gen_ha.PALETTES and len(gen_ha.PALETTES) == 6
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    assert "light color" not in h["input_select"]["hex_wall_palette"]["options"]
    assert h["input_boolean"]["hex_wall_manual_color"]["initial"] is False
    c = json.dumps(h["script"]["hex_wall_manual_color_apply"])
    assert "switch.hex_01_manual_color" in c and "has_value" in c
    assert h["script"]["hex_wall_manual_color_apply"]["variables"]["targets"] == ["switch.hex_01_manual_color"]
    assert gen_ha.INTERFACE["manual_color_switch"] == "switch.{master}_manual_color"
    assert any(a["id"] == "hex_wall_manual_color_changed" for a in h["automation"])
    dash = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall_dashboard.generated.yaml")))
    cards = dash["views"][0]["cards"]
    wall = cards[0]["entities"]; cond = cards[1]
    assert "input_boolean.hex_wall_manual_color" in wall
    assert not {"input_select.hex_wall_fx", "input_select.hex_wall_palette", "input_select.hex_wall_axis",
                "input_number.hex_wall_speed"} & set(wall)
    assert cond["type"] == "conditional" and cond["conditions"][0]["state_not"] == "on"
    assert cond["card"]["entities"] == ["input_select.hex_wall_fx", "input_select.hex_wall_palette",
                                        "input_select.hex_wall_axis", "input_number.hex_wall_speed"]

def test_no_empty_dicts_in_packages():
    """HA package merge drops empty dicts (selector {color_rgb: {}} -> {})."""
    import yaml
    def walk(o, path):
        if isinstance(o, dict):
            assert o or path.endswith("variables"), f"empty mapping at {path}"
            for k, v in o.items(): walk(v, f"{path}.{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o): walk(v, f"{path}[{i}]")
    for f in ("ha/hex_wall.generated.yaml", "ha/packages/hex_wall.yaml", "ha/packages/hex_wall_recorder.yaml"):
        walk(yaml.safe_load(open(os.path.join(ROOT, f))), f)

def test_no_axial_ids_user_facing():
    """Terry's naming rule: users only ever see 'Hex NN', never tile ids like c0 / r2-a."""
    import re, yaml
    ids = {str(t["id"]) for t in lay()["tiles"]}
    pat = re.compile(r"(?<![\w-])(" + "|".join(re.escape(i) for i in sorted(ids, key=len, reverse=True)) + r")(?![\w-])")
    INTERNAL = ("variables", "sequence", "entity_id", "entity", "entities", "target", "triggers", "conditions",
                "actions", "id", "action", "data", "attribute", "path")
    hits = []
    def walk(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in INTERNAL:
                    continue
                walk(v, f"{path}.{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{path}[{i}]")
        elif isinstance(o, str) and pat.search(o):
            hits.append((path, o))
    for f in ("ha/hex_wall.generated.yaml", "ha/packages/hex_wall.yaml",
              "ha/hex_wall_dashboard.generated.yaml", "ha/packages/hex_wall_recorder.yaml"):
        walk(yaml.safe_load(open(os.path.join(ROOT, f))), f)
    assert hits == []
    # the notification text is user-facing even though it sits under actions
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    for a in h["automation"]:
        for act in a["actions"]:
            for k in ("title", "message"):
                v = (act.get("data") or {}).get(k, "")
                assert not pat.search(v), (a["id"], v)
    o = h["script"]["hex_wall_ripple"]["fields"]["origin"]
    assert o["selector"]["select"]["options"][0] == "Hex 01" and o["selector"]["select"]["options"][-1] == "Hex 20"
    assert o["default"] == "Hex 01" and o["example"] == "Hex 01"
    assert "selectattr('nn', 'eq', origin" in h["script"]["hex_wall_ripple"]["variables"]["o"]

def test_no_empty_selector_configs():
    """HA rejects selectors whose config is an empty map ({color_rgb: {}}, {text: {}}); emit null."""
    import yaml
    bad = []
    def walk(o, path):
        if isinstance(o, dict):
            if "selector" in o and isinstance(o["selector"], dict):
                for typ, conf in o["selector"].items():
                    if isinstance(conf, dict) and not conf:
                        bad.append(f"{path}.selector.{typ}")
            for k, v in o.items(): walk(v, f"{path}.{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o): walk(v, f"{path}[{i}]")
    for f in ("ha/hex_wall.generated.yaml", "ha/packages/hex_wall.yaml"):
        walk(yaml.safe_load(open(os.path.join(ROOT, f))), f)
    assert bad == []
    import gen_ha
    assert json.loads(gen_ha.fields_yaml({"c": gen_ha._rgb("x", [1, 2, 3]), "t": gen_ha._txt("y")})) == {
        "c": {"description": "x", "example": "1, 2, 3", "default": [1, 2, 3], "selector": {"color_rgb": None}},
        "t": {"description": "y", "example": "", "selector": {"text": None}}}
