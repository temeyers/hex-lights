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
    ok(await p.textContent('#count') === '20 tiles', w + ' 20 tiles counter');
    // assign IDs via panel on a few tiles by tapping, rest via UI fields too
    const n = await p.locator('.hx').count();
    await p.click('#zfit');
    const tap = async i => { if (await p.isVisible('#sheet')) await p.click('#shClose'); await p.locator('.hx').nth(i).click(); };
    for (let i = 0; i < n; i++) {
      await tap(i);
      await p.fill('#tId', 'hex-' + String(i + 1).padStart(2, '0'));
      if (i === 0) { await p.fill('#tName', 'Centre'); await p.fill('#tMac', 'aa:bb:cc:dd:ee:01'); await p.selectOption('#tRot', '3'); await p.fill('#tLed', '42'); await p.click('#tMaster'); }
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
    ok(o.version === 1 && o.tiles.length === 20 && o.master === 'hex-01' && o.led.pin === 5 && o.led.order === 'RGB' && o.tiles[0].ledCount === 42 && o.tiles[0].mac, w + ' export content');
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
    ok(d.every(t => t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1) && d[0].ring === 0 && d.some(t => t.ring >= 2) && d[5].index === 5, w + ' derived x/y/ring/index');
    // effects
    await p.click('#tabFx');
    const names = await p.$$eval('#fxSel option', os => os.map(o => o.value));
    ok(names.join() === 'solid,breathe,rainbow_sweep,ripple,spiral,sparkle', w + ' effect list');
    for (const e of names) { await p.selectOption('#fxSel', e); await p.click('#fxPlay'); await p.waitForTimeout(250);
      const c = await p.evaluate(() => HexApp.fx.colors); ok(c && Object.keys(c).length === 20, w + ' effect ' + e + ' produced 20 colours'); await p.click('#fxStop'); }
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
  // pinch on touch (CDP synthesized)
  const ctx = await b.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true }); const p = await ctx.newPage(); await p.goto(URL);
  const v0 = await p.evaluate(() => document.getElementById('svg').getAttribute('viewBox'));
  const cdp = await ctx.newCDPSession(p); const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((x, i) => ({ x: x[0], y: x[1], id: i })) });
  await T('touchStart', [[150, 400], [220, 400]]); for (let k = 1; k <= 8; k++) await T('touchMove', [[150 - k * 10, 400], [220 + k * 10, 400]]); await T('touchEnd', []);
  const v1 = await p.evaluate(() => document.getElementById('svg').getAttribute('viewBox'));
  ok(+v1.split(' ')[2] < +v0.split(' ')[2], 'pinch zoom in (' + v0 + ' -> ' + v1 + ')');
  await b.close(); console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
})();
