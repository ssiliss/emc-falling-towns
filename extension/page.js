// Runs inside legacymap.earthmc.net (the Leaflet map). Highlights the towns that fall at the next daily run,
// dims every other town, marks the nearest teleports, and adds a filter panel.
// Keep this file pure ASCII: symbols below are \u escapes so no tool or charset can garble them.
(() => {
  if (window.__emcFall) return;
  window.__emcFall = true;

  const VERSION = "0.6.0";  // shown in the panel header, so it is clear which version Chrome is running

  const DOT = " \u00b7 ", LOCK = "\ud83d\udd12", UNLOCK = "\ud83d\udd13", ARROW = "\u21b3 ", COIN = "\ud83d\udcb0", DASH = "\u2013";
  const COLORS = {
    // light fill so the map stays readable inside the town, strong outline so it still stands out
    closed: { fillColor: "#ff2b2b", color: "#ff1111", fillOpacity: 0.16, opacity: 1, weight: 4 },
    open: { fillColor: "#ffe600", color: "#ffe600", fillOpacity: 0.16, opacity: 1, weight: 4 },
    tp: { fillColor: "#2ecc71", color: "#2ecc71", fillOpacity: 0.14, opacity: 1, weight: 3 },
    dim: { fillColor: "#ffffff", color: "#ffffff", fillOpacity: 0.1, opacity: 0.3, weight: 1 },
    lastFell: { fillColor: "#ff4fa3", color: "#ff2d95", fillOpacity: 0.16, opacity: 1, weight: 4 },
  };
  const DEFAULT_PREFS = { enabled: true, day: "0", closed: true, open: true, minChunks: "", maxChunks: "", nation: "", tp: "near", dim: true, collapsed: false };
  const norm = (s) => String(s).toLowerCase().replace(/_/g, " ").trim();
  const pretty = (s) => String(s).replace(/_/g, " ");

  const state = { busy: false, retry: null, lastLayer: null, lastIdx: new Map(), map: null, data: null, error: "Loading data...", idx: new Map(), epoch: 1, prefs: loadPrefs(), open: null, ui: {} };
  window.__emcState = state;

  function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("emcfall-prefs") || "{}") }; } catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs() { try { localStorage.setItem("emcfall-prefs", JSON.stringify(state.prefs)); } catch { /* storage unavailable */ } }

  // ---- capture the Leaflet map: it is not exposed, so wait for the first event it fires ----
  const hookTimer = setInterval(() => {
    if (!(window.L && window.L.Map)) return;
    clearInterval(hookTimer);
    const fire = L.Map.prototype.fire;
    L.Map.prototype.fire = function () {
      if (!state.map && this instanceof L.Map) state.map = this;
      return fire.apply(this, arguments);
    };
  }, 30);

  // ---- data from the bot (through content.js and the background worker) ----
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.src !== "emcfall-content" || e.data.type !== "data") return;
    clearTimeout(state.waiting);
    state.waiting = null;
    state.busy = false;
    if (e.data.ok) { state.data = e.data.data; state.error = null; } else { state.error = e.data.error; scheduleRetry(); }
    changed();
  });
  const requestData = () => {
    window.postMessage({ src: "emcfall-page", type: "fetch" }, window.location.origin);
    // no reply at all means the extension's background part isn't running: say so instead of waiting forever
    if (!state.waiting) state.waiting = setTimeout(() => {
      state.waiting = null;
      state.busy = false;
      scheduleRetry();
      if (!state.data) { state.error = "No answer from the extension - open chrome://extensions, press the reload icon on this extension, then refresh the map page."; renderList(); }
    }, 8000);
  };
  // while the bot can't be reached (not started yet, PC just woke up...) keep trying every 15 seconds
  function scheduleRetry() {
    if (!state.retry) state.retry = setTimeout(() => { state.retry = null; requestData(); }, 15000);
  }
  const firstTimer = setInterval(() => { if (state.data) clearInterval(firstTimer); else requestData(); }, 3000);
  setTimeout(requestData, 400);
  setInterval(requestData, 5 * 60 * 1000);

  // ---- polygons ----
  function keyOf(layer) {
    if (layer.__emcKey !== undefined) return layer.__emcKey;
    let key = null;
    try {
      const tip = layer.getTooltip && layer.getTooltip();
      if (tip) {
        const html = typeof tip._content === "function" ? tip._content(layer) : tip._content;
        const m = /<b>([^<]+)<\/b>/.exec(String(html));
        if (m) key = norm(m[1]);
      }
    } catch { /* not a town polygon */ }
    layer.__emcKey = key;
    return key;
  }
  function eachTown(fn) {
    if (!state.map) return;
    state.map.eachLayer((l) => {
      if (!(l instanceof L.Polygon)) return;
      const key = keyOf(l);
      if (key) fn(l, key);
    });
  }

  // ---- what to highlight ----
  function selectedFalling() {
    const d = state.data;
    if (!d) return [];
    const p = state.prefs;
    const min = p.minChunks === "" ? 0 : +p.minChunks, max = p.maxChunks === "" ? Infinity : +p.maxChunks, nat = norm(p.nation);
    const days = p.day === "all" ? d.days : d.days.filter((x) => String(x.index) === String(p.day));
    const out = [];
    for (const day of days) for (const t of day.towns) {
      if (t.open ? !p.open : !p.closed) continue;
      if (t.chunks < min || t.chunks > max) continue;
      if (nat && !norm(t.nation || "").includes(nat)) continue;
      out.push({ ...t, dayIndex: day.index, at: day.at });
    }
    return out.sort((a, b) => (a.open - b.open) || (b.chunks - a.chunks));
  }

  // towns that fell at the last run: the bot froze them an hour before it, so they look the same before and after
  function selectedLast() {
    const d = state.data;
    if (!d || !d.lastRun) return [];
    const p = state.prefs;
    const min = p.minChunks === "" ? 0 : +p.minChunks, max = p.maxChunks === "" ? Infinity : +p.maxChunks, nat = norm(p.nation);
    return d.lastRun
      .filter((r) => r.chunks >= min && r.chunks <= max && (!nat || norm(r.nation || "").includes(nat)))
      .map((r) => ({ ...r, lastRun: true }))
      .sort((a, b) => (b.gold - a.gold) || (b.chunks - a.chunks));
  }
  const selected = () => (state.prefs.day === "-1" ? selectedLast() : selectedFalling());
  const styleOf = (t) => (t.lastRun ? COLORS.lastFell : (t.open ? COLORS.open : COLORS.closed));

  // squaremap maps world (x, z) to Leaflet as [-z / 32, x / 32]  (measured on two one-chunk towns)
  const LL = (x, z) => [-z / 32, x / 32];

  // outline of a set of chunks: edges shared by two chunks cancel out, what is left are the border loops
  function outlineRings(blocks) {
    const edges = new Map();
    const add = (x1, z1, x2, z2) => {
      const back = `${x2},${z2}>${x1},${z1}`;
      if (edges.has(back)) edges.delete(back); else edges.set(`${x1},${z1}>${x2},${z2}`, [x1, z1, x2, z2]);
    };
    for (const [x, z] of blocks) {
      add(x, z, x + 1, z); add(x + 1, z, x + 1, z + 1); add(x + 1, z + 1, x, z + 1); add(x, z + 1, x, z);
    }
    const from = new Map();
    for (const e of edges.values()) { const k = `${e[0]},${e[1]}`; (from.get(k) || from.set(k, []).get(k)).push(e); }
    const id = (e) => `${e[0]},${e[1]}>${e[2]},${e[3]}`;
    const used = new Set(), rings = [];
    for (const first of edges.values()) {
      if (used.has(id(first))) continue;
      const ring = [];
      let e = first;
      while (e && !used.has(id(e))) {
        used.add(id(e));
        ring.push([e[0], e[1]]);
        e = (from.get(`${e[2]},${e[3]}`) || []).find((n) => !used.has(id(n)));
      }
      const pts = ring.filter((p, i) => {   // drop points in the middle of a straight run
        const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
        return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
      });
      if (pts.length >= 3) rings.push(pts);
    }
    return rings;
  }

  // towns that already fell are no longer drawn by the map, so draw them ourselves
  function drawLast() {
    if (!state.map) return;
    if (state.lastLayer) { state.lastLayer.remove(); state.lastLayer = null; }
    state.lastIdx = new Map();
    const items = selected().filter((r) => r.lastRun);
    if (!state.prefs.enabled || !items.length) return;
    const group = L.layerGroup();
    for (const r of items) {
      const blocks = r.blocks && r.blocks.length ? r.blocks : [[Math.floor(r.x / 16), Math.floor(r.z / 16)]];
      const label = `${pretty(r.name)} - ${Math.round(r.gold)}g`;
      const rings = outlineRings(blocks).map((ring) => ring.map(([x, z]) => LL(x * 16, z * 16)));
      const poly = L.polygon(rings, { ...COLORS.lastFell }).bindTooltip(label);
      group.addLayer(poly);
      state.lastIdx.set(norm(r.name), poly.getBounds());
    }
    group.addTo(state.map);
    state.lastLayer = group;
  }

  function applyStyles() {
    if (!state.map) return;
    const p = state.prefs, sel = selected();
    const hit = new Map(sel.map((t) => [norm(t.name), t]));
    const tpSet = new Set();
    if (p.tp === "near") sel.forEach((t) => t.tp.forEach((x) => tpSet.add(norm(x.name))));
    else if (p.tp === "all" && state.data) state.data.tpTowns.forEach((n) => tpSet.add(norm(n)));
    const front = [];
    state.idx = new Map();
    eachTown((l, key) => {
      state.idx.set(key, l);
      if (!l.__emcOrig) l.__emcOrig = { fillColor: l.options.fillColor, color: l.options.color, fillOpacity: l.options.fillOpacity, opacity: l.options.opacity, weight: l.options.weight };
      let style;
      if (!p.enabled) style = l.__emcOrig;
      else if (hit.has(key)) { style = styleOf(hit.get(key)); front.push(l); }
      else if (tpSet.has(key)) { style = COLORS.tp; front.push(l); }
      else style = p.dim ? COLORS.dim : l.__emcOrig;
      l.setStyle(style);
      l.__emcEpoch = state.epoch;
    });
    front.forEach((l) => l.bringToFront());
    drawLast();
  }

  // squaremap re-creates the polygons on its own refresh: restyle whenever some are new
  setInterval(() => {
    if (!state.map) return;
    let stale = false;
    eachTown((l) => { if (l.__emcEpoch !== state.epoch) stale = true; });
    if (stale) applyStyles();
  }, 1500);

  function changed() { state.epoch++; applyStyles(); renderList(); }

  function focusTown(name) {
    if (!state.map) return false;
    const l = state.idx.get(norm(name));
    const bounds = l ? l.getBounds() : state.lastIdx.get(norm(name));
    if (!bounds) return false;
    state.map.fitBounds(bounds.pad(3));
    return true;
  }

  // ---- panel ----
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    kids.forEach((k) => e.append(k));
    return e;
  };
  const css = `
    #emcfall{position:fixed;top:10px;right:10px;width:320px;max-height:88vh;display:flex;flex-direction:column;z-index:10000;
      background:rgba(18,20,26,.95);color:#e8e8ee;font:13px/1.4 system-ui,"Segoe UI",sans-serif;border:1px solid #444;border-radius:8px;box-shadow:0 2px 12px #000a}
    #emcfall header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #333;cursor:default;flex:0 0 auto}
    #emcfall header b{flex:1;font-size:14px}
    #emcfall .ver{color:#889;font-size:11px}
    #emcfall button{background:#2a2d36;color:#e8e8ee;border:1px solid #555;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit}
    #emcfall .body{padding:8px 10px;overflow:auto}
    #emcfall > .body:last-child{flex:1 1 auto;min-height:0}
    #emcfall .row{display:flex;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap}
    #emcfall select,#emcfall input[type=text],#emcfall input[type=number]{background:#23262f;color:#e8e8ee;border:1px solid #555;border-radius:4px;padding:2px 4px;font:inherit}
    #emcfall input[type=number]{width:70px}
    #emcfall .statusbar{padding:6px 10px 0;flex:0 0 auto}
    #emcfall .status{font-size:12px;color:#9fd3ff}
    #emcfall .status.err{color:#ff8a8a}
    #emcfall .item{padding:4px 6px;border-radius:4px;cursor:pointer;border-left:4px solid}
    #emcfall .item:hover{background:#2a2d36}
    #emcfall .item.closed{border-color:#ff2b2b}
    #emcfall .item.open{border-color:#ffe600}
    #emcfall .item.last{border-color:#ff4fa3}
    #emcfall .sub{color:#aab;font-size:12px}
    #emcfall .details{margin:2px 0 6px 10px;padding-left:8px;border-left:2px solid #444}
    #emcfall .tp{color:#2ecc71;cursor:pointer;text-decoration:underline}
  `;

  function buildPanel() {
    document.head.append(el("style", { textContent: css }));
    const u = state.ui;
    u.status = el("div", { className: "status" });
    u.list = el("div");
    u.count = el("div", { className: "sub" });
    const p = state.prefs;
    const bind = (node, key, kind = "value") => {
      node[kind] = p[key];
      node.addEventListener("input", () => { p[key] = kind === "checked" ? node.checked : node.value; savePrefs(); changed(); });
      return node;
    };
    const day = el("select");
    day.append(el("option", { value: "-1", textContent: "Fell at last run" }));
    day.append(el("option", { value: "0", textContent: "Next fall" }));
    for (let i = 1; i <= 6; i++) day.append(el("option", { value: String(i), textContent: `+${i} day${i > 1 ? "s" : ""}` }));
    day.append(el("option", { value: "all", textContent: "All days" }));
    const tp = el("select");
    [["near", "TPs near highlighted"], ["all", "All TP towns"], ["off", "No TP marks"]].forEach(([v, t]) => tp.append(el("option", { value: v, textContent: t })));
    const lab = (text, node) => el("label", {}, node, " " + text);
    u.fallRows = el("div", {},
      el("div", { className: "row" }, "Day ", bind(day, "day")),
      el("div", { className: "row" }, lab("Closed", bind(el("input", { type: "checkbox" }), "closed", "checked")), lab("Open (can still be saved)", bind(el("input", { type: "checkbox" }), "open", "checked"))),
      el("div", { className: "row" }, "Chunks ", bind(el("input", { type: "number", min: 0, placeholder: "min" }), "minChunks"), DASH, bind(el("input", { type: "number", min: 0, placeholder: "max" }), "maxChunks")),
      el("div", { className: "row" }, "Nation ", bind(el("input", { type: "text", placeholder: "contains..." }), "nation")));
    u.body = el("div", { className: "body" },
      u.fallRows,
      el("div", { className: "row" }, bind(tp, "tp"), lab("Dim others", bind(el("input", { type: "checkbox" }), "dim", "checked"))),
      u.count, u.list);
    const refresh = el("button", { title: "Fetch fresh data now", textContent: "Refresh" });
    refresh.onclick = () => { state.busy = true; renderStatus(); requestData(); };
    const toggle = el("button", { title: "Turn the highlighting on/off", textContent: "On/Off" });
    toggle.onclick = () => { p.enabled = !p.enabled; savePrefs(); changed(); };
    const fold = el("button", { title: "Collapse", textContent: DASH });
    const sync = () => { u.body.style.display = p.collapsed ? "none" : ""; u.status.parentElement.style.display = p.collapsed ? "none" : ""; };
    fold.onclick = () => { p.collapsed = !p.collapsed; savePrefs(); sync(); };
    document.body.append(el("div", { id: "emcfall" }, el("header", {}, el("b", { textContent: "Falling towns" }), el("span", { className: "ver", textContent: "v" + VERSION }), refresh, toggle, fold), el("div", { className: "statusbar" }, u.status), u.body));
    sync();
    renderList();
  }

  const timeStr = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function renderStatus() {
    const u = state.ui;
    if (!u.status) return;
    if (state.busy) { u.status.textContent = "Refreshing..."; u.status.className = "status"; return; }
    if (state.error) { u.status.textContent = state.error; u.status.className = "status err"; return; }
    if (!state.data) { u.status.textContent = "Loading..."; u.status.className = "status"; return; }
    const mins = Math.max(0, Math.round((Date.now() - state.data.dataAt) / 60000));
    u.status.textContent = `Data updated ${timeStr(state.data.dataAt)} (${mins} min ago)` + (mins > 90 ? " - data is late, try again later" : "");
    u.status.className = "status" + (mins > 45 ? " err" : "");
  }
  setInterval(renderStatus, 30000);

  function renderList() {
    const u = state.ui;
    if (!u.list) return;
    renderStatus();
    const lastRun = state.prefs.day === "-1";
    const sel = selected();
    if (lastRun) {
      u.count.textContent = state.data ? `${sel.length} towns fell at ${timeStr(state.data.lastRunAt)}${DOT}${Math.round(sel.reduce((a, r) => a + r.gold, 0))}g in their banks` : "";
    } else {
      const dayInfo = state.data && state.prefs.day !== "all" ? state.data.days.find((d) => String(d.index) === String(state.prefs.day)) : null;
      u.count.textContent = state.data ? `${sel.length} towns${DOT}fall ${dayInfo ? "at " + timeStr(dayInfo.at) : "in the next 7 runs"}` : "";
    }
    u.list.replaceChildren(...sel.map((t) => {
      const cls = t.lastRun ? "last" : (t.open ? "open" : "closed");
      const nether = t.nx == null ? "" : `nether ${t.nx}, ${t.nz}`;
      const head = t.lastRun
        ? [`${COIN} ${pretty(t.name)} `, el("span", { className: "sub", textContent: `${Math.round(t.gold)}g${DOT}${t.chunks} chunks` })]
        : [`${t.open ? UNLOCK : LOCK} ${pretty(t.name)} `, el("span", { className: "sub", textContent: `(${t.nation ? pretty(t.nation) : "no nation"})${DOT}${t.chunks} chunks` + (state.prefs.day === "all" ? `${DOT}+${t.dayIndex}d` : "") })];
      const item = el("div", { className: "item " + cls }, el("div", {}, ...head), el("div", { className: "sub", textContent: nether }));
      const key = norm(t.name);
      item.onclick = () => {
        focusTown(t.name);
        state.open = state.open === key ? null : key;
        renderList();
      };
      if (state.open === key) {
        const info = t.lastRun
          ? `Fell at the last run${DOT}bank ${Math.round(t.gold)}g${DOT}spawn ${t.x}, ${t.z}`
          : `Mayor ${t.mayor}, offline ${t.offlineDays}d${DOT}${t.residents} resident${t.residents === 1 ? "" : "s"}${t.open ? DOT + "OPEN: a new member saves it" : ""}`;
        const d = el("div", { className: "details sub" }, info);
        t.tp.forEach((x) => {
          const link = el("span", { className: "tp", textContent: pretty(x.name) });
          link.onclick = (ev) => { ev.stopPropagation(); focusTown(x.name); };
          d.append(el("div", {}, ARROW, link, ` ${x.dist} blocks`));
        });
        if (!t.tp.length) d.append(el("div", { textContent: "No TP-enabled town found." }));
        item.append(d);
      }
      return item;
    }));
  }

  const ready = () => { if (!document.getElementById("emcfall")) buildPanel(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
