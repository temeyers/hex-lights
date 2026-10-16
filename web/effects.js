/* LOCAL FALLBACK effects. Same names + signature as Back End's tools/effects.js:
   frame(effect, params, tiles, tMs) -> {tileId:[r,g,b]}
   tiles: [{id,q,r,x,y (0..1),ring,angle (degrees 0-360),index,...}]. EFFECTS mirrors effects.json shape. */
(function (g) {
  var EFFECTS = {
    solid: { params: { color: { type: 'color', default: '#ff8a3d' } } },
    breathe: { params: { color: { type: 'color', default: '#5b8def' }, periodS: { type: 'number', min: 0.5, max: 20, default: 4 } } },
    rainbow_sweep: { params: { speed: { type: 'number', min: 0, max: 5, default: 1 }, axis: { type: 'enum', options: ['x', 'y'], default: 'x' } } },
    ripple: { params: { color: { type: 'color', default: '#2dd4bf' }, speed: { type: 'number', min: 0.1, max: 5, default: 1 }, origin: { type: 'tile', default: null } } },
    spiral: { params: { speed: { type: 'number', min: 0, max: 5, default: 1 } } },
    sparkle: { params: { color: { type: 'color', default: '#ffffff' }, density: { type: 'number', min: 0, max: 1, default: 0.3 } } }
  };
  function hex2rgb(h) { if (Object.prototype.toString.call(h) === '[object Array]') return h; h = String(h || '#ffffff').replace('#', ''); if (h.length === 3) h = h.replace(/(.)/g, '$1$1'); var n = parseInt(h, 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function hsv(hh, s, v) { var i = Math.floor(hh * 6), f = hh * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s), m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6]; return [m[0] * 255 | 0, m[1] * 255 | 0, m[2] * 255 | 0]; }
  function sc(c, k) { return [c[0] * k | 0, c[1] * k | 0, c[2] * k | 0]; }
  function rnd(n) { var x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }
  function frame(effect, p, tiles, tMs) {
    p = p || {}; var out = {}, t = tMs / 1000, i, tl, c;
    var maxRing = 1; for (i = 0; i < tiles.length; i++) if (tiles[i].ring > maxRing) maxRing = tiles[i].ring;
    var o = null; if (effect === 'ripple') for (i = 0; i < tiles.length; i++) if (tiles[i].id === p.origin) o = tiles[i];
    for (i = 0; i < tiles.length; i++) {
      tl = tiles[i];
      if (effect === 'solid') c = hex2rgb(p.color);
      else if (effect === 'breathe') c = sc(hex2rgb(p.color), 0.5 - 0.5 * Math.cos(2 * Math.PI * t / (p.periodS || 4)));
      else if (effect === 'rainbow_sweep') c = hsv(((p.axis === 'y' ? tl.y : tl.x) - t * (p.speed || 0) * 0.25 + 10) % 1, 1, 1);
      else if (effect === 'ripple') {
        var d = o ? Math.max(Math.abs(tl.q - o.q), Math.abs(tl.r - o.r), Math.abs(tl.q + tl.r - o.q - o.r)) : tl.ring;
        var ph = (t * (p.speed || 1) * 2) % (maxRing + 4) - d; c = sc(hex2rgb(p.color), Math.max(0, 1 - Math.abs(ph)));
      } else if (effect === 'spiral') c = hsv((tl.angle / 360 + tl.ring / (maxRing + 1) * 0.5 + t * (p.speed || 0) * 0.2) % 1, 1, 1);
      else if (effect === 'sparkle') { var s = Math.floor(t * 8), on = rnd(tl.index * 97 + s) < (p.density == null ? 0.3 : p.density); c = on ? sc(hex2rgb(p.color), 1 - (t * 8 - s)) : [0, 0, 0]; }
      else c = [0, 0, 0];
      out[tl.id || ('#' + tl.index)] = c;
    }
    return out;
  }
  g.LocalEffects = { EFFECTS: EFFECTS, frame: frame };
})(this);
