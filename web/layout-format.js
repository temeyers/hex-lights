/* Layout format v1 (agreed with Back End). Canonical file: /workspace/hex-lights/layout.json
   Only serialize/parse/validate live here so the format is easy to swap. ES5, no deps. */
(function (g) {
  var TYPES = ['WS2812'], ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR'];
  function defaults() {
    return { version: 1, name: 'Hex wall', hex: { orientation: 'pointy', sizeMm: 100 },
      led: { pin: 16, type: 'WS2812', order: 'GRB', count: 30 }, master: null, tiles: [] };
  }
  function int(v, d) { v = parseInt(v, 10); return isNaN(v) ? d : v; }
  function str(v) { return v == null ? '' : String(v).trim(); }
  /* state -> plain object in EXACT format; derived fields (x,y,ring,angle,index,...) are never written */
  function toObject(s) {
    var o = { version: 1, name: str(s.name), hex: { orientation: s.hex.orientation === 'flat' ? 'flat' : 'pointy', sizeMm: Number(s.hex.sizeMm) || 0 },
      led: { pin: int(s.led.pin, 0), type: s.led.type, order: s.led.order, count: int(s.led.count, 0) },
      master: s.master || null, tiles: [] };
    for (var i = 0; i < s.tiles.length; i++) {
      var t = s.tiles[i], x = { id: str(t.id) };
      if (str(t.name)) x.name = str(t.name);
      if (str(t.mac)) x.mac = str(t.mac);
      x.q = t.q; x.r = t.r; x.rot = ((int(t.rot, 0) % 6) + 6) % 6;
      if (t.ledCount !== '' && t.ledCount != null && !isNaN(parseInt(t.ledCount, 10))) x.ledCount = int(t.ledCount, 0);
      o.tiles.push(x);
    }
    return o;
  }
  function serialize(s) { return JSON.stringify(toObject(s), null, 2); }
  /* returns {layout, errors[]} ; throws on unreadable JSON / wrong version */
  function parse(text) {
    var o = typeof text === 'string' ? JSON.parse(text) : text, d = defaults();
    if (!o || o.version !== 1) throw new Error('Unsupported layout version: ' + (o && o.version));
    var h = o.hex || {}, l = o.led || {};
    var s = { version: 1, name: str(o.name || d.name),
      hex: { orientation: h.orientation === 'flat' ? 'flat' : 'pointy', sizeMm: Number(h.sizeMm) || d.hex.sizeMm },
      led: { pin: int(l.pin, d.led.pin), type: l.type || d.led.type, order: l.order || d.led.order, count: int(l.count, d.led.count) },
      master: o.master == null ? null : String(o.master), tiles: [] };
    var ts = o.tiles || [];
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      s.tiles.push({ id: str(t.id), name: str(t.name), mac: str(t.mac), q: int(t.q, 0), r: int(t.r, 0),
        rot: ((int(t.rot, 0) % 6) + 6) % 6, ledCount: t.ledCount == null ? '' : int(t.ledCount, '') });
    }
    return { layout: s, errors: validate(s) };
  }
  var SLUG = /^[a-z0-9][a-z0-9_-]*$/, MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
  /* errors: [{tile:index|null, field, msg}] */
  function validate(s) {
    var e = [], ids = {}, pos = {}, i, t;
    for (i = 0; i < s.tiles.length; i++) {
      t = s.tiles[i];
      if (!t.id) e.push({ tile: i, field: 'id', msg: 'Missing ID' });
      else {
        if (!SLUG.test(t.id) && !MAC.test(t.id)) e.push({ tile: i, field: 'id', msg: 'ID must be a slug (a-z 0-9 - _) or MAC' });
        if (ids[t.id] != null) { e.push({ tile: i, field: 'id', msg: 'Duplicate ID "' + t.id + '"' }); e.push({ tile: ids[t.id], field: 'id', msg: 'Duplicate ID "' + t.id + '"' }); }
        else ids[t.id] = i;
      }
      if (t.mac && !MAC.test(t.mac)) e.push({ tile: i, field: 'mac', msg: 'MAC looks wrong' });
      var k = t.q + ',' + t.r;
      if (pos[k] != null) e.push({ tile: i, field: 'pos', msg: 'Two tiles at ' + k });
      pos[k] = i;
    }
    if (s.tiles.length && !s.master) e.push({ tile: null, field: 'master', msg: 'No master tile chosen' });
    else if (s.master && ids[s.master] == null) e.push({ tile: null, field: 'master', msg: 'Master "' + s.master + '" is not a tile ID' });
    if (TYPES.indexOf(s.led.type) < 0) e.push({ tile: null, field: 'led', msg: 'LED type must be WS2812' });
    if (ORDERS.indexOf(s.led.order) < 0) e.push({ tile: null, field: 'led', msg: 'Unknown colour order' });
    return e;
  }
  g.LayoutFormat = { defaults: defaults, toObject: toObject, serialize: serialize, parse: parse, validate: validate, TYPES: TYPES, ORDERS: ORDERS };
})(this);
