/* LOCAL FALLBACK effects. Same names + signature as Back End's tools/effects.js:
   frame(effect, params, tiles, tMs) -> {tileId:[r,g,b]}
   tiles: [{id,q,r,x,y (0..1),ring,angle (degrees 0-360),index,...}]. EFFECTS mirrors effects.json shape. */
(function (g) {
  var EFFECTS = {
    solid: { params: { color: { type: 'color', default: '#ff8a3d' } } },
    breathe: { params: { color: { type: 'color', default: '#5b8def' }, periodS: { type: 'number', min: 0.5, max: 20, default: 4 } } },
    rainbow_sweep: { params: { speed: { type: 'number', min: 0.01, max: 5, default: 0.25 }, axis: { type: 'enum', options: ['x', 'y'], default: 'x' }, palette: { type: 'enum', options: ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'], default: 'rainbow' } } },
    ripple: { params: { color: { type: 'color', default: '#2dd4bf' }, speed: { type: 'number', min: 0.1, max: 5, default: 1 }, origin: { type: 'tile', default: null }, palette: { type: 'enum', options: ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'], default: 'mono' } } },
    spiral: { params: { speed: { type: 'number', min: 0.01, max: 5, default: 0.2 }, palette: { type: 'enum', options: ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'], default: 'rainbow' } } },
    sparkle: { params: { color: { type: 'color', default: '#ffffff' }, density: { type: 'number', min: 0, max: 1, default: 0.3 } } },
    chase: { params: { speed: { type: 'number', min: 0.2, max: 20, default: 3 }, tail: { type: 'number', min: 1, max: 10, default: 3 }, palette: { type: 'enum', options: ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'], default: 'rainbow' }, color: { type: 'color', default: [255, 140, 40] } } },
    wipe: { params: { speed: { type: 'number', min: 0.05, max: 5, default: 0.3 }, axis: { type: 'enum', options: ['x', 'y', 'ring', 'angle'], default: 'x' }, palette: { type: 'enum', options: ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'], default: 'rainbow' }, color: { type: 'color', default: [255, 140, 40] } } },
    rainbow_flow: { params: { speed: { type: 'number', min: 0.01, max: 5, default: 0.2 }, scale: { type: 'number', min: 0.1, max: 5, default: 1 }, palette: { type: 'enum', options: ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'], default: 'rainbow' }, color: { type: 'color', default: [255, 140, 40] } } }
  };
  var PALETTES = { rainbow: null, ocean: [[0, 40, 120], [0, 160, 200], [40, 220, 180], [0, 40, 120]], sunset: [[255, 60, 0], [255, 0, 80], [120, 0, 160], [255, 60, 0]],
    forest: [[10, 80, 10], [60, 180, 20], [180, 220, 40], [10, 80, 10]], fire: [[120, 0, 0], [255, 60, 0], [255, 180, 20], [120, 0, 0]], mono: null };
  function pal(name, u, color) {
    color = color || [255, 140, 40]; u = u - Math.floor(u); if (name === 'mono') return hex2rgb(color).slice();
    var st = PALETTES[name]; if (!st) return hsv(u, 1, 1);
    var f = u * (st.length - 1), i = Math.min(Math.floor(f), st.length - 2), w = f - i;
    return [0, 1, 2].map(function (k) { return Math.round(st[i][k] + (st[i + 1][k] - st[i][k]) * w); });
  }
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
      else if (effect === 'rainbow_sweep') c = pal(p.palette || 'rainbow', (p.axis === 'y' ? tl.y : tl.x) + t * (p.speed || 0), p.color);
      else if (effect === 'chase') { var N = tiles.length, hd = (t * (p.speed || 3)) % N, dd = (((hd - (tl.order != null ? tl.order : tl.index)) % N) + N) % N; c = sc(pal(p.palette || 'rainbow', tl.index / N, p.color), Math.max(0, 1 - dd / (p.tail || 3))); }
      else if (effect === 'wipe') { var uu = p.axis === 'ring' ? tl.ring / maxRing : p.axis === 'angle' ? tl.angle / 360 : tl[p.axis || 'x'], wp = (t * (p.speed || 0.3)) % 2; c = (wp < 1 ? uu <= wp : uu > wp - 1) ? pal(p.palette || 'rainbow', uu === 1 ? 0.999 : uu, p.color) : [0, 0, 0]; }
      else if (effect === 'rainbow_flow') c = pal(p.palette || 'rainbow', (tl.x + tl.y) / 2 * (p.scale || 1) - t * (p.speed || 0.2), p.color);
      else if (effect === 'ripple') {
        var d = o ? Math.max(Math.abs(tl.q - o.q), Math.abs(tl.r - o.r), Math.abs(tl.q + tl.r - o.q - o.r)) : tl.ring;
        var ph = (t * (p.speed || 1) * 2) % (maxRing + 4) - d; c = sc(pal(p.palette || 'mono', d / maxRing, p.color), Math.max(0, 1 - Math.abs(ph)));
      } else if (effect === 'spiral') c = pal(p.palette || 'rainbow', (tl.angle + tl.ring * 30) / 360 + t * (p.speed || 0.2), p.color);
      else if (effect === 'sparkle') { var s = Math.floor(t * 8), on = rnd(tl.index * 97 + s) < (p.density == null ? 0.3 : p.density); c = on ? sc(hex2rgb(p.color), 1 - (t * 8 - s)) : [0, 0, 0]; }
      else c = [0, 0, 0];
      out[tl.id || ('#' + tl.index)] = c;
    }
    return out;
  }
  function frameLeds(effect, p, tiles, tMs) { var f = frame(effect, p, tiles, tMs), o = {}; for (var i = 0; i < tiles.length; i++) { var id = tiles[i].id || ('#' + i), a = []; for (var k = 0; k < (tiles[i].leds || 44); k++) a.push(f[id].slice()); o[id] = a; } return o; }
  g.LocalEffects = { EFFECTS: EFFECTS, frame: frame, frameLeds: frameLeds, pal: pal, PALETTES: PALETTES };
})(this);
