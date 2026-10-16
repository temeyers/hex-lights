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
    assert s == {"tile_id": "r1-e", "tile_num": 2, "q": 1, "r": 0, "rotation": 0,
                 "led_pin": "GPIO4", "num_leds": 60, "led_count": 44, "static_leader": 0, "leader_priority": 3}
    assert g.substitutions(d, t["c0"])["leader_priority"] == 1
    assert g.substitutions(d, t["r1-e"], pin_leader=True)["static_leader"] == 1
    assert g.substitutions(d, t["r3-a"])["led_count"] == 42 and g.substitutions(d, t["r3-a"])["num_leds"] == 60
    L = lay(); L["led"].update(budgetMa=900, maxScale=0.4); L["tiles"][1]["priority"] = 7
    s = g.substitutions(g.derive(L), g.derive(L)["tiles"][1])
    assert (s["tile_budget_ma"], s["max_scale"], s["max_scale_pct"], s["leader_priority"]) == (900, 0.4, "40%", 7)
    assert g.light_entity(d, t["r1-e"]) == "light.hex_r1_e_light"

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
    assert len(ents) == 20 and "light.hex_c0_light" in ents and "light.hex_r2_a_light" in ents
    assert "esphome.hex_c0_set_wall_effect" in open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()

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
    assert "number.hex_c0_led_count" in txt and "esphome.hex_c0_set_wall_fx" in txt

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
    assert gen_ha.WALL_FX["ripple"] == 1 and gen_ha.WALL_FX["breathe"] == 3
    assert [gen_ha.WALL_FX[n] for n in ("random_ripple", "twinkle", "color_cycle", "snake")] == [7, 8, 9, 10]
    h = yaml.safe_load(open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")))
    assert set(gen_ha.WALL_FX) <= set(h["input_select"]["hex_wall_fx"]["options"])
    assert h["input_select"]["hex_wall_axis"]["options"] == ["x", "y", "ring", "angle"]
    n = h["input_number"]["hex_wall_led_count"]; assert (n["min"], n["max"], n["initial"]) == (1, 60, 44)
    txt = open(os.path.join(ROOT, "ha/hex_wall.generated.yaml")).read()
    assert "select.hex_c0_wall_wipe_axis" in txt and "10000] | min" in txt
    cat = json.load(open(os.path.join(ROOT, "effects.json")))
    fo = {e["name"] for e in cat["effects"] if e.get("firmwareOnly")}
    assert fo == {"random_ripple", "twinkle", "color_cycle", "snake"}
    tpl = open(os.path.join(ROOT, "esphome/templates/tile-common.yaml")).read()
    if "set_wall_fx" in tpl:   # Hardware's template present: names must line up
        for k in ("effect", "palette", "speed", "scale", "hue", "saturation", "value", "start_delay_ms"):
            assert f"{k}: int" in tpl
