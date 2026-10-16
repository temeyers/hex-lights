/* Layout format v1 (agreed with Back End). Canonical file: /workspace/hex-lights/layout.json
   Only serialize/parse/validate live here so the format is easy to swap. ES5, no deps. */
(function (g) {
  var TYPES = ['WS2812'], ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR'];
  function defaults() {
    return { version: 1, name: 'Hex wall', hex: { orientation: 'pointy', sizeMm: 100 },
      led: { pin: 'GPIO4', type: 'WS2812', order: 'GRB', count: 44 }, master: null, tiles: [] };
  }
  function pin(v) { if (typeof v === 'number' || /^\d+$/.test(str(v))) return 'GPIO' + parseInt(v, 10); return str(v).toUpperCase(); }
  function extras(src, known) { var o = {}; for (var k in src) if (src.hasOwnProperty(k) && known.indexOf(k) < 0) o[k] = src[k]; return o; }
  function merge(o, x) { for (var k in x) if (x.hasOwnProperty(k) && !(k in o)) o[k] = x[k]; return o; }
  var TOP = ['version', 'name', 'hex', 'led', 'master', 'tiles'], LEDK = ['pin', 'type', 'order', 'count'], TK = ['id', 'name', 'mac', 'q', 'r', 'rot', 'ledCount', 'rotationDeg', 'order'],
    DERIVED = ['s', 'ring', 'x', 'y', 'angle', 'index', 'isMaster', 'leds', 'neighbors'];
  function int(v, d) { v = parseInt(v, 10); return isNaN(v) ? d : v; }
  function str(v) { return v == null ? '' : String(v).trim(); }
  /* state -> plain object in EXACT format; derived fields (x,y,ring,angle,index,...) are never written */
  function toObject(s) {
    var o = { version: 1, name: str(s.name), hex: { orientation: s.hex.orientation === 'flat' ? 'flat' : 'pointy', sizeMm: Number(s.hex.sizeMm) || 0 },
      led: merge({ pin: pin(s.led.pin), type: s.led.type, order: s.led.order, count: int(s.led.count, 0) }, s.led._x || {}),
      master: s.master || null, tiles: [] };
    for (var i = 0; i < s.tiles.length; i++) {
      var t = s.tiles[i], x = { id: str(t.id) };
      if (str(t.name)) x.name = str(t.name);
      if (str(t.mac)) x.mac = str(t.mac);
      x.q = t.q; x.r = t.r; x.rot = ((int(t.rot, 0) % 6) + 6) % 6;
      if (t.ledCount !== '' && t.ledCount != null && !isNaN(parseInt(t.ledCount, 10))) x.ledCount = int(t.ledCount, 0);
      if (t.rotDeg != null && t.rotDeg !== '' && int(t.rotDeg, 0) !== x.rot * 60) x.rotationDeg = int(t.rotDeg, 0);
      if (t.order != null && t.order !== '') x.order = int(t.order, 0);
      o.tiles.push(merge(x, t._x || {}));
    }
    return merge(o, s._x || {});
  }
  function serialize(s) { return JSON.stringify(toObject(s), null, 2); }
  /* Unknown keys (e.g. led.budgetMa, tile.pin/priority) are kept and written back; derived out/ fields are dropped.
     returns {layout, errors[]} ; throws on unreadable JSON / wrong version */
  function parse(text) {
    var o = typeof text === 'string' ? JSON.parse(text) : text, d = defaults();
    if (!o || o.version !== 1) throw new Error('Unsupported layout version: ' + (o && o.version));
    var h = o.hex || {}, l = o.led || {};
    var s = { version: 1, name: str(o.name || d.name),
      hex: { orientation: h.orientation === 'flat' ? 'flat' : 'pointy', sizeMm: Number(h.sizeMm) || d.hex.sizeMm },
      led: { pin: l.pin == null ? d.led.pin : pin(l.pin), type: l.type || d.led.type, order: l.order || d.led.order, count: int(l.count, d.led.count), _x: extras(l, LEDK) },
      master: o.master == null ? null : String(o.master), tiles: [], _x: extras(o, TOP) };
    var ts = o.tiles || [];
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      s.tiles.push({ id: str(t.id), name: str(t.name), mac: str(t.mac), q: int(t.q, 0), r: int(t.r, 0),
        rot: ((int(t.rot, 0) % 6) + 6) % 6, ledCount: t.ledCount == null ? '' : int(t.ledCount, ''), rotDeg: t.rotationDeg == null ? null : int(t.rotationDeg, null), order: t.order == null ? null : int(t.order, null), _x: extras(t, TK.concat(DERIVED)) });
    }
    return { layout: s, errors: validate(s) };
  }
  /* Hardware runtime layout. rotationDeg (0-359) is optional; absent => rot*60. rot (0-5) stays the canonical
     coarse value and is always written as the nearest 60° step, so tools that only know rot still work. */
  function rotDeg(t) { return t.rotDeg != null && t.rotDeg !== '' ? int(t.rotDeg, 0) : (int(t.rot, 0) % 6) * 60; }
  function order(t, i) { return t.order != null && t.order !== '' ? int(t.order, 0) : i; }
  function rotFromDeg(d) { return Math.round((((d % 360) + 360) % 360) / 60) % 6; }
  var MAXLED = 60; // firmware number.hex_<id>_led_count is 1..60
  var SLUG = /^[a-z0-9][a-z0-9_-]*$/, MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
  /* errors: [{tile:index|null, field, msg}] */
  function validate(s) {
    var e = [], ids = {}, pos = {}, ords = {}, i, t;
    for (i = 0; i < s.tiles.length; i++) {
      t = s.tiles[i];
      if (!t.id) e.push({ tile: i, field: 'id', msg: 'Missing ID' });
      else {
        if (!SLUG.test(t.id) && !MAC.test(t.id)) e.push({ tile: i, field: 'id', msg: 'ID must be a slug (a-z 0-9 - _) or MAC' });
        if (ids[t.id] != null) { e.push({ tile: i, field: 'id', msg: 'Duplicate ID "' + t.id + '"' }); e.push({ tile: ids[t.id], field: 'id', msg: 'Duplicate ID "' + t.id + '"' }); }
        else ids[t.id] = i;
      }
      if (t.ledCount !== '' && t.ledCount != null && !(t.ledCount >= 1 && t.ledCount <= MAXLED)) e.push({ tile: i, field: 'ledCount', msg: 'LED count must be 1-' + MAXLED + ' (firmware limit)' });
      if (!(t.q >= -50 && t.q <= 50 && t.r >= -50 && t.r <= 50)) e.push({ tile: i, field: 'pos', msg: 'Grid q/r must be -50..50' });
      var dg = rotDeg(t); if (!(dg >= 0 && dg <= 359) || dg % 1) e.push({ tile: i, field: 'rotDeg', msg: 'Rotation must be 0-359°' });
      var od = order(t, i); if (!(od >= 0 && od <= 254) || od % 1) e.push({ tile: i, field: 'order', msg: 'Chase order must be 0-254' });
      else if (ords[od] != null) { e.push({ tile: i, field: 'order', msg: 'Duplicate chase order ' + od }); if (!ords['d' + od]) e.push({ tile: ords[od], field: 'order', msg: 'Duplicate chase order ' + od }); ords['d' + od] = 1; }
      else ords[od] = i;
      if (t.mac && !MAC.test(t.mac)) e.push({ tile: i, field: 'mac', msg: 'MAC looks wrong' });
      var k = t.q + ',' + t.r;
      if (pos[k] != null) e.push({ tile: i, field: 'pos', msg: 'Two tiles at ' + k });
      pos[k] = i;
    }
    if (s.tiles.length && !s.master) e.push({ tile: null, field: 'master', msg: 'No master tile chosen' });
    else if (s.master && ids[s.master] == null) e.push({ tile: null, field: 'master', msg: 'Master "' + s.master + '" is not a tile ID' });
    if (!(s.led.count >= 1 && s.led.count <= MAXLED)) e.push({ tile: null, field: 'led', msg: 'LEDs per tile must be 1-' + MAXLED + ' (firmware limit)' });
    if (!/^GPIO\d+$/.test(pin(s.led.pin))) e.push({ tile: null, field: 'led', msg: 'LED pin must look like GPIO<n>' });
    if (TYPES.indexOf(s.led.type) < 0) e.push({ tile: null, field: 'led', msg: 'LED type must be WS2812' });
    if (ORDERS.indexOf(s.led.order) < 0) e.push({ tile: null, field: 'led', msg: 'Unknown colour order' });
    return e;
  }
  g.LayoutFormat = { defaults: defaults, toObject: toObject, serialize: serialize, parse: parse, validate: validate, MAXLED: 60, rotDeg: rotDeg, order: order, rotFromDeg: rotFromDeg, TYPES: TYPES, ORDERS: ORDERS };
})(this);
