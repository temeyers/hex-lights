// node tests/effects.test.mjs  (needs out/layout.json: run tools/gen_tiles.py first)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frame, hsv, hexDistance, hash01 } from "../tools/effects.js";
const lay = JSON.parse(readFileSync(new URL("../out/layout.json", import.meta.url)));
const cat = JSON.parse(readFileSync(new URL("../effects.json", import.meta.url)));
const tiles = lay.tiles;
assert.deepEqual(hsv(0), [255, 0, 0]); assert.deepEqual(hsv(120), [0, 255, 0]); assert.deepEqual(hsv(240), [0, 0, 255]);
assert.equal(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 }), 2);
for (const e of cat.effects) {
  for (const tMs of [0, 123, 5000]) {
    const f = frame(e.name, {}, tiles, tMs);
    assert.equal(Object.keys(f).length, tiles.length, e.name);
    for (const c of Object.values(f)) { assert.equal(c.length, 3); c.forEach((u) => assert.ok(Number.isInteger(u) && u >= 0 && u <= 255, `${e.name} ${c}`)); }
  }
}
assert.deepEqual(frame("solid", { color: [1, 2, 3] }, tiles, 0).c0, [1, 2, 3]);
assert.deepEqual(frame("breathe", { color: [200, 200, 200], periodS: 2 }, tiles, 0).c0, [0, 0, 0]);
assert.deepEqual(frame("breathe", { color: [200, 200, 200], periodS: 2 }, tiles, 1000).c0, [200, 200, 200]);
const rip = frame("ripple", { color: [100, 100, 100], speed: 1 }, tiles, 0);
assert.deepEqual(rip.c0, [100, 100, 100]); assert.deepEqual(rip["r2-a"], [0, 0, 0]);
assert.deepEqual(frame("ripple", { color: [100, 100, 100], speed: 1 }, tiles, 1000)["r1-e"], [100, 100, 100]);
const xs = tiles.map((t) => t.x); const left = tiles[xs.indexOf(Math.min(...xs))];
assert.deepEqual(frame("rainbow_sweep", { axis: "x", speed: 1 }, tiles, 0)[left.id], [255, 0, 0]);
assert.deepEqual(frame("sparkle", {}, tiles, 777), frame("sparkle", {}, tiles, 777)); // deterministic
assert.equal(Object.values(frame("sparkle", { density: 0 }, tiles, 0)).every((c) => c.every((u) => u === 0)), true);
assert.ok(hash01(3, 4) >= 0 && hash01(3, 4) < 1);
console.log("effects.js: all tests passed");
// --- wall effects ---
import { frameLeds, pal, PALETTES } from "../tools/effects.js";
const WALL = ["chase", "wipe", "rainbow_flow"];
for (const e of WALL) assert.ok(cat.effects.find((x) => x.name === e), `${e} in effects.json`);
for (const name of Object.keys(PALETTES)) for (const u of [0, 0.3, 0.999, 1.7, -0.2]) {
  const c = pal(name, u); assert.equal(c.length, 3); c.forEach((v) => assert.ok(Number.isInteger(v) && v >= 0 && v <= 255));
}
for (const e of WALL) for (const palette of Object.keys(PALETTES)) for (const tMs of [0, 333, 7777, 123456]) {
  const a = frame(e, { palette }, tiles, tMs), b = frame(e, { palette }, tiles, tMs);
  assert.deepEqual(a, b, `${e} deterministic`);
  for (const c of Object.values(a)) c.forEach((v) => assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${e} ${c}`));
}
// chase: head tile (index 0 at t=0) is full brightness, the tile far behind is dark
const ch = frame("chase", { palette: "mono", color: [100, 100, 100], tail: 3, speed: 1 }, tiles, 0);
assert.deepEqual(ch[tiles[0].id], [100, 100, 100]); assert.deepEqual(ch[tiles[5].id], [0, 0, 0]);
assert.deepEqual(frame("chase", { palette: "mono", color: [100, 100, 100], tail: 3, speed: 1 }, tiles, 5000)[tiles[5].id], [100, 100, 100]);
// wipe: half way through phase 0 roughly half the tiles are lit, all lit at ph -> 1
const lit = (f) => Object.values(f).filter((c) => c.some((v) => v > 0)).length;
const w = (tMs) => frame("wipe", { speed: 1, palette: "fire" }, tiles, tMs);
assert.ok(lit(w(500)) > 0 && lit(w(500)) < tiles.length); assert.equal(lit(w(999)), tiles.length - tiles.filter((t) => t.x > 0.999).length);
assert.equal(lit(w(1999)), tiles.filter((t) => t.x > 0.999).length);
// rainbow_flow is periodic: one cycle later is the same frame
assert.deepEqual(frame("rainbow_flow", { speed: 0.5 }, tiles, 1000), frame("rainbow_flow", { speed: 0.5 }, tiles, 3000));
// per-LED output
const L = frameLeds("rainbow_flow", {}, tiles, 0);
assert.equal(L[tiles[0].id].length, tiles[0].leds || 44);
assert.equal(frameLeds("solid", {}, [{ ...tiles[0], leds: undefined }], 0)[tiles[0].id].length, 44);
assert.deepEqual(L[tiles[0].id][7], frame("rainbow_flow", {}, tiles, 0)[tiles[0].id]);
console.log("wall effects: all tests passed");
// --- order-driven chase + rainbow_sweep axes ---
{
  const T = tiles.map((t, i) => ({ ...t, order: tiles.length - 1 - i }));
  const f = frame("chase", { palette: "mono", color: [100, 100, 100], tail: 1, speed: 1 }, T, 0);
  assert.deepEqual(f[T[T.length - 1].id], [100, 100, 100]);  // order 0 = last tile in list
  assert.deepEqual(f[T[0].id], [0, 0, 0]);
  const g = frame("chase", { palette: "mono", color: [100, 100, 100], tail: 1, speed: 1 }, tiles, 0);
  assert.deepEqual(g[tiles[0].id], [100, 100, 100]);           // no order -> index
  for (const axis of ["x", "y", "ring", "angle"]) {
    const a = frame("rainbow_sweep", { axis }, tiles, 1234);
    assert.deepEqual(a, frame("rainbow_sweep", { axis }, tiles, 1234));
    for (const c of Object.values(a)) c.forEach((v) => assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${axis} ${c}`));
  }
  const ringF = frame("rainbow_sweep", { axis: "ring", speed: 1 }, tiles, 0);
  assert.deepEqual(ringF.c0, [255, 0, 0]);                       // ring 0 -> hue 0
  assert.deepEqual(ringF["r1-e"], ringF["r1-w"]);                // same ring -> same colour
  console.log("order/axis: all tests passed");
}
