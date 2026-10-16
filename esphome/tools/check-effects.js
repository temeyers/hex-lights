// Host check: every animated effect must be non-uniform and changing on a LONE tile and on a 3-tile wall,
// at several LED counts; chase must show a moving segment (not all LEDs) and hand off between tiles.
// Run: node tools/check-effects.js
const { frame } = require('./effects-ref.js');
const NAMES = ['solid','radial_wave','rainbow_sweep','pulse','chase','wipe','rainbow_flow','random_ripple','twinkle','color_cycle','snake'];
const UNIFORM_OK = new Set([0, 3]);  // solid, pulse are uniform by design
let fail = 0; const bad = m => { fail++; console.log('FAIL', m); };
const key = c => c.join(',');
const walls = { lone: [{id:1,q:0,r:0,order:0}], three: [{id:1,q:0,r:0,order:0},{id:2,q:1,r:0,order:1},{id:3,q:1,r:-1,order:2}] };
for (const [wn, tiles] of Object.entries(walls)) for (const n of [1, 12, 44, 60]) for (let e = 0; e < NAMES.length; e++) {
  const P = {effect:e, palette:0, speed:500, scale:150, hue:0, sat:255, value:255, axis:0, seed:12345};
  if (e === 8) P.scale = 500;
  const frames = []; for (let t = 0; t < 8000; t += 25) frames.push(frame(P, tiles, t, n)[1]);
  const changes = new Set(frames.map(f => f.map(key).join('|'))).size > 1;
  if (e !== 0 && !changes) bad(`${wn} n=${n} ${NAMES[e]} frozen`);
  if (n >= 12 && !UNIFORM_OK.has(e)) {
    const nonUniform = frames.some(f => new Set(f.map(key)).size > 1);
    if (!nonUniform) bad(`${wn} n=${n} ${NAMES[e]} lights the tile uniformly`);
  }
  if ((e === 4 || e === 10) && n >= 12) {
    const allOn = frames.some(f => f.every(c => c[0] + c[1] + c[2] > 0) && wn === 'lone' && e === 4);
    if (allOn) bad(`${wn} n=${n} chase lights all LEDs`);
    const heads = frames.map(f => f.reduce((bi, c, i, a) => (c[0]+c[1]+c[2]) > (a[bi][0]+a[bi][1]+a[bi][2]) ? i : bi, 0));
    if (wn === 'lone' && new Set(heads).size < n / 3) bad(`${wn} n=${n} ${NAMES[e]} comet doesn't circle (${new Set(heads).size} positions)`);
  }
}
// hand-off: on the 3-tile wall the lit tile moves 1 -> 2 -> 3 in chase order
{ const P = {effect:4, palette:0, speed:500, scale:100, hue:0, sat:255, value:255, axis:0, seed:1};
  const lit = []; for (let t = 0; t < 8000; t += 250) { const f = frame(P, walls.three, t, 44);
    const s = [1,2,3].map(id => f[id].reduce((a, c) => a + c[0]+c[1]+c[2], 0)); lit.push(s.indexOf(Math.max(...s)) + 1); }
  const seq = lit.filter((v, i) => i === 0 || v !== lit[i-1]).join('');
  if (!seq.includes('1231')) bad('chase hand-off order ' + seq); }
// determinism
{ const P = {effect:7, palette:1, speed:700, scale:150, hue:0, sat:255, value:255, axis:0, seed:99};
  if (JSON.stringify(frame(P, walls.three, 4321, 44)) !== JSON.stringify(frame(P, walls.three, 4321, 44))) bad('not deterministic'); }
console.log(fail ? `${fail} failures` : 'effects check OK');
process.exit(fail ? 1 : 0);
