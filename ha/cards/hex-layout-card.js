/* hex-layout-card v1 - honeycomb layout for Hex lights. No build step. */
const HLC_VERSION = "2";
const SQ3 = Math.sqrt(3);

class HexLayoutCard extends HTMLElement {
  static getStubConfig() { return { layout_id: "hex_layout_quin", layout: { tiles: {}, groups: [] } }; }
  setConfig(config) {
    this._config = Object.assign({ layout_id: "hex_layout_quin", pattern: "^light\\.hex_.*_light$", size: 34, orientation: "pointy" }, config || {});
    const l = this._config.layout || {};
    this._layout = { tiles: Object.assign({}, l.tiles || {}), groups: (l.groups || []).map(g => ({ name: g.name, entities: [...(g.entities || [])] })) };
    this._edit = this._edit || false; this._sel = new Set(); this._dirty = false;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }
  set hass(h) { const first = !this._hass; this._hass = h; if (first || !this._drag) this._render(); }
  getCardSize() { return 5; }
  getGridOptions() { return { columns: 12, min_rows: 4 }; }

  _lights() {
    const re = new RegExp(this._config.pattern);
    return Object.keys(this._hass ? this._hass.states : {}).filter(e => re.test(e)).sort();
  }
  _name(e) {
    const st = this._hass && this._hass.states[e];
    let n = (st && st.attributes.friendly_name) || e;
    const m = e.match(/^light\.hex_(\d+)_light$/);
    if (m) n = "Hex " + m[1];
    return n.replace(/\btiles?\b/gi, "").replace(/\s+/g, " ").trim();
  }
  _color(e) {
    const st = this._hass && this._hass.states[e];
    if (!st || st.state !== "on") return { fill: "rgba(255,255,255,0.10)", on: false, b: 0 };
    const a = st.attributes; let rgb = a.rgb_color || [255, 214, 160];
    // Prefer what the tile is actually showing: sensor.hex_NN_displayed_color (#RRGGBB, brightness-scaled),
    // normalized so the max channel is 255 (hue only); intensity still comes from the light's brightness.
    const ds = this._hass.states[e.replace(/^light\./, "sensor.").replace(/_light$/, "_displayed_color")];
    const m = ds && /^#([0-9a-f]{6})$/i.exec(ds.state || "");
    if (m) {
      const v = [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)), mx = Math.max(...v);
      if (mx > 0) rgb = v.map(c => Math.round(c * 255 / mx));
    }
    const b = a.brightness == null ? 255 : a.brightness;
    return { fill: `rgb(${rgb.join(",")})`, on: true, b, op: 0.35 + 0.65 * (b / 255) };
  }
  // axial (q,r) -> pixel
  _px(q, r) {
    const s = this._config.size;
    return this._config.orientation === "flat"
      ? { x: s * 1.5 * q, y: s * SQ3 * (r + q / 2) }
      : { x: s * SQ3 * (q + r / 2), y: s * 1.5 * r };
  }
  _cell(x, y) {
    const s = this._config.size; let q, r;
    if (this._config.orientation === "flat") { q = (2 / 3 * x) / s; r = (-x / 3 + SQ3 / 3 * y) / s; }
    else { q = (SQ3 / 3 * x - y / 3) / s; r = (2 / 3 * y) / s; }
    let rx = Math.round(q), rz = Math.round(r), ry = Math.round(-q - r);
    const dx = Math.abs(rx - q), dz = Math.abs(rz - r), dy = Math.abs(ry + q + r);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy <= dz) rz = -rx - ry;
    return { q: rx, r: rz };
  }
  _poly(cx, cy, rot) {
    const s = this._config.size * 0.94, off = (this._config.orientation === "flat" ? 0 : 30) + (rot || 0);
    const p = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i + off); p.push((cx + s * Math.cos(a)).toFixed(1) + "," + (cy + s * Math.sin(a)).toFixed(1)); }
    return p.join(" ");
  }

  _render() {
    if (!this._config || !this.shadowRoot) return;
    const lights = this._lights(), T = this._layout.tiles;
    const placed = lights.filter(e => T[e]), unplaced = lights.filter(e => !T[e]);
    // bounds
    const pts = placed.map(e => this._px(T[e].q, T[e].r));
    const cells = [];
    if (this._edit) { const R = 4; for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) if (Math.abs(q + r) <= R) cells.push({ q, r }); cells.forEach(c => pts.push(this._px(c.q, c.r))); }
    if (!this._edit) { const c0 = pts.length ? pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 }) : { x: 0, y: 0 }; const m = this._config.size * 3; pts.push({ x: c0.x - m, y: c0.y - m * 0.6 }, { x: c0.x + m, y: c0.y + m * 0.6 }); }
    if (!pts.length) pts.push({ x: 0, y: 0 });
    const s = this._config.size, pad = s * 1.2;
    const minX = Math.min(...pts.map(p => p.x)) - pad, maxX = Math.max(...pts.map(p => p.x)) + pad;
    const minY = Math.min(...pts.map(p => p.y)) - pad, maxY = Math.max(...pts.map(p => p.y)) + pad;
    this._vb = { minX, minY, w: maxX - minX, h: maxY - minY };
    let svg = `<svg id="svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" preserveAspectRatio="xMidYMid meet"><defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${s * 0.22}"/></filter></defs>`;
    cells.forEach(c => { const p = this._px(c.q, c.r); svg += `<polygon class="cell" points="${this._poly(p.x, p.y, 0)}"/>`; });
    placed.forEach(e => {
      const p = this._px(T[e].q, T[e].r), c = this._color(e), rot = T[e].rot || 0, sel = this._sel.has(e);
      const tg = this._tgt(), isT = tg && tg !== "All" && this._hexName(e) === tg;
      svg += `<g class="tile${sel ? " sel" : ""}${isT ? " tgt" : ""}" data-e="${e}">`;
      if (c.on) svg += `<polygon points="${this._poly(p.x, p.y, rot)}" fill="${c.fill}" opacity="${(c.op * 0.8).toFixed(2)}" filter="url(#glow)"/>`;
      svg += `<polygon class="hex" points="${this._poly(p.x, p.y, rot)}" fill="${c.fill}" fill-opacity="${c.on ? c.op.toFixed(2) : 1}"/>`;
      svg += `<text x="${p.x}" y="${p.y + 4}" class="${c.on && c.b > 150 ? "dark" : ""}">${this._name(e)}</text></g>`;
    });
    svg += `</svg>`;
    const groups = this._layout.groups;
    const anyOn = lights.some(e => this._hass && this._hass.states[e] && this._hass.states[e].state === "on");
    const chip = (label, idx, on) => `<button class="chip${on ? " on" : ""}" data-g="${idx}">${label}</button>`;
    const gOn = g => g.entities.some(e => this._hass && this._hass.states[e] && this._hass.states[e].state === "on");
    let html = `<style>${HexLayoutCard.css}</style><ha-card>
      <div class="head"><span class="title">${this._config.title || "Hex layout"}</span>
      <button class="btn" id="edit">${this._edit ? "Done" : "Edit layout"}</button></div>
      <div class="chips">${this._tgtEnt() ? `<button class="chip${this._tgt() === "All" ? " tgtchip" : ""}" data-g="all" title="Target: whole wall">All</button><button class="chip pwr${anyOn ? " on" : ""}" id="pwr" title="Turn the selected target on/off">⏻ ${this._tgt() === "All" ? "All" : this._tgt()} on/off</button>` : chip("All", "all", anyOn)}${groups.map((g, i) => chip(g.name, i, gOn(g))).join("")}</div>
      <div class="stage">${svg}</div>`;
    if (this._edit) {
      html += `<div class="edit">
        <div class="row"><b>Tray</b> ${unplaced.length ? unplaced.map(e => `<span class="tray" data-tray="${e}">${this._name(e)}</span>`).join("") : "<i>All lights placed</i>"}</div>
        <div class="row hint">Drag a light from the tray or a placed hex onto a cell. Tap placed hexes to select.</div>
        <div class="row"><button class="btn" id="rot" ${this._sel.size ? "" : "disabled"}>Rotate</button>
        <button class="btn" id="rem" ${this._sel.size ? "" : "disabled"}>Remove</button>
        <input id="gname" placeholder="Group name"/><button class="btn" id="gadd" ${this._sel.size ? "" : "disabled"}>Save group</button></div>
        ${groups.length ? `<div class="row">${groups.map((g, i) => `<span class="gl">${g.name} (${g.entities.length}) <a data-gdel="${i}">✕</a></span>`).join("")}</div>` : ""}
        <div class="row status">${this._status || (this._dirty ? "Unsaved changes – press Done to save" : "")}</div></div>`;
    }
    html += `</ha-card>`;
    this.shadowRoot.innerHTML = html;
    this._bind();
  }

  _svgPt(ev) {
    const svg = this.shadowRoot.getElementById("svg"), r = svg.getBoundingClientRect(), vb = this._vb;
    const sc = Math.min(r.width / vb.w, r.height / vb.h), ox = (r.width - vb.w * sc) / 2, oy = (r.height - vb.h * sc) / 2;
    return { x: (ev.clientX - r.left - ox) / sc + vb.minX, y: (ev.clientY - r.top - oy) / sc + vb.minY };
  }
  _occupied(q, r, except) { return Object.entries(this._layout.tiles).find(([e, t]) => e !== except && t.q === q && t.r === r); }
  _place(e, ev) {
    const p = this._svgPt(ev), c = this._cell(p.x, p.y);
    if (this._occupied(c.q, c.r, e)) { this._status = "That cell is taken"; return; }
    this._layout.tiles[e] = Object.assign({}, this._layout.tiles[e] || {}, { q: c.q, r: c.r }); this._dirty = true; this._status = "";
  }

  _bind() {
    const $ = id => this.shadowRoot.getElementById(id);
    $("edit").onclick = () => { if (this._edit && this._dirty) this._save(); this._edit = !this._edit; this._sel.clear(); this._render(); };
    this.shadowRoot.querySelectorAll(".chip").forEach(b => b.onclick = () => {
      const g = b.dataset.g, ents = g === "all" ? this._lights() : this._layout.groups[+g].entities;
      const toggle = () => {
        const on = ents.some(e => this._hass.states[e] && this._hass.states[e].state === "on");
        this._hass.callService("light", on ? "turn_off" : "turn_on", { entity_id: ents });
      };
      if (g === "all" && this._tgtEnt()) this._setTgt("All"); else toggle();
    });
    const pw = $("pwr");
    if (pw) pw.onclick = () => {
      const tg = this._tgt(), ents = !tg || tg === "All" ? this._lights() : this._lights().filter(e => this._hexName(e) === tg);
      // all on -> off; any off (mixed or all off) -> on, so a stray off tile is brought back, never the reverse
      const allOn = ents.length && ents.every(e => this._hass.states[e] && this._hass.states[e].state === "on");
      this._hass.callService("light", allOn ? "turn_off" : "turn_on", { entity_id: ents });
    };
    this.shadowRoot.querySelectorAll(".tile").forEach(t => {
      const e = t.dataset.e; let timer, long = false, down = null, moved = false;
      t.onpointerdown = ev => {
        down = ev; long = false; moved = false;
        if (this._edit) { this._drag = e; t.setPointerCapture(ev.pointerId); return; }
        timer = setTimeout(() => { long = true; this._moreInfo(e); }, 550);
      };
      t.onpointermove = ev => { if (down && Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) > 6) { moved = true; clearTimeout(timer); } };
      t.onpointerup = ev => {
        clearTimeout(timer);
        if (this._edit) { this._drag = null; if (moved) this._place(e, ev); else { this._sel.has(e) ? this._sel.delete(e) : this._sel.add(e); } this._render(); }
        else if (!long && !moved) {
          const n = this._hexName(e), toggle = () => this._hass.callService("light", "toggle", { entity_id: e });
          // tap = select target (tap again = back to All). No double-tap toggle: two quick taps to deselect
          // were read as a double tap and switched the tile off. On/off = the power button or more-info (hold).
          if (this._tgtEnt() && n) this._setTgt(this._tgt() === n ? "All" : n);
          else toggle();
        }
        down = null;
      };
      t.oncontextmenu = ev => ev.preventDefault();
    });
    this.shadowRoot.querySelectorAll(".tray").forEach(t => {
      t.onpointerdown = ev => { this._drag = t.dataset.tray; t.setPointerCapture(ev.pointerId); t.classList.add("dragging"); };
      t.onpointerup = ev => {
        const e = this._drag; this._drag = null;
        const r = this.shadowRoot.getElementById("svg").getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) this._place(e, ev);
        else { // tap: place in first free cell near centre
          const cs=[]; for (let q=-4;q<=4;q++) for (let r=-4;r<=4;r++) if (Math.abs(q+r)<=4) cs.push({q,r,d:(Math.abs(q)+Math.abs(r)+Math.abs(q+r))/2}); cs.sort((x,y)=>x.d-y.d); const c=cs.find(c=>!this._occupied(c.q,c.r)); if (c) { this._layout.tiles[e]={q:c.q,r:c.r,rot:0}; this._dirty=true; }
        }
        this._render();
      };
    });
    if (!this._edit) return;
    $("rot").onclick = () => { this._sel.forEach(e => { const t = this._layout.tiles[e]; t.rot = ((t.rot || 0) + 60) % 360; }); this._dirty = true; this._render(); };
    $("rem").onclick = () => { this._sel.forEach(e => { delete this._layout.tiles[e]; this._layout.groups.forEach(g => g.entities = g.entities.filter(x => x !== e)); }); this._sel.clear(); this._dirty = true; this._render(); };
    $("gadd").onclick = () => {
      const n = $("gname").value.trim(); if (!n) { this._status = "Name the group first"; return this._render(); }
      const ex = this._layout.groups.find(g => g.name.toLowerCase() === n.toLowerCase());
      if (ex) ex.entities = [...this._sel]; else this._layout.groups.push({ name: n, entities: [...this._sel] });
      this._sel.clear(); this._dirty = true; this._render();
    };
    this.shadowRoot.querySelectorAll("[data-gdel]").forEach(a => a.onclick = () => { this._layout.groups.splice(+a.dataset.gdel, 1); this._dirty = true; this._render(); });
  }

  _tgtEnt() { const te = this._config.target_entity || "input_select.hex_wall_target"; return this._hass && this._hass.states[te] ? te : null; }
  _tgt() { const te = this._tgtEnt(); return te ? this._hass.states[te].state : null; }
  _hexName(e) { const m = e.match(/^light\.hex_(\d+)_light$/); return m ? `Hex ${m[1]}` : null; }
  _setTgt(opt) { const te = this._tgtEnt(); if (te) this._hass.callService("input_select", "select_option", { entity_id: te, option: opt }); }
  // single tap = select target (tap the selected hex again = All), double tap = on/off
  _tap(key, single, dbl) {
    this._taps = this._taps || {};
    if (this._taps[key]) { clearTimeout(this._taps[key]); delete this._taps[key]; dbl(); return; }
    this._taps[key] = setTimeout(() => { delete this._taps[key]; single(); }, 280);
  }
  _moreInfo(e) { this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: e }, bubbles: true, composed: true })); }

  // Persist: write the layout into this card's own config in the dashboard (shared across devices).
  async _save() {
    const id = this._config.layout_id, layout = JSON.parse(JSON.stringify(this._layout));
    try {
      const url = this._config.dashboard || (location.pathname.split("/")[1] || null);
      const cfg = await this._hass.callWS({ type: "lovelace/config", url_path: url === "lovelace" ? null : url });
      let found = false;
      const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") {
        if (o.type === "custom:hex-layout-card" && o.layout_id === id) { o.layout = layout; found = true; }
        Object.values(o).forEach(walk); } };
      walk(cfg);
      if (!found) throw new Error("card not found in dashboard");
      await this._hass.callWS({ type: "lovelace/config/save", url_path: url === "lovelace" ? null : url, config: cfg });
      this._config = Object.assign({}, this._config, { layout }); this._dirty = false; this._status = "Saved";
    } catch (err) {
      // Fallback (non-admin users): per-user frontend storage
      try { await this._hass.callWS({ type: "frontend/set_user_data", key: id, value: layout }); this._dirty = false; this._status = "Saved to your user only (" + err.message + ")"; }
      catch (e2) { this._status = "Save failed: " + e2.message; }
    }
    this._render();
  }
}
HexLayoutCard.css = `
ha-card{display:block;background:rgba(255,255,255,0.08);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,0.18);border-radius:18px;padding:12px;color:#fff}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.title{font-weight:500;font-size:16px}
.btn,.chip{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);color:#fff;border-radius:14px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.btn[disabled]{opacity:.4;cursor:default}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.chip.on{background:rgba(255,200,90,0.35);border-color:rgba(255,210,120,0.7)}.chip.tgtchip{border:2px solid #fff;font-weight:600}
.stage{width:100%;height:260px;touch-action:none}svg{width:100%;height:100%;user-select:none}
.cell{fill:rgba(255,255,255,0.03);stroke:rgba(255,255,255,0.18);stroke-dasharray:3 3}
.hex{stroke:rgba(255,255,255,0.45);stroke-width:1.5}.tile{cursor:pointer}.tile.sel .hex{stroke:#4fc3f7;stroke-width:3.5}.tile.tgt .hex{stroke:#fff;stroke-width:4;stroke-dasharray:none}
text{fill:#fff;font-size:11px;text-anchor:middle;pointer-events:none;font-family:inherit}text.dark{fill:rgba(0,0,0,0.75)}
.edit{border-top:1px solid rgba(255,255,255,0.15);margin-top:8px;padding-top:8px;font-size:13px}.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:5px 0}
.tray{background:rgba(79,195,247,0.25);border:1px solid rgba(79,195,247,0.6);border-radius:10px;padding:4px 10px;cursor:grab;touch-action:none}
.hint{opacity:.7}.status{color:#ffd27a}.gl{background:rgba(255,255,255,0.1);border-radius:10px;padding:3px 8px}.gl a{cursor:pointer;margin-left:4px}
input{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.22);border-radius:10px;color:#fff;padding:5px 8px;font:inherit;font-size:13px;width:120px}`;
customElements.get("hex-layout-card") || customElements.define("hex-layout-card", HexLayoutCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "hex-layout-card", name: "Hex layout", description: "Honeycomb layout for Hex lights" });
console.info("hex-layout-card " + HLC_VERSION);
