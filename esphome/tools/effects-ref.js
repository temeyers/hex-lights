// Reference of hexsync v2 effect math (mirrors components/hexsync/hexsync.cpp pixel_/render).
// Front End can use it for the preview. Pure functions; output [r,g,b] 0..255.
// tiles: [{id, q, r, order}] (live layout). P: {effect, palette, speed (mc/s), scale (x100),
// hue, sat, value (0-255), axis (0 x,1 y,2 ring,3 angle), seed (u32)}. tMs = clock - start_ms (>=0).
const STOPS = [null,
  [[0,40,120],[0,160,200],[40,220,180],[0,40,120]],   // ocean
  [[255,60,0],[255,0,80],[120,0,160],[255,60,0]],     // sunset
  [[10,80,10],[60,180,20],[180,220,40],[10,80,10]],   // forest
  [[120,0,0],[255,60,0],[255,180,20],[120,0,0]]];     // fire
const frac = x => x - Math.floor(x);
function hsv(h, s, v) { h = frac(h / 360) * 6; const i = Math.floor(h), f = h - i;
  const p = v*(1-s), q = v*(1-s*f), t = v*(1-s*(1-f));
  const [r,g,b] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6];
  return [r,g,b].map(c => Math.round(c * 255)); }
function pal(id, u, hue, sat) { u = frac(u);
  if (id === 0) return hsv(u * 360, 1, 1);
  if (id === 5 || !STOPS[id]) return hsv(hue * 360 / 255, sat / 255, 1);
  const seg = u * 3, i = Math.min(2, Math.floor(seg)), f = seg - i, a = STOPS[id][i], b = STOPS[id][i+1];
  return a.map((x, k) => Math.round(x + (b[k] - x) * f)); }
const scaleC = (c, k) => c.map(x => Math.round(x * Math.min(1, Math.max(0, k))));
const hash01 = (a, b) => (((Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) >>> 0) % 1000003) / 1000003;
const hexd = (q1, r1, q2, r2) => (Math.abs(q1-q2) + Math.abs(r1-r2) + Math.abs(q1-q2+r1-r2)) / 2;
const fmod = (a, b) => a - b * Math.trunc(a / b);   // C fmodf

const LED_R = 0.85, SQ3 = Math.sqrt(3), SPIRAL = 0.5;
// chase/snake comet: travels LED-by-LED through tiles in chase order (index*n + led), speed in tiles/s
function chaseK(ts, spd, sc, idx, count, led, n) {
  const total = count * n, hg = fmod(ts * spd * n, total), d = fmod(hg - (idx * n + led) + total, total);
  const tail = Math.max(2, Math.min(n, n * 0.25 * Math.max(sc, 0.04)));
  return d < tail ? 1 - d / tail : 0; }

// Returns {tileId: [[r,g,b] x ledCount]}. T.rot (deg) optional. Per-LED geometry: LED i sits on the
// tile ring at angle 2*pi*i/n + rot, so every effect also animates within a lone tile.
function frame(P, tiles, tMs, ledCount = 44) {
  tiles = [...tiles].sort((a, b) => a.id - b.id);
  const xy = t => [SQ3 * (t.q + t.r / 2), 1.5 * t.r];
  const xs = tiles.map(t => xy(t)[0]), ys = tiles.map(t => xy(t)[1]);
  const minx = Math.min(...xs) - 1, maxx = Math.max(...xs) + 1, miny = Math.min(...ys) - 1, maxy = Math.max(...ys) + 1;
  const maxRing = Math.max(...tiles.map(t => hexd(t.q, t.r, 0, 0))), maxRingW = maxRing + 1;
  const count = Math.max(tiles.length, Math.max(...tiles.map(t => t.order)) + 1);
  let diam = 0; for (const a of tiles) for (const b of tiles) diam = Math.max(diam, hexd(a.q, a.r, b.q, b.r));
  const spd = P.speed / 1000, sc = P.scale / 100, seed = P.seed >>> 0, s16 = seed & 0xffff;
  let ts = Math.max(0, tMs) / 1000, ox = 0, oy = 0, maxOd = 1;
  if (P.effect === 7) {                        // random_ripple
    const per = diam + 3, cyc = ts * spd / per, k = Math.floor(cyc);
    const o = tiles[Math.floor(hash01(seed, k) * tiles.length) % tiles.length];
    [ox, oy] = xy(o); maxOd = Math.max(...tiles.map(t => hexd(o.q, o.r, t.q, t.r))) + 1;
    if (spd > 0) ts = frac(cyc) * per / spd;
  }
  const head = Math.floor(fmod(ts * spd, count));
  const headT = tiles.find(t => t.order === head);
  const out = {}, n = ledCount;
  for (const T of tiles) {
    const [cx, cy] = xy(T), idx = T.order, leds = [];
    const headD = headT ? hexd(T.q, T.r, headT.q, headT.r) : 99;
    for (let led = 0; led < n; led++) {
      const lf = led / n, th = 2 * Math.PI * lf + (T.rot || 0) * Math.PI / 180;
      const px = cx + LED_R * Math.cos(th), py = cy + LED_R * Math.sin(th);
      const xn = (px - minx) / (maxx - minx), yn = (py - miny) / (maxy - miny);
      const ringw = Math.hypot(px, py) / SQ3 + SPIRAL * lf;
      let angle = Math.atan2(py, px) * 180 / Math.PI; if (angle < 0) angle += 360;
      const od = Math.hypot(px - ox, py - oy) / SQ3 + SPIRAL * lf;
      const axisU = P.axis === 1 ? yn : P.axis === 2 ? ringw / maxRingW : P.axis === 3 ? angle / 360 : xn;
      let c = [0, 0, 0];
      switch (P.effect) {
        case 0: c = pal(5, 0, P.hue, P.sat); break;                                    // solid
        case 1: { const ph = fmod(ts*spd, maxRingW+2);                                 // radial_wave
          c = scaleC(pal(P.palette, ringw/maxRingW, P.hue, P.sat), Math.max(0, 1-Math.abs(ph-ringw))); break; }
        case 2: c = pal(P.palette, axisU + ts*spd, P.hue, P.sat); break;                // rainbow_sweep
        case 3: c = scaleC(pal(P.palette, 0, P.hue, P.sat), 0.5 - 0.5*Math.cos(2*Math.PI*ts*spd)); break; // pulse (uniform)
        case 4: case 10: { let k = chaseK(ts, spd, sc, idx, count, led, n);             // chase / snake
          if (P.effect === 10 && k <= 0 && headD === 1) k = 0.25;
          c = scaleC(pal(P.palette, (idx + lf)/count, P.hue, P.sat), k); break; }
        case 5: { const ph = fmod(ts*spd, 2), on = ph < 1 ? axisU <= ph : axisU > ph - 1; // wipe
          c = on ? pal(P.palette, axisU, P.hue, P.sat) : [0,0,0]; break; }
        case 6: c = pal(P.palette, ((xn+yn)/2)*sc - ts*spd, P.hue, P.sat); break;           // rainbow_flow
        case 7: { const ph = fmod(ts*spd, maxOd+2);                                         // random_ripple
          c = scaleC(pal(P.palette, od/maxOd, P.hue, P.sat), Math.max(0, 1-Math.abs(ph-od))); break; }
        case 8: { const g = idx*64 + led, u = ts*spd + hash01(g, s16), slot = Math.floor(u), f = u - slot; // twinkle
          const on = hash01(g, (slot + s16) >>> 0) < Math.min(1, sc/10);
          c = on ? scaleC(pal(P.palette, hash01(slot, g), P.hue, P.sat), Math.sin(Math.PI*f)) : [0,0,0]; break; }
        case 9: c = pal(P.palette, (idx + lf)/count + ts*spd, P.hue, P.sat); break;        // color_cycle
      }
      leds.push(scaleC(c, P.value / 255));
    }
    out[T.id] = leds;
  }
  return out;   // note: firmware float math / power cap can differ by a count or two
}
if (typeof module !== 'undefined') module.exports = { frame, pal, hsv, hash01 };
