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
