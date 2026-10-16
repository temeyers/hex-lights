// node test (NODE_PATH=/tmp/pw/node_modules). Serves via http://localhost:8411/web/
const { chromium } = require('playwright'); const fs = require('fs');
const OUT = __dirname + '/screenshots/'; const URL = 'http://localhost:8411/web/index.html';
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
  for (const w of [375, 1280]) {
    const ctx = await b.newContext({ viewport: { width: w, height: w === 375 ? 812 : 800 }, hasTouch: w === 375, acceptDownloads: true });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload();
    for (let i = 0; i < 20; i++) await p.click('#add');
    ok(await p.evaluate(() => HexApp.state().led.count) === 44, w + ' new layout default led.count 44');
    ok(await p.textContent('#count') === '20 tiles', w + ' 20 tiles counter');
    // assign IDs via panel on a few tiles by tapping, rest via UI fields too
    const n = await p.locator('.hx').count();
    await p.click('#zfit');
    const tap = async i => { if (await p.isVisible('#sheet')) await p.click('#shClose'); await p.locator('.hx').nth(i).click(); };
    for (let i = 0; i < n; i++) {
      await tap(i);
      await p.fill('#tId', 'hex-' + String(i + 1).padStart(2, '0'));
      if (i === 0) { await p.fill('#tName', 'Centre'); await p.fill('#tMac', 'aa:bb:cc:dd:ee:01'); await p.selectOption('#tRot', '3'); await p.fill('#tLed', '42'); await p.click('#tMaster'); }
      if (i === 2) { await p.fill('#tLed', '999'); ok(await p.evaluate(() => HexApp.state().tiles[2].ledCount) === 300, w + ' ledCount clamped to 300');
        await p.click('#tLedDef'); ok(await p.evaluate(() => HexApp.state().tiles[2].ledCount) === '' && (await p.inputValue('#tLed')) === '', w + ' use default clears override'); }
    }
    console.log(JSON.stringify(await p.evaluate(() => LayoutFormat.validate(HexApp.state())))); ok(await p.locator('#errs').isHidden(), w + ' no validation issues after IDs');
    // duplicate flag
    await tap(1); await p.fill('#tId', 'hex-03');
    ok((await p.textContent('#tIdErr')).includes('Duplicate'), w + ' duplicate flagged');
    await p.fill('#tId', ''); ok((await p.textContent('#tIdErr')).includes('Missing'), w + ' missing flagged');
    await p.fill('#tId', 'hex-02');
    // drag a tile to an empty spot
    const before = await p.evaluate(() => JSON.stringify(HexApp.state().tiles[19]));
    if (await p.isVisible('#sheet')) await p.click('#shClose');
    const bb = await p.locator('.hx').nth(19).boundingBox();
    await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await p.mouse.down(); await p.mouse.move(w - 40, 100, { steps: 8 }); await p.mouse.up();
    ok(before !== await p.evaluate(() => JSON.stringify(HexApp.state().tiles[19])), w + ' drag moved tile');
    await p.screenshot({ path: OUT + 'editor-' + w + '.png' });
    // layout panel
    await p.click('#tabLayout'); await p.fill('#lName', 'Living room'); await p.fill('#lPin', '5'); await p.fill('#lCount', '36'); await p.selectOption('#lOrder', 'RGB');
    await p.screenshot({ path: OUT + 'layout-panel-' + w + '.png' });
    // export
    await p.click('#tabFile'); const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exp')]);
    const file = OUT + '../layout-export-' + w + '.json'; await dl.saveAs(file); const exp = fs.readFileSync(file, 'utf8'); const o = JSON.parse(exp);
    ok(o.version === 1 && o.tiles.length === 20 && o.master === 'hex-01' && o.led.pin === 'GPIO5' && o.led.order === 'RGB' && o.tiles[0].ledCount === 42 && o.tiles[0].mac, w + ' export content');
    ok(JSON.stringify(Object.keys(o)) === '["version","name","hex","led","master","tiles"]' && !('x' in o.tiles[0]) && !('ring' in o.tiles[0]), w + ' export has no derived fields');
    // reimport after clearing
    await p.evaluate(() => { localStorage.clear(); }); await p.reload();
    ok(await p.textContent('#count') === '0 tiles', w + ' cleared');
    await p.click('#tabFile'); await p.setInputFiles('#imp', file); await p.waitForTimeout(300);
    const re = await p.evaluate(() => LayoutFormat.serialize(HexApp.state()));
    ok(re === exp, w + ' round-trip identical');
    await p.reload(); ok(await p.evaluate(() => LayoutFormat.serialize(HexApp.state())) === exp, w + ' autosave restored after reload');
    await p.screenshot({ path: OUT + 'file-panel-' + w + '.png' });
    // derived fields
    const d = await p.evaluate(() => HexApp.derived());
    ok(d[0].leds === 42 && d[0].ledCount === 42 && d[2].leds === 36 && d.filter(t => t.leds === 36).length === 19 && !('ledCount' in o.tiles[2]), w + ' effective leds (override 42, default 36)');
    ok(d.every(t => t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1) && d[0].ring === 0 && d.some(t => t.ring >= 2) && d[5].index === 5, w + ' derived x/y/ring/index');
    // effects
    await p.click('#tabFx');
    const names = await p.$$eval('#fxSel option', os => os.map(o => o.value));
    ok(names.join() === 'solid,breathe,rainbow_sweep,ripple,spiral,sparkle', w + ' effect list');
    ok((await p.textContent('#fxSrc')).includes('Back End effects.json + tools/effects.js'), w + ' using Back End effects (' + await p.textContent('#fxSrc') + ')');
    const ctl = {}; for (const e of names) { await p.selectOption('#fxSel', e); ctl[e] = await p.$$eval('#fxParams [data-k]', xs => xs.map(x => x.dataset.k + ':' + (x.type || x.tagName)).join(',')); }
    console.log('controls', JSON.stringify(ctl));
    ok(ctl.solid === 'color:color' && ctl.breathe === 'color:color,periodS:range' && ctl.rainbow_sweep === 'speed:range,axis:select-one' && ctl.ripple === 'color:color,speed:range,origin:select-one' && ctl.spiral === 'speed:range' && ctl.sparkle === 'color:color,density:range', w + ' controls built from effects.json');
    for (const e of names) { await p.selectOption('#fxSel', e); await p.click('#fxPlay'); await p.waitForTimeout(250);
      const c = await p.evaluate(() => HexApp.fx.colors); ok(c && Object.keys(c).length === 20 && Object.values(c).every(v => v.length === 3), w + ' effect ' + e + ' produced 20 colours'); if (e !== 'sparkle' && e !== 'ripple' && e !== 'breathe') ok(Object.values(c).some(v => v[0] + v[1] + v[2] > 0), w + ' effect ' + e + ' lit'); await p.click('#fxStop'); }
    await p.selectOption('#fxSel', 'rainbow_sweep'); await p.click('#fxPlay'); await p.waitForTimeout(600);
    await p.screenshot({ path: OUT + 'preview-rainbow-' + w + '.png' }); await p.click('#fxStop');
    await p.selectOption('#fxSel', 'ripple'); const top = await p.evaluate(() => { let best = null; document.querySelectorAll('.hx').forEach(g => { const r = g.getBoundingClientRect(); if (r.top > 60 && (!best || r.top < best.t)) best = { t: r.top, i: +g.dataset.i, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); return best; });
    await p.mouse.click(top.x, top.y);
    ok(await p.evaluate(() => HexApp.fx.params.origin) === 'hex-' + String(top.i + 1).padStart(2, '0'), w + ' tap sets ripple origin');
    await p.waitForTimeout(500); await p.screenshot({ path: OUT + 'preview-ripple-' + w + '.png' }); await p.click('#fxStop');
    // flat toggle
    await p.click('#tabLayout'); await p.selectOption('#lOri', 'flat'); await p.screenshot({ path: OUT + 'flat-' + w + '.png' });
    // layout checks
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), w + ' no horizontal scroll');
    const small = await p.evaluate(() => [...document.querySelectorAll('button,select,input:not([type=file])')].filter(e => e.offsetParent && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44)).map(e => e.id || e.tagName));
    ok(small.length === 0, w + ' tap targets >=44px ' + small.join(','));
    ok(errs.length === 0, w + ' no page errors ' + errs.join('|'));
    await ctx.close();
  }
  // Back End reference layout: derived fields vs out/layout.json, and export round trip
  { const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); await p.goto(URL);
    await p.click('#tabFile'); await p.setInputFiles('#imp', '/workspace/hex-lights/layout.json'); await p.waitForTimeout(300);
    const ref = JSON.parse(fs.readFileSync('/workspace/hex-lights/out/layout.json', 'utf8')).tiles;
    const mine = await p.evaluate(() => HexApp.derived()); const mm = [];
    ref.forEach((t, i) => { const m = mine[i]; for (const k of ['id', 'q', 'r', 'ring', 'index', 'isMaster', 'leds']) if (m[k] !== t[k]) mm.push(t.id + '.' + k + ' ' + m[k] + '!=' + t[k]);
      if (Math.abs(m.x - t.x) > 6e-5) mm.push(t.id + '.x ' + m.x + '!=' + t.x); if (Math.abs(m.y - t.y) > 6e-5) mm.push(t.id + '.y ' + m.y + '!=' + t.y);
      if (Math.abs(m.angle - t.angle) > 0.006) mm.push(t.id + '.angle ' + m.angle + '!=' + t.angle); });
    console.log('derived mismatches: ' + (mm.length ? mm.join('; ') : 'none') + ' (' + ref.length + ' tiles)');
    ok(mm.length === 0 && mine.length === ref.length, 'derived fields match out/layout.json');
    const src = JSON.parse(fs.readFileSync('/workspace/hex-lights/layout.json', 'utf8')), back = JSON.parse(await p.evaluate(() => LayoutFormat.serialize(HexApp.state())));
    ok(JSON.stringify(back) === JSON.stringify(src), 'Back End layout.json round-trips unchanged');
    const imp = JSON.parse(JSON.stringify(src)); imp.led.count = 60; imp.tiles[1].ledCount = 12;
    await p.evaluate(t => { document.getElementById('json').value = t; }, JSON.stringify(imp)); await p.click('#loadTxt');
    const dd = await p.evaluate(() => [HexApp.state().led.count, HexApp.derived().map(t => t.leds)]);
    ok(dd[0] === 60 && dd[1][1] === 12 && dd[1][0] === 60, 'import keeps led.count (60) and per-tile override; leds passed to frame');
    let seen = null; await p.evaluate(() => { const F = HexApp.FX(); const orig = F.frame; F.frame = function (e, pr, tiles, t) { window.__seen = tiles.map(x => x.leds); return orig(e, pr, tiles, t); }; });
    await p.click('#tabFx'); await p.click('#fxPlay'); await p.waitForTimeout(200); seen = await p.evaluate(() => window.__seen); await p.click('#fxStop');
    ok(seen && seen[1] === 12 && seen[0] === 60, 'frame() receives effective leds');
    // flat orientation sanity vs Back End formula
    const fl = await p.evaluate(() => { HexApp.state().hex.orientation = 'flat'; return HexApp.derived(); });
    console.log('flat sample', JSON.stringify(fl.slice(0, 3).map(t => [t.id, +t.x.toFixed(4), +t.y.toFixed(4), +t.angle.toFixed(2)])));
    await ctx.close(); }
  // pinch on touch (CDP synthesized)
  const ctx = await b.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true }); const p = await ctx.newPage(); await p.goto(URL);
  const v0 = await p.evaluate(() => document.getElementById('svg').getAttribute('viewBox'));
  const cdp = await ctx.newCDPSession(p); const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((x, i) => ({ x: x[0], y: x[1], id: i })) });
  await T('touchStart', [[150, 400], [220, 400]]); for (let k = 1; k <= 8; k++) await T('touchMove', [[150 - k * 10, 400], [220 + k * 10, 400]]); await T('touchEnd', []);
  const v1 = await p.evaluate(() => document.getElementById('svg').getAttribute('viewBox'));
  ok(+v1.split(' ')[2] < +v0.split(' ')[2], 'pinch zoom in (' + v0 + ' -> ' + v1 + ')');
  await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
})();
