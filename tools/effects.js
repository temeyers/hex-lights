// Dependency-free reference implementation of effects.json.
// frame(effect, params, tiles, tMs) -> {tileId: [r,g,b]}
// tiles: array from out/layout.json "tiles" (needs id, q, r, x, y, ring, angle, index).
export const DEFAULTS = {
  solid: { color: [255, 140, 40] },
  breathe: { color: [255, 140, 40], periodS: 4 },
  rainbow_sweep: { speed: 0.25, axis: "x" },
  ripple: { color: [40, 120, 255], speed: 2, origin: null },
  spiral: { speed: 0.2 },
  sparkle: { color: [255, 255, 255], density: 0.15 },
  chase: { speed: 3, tail: 3, palette: "rainbow", color: [255, 140, 40] },
  wipe: { speed: 0.3, axis: "x", palette: "rainbow", color: [255, 140, 40] },
  rainbow_flow: { speed: 0.2, scale: 1, palette: "rainbow", color: [255, 140, 40] },
};
DEFAULTS.rainbow_sweep.palette = "rainbow";
DEFAULTS.spiral.palette = "rainbow";
DEFAULTS.ripple.palette = "mono";

export const PALETTES = {
  rainbow: null,
  ocean: [[0, 40, 120], [0, 160, 200], [40, 220, 180], [0, 40, 120]],
  sunset: [[255, 60, 0], [255, 0, 80], [120, 0, 160], [255, 60, 0]],
  forest: [[10, 80, 10], [60, 180, 20], [180, 220, 40], [10, 80, 10]],
  fire: [[120, 0, 0], [255, 60, 0], [255, 180, 20], [120, 0, 0]],
  mono: null,
  "light color": null,   // id 6: shades of the (master) light colour
};

// 0..1 coordinate along an axis: x | y | ring (ring/maxRing) | angle (angle/360)
export const axisU = (tile, axis, maxRing) =>
  axis === "ring" ? tile.ring / maxRing : axis === "angle" ? tile.angle / 360 : tile[axis];

const frac = (u) => u - Math.floor(u);

export function pal(name, u, color = [255, 140, 40]) {
  u = frac(u);
  if (name === "mono") return [...color];
  // Hardware PAL_LIGHT: light colour scaled 25..100 % along the palette coordinate
  if (name === "light color") { const k = 0.625 + 0.375 * Math.cos(2 * Math.PI * u); return color.map((c) => Math.round(c * k)); }
  const st = PALETTES[name];
  if (!st) return hsv(u * 360);
  const f = u * (st.length - 1), i = Math.min(Math.floor(f), st.length - 2), w = f - i;
  return st[i].map((a, k) => Math.round(a + (st[i + 1][k] - a) * w));
}

export function hsv(h, s = 1, v = 1) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((u) => Math.round((u + m) * 255));
}

export function hexDistance(a, b) {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hash01(a, b) {
  const v = ((Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) >>> 0) % 1000003;
  return v / 1000003;
}

const scale = (c, k) => c.map((u) => Math.round(u * k));

export function frame(effect, params, tiles, tMs) {
  const p = { ...(DEFAULTS[effect] || {}), ...(params || {}) };
  const out = {};
  const t = tMs / 1000;
  let origin, maxD;
  const N = tiles.length, maxRing = Math.max(1, ...tiles.map((x) => x.ring));
  if (effect === "ripple") {
    origin = tiles.find((x) => x.id === p.origin) || tiles.find((x) => x.isMaster) || tiles[0];
    maxD = Math.max(...tiles.map((x) => hexDistance(x, origin)));
  }
  for (const tile of tiles) {
    let rgb;
    switch (effect) {
      case "solid": rgb = [...p.color]; break;
      case "breathe": rgb = scale(p.color, 0.5 - 0.5 * Math.cos((2 * Math.PI * tMs) / (p.periodS * 1000))); break;
      case "rainbow_sweep": rgb = pal(p.palette, axisU(tile, p.axis, maxRing) + t * p.speed, p.color); break;
      case "ripple": {
        const d = hexDistance(tile, origin), ph = (t * p.speed) % (maxD + 2);
        rgb = scale(pal(p.palette, d / Math.max(1, maxD), p.color), Math.max(0, 1 - Math.abs(ph - d))); break;
      }
      case "spiral": rgb = pal(p.palette, (tile.angle + tile.ring * 30) / 360 + t * p.speed, p.color); break;
      case "sparkle": rgb = hash01(tile.index, Math.floor(tMs / 100)) < p.density ? [...p.color] : [0, 0, 0]; break;
      case "chase": {
        const o = Number.isInteger(tile.order) ? tile.order : tile.index;
        const head = (t * p.speed) % N, d = (((head - o) % N) + N) % N;
        rgb = scale(pal(p.palette, tile.index / N, p.color), Math.max(0, 1 - d / p.tail)); break;
      }
      case "wipe": {
        const u = axisU(tile, p.axis, maxRing);
        const ph = (t * p.speed) % 2, on = ph < 1 ? u <= ph : u > ph - 1;
        rgb = on ? pal(p.palette, u === 1 ? 0.999 : u, p.color) : [0, 0, 0]; break;
      }
      case "rainbow_flow": rgb = pal(p.palette, ((tile.x + tile.y) / 2) * p.scale - t * p.speed, p.color); break;
      default: throw new Error(`unknown effect ${effect}`);
    }
    out[tile.id] = rgb;
  }
  return out;
}

// Per-LED output: {tileId: [[r,g,b] x leds]}, leds = tile.leds || 44.
// v1: every LED of a tile shows the tile colour from frame().
export function frameLeds(effect, params, tiles, tMs) {
  const f = frame(effect, params, tiles, tMs), out = {};
  for (const tile of tiles) out[tile.id] = Array.from({ length: tile.leds || 44 }, () => [...f[tile.id]]);
  return out;
}
