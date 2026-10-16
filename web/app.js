/* Hex lights layout editor. ES5, no deps. */
(function () {
  var LF = window.LayoutFormat, KEY = 'hexlights.layout.v1', R = 40, S3 = Math.sqrt(3);
  function hyp(a, b) { return Math.sqrt(a * a + b * b); }
  var $ = function (id) { return document.getElementById(id); };
  var svg = $('svg'), gT = $('tiles'), gG = $('grid');
  var st = load(), sel = -1, view = { x: -300, y: -300, w: 600, h: 600 }, errs = [];
  var FX = { defs: LocalEffects.EFFECTS, frame: LocalEffects.frame, src: 'local fallback (web/effects.js)' };
  var fx = { name: 'solid', params: {}, play: false, t0: 0, tAcc: 0, last: 0, colors: null };

  function load() { try { var s = localStorage.getItem(KEY); if (s) return LF.parse(s).layout; } catch (e) {} return LF.defaults(); }
  function save() { try { localStorage.setItem(KEY, LF.serialize(st)); } catch (e) {} }

  /* ---- hex math (axial) ---- */
  function px(q, r) { return st.hex.orientation === 'flat' ? [R * 1.5 * q, R * S3 * (r + q / 2)] : [R * S3 * (q + r / 2), R * 1.5 * r]; }
  function axial(x, y) {
    var q, r; if (st.hex.orientation === 'flat') { q = (2 / 3 * x) / R; r = (-x / 3 + S3 / 3 * y) / R; } else { q = (S3 / 3 * x - y / 3) / R; r = (2 / 3 * y) / R; }
    var s = -q - r, rq = Math.round(q), rr = Math.round(r), rs = Math.round(s), dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs; return [rq, rr];
  }
  function dist(a, b) { return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r)); }
  function corners(cx, cy, k) { var p = [], o = st.hex.orientation === 'flat' ? 0 : 30; for (var i = 0; i < 6; i++) { var a = Math.PI / 180 * (60 * i + o); p.push((cx + k * Math.cos(a)).toFixed(1) + ',' + (cy + k * Math.sin(a)).toFixed(1)); } return 'M' + p.join('L') + 'Z'; }
  function at(q, r, skip) { for (var i = 0; i < st.tiles.length; i++) if (i !== skip && st.tiles[i].q === q && st.tiles[i].r === r) return i; return -1; }
  function masterIdx() { for (var i = 0; i < st.tiles.length; i++) if (st.tiles[i].id && st.tiles[i].id === st.master) return i; return -1; }

  /* derived fields, same as Back End tools/gen_tiles.py derive(): unit-hex pixel math (pointy x=√3(q+r/2), y=1.5r; flat x=1.5q, y=√3(q/2+r)),
     x/y normalised per axis (single row/col -> 0.5), ring = hex distance from master, angle = degrees 0-360 from master
     (0 = right, clockwise on screen since y grows downward; master 0), index = layout order. */
  function upx(q, r) { return st.hex.orientation === 'flat' ? [1.5 * q, S3 * (q / 2 + r)] : [S3 * (q + r / 2), 1.5 * r]; }
  function derived() {
    var T = st.tiles, out = [], mn = [1e9, 1e9], mx = [-1e9, -1e9], i, p, mi = masterIdx(), m = T[mi >= 0 ? mi : 0], mp = m ? upx(m.q, m.r) : [0, 0];
    for (i = 0; i < T.length; i++) { p = upx(T[i].q, T[i].r); mn = [Math.min(mn[0], p[0]), Math.min(mn[1], p[1])]; mx = [Math.max(mx[0], p[0]), Math.max(mx[1], p[1])]; }
    for (i = 0; i < T.length; i++) {
      var t = T[i]; p = upx(t.q, t.r); var a = Math.atan2(p[1] - mp[1], p[0] - mp[0]) * 180 / Math.PI; a = ((a % 360) + 360) % 360;
      out.push({ id: t.id || ('#' + i), name: t.name, mac: t.mac, q: t.q, r: t.r, rot: t.rot, ledCount: t.ledCount === '' ? undefined : t.ledCount,
        x: mx[0] - mn[0] > 1e-9 ? (p[0] - mn[0]) / (mx[0] - mn[0]) : 0.5, y: mx[1] - mn[1] > 1e-9 ? (p[1] - mn[1]) / (mx[1] - mn[1]) : 0.5,
        ring: m ? dist(t, m) : 0, angle: (t === m || (t.q === m.q && t.r === m.r)) ? 0 : a, index: i, order: LF.order(t, i), rotation: LF.rotDeg(t), isMaster: t === m, leds: t.ledCount === '' ? st.led.count : t.ledCount });
    }
    return out;
  }

  /* ---- render ---- */
  function setVB() { svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h); }
  function drawGrid() {
    var h = '', c = axial(view.x + view.w / 2, view.y + view.h / 2), n = Math.min(30, Math.ceil(Math.max(view.w, view.h) / R / 1.4) + 2);
    if (view.w > 4000) { gG.innerHTML = ''; return; }
    for (var q = -n; q <= n; q++) for (var r = Math.max(-n, -q - n); r <= Math.min(n, -q + n); r++) { var p = px(c[0] + q, c[1] + r); h += '<path class="cell" d="' + corners(p[0], p[1], R) + '"/>'; }
    gG.innerHTML = h;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render() {
    errs = LF.validate(st); var bad = {}, i, h = '';
    for (i = 0; i < errs.length; i++) if (errs[i].tile != null) bad[errs[i].tile] = 1;
    var mi = masterIdx(), D = fx.colors ? derived() : null, bri = $('bri').value / 100, ledR = R * 0.74, dotR = Math.max(1.2, Math.min(3.2, R * 2.6 / 44));
    for (i = 0; i < st.tiles.length; i++) {
      var t = st.tiles[i], p = px(t.q, t.r), lab = t.name || t.id || '?', fill = '';
      var dots = '', deg = LF.rotDeg(t);
      if (D) {
        var c = fx.colors[D[i].id] || [0, 0, 0], L = fx.leds && fx.leds[D[i].id], n = L ? L.length : D[i].leds;
        fill = ' style="fill:rgb(' + (c[0] * bri * 0.3 | 0) + ',' + (c[1] * bri * 0.3 | 0) + ',' + (c[2] * bri * 0.3 | 0) + ')"';
        for (var k = 0; k < n; k++) { // LEDs evenly around the edge, offset by rotation (DESIGN.md: radius 0.45, offset by rotation)
          var lc = L ? L[k] : c, la = Math.PI / 180 * (deg + 360 * k / n);
          dots += '<circle class="led" cx="' + (p[0] + Math.cos(la) * ledR).toFixed(1) + '" cy="' + (p[1] + Math.sin(la) * ledR).toFixed(1) + '" r="' + dotR.toFixed(1) + '" fill="rgb(' + (lc[0] * bri | 0) + ',' + (lc[1] * bri | 0) + ',' + (lc[2] * bri | 0) + ')"/>';
        }
      }
      var a = Math.PI / 180 * (deg + (st.hex.orientation === 'flat' ? 30 : 0) - 90);
      h += '<g class="hx' + (i === sel ? ' sel' : '') + (bad[i] ? ' bad' : '') + '" data-i="' + i + '"><path d="' + corners(p[0], p[1], R - 2) + '"' + fill + '/>' +
        '<line class="rotmark" x1="' + (p[0] + Math.cos(a) * R * 0.55).toFixed(1) + '" y1="' + (p[1] + Math.sin(a) * R * 0.55).toFixed(1) + '" x2="' + (p[0] + Math.cos(a) * R * 0.8).toFixed(1) + '" y2="' + (p[1] + Math.sin(a) * R * 0.8).toFixed(1) + '"/>' +
        dots + (D ? '' : '<text x="' + p[0] + '" y="' + p[1] + '">' + esc(lab.length > 9 ? lab.slice(0, 8) + '…' : lab) + '</text>') +
        syncBadge(i, p) + (i === mi ? '<text class="star" x="' + p[0] + '" y="' + (p[1] - R * 0.5) + '">★</text>' : '') + '</g>';
    }
    gT.innerHTML = h;
    $('count').textContent = st.tiles.length + (st.tiles.length === 1 ? ' tile' : ' tiles');
    $('errs').hidden = !errs.length; $('errs').textContent = errs.length + ' issue' + (errs.length > 1 ? 's' : '');
  }
  /* expected sync source per DESIGN.md (live value only from sensor.hex_<id>_sync_source: espnow / jumper / jumper-lost).
     Wireless -> espnow for every tile. Jumper -> jumper for every tile (the leader pulses the line and also reports jumper).
     Leader expected = master (gen_tiles gives it leader_priority 1). */
  function syncSrc(i) { var j = st.sync && st.sync.mode === 'jumper', lead = i === masterIdx();
    return { src: j ? 'jumper' : 'espnow', color: j ? '#B45309' : '#2563EB', lead: lead,
      why: j ? (lead ? 'leader: pulses the sync line every 100 ms' : 'follows the leader\'s pulses; falls back to espnow (jumper-lost) after >1 s without edges') : (lead ? 'leader: clock source over ESP-NOW' : 'clock from the leader over ESP-NOW') }; }
  function nid(id) { id = String(id || ''); return /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(id) ? id.toLowerCase().replace(/[^0-9a-f]/g, '') : id.replace(/-/g, '_'); }
  function syncBadge(i, p) { var s = syncSrc(i), tx = (s.src === 'jumper' ? 'J' : 'W') + (s.lead ? '·L' : ''), w = s.lead ? 22 : 14, x = p[0] - w / 2, y = p[1] + R * 0.38;
    return '<g class="sb"><title>Sync source (expected): ' + s.src + '</title><rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w + '" height="12" rx="6" fill="' + s.color + '"/><text x="' + p[0].toFixed(1) + '" y="' + (y + 6).toFixed(1) + '">' + tx + '</text></g>'; }
  /* jumper wiring per DESIGN.md "Sync mode": one shared line + GND, 330 R series at each tile, one 4.7 k pull-up to 3.3 V */
  function wiring(pinName, n) {
    var cols = [70, 165, 260], h = '<svg viewBox="0 0 340 250" role="img" aria-label="Jumper wire sync wiring">';
    h += '<text x="18" y="16">3.3V (any one tile)</text><line class="ln" x1="40" y1="22" x2="40" y2="36"/>';
    h += '<rect class="pu" x="30" y="36" width="20" height="34" rx="3"/><text x="56" y="52">4.7 kΩ pull-up</text><text class="mu" x="56" y="65">one only (optional*)</text>';
    h += '<line class="ln" x1="40" y1="70" x2="40" y2="90"/><line class="ln" x1="14" y1="90" x2="330" y2="90"/><text x="6" y="106">SYNC</text>';
    for (var k = 0; k < 3; k++) { var x = cols[k];
      h += '<circle cx="' + x + '" cy="90" r="3" fill="currentColor"/><line class="ln" x1="' + x + '" y1="90" x2="' + x + '" y2="104"/>';
      h += '<rect class="res" x="' + (x - 10) + '" y="104" width="20" height="30" rx="3"/><text x="' + (x + 14) + '" y="123">330 Ω</text>';
      h += '<line class="ln" x1="' + x + '" y1="134" x2="' + x + '" y2="150"/><rect class="tile" x="' + (x - 34) + '" y="150" width="68" height="44" rx="8"/>';
      h += '<text x="' + (x - 26) + '" y="168">' + esc(pinName) + '</text><text class="mu" x="' + (x - 26) + '" y="184">tile ' + (k + 1) + '</text>';
      h += '<line class="gnd" x1="' + x + '" y1="194" x2="' + x + '" y2="214"/><text class="mu" x="' + (x + 4) + '" y="208">GND</text>'; }
    h += '<text x="300" y="175">… ×' + Math.max(n, 1) + '</text><line class="gnd" x1="14" y1="214" x2="330" y2="214"/><text x="14" y="232">GND bus (LED power GND is fine)</text></svg>';
    h += '<ul><li>Each tile: ' + esc(pinName) + ' → 330 Ω series resistor → shared SYNC line. Plus a shared GND.</li><li>One 4.7 kΩ pull-up to 3.3 V on one tile. *DESIGN.md: optional, internal ~45 kΩ pull-ups also work for short lines [EST].</li>' +
      '<li>Twisted pair (sync + GND) or ribbon, kept short and away from the 5 V branch runs. Open-drain: tiles only pull low.</li><li>Then set <span class="mono">select.' + nodeName() + '_sync_mode</span> to "Jumper wire". sync_pin is a compile-time substitution (regenerate and flash to change it).</li></ul>';
    return h;
  }
  function refresh() { render(); save(); syncPanels(); }

  /* ---- panels ---- */
  var panes = { tile: 'pTile', layout: 'pLayout', fx: 'pFx', file: 'pFile', hw: 'pHw' }, cur = null;
  function show(p) {
    var wasOpen = !$('sheet').hidden; cur = p; $('sheet').hidden = !p;
    for (var k in panes) $(panes[k]).className = 'pane' + (k === p ? ' show' : '');
    $('shTitle').textContent = { tile: 'Tile', layout: 'Layout & LEDs', fx: 'Effect preview', file: 'Import / export', hw: 'Hardware push' }[p] || '';
    $('tabLayout').className = 'btn' + (p === 'layout' ? ' on' : ''); $('tabFx').className = 'btn' + (p === 'fx' ? ' on' : ''); $('tabFile').className = 'btn' + (p === 'file' ? ' on' : ''); $('tabHw').className = 'btn' + (p === 'hw' ? ' on' : '');
    syncPanels(); if (wasOpen !== !!p) { clearTimeout(fitTimer); fitTimer = setTimeout(function () { fitTimer = 0; fit(); }, 0); } // refit only when the panel opens/closes
  }
  var fitTimer = 0;
  function opts(el, list, v) { var h = ''; for (var i = 0; i < list.length; i++) { var o = list[i], val = o.v != null ? o.v : o, tx = o.t || o; h += '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(tx) + '</option>'; } el.innerHTML = h; }
  function setv(el, v) { if (document.activeElement !== el) el.value = v == null ? '' : v; }
  function syncPanels() {
    if (cur === 'tile' && st.tiles[sel]) {
      var t = st.tiles[sel], e = [];
      setv($('tId'), t.id); setv($('tName'), t.name); setv($('tMac'), t.mac); setv($('tQ'), t.q); setv($('tR'), t.r); setv($('tDeg'), LF.rotDeg(t)); setv($('tOrd'), t.order == null || t.order === '' ? '' : t.order); $('tOrd').placeholder = 'default (' + sel + ')'; $('tOrdDef').disabled = t.order == null || t.order === ''; setv($('tLed'), t.ledCount); $('tLed').placeholder = 'default (' + st.led.count + ')'; $('tLedDef').disabled = t.ledCount === '';
      for (var i = 0; i < errs.length; i++) if (errs[i].tile === sel) e.push(errs[i].msg);
      $('tIdErr').textContent = e.join(' · ');
      var ss = syncSrc(sel); $('tSync').innerHTML = '<span class="badge" style="background:' + ss.color + '">' + ss.src + '</span>expected · ' + esc(ss.why) + '. Live value: <span class="mono">sensor.hex_' + esc(nid(t.id)) + '_sync_source</span>';
      $('tPos').textContent = 'q ' + t.q + ', r ' + t.r + (t.id && t.id === st.master ? ' · master' : '');
      $('tMaster').textContent = t.id && t.id === st.master ? 'Is master ★' : 'Make master';
    } else if (cur === 'tile') show(null);
    if (cur === 'hw') hwSync();
    if (cur === 'layout') {
      var sy = st.sync || (st.sync = { mode: 'wireless', pin: 'GPIO12' }), jm = sy.mode === 'jumper';
      $('syW').className = 'btn' + (jm ? '' : ' on'); $('syJ').className = 'btn' + (jm ? ' on' : ''); $('syW').setAttribute('aria-checked', !jm); $('syJ').setAttribute('aria-checked', jm);
      setv($('lSyncPin'), sy.pin); $('wireBox').hidden = !jm; if (jm) $('wireBox').innerHTML = wiring(LF.normPin(sy.pin || 'GPIO12'), st.tiles.length);
      setv($('lName'), st.name); $('lOri').value = st.hex.orientation; setv($('lSize'), st.hex.sizeMm); setv($('lPin'), st.led.pin); setv($('lCount'), st.led.count);
      opts($('lType'), LF.TYPES, st.led.type); opts($('lOrder'), LF.ORDERS, st.led.order);
      var m = [{ v: '', t: '— none —' }]; for (var j = 0; j < st.tiles.length; j++) if (st.tiles[j].id) m.push(st.tiles[j].id); opts($('lMaster'), m, st.master || '');
      var h = ''; for (var k = 0; k < errs.length; k++) h += '<li>' + (errs[k].tile != null ? 'Tile at ' + st.tiles[errs[k].tile].q + ',' + st.tiles[errs[k].tile].r + ': ' : '') + esc(errs[k].msg) + '</li>';
      $('errList').innerHTML = h;
    }
  }
  function bind(id, ev, fn) { $(id).addEventListener(ev, fn); }
  function tset(f, v) { if (st.tiles[sel]) { var old = st.tiles[sel].id; st.tiles[sel][f] = v; if (f === 'id' && st.master === old && old) st.master = v; refresh(); } }
  bind('tId', 'input', function () { tset('id', this.value.trim()); });
  bind('tName', 'input', function () { tset('name', this.value); });
  bind('tMac', 'input', function () { tset('mac', this.value.trim()); });
  function rotSet(d) { d = parseInt(d, 10); if (isNaN(d)) return; if (st.tiles[sel]) { st.tiles[sel].rot = LF.rotFromDeg(d); tset('rotDeg', d); } }
  bind('tDeg', 'input', function () { rotSet(this.value); });
  bind('tRotStep', 'click', function () { if (st.tiles[sel]) { var d = (LF.rotDeg(st.tiles[sel]) + 60) % 360; $('tDeg').value = d; rotSet(d); } });
  bind('tQ', 'input', function () { var v = parseInt(this.value, 10); if (!isNaN(v)) tset('q', v); });
  bind('tR', 'input', function () { var v = parseInt(this.value, 10); if (!isNaN(v)) tset('r', v); });
  bind('tOrd', 'input', function () { tset('order', this.value === '' ? null : parseInt(this.value, 10)); });
  bind('tOrdDef', 'click', function () { $('tOrd').value = ''; tset('order', null); });
  bind('tLed', 'input', function () { tset('ledCount', this.value === '' ? '' : Math.max(1, parseInt(this.value, 10) || 1)); });
  bind('tLedDef', 'click', function () { $('tLed').value = ''; tset('ledCount', ''); });
  bind('tMaster', 'click', function () { var t = st.tiles[sel]; if (!t) return; if (!t.id) { $('tIdErr').textContent = 'Give the tile an ID first'; return; } st.master = t.id; refresh(); });
  bind('tDel', 'click', function () { if (sel < 0) return; if (st.tiles[sel].id === st.master) st.master = null; st.tiles.splice(sel, 1); sel = -1; show(null); refresh(); });
  bind('lName', 'input', function () { st.name = this.value; refresh(); });
  bind('lOri', 'change', function () { st.hex.orientation = this.value; drawGrid(); refresh(); fit(); });
  bind('lSize', 'input', function () { st.hex.sizeMm = parseFloat(this.value) || 0; refresh(); });
  bind('lPin', 'input', function () { st.led.pin = this.value.trim(); refresh(); });
  bind('lCount', 'input', function () { st.led.count = parseInt(this.value, 10) || 0; refresh(); });
  bind('lType', 'change', function () { st.led.type = this.value; refresh(); });
  bind('lOrder', 'change', function () { st.led.order = this.value; refresh(); });
  bind('syW', 'click', function () { st.sync.mode = 'wireless'; refresh(); });
  bind('syJ', 'click', function () { st.sync.mode = 'jumper'; refresh(); });
  bind('lSyncPin', 'input', function () { st.sync.pin = this.value.trim(); refresh(); });
  bind('lMaster', 'change', function () { st.master = this.value || null; refresh(); });
  bind('errs', 'click', function () { show('layout'); });
  bind('shClose', 'click', function () { sel = -1; show(null); render(); });
  bind('tabLayout', 'click', function () { show(cur === 'layout' ? null : 'layout'); });
  bind('tabFx', 'click', function () { show(cur === 'fx' ? null : 'fx'); });
  bind('tabHw', 'click', function () { show(cur === 'hw' ? null : 'hw'); });
  bind('tabFile', 'click', function () { show(cur === 'file' ? null : 'file'); if (cur) $('json').value = LF.serialize(st); });

  /* add tile: next free cell nearest the master (or first tile / view centre) -> compact cluster */
  bind('add', 'click', function () {
    var mi = masterIdx(), b = st.tiles[mi >= 0 ? mi : 0], c = b ? [b.q, b.r] : axial(view.x + view.w / 2, view.y + view.h / 2), best = null;
    for (var k = 0; k < 12 && !best; k++) for (var q = -k; q <= k; q++) for (var r = Math.max(-k, -q - k); r <= Math.min(k, -q + k); r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) !== k) continue;
      if (!best && at(c[0] + q, c[1] + r) < 0) best = [c[0] + q, c[1] + r];
    }
    if (!best) return;
    var n = st.tiles.length + 1, id = 'tile-' + n; while (st.tiles.some(function (t) { return t.id === id; })) id = 'tile-' + (++n);
    st.tiles.push({ id: id, name: '', mac: '', q: best[0], r: best[1], rot: 0, ledCount: '' });
    if (!st.master) st.master = id;
    sel = st.tiles.length - 1; refresh();
    var np = px(best[0], best[1]); if (np[0] - R < view.x || np[0] + R > view.x + view.w || np[1] - R < view.y || np[1] + R > view.y + view.h) fit();
  });

  /* ---- file ---- */
  function download(name, text) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  function importText(text) {
    try { var res = LF.parse(text); st = res.layout; sel = -1; save(); drawGrid(); render(); fit(); $('json').value = LF.serialize(st); $('fileMsg').textContent = 'Imported ' + st.tiles.length + ' tiles' + (res.errors.length ? ' with ' + res.errors.length + ' issue(s)' : '') + '.'; }
    catch (e) { $('fileMsg').textContent = 'Import failed: ' + e.message; }
  }
  bind('exp', 'click', function () { var t = LF.serialize(st); $('json').value = t; download('layout.json', t); $('fileMsg').textContent = errs.length ? 'Exported, but fix ' + errs.length + ' issue(s) before Back End uses it.' : 'Exported layout.json'; });
  bind('impBtn', 'click', function () { $('imp').click(); });
  bind('imp', 'change', function () { var f = this.files[0]; if (!f) return; var rd = new FileReader(); rd.onload = function () { importText(rd.result); }; rd.readAsText(f); this.value = ''; });
  bind('loadTxt', 'click', function () { importText($('json').value); });
  bind('copy', 'click', function () { var t = $('json'); t.value = LF.serialize(st); t.select(); try { navigator.clipboard.writeText(t.value); } catch (e) { document.execCommand('copy'); } $('fileMsg').textContent = 'Copied.'; });
  bind('clear', 'click', function () { if (confirm('Clear all tiles?')) { st = LF.defaults(); sel = -1; refresh(); } });

  /* ---- pan / zoom / drag (pointer events; touch handled via pointerType touch + touch-action:none) ---- */
  var ptrs = {}, drag = null, pinch = null;
  function toSvg(cx, cy) { var b = svg.getBoundingClientRect(), k = Math.max(view.w / b.width, view.h / b.height); return [view.x + (cx - b.left - (b.width - view.w / k) / 2) * k, view.y + (cy - b.top - (b.height - view.h / k) / 2) * k]; }
  function zoomAt(f, cx, cy) { var p = toSvg(cx, cy), nw = Math.max(150, Math.min(6000, view.w * f)), s = nw / view.w; view.x = p[0] - (p[0] - view.x) * s; view.y = p[1] - (p[1] - view.y) * s; view.w = nw; view.h *= s; setVB(); drawGrid(); }
  function fit() {
    var b = svg.getBoundingClientRect(), sh = $('sheet'), pad = 0; // desktop: side panel overlays the right of the canvas
    if (!sh.hidden && getComputedStyle(sh).position === 'fixed') pad = Math.min(b.width / 2, sh.getBoundingClientRect().width + 24);
    b = { width: b.width - pad, height: b.height, full: b.width }; ar = (b.height || 1) / (b.width || 1), mn = [-R * 3, -R * 3], mx = [R * 3, R * 3];
    for (var i = 0; i < st.tiles.length; i++) { var p = px(st.tiles[i].q, st.tiles[i].r); mn = [Math.min(mn[0], p[0] - R * 1.5), Math.min(mn[1], p[1] - R * 1.5)]; mx = [Math.max(mx[0], p[0] + R * 1.5), Math.max(mx[1], p[1] + R * 1.5)]; }
    var w = mx[0] - mn[0], h = mx[1] - mn[1]; if (h / w > ar) w = h / ar; else h = w * ar;
    var W = w * b.full / (b.width || 1); view = { x: (mn[0] + mx[0] - w) / 2, y: (mn[1] + mx[1] - h) / 2, w: W, h: h }; setVB(); drawGrid();
  }
  svg.addEventListener('pointerdown', function (e) {
    svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
    ptrs[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(ptrs);
    if (ids.length === 2) { drag = null; var a = ptrs[ids[0]], b = ptrs[ids[1]]; pinch = { d: hyp(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; return; }
    var g = e.target.closest ? e.target.closest('.hx') : null;
    drag = { i: g ? +g.getAttribute('data-i') : -1, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  });
  svg.addEventListener('pointermove', function (e) {
    if (!ptrs[e.pointerId]) return; ptrs[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(ptrs);
    if (pinch && ids.length >= 2) {
      var a = ptrs[ids[0]], b = ptrs[ids[1]], d = hyp(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      var p0 = toSvg(pinch.c[0], pinch.c[1]), p1 = toSvg(c[0], c[1]); view.x += p0[0] - p1[0]; view.y += p0[1] - p1[1]; setVB();
      if (d > 0) zoomAt(pinch.d / d, c[0], c[1]); pinch = { d: d, c: c }; return;
    }
    if (!drag) return;
    if (!drag.moved && hyp(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
    if (!drag.moved) return;
    if (drag.i >= 0 && !fx.play) {
      var g = gT.querySelector('[data-i="' + drag.i + '"]'), q = toSvg(e.clientX, e.clientY), t = st.tiles[drag.i], o = px(t.q, t.r);
      g.setAttribute('transform', 'translate(' + (q[0] - o[0]).toFixed(1) + ',' + (q[1] - o[1]).toFixed(1) + ')'); g.classList.add('drag');
    } else {
      var p0 = toSvg(drag.lx, drag.ly), p1 = toSvg(e.clientX, e.clientY); view.x += p0[0] - p1[0]; view.y += p0[1] - p1[1]; setVB();
    }
    drag.lx = e.clientX; drag.ly = e.clientY;
  });
  function up(e) {
    delete ptrs[e.pointerId];
    if (pinch) { if (Object.keys(ptrs).length < 2) { pinch = null; drawGrid(); } drag = null; return; }
    if (!drag) return; var d = drag; drag = null;
    if (!d.moved) { // tap
      if (d.i >= 0 && cur === 'fx') { setOrigin(st.tiles[d.i].id); return; }
      sel = d.i; render(); if (sel >= 0) show('tile'); else if (cur === 'tile') show(null); return;
    }
    if (d.i >= 0 && !fx.play) {
      var q = toSvg(e.clientX, e.clientY), a = axial(q[0], q[1]);
      if (at(a[0], a[1], d.i) < 0) { st.tiles[d.i].q = a[0]; st.tiles[d.i].r = a[1]; }
      sel = d.i; refresh(); show('tile');
    } else drawGrid();
  }
  svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false }); // belt-and-braces for iOS
  svg.addEventListener('wheel', function (e) { e.preventDefault(); zoomAt(e.deltaY > 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
  bind('zin', 'click', function () { var b = svg.getBoundingClientRect(); zoomAt(1 / 1.25, b.left + b.width / 2, b.top + b.height / 2); });
  bind('zout', 'click', function () { var b = svg.getBoundingClientRect(); zoomAt(1.25, b.left + b.width / 2, b.top + b.height / 2); });
  bind('zfit', 'click', fit);
  window.addEventListener('resize', function () { var b = svg.getBoundingClientRect(); view.h = view.w * b.height / (b.width || 1); setVB(); drawGrid(); });

  /* ---- effects: prefer Back End's ../effects.json + ../tools/effects.js, else local fallback ---- */
  function normDefs(j) { // accepts {effects:{name:{params}}}, {name:{params}} or [{name,params}]
    var e = j && j.effects ? j.effects : j, o = {};
    if (Object.prototype.toString.call(e) === '[object Array]') { for (var i = 0; i < e.length; i++) o[e[i].name || e[i].id] = { params: e[i].params || {}, hexsyncId: e[i].hexsyncId, firmwareOnly: !!e[i].firmwareOnly }; return o; }
    for (var k in e) if (e.hasOwnProperty(k)) o[k] = { params: (e[k] && e[k].params) || e[k] || {} };
    return o;
  }
  function paramList(p) { if (Object.prototype.toString.call(p) === '[object Array]') { var o = {}; for (var i = 0; i < p.length; i++) o[p[i].name] = p[i]; return o; } return p; }
  function loadRemote(done) {
    if (!window.fetch || location.protocol === 'file:') return done();
    fetch('../effects.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var defs = normDefs(j);
      return fetch('../tools/effects.js', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (src) {
        var f = null;
        if (/^\s*export\s|\nexport\s/.test(src)) { // ES module -> dynamic import (wrapped so this file still parses as ES5)
          return (new Function('u', 'return import(u)'))(new URL('../tools/effects.js', location.href).href).then(function (m) {
            f = m.frame || (m['default'] && m['default'].frame); if (typeof f !== 'function') throw 0;
            FX = { defs: defs, frame: f, frameLeds: m.frameLeds, pal: m.pal, src: 'Back End effects.json + tools/effects.js' };
          });
        }
        var mo = { exports: {} }; (new Function('module', 'exports', src))(mo, mo.exports);
        f = mo.exports.frame || (mo.exports['default'] && mo.exports['default'].frame); if (typeof f !== 'function') throw 0;
        FX = { defs: defs, frame: f, frameLeds: mo.exports.frameLeds, pal: mo.exports.pal, src: 'Back End effects.json + tools/effects.js' };
      }).then(null, function () { FX = { defs: defs, frame: LocalEffects.frame, src: 'Back End effects.json + local frame() fallback' }; });
    }).then(done, done);
  }
  var FWREF = null; // esphome/tools/effects-ref.js (plain script, module.exports = {frame,...})
  if (window.fetch && location.protocol !== 'file:') fetch('../esphome/tools/effects-ref.js', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (src) {
    var mo = { exports: {} }; (new Function('module', 'exports', src))(mo, mo.exports); if (typeof mo.exports.frame === 'function') FWREF = mo.exports;
  }).then(null, function () {}).then(function () { if (!FWREF) { $('fxSrcSel').value = 'be'; $('fxSrcSel').options[1].disabled = true; $('fxSrcSel').options[1].text = 'Firmware reference (not found)'; } });
  bind('fxSrcSel', 'change', function () { fx.fw = this.value === 'fw'; $('fxFwMsg').textContent = ''; });
  /* firmware ref wants numeric ids (tile_id from tiles.csv, else index+1), q, r, order; one ledCount -> use max, slice per tile */
  function fwFrame(D, tMs) {
    var r = fwParams(); if (r.error) throw new Error(r.error);
    var P = { effect: r.P.effect, palette: r.P.palette, speed: r.P.speed, scale: r.P.scale, hue: r.P.hue, sat: r.P.saturation, value: r.P.value,
      axis: { x: 0, y: 1, ring: 2, angle: 3 }[fx.params.axis] || 0, seed: 1 };
    var num = {}, i, k; if (csv) for (k = 0; k < csv.rows.length; k++) num[csv.rows[k].id] = k + 1;
    var tl = [], back = {}, maxL = 1;
    for (i = 0; i < D.length; i++) { var nid = num[D[i].id] || (1000 + i); tl.push({ id: nid, q: D[i].q, r: D[i].r, order: D[i].order }); back[nid] = D[i]; if (D[i].leds > maxL) maxL = D[i].leds; }
    var o = FWREF.frame(P, tl, tMs, maxL), out = {};
    for (k in o) if (o.hasOwnProperty(k)) out[back[k].id] = o[k].slice(0, back[k].leds);
    return out;
  }
  function setOrigin(id) { fx.params.origin = id; var el = $('fxp-origin'); if (el) el.value = id; if (!fx.play) startFx(); }
  function buildFx() {
    var names = Object.keys(FX.defs); opts($('fxSel'), names, fx.name); if (names.indexOf(fx.name) < 0) fx.name = names[0];
    $('fxSrc').textContent = 'Effects: ' + FX.src;
    var p = paramList(FX.defs[fx.name].params), h = '', k; fx.params = {};
    for (k in p) if (p.hasOwnProperty(k)) {
      var d = p[k] || {}, v = d['default'], ty = d.type || (typeof v === 'number' ? 'number' : 'string');
      if (k === 'origin' || ty === 'tile' || ty === 'tileId') { v = st.master || (st.tiles[0] && st.tiles[0].id) || ''; var tl = []; for (var i = 0; i < st.tiles.length; i++) if (st.tiles[i].id) tl.push(st.tiles[i].id);
        h += '<label>' + k + '<select id="fxp-origin" data-k="' + k + '">' + tl.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>'; }
      else if (ty === 'color') { var arr = Object.prototype.toString.call(v) === '[object Array]'; h += '<label>' + k + '<input type="color" data-k="' + k + '"' + (arr ? ' data-rgb="1"' : '') + ' value="' + esc(toHex(v)) + '"></label>'; }
      else if (k === 'palette' && (d.options || d['enum'])) { var po = d.options || d['enum'];
        h += '<label>palette</label><div class="sw" role="radiogroup" aria-label="palette">' + po.map(function (x) { return '<button type="button" role="radio" class="swb' + (x === v ? ' on' : '') + '" aria-checked="' + (x === v) + '" data-pal="' + esc(x) + '" style="background:' + palCss(x) + '">' + esc(x) + '</button>'; }).join('') + '</div>'; }
      else if (d.options || d['enum'] || ty === 'enum') { var op = d.options || d['enum'] || []; h += '<label>' + k + '<select data-k="' + k + '">' + op.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>'; }
      else if (ty === 'number' || ty === 'int' || ty === 'float') { var mn = d.min != null ? d.min : 0, mx = d.max != null ? d.max : 10, stp = ty === 'int' ? 1 : (mx - mn) / 100;
        h += '<label>' + k + ' <span class="num" id="fxv-' + k + '">' + v + '</span><input type="range" data-k="' + k + '" data-num="1" min="' + mn + '" max="' + mx + '" step="' + stp + '" value="' + v + '"></label>'; }
      else h += '<label>' + k + '<input data-k="' + k + '" value="' + esc(v == null ? '' : v) + '"></label>';
      fx.params[k] = v;
    }
    $('fxParams').innerHTML = h;
  }
  function palFn() { return FX.pal || LocalEffects.pal; }
  function palCss(name) { var st2 = [], col = fx.params.color || [255, 140, 40]; for (var i = 0; i <= 8; i++) { var c = palFn()(name, i / 8.0001, col); st2.push('rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'); } return 'linear-gradient(90deg,' + st2.join(',') + ')'; }
  $('fxParams').addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-pal]') : null; if (!b) return; fx.params.palette = b.getAttribute('data-pal');
    var bs = $('fxParams').querySelectorAll('[data-pal]'); for (var i = 0; i < bs.length; i++) { var on = bs[i] === b; bs[i].className = 'swb' + (on ? ' on' : ''); bs[i].setAttribute('aria-checked', on); } });
  function toHex(v) { if (Object.prototype.toString.call(v) === '[object Array]') return '#' + v.map(function (n) { return ('0' + (Math.max(0, Math.min(255, n | 0))).toString(16)).slice(-2); }).join(''); return v || '#ffffff'; }
  function pval(el) { if (el.getAttribute('data-num')) return parseFloat(el.value); if (el.getAttribute('data-rgb')) { var n = parseInt(el.value.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; } return el.value; }
  $('fxParams').addEventListener('input', function (e) { var k = e.target.getAttribute('data-k'); if (!k) return; var v = pval(e.target); fx.params[k] = v; var s = $('fxv-' + k); if (s) s.textContent = v; });
  $('fxParams').addEventListener('change', function (e) { var k = e.target.getAttribute('data-k'); if (k) fx.params[k] = pval(e.target); });
  bind('fxSel', 'change', function () { fx.name = this.value; buildFx(); $('fxFwMsg').textContent = FX.defs[fx.name].firmwareOnly ? 'Firmware-only effect: previewed with the firmware reference.' : ''; });
  function lbl() { $('briV').textContent = $('bri').value + '%'; $('spdV').textContent = ($('spd').value / 100).toFixed(1) + '×'; }
  bind('bri', 'input', function () { lbl(); if (fx.colors) render(); if (cur === 'hw') hwFxSync(); }); bind('spd', 'input', lbl);
  function tick(now) {
    if (!fx.play) return; var dt = now - (fx.last || now); fx.last = now; fx.tAcc += dt * $('spd').value / 100;
    try { var D = derived(), t = fx.tAcc;
      var fo = FX.defs[fx.name] && FX.defs[fx.name].firmwareOnly; if (fo && !FWREF) throw new Error(fx.name + ' is firmware-only and esphome/tools/effects-ref.js is not available');
      if ((fx.fw || fo) && FWREF) { fx.leds = fwFrame(D, t); fx.colors = {}; for (var id2 in fx.leds) if (fx.leds.hasOwnProperty(id2)) fx.colors[id2] = fx.leds[id2][0] || [0, 0, 0]; fx.mode = 'firmware'; }
      else if (typeof FX.frameLeds === 'function') { fx.leds = FX.frameLeds(fx.name, fx.params, D, t); fx.colors = {}; for (var id in fx.leds) if (fx.leds.hasOwnProperty(id)) fx.colors[id] = fx.leds[id][0] || [0, 0, 0]; fx.mode = 'frameLeds'; }
      else { fx.leds = null; fx.colors = FX.frame(fx.name, fx.params, D, t); fx.mode = 'frame'; } } catch (e) { $('fxFwMsg').textContent = e.message; fx.play = false; fx.colors = null; fx.leds = null; }
    render(); requestAnimationFrame(tick);
  }
  function startFx() { if (fx.play) return; fx.play = true; fx.last = 0; requestAnimationFrame(tick); }
  bind('fxPlay', 'click', startFx);
  bind('fxStop', 'click', function () { fx.play = false; fx.colors = null; fx.leds = null; render(); });

  /* ---- Hardware push (generate only; nothing is sent) ---- */
  var csv = null; // {rows:[{id,mac}], src}
  function normMac(m) { return String(m || '').toLowerCase().replace(/[^0-9a-f]/g, ''); }
  function parseCsv(text, src) {
    var lines = String(text).replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); }); if (!lines.length) throw new Error('empty');
    var hd = lines[0].split(',').map(function (x) { return x.trim().toLowerCase(); }), ii = hd.indexOf('id'), mi = hd.indexOf('mac'); if (ii < 0) throw new Error('tiles.csv needs an id column');
    return { rows: lines.slice(1).map(function (l) { var c = l.split(','); return { id: (c[ii] || '').trim(), mac: mi >= 0 ? (c[mi] || '').trim() : '' }; }), src: src };
  }
  function nodeName() { var m = st.master || 'c0'; return 'hex_' + (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(m) ? normMac(m) : m.replace(/-/g, '_')); }
  /* tile_id = 1-based row in esphome/tiles.csv, matched by tile id, then by mac (tile mac or a MAC-style id) */
  function hwBuild() {
    var out = { entries: [], problems: [], perTile: [] }, i, t, v = LF.validate(st);
    for (i = 0; i < v.length; i++) if (/^(pos|rotDeg|order)$/.test(v[i].field)) out.problems.push((v[i].tile != null ? (st.tiles[v[i].tile].id || 'tile ' + v[i].tile) + ': ' : '') + v[i].msg);
    if (!csv) { out.problems.push('tiles.csv not loaded'); return out; }
    for (i = 0; i < st.tiles.length; i++) {
      t = st.tiles[i]; var num = -1, k;
      for (k = 0; k < csv.rows.length && num < 0; k++) if (t.id && csv.rows[k].id === t.id) num = k + 1;
      for (k = 0; k < csv.rows.length && num < 0; k++) { var cm = normMac(csv.rows[k].mac || csv.rows[k].id), tm = normMac(t.mac) || normMac(t.id); if (cm.length === 12 && cm === tm) num = k + 1; }
      if (num < 0) { out.problems.push((t.id || 'tile at ' + t.q + ',' + t.r) + ' is not in tiles.csv'); continue; }
      if (num > 250) { out.problems.push(t.id + ': tile_id ' + num + ' > 250'); continue; }
      var e = { tile_id: num, q: t.q, r: t.r, rotation: LF.rotDeg(t), order: LF.order(t, i), id: t.id };
      out.entries.push(e);
    }
    out.bulk = out.entries.map(function (e) { return e.tile_id + ':' + e.q + ':' + e.r + ':' + e.rotation + ':' + e.order; }).join(';');
    return out;
  }
  function hwSync() {
    var b = hwBuild(), nn = nodeName();
    $('hwSrc').textContent = csv ? 'tiles.csv: ' + csv.src + ' (' + csv.rows.length + ' rows) · service node: ' + nn + ' (master)' : 'tiles.csv not loaded yet.';
    $('hwErr').innerHTML = b.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + (b.problems.length ? '<li><b>Fix these first: one bad entry makes the tile reject the whole string.</b></li>' : '');
    $('hwBulk').value = b.problems.length ? '' : b.bulk; $('hwCopy').disabled = !!b.problems.length; $('hwCopyYaml').disabled = !!b.problems.length;
    $('hwYaml').value = b.problems.length ? '' : '# Bulk (all tiles)\naction: esphome.' + nn + '_set_layout_bulk\ndata:\n  layout: "' + b.bulk + '"\n\n# Per tile (resend one that did not ack)\n' +
      '# Sync mode (DESIGN.md: master-only select; sync_pin ' + LF.normPin(st.sync.pin || 'GPIO12') + ' is a compile-time substitution)\naction: select.select_option\ntarget:\n  entity_id: select.' + nn + '_sync_mode\ndata:\n  option: "' + (st.sync.mode === 'jumper' ? 'Jumper wire' : 'Wireless (ESP-NOW)') + '"\n\n' +
      b.entries.map(function (e) { return '# ' + e.id + '\naction: esphome.' + nn + '_set_tile_layout\ndata: {tile_id: ' + e.tile_id + ', q: ' + e.q + ', r: ' + e.r + ', rotation: ' + e.rotation + ', order: ' + e.order + '}'; }).join('\n---\n');
    $('hwCsvBox').open = !csv; hwFxSync(); return b;
  }
  /* ---- Wall effect snippet (esphome.hex_<master>_set_wall_fx), built from the preview ---- */
  // fallback only; effects.json hexsyncId wins. spiral and sparkle have no firmware id.
  var FW_ID = { solid: 0, ripple: 1, rainbow_sweep: 2, breathe: 3, chase: 4, wipe: 5, rainbow_flow: 6, random_ripple: 7, twinkle: 8, color_cycle: 9, snake: 10 };
  var FW_PAL = ['rainbow', 'ocean', 'sunset', 'forest', 'fire', 'mono'];
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rgbToHsv255(c) { c = Object.prototype.toString.call(c) === '[object Array]' ? c : (function (h) { var n = parseInt(String(h || '#ffffff').slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; })(c);
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360;
    return [Math.round(h * 255 / 360) % 256, Math.round(mx ? d / mx * 255 : 0), Math.round(mx * 255)]; }
  /* returns {P, note} or {error}. speed in milli-cycles/s (0-10000), scale x100 */
  function fwParams() {
    var n = fx.name, p = fx.params, df = FX.defs[n] || {}, id = df.hexsyncId != null ? df.hexsyncId : (FX.defs[n] && 'hexsyncId' in FX.defs[n] ? null : FW_ID[n]);
    if (id == null) return { error: 'The preview effect "' + n + '" has no firmware id, so it can\'t be sent as a wall effect.' };
    var sp = n === 'breathe' ? 1 / (p.periodS || 4) : (p.speed != null ? p.speed : 1), sc = 100, notes = [];
    if (n === 'chase') sc = (p.tail || 3) * 100; else if (n === 'rainbow_flow') sc = (p.scale || 1) * 100;
    if (n === 'ripple' && p.origin && p.origin !== st.master) notes.push('firmware radial_wave always starts at q,r = 0,0, not the chosen origin');
    if (n === 'wipe' || n === 'rainbow_sweep') notes.push('axis is not a service field: set select.' + nodeName() + '_wall_wipe_axis to ' + (p.axis || 'x') + ' (shared by wipe and rainbow_sweep; x, y, ring, angle)');
    var hsv = p.color ? rgbToHsv255(p.color) : [0, 255, 255], bri = clamp(($('bri').value | 0) / 100, 0, 1), pi = FW_PAL.indexOf(p.palette);
    var P = { effect: id, palette: pi < 0 ? (p.color ? 5 : 0) : pi, speed: clamp(Math.round(sp * 1000), 0, 10000), scale: clamp(Math.round(sc), 0, 65535),
      hue: hsv[0], saturation: hsv[1], value: clamp(Math.round(hsv[2] * bri), 0, 255), start_delay_ms: clamp(parseInt($('hwDelay').value, 10) || 0, 0, 10000) };
    if (sp * 1000 > 10000) notes.push('speed capped at 10000 mc/s');
    return { P: P, note: notes.join('; ') };
  }
  function hwFxSync() {
    var r = fwParams(), nn = nodeName();
    $('hwCopyFx').disabled = !!r.error; $('hwFx').disabled = !!r.error;
    if (r.error) { $('hwFx').value = ''; $('hwFxMsg').textContent = r.error; return r; }
    var P = r.P; $('hwFxMsg').textContent = 'Effect ' + fx.name + ' → firmware id ' + P.effect + '. Axis (wipe and rainbow_sweep) is select.' + nn + '_wall_wipe_axis, not a service field. value includes the preview brightness (' + $('bri').value + '%).' + (r.note ? ' Note: ' + r.note + '.' : '');
    $('hwFx').value = 'action: esphome.' + nn + '_set_wall_fx\ndata:\n  effect: ' + P.effect + '\n  palette: ' + P.palette + '\n  speed: ' + P.speed + '\n  scale: ' + P.scale + '\n  hue: ' + P.hue + '\n  saturation: ' + P.saturation + '\n  value: ' + P.value + '\n  start_delay_ms: ' + P.start_delay_ms;
    return r;
  }
  bind('hwDelay', 'input', function () { if (+this.value > 10000) this.value = 10000; hwFxSync(); });
  bind('hwCopyFx', 'click', function () { copyText($('hwFx'), 'Wall effect YAML copied.'); });
  function copyText(el, msg) { el.select(); try { navigator.clipboard.writeText(el.value); } catch (e) { document.execCommand('copy'); } $('hwMsg').textContent = msg; }
  bind('hwCopy', 'click', function () { copyText($('hwBulk'), 'Bulk string copied.'); });
  bind('hwCopyYaml', 'click', function () { copyText($('hwYaml'), 'YAML copied.'); });
  bind('hwCsvLoad', 'click', function () { try { csv = parseCsv($('hwCsv').value, 'pasted'); $('hwMsg').textContent = ''; } catch (e) { $('hwMsg').textContent = 'tiles.csv: ' + e.message; } hwSync(); });
  if (window.fetch && location.protocol !== 'file:') fetch('../esphome/tiles.csv', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (t) { csv = parseCsv(t, 'esphome/tiles.csv'); if (cur === 'hw') hwSync(); }, function () {});

  window.HexApp = { state: function () { return st; }, derived: derived, fx: fx, FX: function () { return FX; }, hw: hwBuild, fwParams: fwParams, fwRef: function () { return FWREF; } }; // test hook
  lbl(); setVB(); fit(); render(); loadRemote(buildFx);
})();
