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
};

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
  if (effect === "ripple") {
    origin = tiles.find((x) => x.id === p.origin) || tiles.find((x) => x.isMaster) || tiles[0];
    maxD = Math.max(...tiles.map((x) => hexDistance(x, origin)));
  }
  for (const tile of tiles) {
    let rgb;
    switch (effect) {
      case "solid": rgb = [...p.color]; break;
      case "breathe": rgb = scale(p.color, 0.5 - 0.5 * Math.cos((2 * Math.PI * tMs) / (p.periodS * 1000))); break;
      case "rainbow_sweep": rgb = hsv(tile[p.axis] * 360 + t * p.speed * 360); break;
      case "ripple": {
        const d = hexDistance(tile, origin), ph = (t * p.speed) % (maxD + 2);
        rgb = scale(p.color, Math.max(0, 1 - Math.abs(ph - d))); break;
      }
      case "spiral": rgb = hsv(tile.angle + tile.ring * 30 + t * p.speed * 360); break;
      case "sparkle": rgb = hash01(tile.index, Math.floor(tMs / 100)) < p.density ? [...p.color] : [0, 0, 0]; break;
      default: throw new Error(`unknown effect ${effect}`);
    }
    out[tile.id] = rgb;
  }
  return out;
}
