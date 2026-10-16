#!/usr/bin/env python3
"""Generate per-tile ESPHome configs, layout/neighbor JSON and the HA package
from layout.json (or layout.yaml with the same shape). Stdlib + PyYAML."""
import argparse, json, math, os, re, sys
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
MAC = re.compile(r"^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$")
DIRS = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
# Shared secret names used by Hardware's esphome/templates/tile-common.yaml
SECRETS_SHARED = ["wifi_ssid", "wifi_password", "fallback_ap_password", "ota_password", "api_key"]
# Tile configs live next to Hardware's esphome/tiles/ so the template's relative
# paths (external_components: ../components) resolve the same way.
TILE_DIR = "esphome/generated"
DEFAULT_PACKAGE = "../templates/tile-common.yaml"
BAD_PINS = {0: "strapping", 3: "strapping", 45: "strapping", 46: "strapping",
            19: "USB", 20: "USB", 48: "onboard RGB LED"}
PIN = re.compile(r"^GPIO(\d+)$")
DEFAULT_PREFIX = "hex"


class LayoutError(ValueError):
    pass


def load_layout(path):
    with open(path) as f:
        return json.load(f) if path.endswith(".json") else yaml.safe_load(f)


def hex_distance(a, b):
    dq, dr = a[0] - b[0], a[1] - b[1]
    return (abs(dq) + abs(dr) + abs(dq + dr)) // 2


def axial_to_xy(q, r, orientation):
    s3 = math.sqrt(3)
    if orientation == "pointy":
        return s3 * (q + r / 2), 1.5 * r
    return 1.5 * q, s3 * (q / 2 + r)


def norm_id(i):
    """Slug ids stay as-is; MAC ids become a slug (aabbccddeeff)."""
    if MAC.match(i):
        return re.sub(r"[:-]", "", i).lower()
    return i


def check_pin(pin, where):
    m = PIN.match(str(pin))
    if not m:
        raise LayoutError(f"{where} must look like GPIO<n>, got {pin!r}")
    n = int(m.group(1))
    if n in BAD_PINS:
        raise LayoutError(f"{where} GPIO{n} is not allowed on the S3 Super Mini ({BAD_PINS[n]})")


def validate(lay):
    """Raise LayoutError on errors; return list of warnings."""
    warns = []
    if not isinstance(lay, dict):
        raise LayoutError("layout must be a mapping")
    if lay.get("version") != 1:
        raise LayoutError("version must be 1")
    hx = lay.get("hex") or {}
    if hx.get("orientation") not in ("pointy", "flat"):
        raise LayoutError("hex.orientation must be pointy|flat")
    led = lay.get("led") or {}
    for k in ("pin", "count"):
        if k not in led:
            raise LayoutError(f"led.{k} is required")
    if not isinstance(led["count"], int) or led["count"] < 1:
        raise LayoutError("led.count must be a positive int")
    check_pin(led["pin"], "led.pin")
    if "budgetMa" in led and (not isinstance(led["budgetMa"], int) or led["budgetMa"] < 1):
        raise LayoutError("led.budgetMa must be a positive int")
    if "maxScale" in led and not (isinstance(led["maxScale"], (int, float)) and 0 < led["maxScale"] <= 1):
        raise LayoutError("led.maxScale must be in (0, 1]")
    tiles = lay.get("tiles")
    if not isinstance(tiles, list) or not 1 <= len(tiles) <= 64:
        raise LayoutError("tiles must be a list of 1-64 tiles")
    ids, coords = set(), {}
    for t in tiles:
        i = str(t.get("id", ""))
        if not (SLUG.match(i) or MAC.match(i)):
            raise LayoutError(f"bad tile id {i!r} (slug or MAC)")
        if norm_id(i) in ids:
            raise LayoutError(f"duplicate tile id {i}")
        ids.add(norm_id(i))
        q, r = t.get("q"), t.get("r")
        if not isinstance(q, int) or not isinstance(r, int):
            raise LayoutError(f"tile {i}: q and r must be ints")
        if (q, r) in coords:
            raise LayoutError(f"tile {i}: coordinate ({q},{r}) already used by {coords[(q, r)]}")
        coords[(q, r)] = i
        rot = t.get("rot", 0)
        if not isinstance(rot, int) or not 0 <= rot <= 5:
            raise LayoutError(f"tile {i}: rot must be 0-5")
        if "ledCount" in t and (not isinstance(t["ledCount"], int) or t["ledCount"] < 1):
            raise LayoutError(f"tile {i}: ledCount must be a positive int")
        if "pin" in t:
            check_pin(t["pin"], f"tile {i}: pin")
        if "priority" in t and not isinstance(t["priority"], int):
            raise LayoutError(f"tile {i}: priority must be an int")
        if t.get("mac") and not MAC.match(str(t["mac"])):
            raise LayoutError(f"tile {i}: bad mac")
    m = lay.get("master")
    if isinstance(m, list) or m is None:
        raise LayoutError("exactly one master tile id is required")
    if m not in {str(t["id"]) for t in tiles}:
        raise LayoutError(f"master {m!r} is not a tile id")
    # reachability from master
    start = next((q, r) for (q, r), i in coords.items() if i == m)
    seen, todo = {start}, [start]
    while todo:
        q, r = todo.pop()
        for dq, dr in DIRS:
            n = (q + dq, r + dr)
            if n in coords and n not in seen:
                seen.add(n); todo.append(n)
    islands = sorted(coords[c] for c in coords if c not in seen)
    if islands:
        warns.append("tiles not reachable from master as neighbors (island): " + ", ".join(islands))
    return warns


def derive(lay):
    """Return the layout with derived per-tile fields (out/layout.json)."""
    ori = lay["hex"]["orientation"]
    tiles = lay["tiles"]
    coords = {(t["q"], t["r"]): str(t["id"]) for t in tiles}
    mt = next(t for t in tiles if str(t["id"]) == lay["master"])
    mc = (mt["q"], mt["r"])
    raw = {str(t["id"]): axial_to_xy(t["q"], t["r"], ori) for t in tiles}
    xs = [p[0] for p in raw.values()]; ys = [p[1] for p in raw.values()]
    def nrm(v, lo, hi):
        return 0.5 if hi - lo < 1e-9 else (v - lo) / (hi - lo)
    mx, my = raw[str(mt["id"])]
    out = []
    for idx, t in enumerate(tiles):
        i = str(t["id"]); q, r = t["q"], t["r"]
        px, py = raw[i]
        ang = 0.0 if (q, r) == mc else math.degrees(math.atan2(py - my, px - mx)) % 360
        d = dict(t)
        d.setdefault("rot", 0)
        d.update(
            s=-q - r, ring=hex_distance((q, r), mc),
            x=round(nrm(px, min(xs), max(xs)), 4), y=round(nrm(py, min(ys), max(ys)), 4),
            angle=round(ang, 2), index=idx, isMaster=(i == lay["master"]),
            leds=t.get("ledCount", lay["led"]["count"]),
            neighbors=[coords[(q + dq, r + dr)] for dq, dr in DIRS if (q + dq, r + dr) in coords],
        )
        out.append(d)
    res = {k: v for k, v in lay.items() if k != "tiles"}
    res["led"] = {"type": "WS2812", "order": "GRB", **lay["led"]}
    res["tiles"] = out
    return res


def device_name(lay, t):
    """Hardware's template sets esphome name: hex-${tile_id}."""
    return f"hex-{norm_id(str(t['id']))}"


def node(lay, t):
    return device_name(lay, t).replace("-", "_")


def light_entity(lay, t):
    """Template light is `name: Light` -> light.<node>_light."""
    return f"light.{node(lay, t)}_light"


def substitutions(lay, t):
    """Exactly the substitution names Hardware's template consumes."""
    led = lay["led"]
    master = next(x for x in lay["tiles"] if x["isMaster"])
    subs = {
        "tile_id": norm_id(str(t["id"])),
        "tile_num": t["index"] + 1,          # 1..N in layout order (hexsync id)
        "q": t["q"], "r": t["r"],
        "rotation": t["rot"],
        "led_pin": t.get("pin", led["pin"]),
        "num_leds": t["leds"],
        "static_leader": master["index"] + 1,
    }
    if "priority" in t:
        subs["leader_priority"] = t["priority"]   # else template default: ${tile_num}
    if "budgetMa" in led:
        subs["tile_budget_ma"] = led["budgetMa"]  # else template default 1200
    if "maxScale" in led:                          # else template default 0.55 / 55%
        subs["max_scale"] = led["maxScale"]
        subs["max_scale_pct"] = f"{round(led['maxScale'] * 100)}%"
    return subs


def tile_yaml(lay, t):
    lines = ["# GENERATED by tools/gen_tiles.py from layout.json - do not edit.", "substitutions:"]
    lines += [f"  {k}: {json.dumps(str(v))}" for k, v in substitutions(lay, t).items()]
    pkg = lay.get("package", DEFAULT_PACKAGE)
    lines += ["", "packages:", f"  tile: !include {pkg}", ""]
    return "\n".join(lines)


def secret_keys(lay):
    return list(SECRETS_SHARED)


def secrets_template(lay):
    lines = ["# Copy to secrets.yaml (gitignored) next to the tile configs and fill in.",
             "# Keys used by esphome/templates/tile-common.yaml:"]
    lines += [f"#   - {k}" for k in SECRETS_SHARED]
    lines += [f'{k}: "CHANGE_ME"' for k in SECRETS_SHARED[:4]]
    lines += ['api_key: "CHANGE_ME_32_byte_base64_key="']
    return "\n".join(lines) + "\n"


def tiles_csv(lay):
    """Hardware's esphome/tiles.csv format (id,q,r,rot), rows in tile_num order."""
    rows = ["id,q,r,rot"] + [f"{t['id']},{t['q']},{t['r']},{t.get('rot', 0)}" for t in lay["tiles"]]
    return "\n".join(rows) + "\n"


def build_outputs(lay):
    """Return {relative_path: text} for every generated file."""
    d = derive(lay)
    files = {}
    for t in d["tiles"]:
        files[f"{TILE_DIR}/{norm_id(str(t['id']))}.yaml"] = tile_yaml(d, t)
    files["out/layout.json"] = json.dumps(d, indent=2) + "\n"
    files["out/neighbors.json"] = json.dumps({str(t["id"]): t["neighbors"] for t in d["tiles"]}, indent=2) + "\n"
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import gen_ha
    files["ha/hex_wall.generated.yaml"] = gen_ha.render(d, node, light_entity)
    return files


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--layout", default=None, help="layout.json or layout.yaml (default: repo root)")
    ap.add_argument("--root", default=ROOT, help="output root (default: repo root)")
    ap.add_argument("--check", action="store_true", help="fail if outputs are stale; write nothing")
    ap.add_argument("--secrets-template", action="store_true", help="also write secrets.example.yaml")
    ap.add_argument("--emit-csv", nargs="?", const="out/tiles.csv", metavar="PATH",
                    help="also write Hardware's tiles.csv format (default out/tiles.csv)")
    a = ap.parse_args(argv)
    path = a.layout or next(p for p in (os.path.join(a.root, "layout.json"), os.path.join(a.root, "layout.yaml"))
                            if os.path.exists(p) or p.endswith(".yaml"))
    lay = load_layout(path)
    try:
        warns = validate(lay)
    except LayoutError as e:
        print(f"error: {e}", file=sys.stderr); return 2
    for w in warns:
        print(f"warning: {w}", file=sys.stderr)
    files = build_outputs(lay)
    if a.secrets_template:
        files["secrets.example.yaml"] = secrets_template(lay)
    if a.emit_csv:
        files[a.emit_csv] = tiles_csv(lay)
    stale = []
    for rel, text in sorted(files.items()):
        p = os.path.join(a.root, rel)
        cur = open(p).read() if os.path.exists(p) else None
        if cur != text:
            stale.append(rel)
            if not a.check:
                os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
                with open(p, "w") as f:
                    f.write(text)
    # stale per-tile files from removed tiles
    od = os.path.join(a.root, TILE_DIR)
    extra = [f"{TILE_DIR}/{f}" for f in (os.listdir(od) if os.path.isdir(od) else [])
             if f.endswith(".yaml") and f != "secrets.yaml" and f"{TILE_DIR}/{f}" not in files]
    if a.check:
        if stale or extra:
            print("stale: " + ", ".join(stale + extra), file=sys.stderr); return 1
        print("up to date"); return 0
    for e in extra:
        os.remove(os.path.join(a.root, e))
    print(f"wrote {len(stale)} file(s), removed {len(extra)}, {len(files)} total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
