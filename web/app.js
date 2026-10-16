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

  /* derived tile info passed to frame(): x,y normalised 0..1, ring = hex distance from master, angle = turn 0..1 around master, index */
  function derived() {
    var T = st.tiles, out = [], mn = [1e9, 1e9], mx = [-1e9, -1e9], i, p, mi = masterIdx(), m = T[mi >= 0 ? mi : 0], mp = m ? px(m.q, m.r) : [0, 0];
    for (i = 0; i < T.length; i++) { p = px(T[i].q, T[i].r); mn = [Math.min(mn[0], p[0]), Math.min(mn[1], p[1])]; mx = [Math.max(mx[0], p[0]), Math.max(mx[1], p[1])]; }
    for (i = 0; i < T.length; i++) {
      var t = T[i]; p = px(t.q, t.r); var a = Math.atan2(p[1] - mp[1], p[0] - mp[0]) / (2 * Math.PI); if (a < 0) a += 1;
      out.push({ id: t.id || ('#' + i), name: t.name, mac: t.mac, q: t.q, r: t.r, rot: t.rot, ledCount: t.ledCount === '' ? st.led.count : t.ledCount,
        x: mx[0] > mn[0] ? (p[0] - mn[0]) / (mx[0] - mn[0]) : 0.5, y: mx[1] > mn[1] ? (p[1] - mn[1]) / (mx[1] - mn[1]) : 0.5,
        ring: m ? dist(t, m) : 0, angle: (t === m) ? 0 : a, index: i });
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
    var mi = masterIdx(), D = fx.colors ? derived() : null, bri = $('bri').value / 100;
    for (i = 0; i < st.tiles.length; i++) {
      var t = st.tiles[i], p = px(t.q, t.r), lab = t.name || t.id || '?', fill = '';
      if (D) { var c = fx.colors[D[i].id] || [0, 0, 0]; fill = ' style="fill:rgb(' + (c[0] * bri | 0) + ',' + (c[1] * bri | 0) + ',' + (c[2] * bri | 0) + ')"'; }
      var a = Math.PI / 180 * (60 * t.rot + (st.hex.orientation === 'flat' ? 30 : 0) - 90);
      h += '<g class="hx' + (i === sel ? ' sel' : '') + (bad[i] ? ' bad' : '') + '" data-i="' + i + '"><path d="' + corners(p[0], p[1], R - 2) + '"' + fill + '/>' +
        '<line class="rotmark" x1="' + (p[0] + Math.cos(a) * R * 0.55).toFixed(1) + '" y1="' + (p[1] + Math.sin(a) * R * 0.55).toFixed(1) + '" x2="' + (p[0] + Math.cos(a) * R * 0.8).toFixed(1) + '" y2="' + (p[1] + Math.sin(a) * R * 0.8).toFixed(1) + '"/>' +
        (D ? '' : '<text x="' + p[0] + '" y="' + p[1] + '">' + esc(lab.length > 9 ? lab.slice(0, 8) + '…' : lab) + '</text>') +
        (i === mi ? '<text class="star" x="' + p[0] + '" y="' + (p[1] - R * 0.5) + '">★</text>' : '') + '</g>';
    }
    gT.innerHTML = h;
    $('count').textContent = st.tiles.length + (st.tiles.length === 1 ? ' tile' : ' tiles');
    $('errs').hidden = !errs.length; $('errs').textContent = errs.length + ' issue' + (errs.length > 1 ? 's' : '');
  }
  function refresh() { render(); save(); syncPanels(); }

  /* ---- panels ---- */
  var panes = { tile: 'pTile', layout: 'pLayout', fx: 'pFx', file: 'pFile' }, cur = null;
  function show(p) {
    var wasOpen = !$('sheet').hidden; cur = p; $('sheet').hidden = !p;
    for (var k in panes) $(panes[k]).className = 'pane' + (k === p ? ' show' : '');
    $('shTitle').textContent = { tile: 'Tile', layout: 'Layout & LEDs', fx: 'Effect preview', file: 'Import / export' }[p] || '';
    $('tabLayout').className = 'btn' + (p === 'layout' ? ' on' : ''); $('tabFx').className = 'btn' + (p === 'fx' ? ' on' : ''); $('tabFile').className = 'btn' + (p === 'file' ? ' on' : '');
    syncPanels(); if (wasOpen !== !!p) { clearTimeout(fitTimer); fitTimer = setTimeout(function () { fitTimer = 0; fit(); }, 0); } // refit only when the panel opens/closes
  }
  var fitTimer = 0;
  function opts(el, list, v) { var h = ''; for (var i = 0; i < list.length; i++) { var o = list[i], val = o.v != null ? o.v : o, tx = o.t || o; h += '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(tx) + '</option>'; } el.innerHTML = h; }
  function setv(el, v) { if (document.activeElement !== el) el.value = v == null ? '' : v; }
  function syncPanels() {
    if (cur === 'tile' && st.tiles[sel]) {
      var t = st.tiles[sel], e = [];
      setv($('tId'), t.id); setv($('tName'), t.name); setv($('tMac'), t.mac); $('tRot').value = t.rot; setv($('tLed'), t.ledCount);
      for (var i = 0; i < errs.length; i++) if (errs[i].tile === sel) e.push(errs[i].msg);
      $('tIdErr').textContent = e.join(' · ');
      $('tPos').textContent = 'q ' + t.q + ', r ' + t.r + (t.id && t.id === st.master ? ' · master' : '');
      $('tMaster').textContent = t.id && t.id === st.master ? 'Is master ★' : 'Make master';
    } else if (cur === 'tile') show(null);
    if (cur === 'layout') {
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
  bind('tRot', 'change', function () { tset('rot', +this.value); });
  bind('tLed', 'input', function () { tset('ledCount', this.value === '' ? '' : Math.max(1, parseInt(this.value, 10) || 1)); });
  bind('tMaster', 'click', function () { var t = st.tiles[sel]; if (!t) return; if (!t.id) { $('tIdErr').textContent = 'Give the tile an ID first'; return; } st.master = t.id; refresh(); });
  bind('tDel', 'click', function () { if (sel < 0) return; if (st.tiles[sel].id === st.master) st.master = null; st.tiles.splice(sel, 1); sel = -1; show(null); refresh(); });
  bind('lName', 'input', function () { st.name = this.value; refresh(); });
  bind('lOri', 'change', function () { st.hex.orientation = this.value; drawGrid(); refresh(); fit(); });
  bind('lSize', 'input', function () { st.hex.sizeMm = parseFloat(this.value) || 0; refresh(); });
  bind('lPin', 'input', function () { st.led.pin = parseInt(this.value, 10) || 0; refresh(); });
  bind('lCount', 'input', function () { st.led.count = parseInt(this.value, 10) || 0; refresh(); });
  bind('lType', 'change', function () { st.led.type = this.value; refresh(); });
  bind('lOrder', 'change', function () { st.led.order = this.value; refresh(); });
  bind('lMaster', 'change', function () { st.master = this.value || null; refresh(); });
  bind('errs', 'click', function () { show('layout'); });
  bind('shClose', 'click', function () { sel = -1; show(null); render(); });
  bind('tabLayout', 'click', function () { show(cur === 'layout' ? null : 'layout'); });
  bind('tabFx', 'click', function () { show(cur === 'fx' ? null : 'fx'); });
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
    if (Object.prototype.toString.call(e) === '[object Array]') { for (var i = 0; i < e.length; i++) o[e[i].name || e[i].id] = { params: e[i].params || {} }; return o; }
    for (var k in e) if (e.hasOwnProperty(k)) o[k] = { params: (e[k] && e[k].params) || e[k] || {} };
    return o;
  }
  function paramList(p) { if (Object.prototype.toString.call(p) === '[object Array]') { var o = {}; for (var i = 0; i < p.length; i++) o[p[i].name] = p[i]; return o; } return p; }
  function loadRemote(done) {
    if (!window.fetch || location.protocol === 'file:') return done();
    fetch('../effects.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var defs = normDefs(j);
      return fetch('../tools/effects.js', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (src) {
        var m = { exports: {} }; (new Function('module', 'exports', src))(m, m.exports);
        var f = m.exports.frame || (m.exports.default && m.exports.default.frame); if (typeof f !== 'function') throw 0;
        FX = { defs: defs, frame: f, src: 'Back End effects.json + tools/effects.js' };
      }, function () { FX = { defs: defs, frame: LocalEffects.frame, src: 'Back End effects.json + local frame() fallback' }; });
    }).then(done, done);
  }
  function setOrigin(id) { fx.params.origin = id; var el = $('fxp-origin'); if (el) el.value = id; if (!fx.play) startFx(); }
  function buildFx() {
    var names = Object.keys(FX.defs); opts($('fxSel'), names, fx.name); if (names.indexOf(fx.name) < 0) fx.name = names[0];
    $('fxSrc').textContent = 'Effects: ' + FX.src;
    var p = paramList(FX.defs[fx.name].params), h = '', k; fx.params = {};
    for (k in p) if (p.hasOwnProperty(k)) {
      var d = p[k] || {}, v = d['default'], ty = d.type || (typeof v === 'number' ? 'number' : 'string');
      if (k === 'origin' || ty === 'tile') { v = st.master || (st.tiles[0] && st.tiles[0].id) || ''; var tl = []; for (var i = 0; i < st.tiles.length; i++) if (st.tiles[i].id) tl.push(st.tiles[i].id);
        h += '<label>' + k + '<select id="fxp-origin" data-k="' + k + '">' + tl.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>'; }
      else if (ty === 'color') h += '<label>' + k + '<input type="color" data-k="' + k + '" value="' + esc(v || '#ffffff') + '"></label>';
      else if (d.options || d['enum'] || ty === 'enum') { var op = d.options || d['enum'] || []; h += '<label>' + k + '<select data-k="' + k + '">' + op.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>'; }
      else if (ty === 'number' || ty === 'int' || ty === 'float') { var mn = d.min != null ? d.min : 0, mx = d.max != null ? d.max : 10, stp = ty === 'int' ? 1 : (mx - mn) / 100;
        h += '<label>' + k + ' <span class="num" id="fxv-' + k + '">' + v + '</span><input type="range" data-k="' + k + '" data-num="1" min="' + mn + '" max="' + mx + '" step="' + stp + '" value="' + v + '"></label>'; }
      else h += '<label>' + k + '<input data-k="' + k + '" value="' + esc(v == null ? '' : v) + '"></label>';
      fx.params[k] = v;
    }
    $('fxParams').innerHTML = h;
  }
  $('fxParams').addEventListener('input', function (e) { var k = e.target.getAttribute('data-k'); if (!k) return; var v = e.target.getAttribute('data-num') ? parseFloat(e.target.value) : e.target.value; fx.params[k] = v; var s = $('fxv-' + k); if (s) s.textContent = v; });
  $('fxParams').addEventListener('change', function (e) { var k = e.target.getAttribute('data-k'); if (k) fx.params[k] = e.target.getAttribute('data-num') ? parseFloat(e.target.value) : e.target.value; });
  bind('fxSel', 'change', function () { fx.name = this.value; buildFx(); });
  function lbl() { $('briV').textContent = $('bri').value + '%'; $('spdV').textContent = ($('spd').value / 100).toFixed(1) + '×'; }
  bind('bri', 'input', function () { lbl(); if (fx.colors) render(); }); bind('spd', 'input', lbl);
  function tick(now) {
    if (!fx.play) return; var dt = now - (fx.last || now); fx.last = now; fx.tAcc += dt * $('spd').value / 100;
    try { fx.colors = FX.frame(fx.name, fx.params, derived(), fx.tAcc); } catch (e) { $('fxSrc').textContent = 'Effect error: ' + e.message; fx.play = false; }
    render(); requestAnimationFrame(tick);
  }
  function startFx() { if (fx.play) return; fx.play = true; fx.last = 0; requestAnimationFrame(tick); }
  bind('fxPlay', 'click', startFx);
  bind('fxStop', 'click', function () { fx.play = false; fx.colors = null; render(); });

  window.HexApp = { state: function () { return st; }, derived: derived, fx: fx, FX: function () { return FX; } }; // test hook
  lbl(); setVB(); fit(); render(); loadRemote(buildFx);
})();
