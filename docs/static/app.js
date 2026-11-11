/* Temporal City — front end (vanilla JS + Leaflet + Chart.js) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (url, opt = {}) => {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || r.statusText);
  return j;
};

const CAT_COLOR = TC_PALETTE.category;
const LAB_COLOR = TC_PALETTE.label;
const LABELS = ["verified", "observed", "retrieved", "conflict", "estimated", "missing", "pending"];
const DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const DAYNAME = { mo: "Mon", tu: "Tue", we: "Wed", th: "Thu", fr: "Fri", sa: "Sat", su: "Sun" };

const S = {
  meta: null, areas: [], sel: new Set(), pois: [], tab: "settings", mapMode: "category",
  exLabels: new Set(["verified", "observed", "retrieved"]), exDay: "weekday", exMetric: "share",
  retCats: new Set(), chart: null, picking: false, selPoi: null, states: {},
};

/* ------------------------------------------------------------------ map (MapLibre, same basemap as the atlas) */
let map = null, mapReady = false, hoverPopup = null;
const ATLAS_STYLE = "https://tiles.openfreemap.org/styles/positron";
const fc = (features) => ({ type: "FeatureCollection", features });

function circlePolygon(lat, lon, r) {
  const coords = [];
  for (let i = 0; i <= 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    coords.push([lon + (Math.cos(a) * r) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (Math.sin(a) * r) / 111320]);
  }
  return { type: "Polygon", coordinates: [coords] };
}
function areaGeometries(a) {
  const g = a.geojson;
  if (a.kind === "circle" || (!g && a.lat != null && a.lon != null)) return [circlePolygon(a.lat, a.lon, a.radius || 400)];
  if (!g) return [];
  if (g.type === "FeatureCollection") return g.features.map((f) => f.geometry).filter(Boolean);
  if (g.type === "Feature") return [g.geometry];
  return [g];
}
function boundsOf(geoms) {
  let w = 180, so = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); so = Math.min(so, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  geoms.forEach((g) => walk(g.coordinates));
  return [[w, so], [e, n]];
}
function fitAreas(list) {
  if (!mapReady || !list.length) return;
  map.fitBounds(boundsOf(list.flatMap(areaGeometries)), { padding: 40, duration: 600, maxZoom: 16.5 });
}

function initMap() {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 5000);
  fetch(ATLAS_STYLE, { signal: ctrl.signal }).then((r) => { clearTimeout(t); if (!r.ok) throw Error(); return r.json(); })
    .then(build).catch(() => build({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#f3f5f8" } }] }));
  function build(style) {
    map = new maplibregl.Map({ container: "map", style, center: [103.851, 1.29], zoom: 13.6, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("error", () => {});
    map.on("load", () => {
      for (const l of map.getStyle().layers.filter((x) => x.type === "fill-extrusion")) map.removeLayer(l.id);
      map.addSource("areas", { type: "geojson", data: fc([]) });
      map.addSource("pois", { type: "geojson", data: fc([]) });
      map.addSource("pick", { type: "geojson", data: fc([]) });
      map.addLayer({ id: "areas-fill", type: "fill", source: "areas", paint: { "fill-color": "#9f91c9", "fill-opacity": ["case", ["get", "on"], 0.05, 0.02] } });
      map.addLayer({ id: "areas-line", type: "line", source: "areas", paint: { "line-color": ["case", ["get", "on"], "#8572ba", "#a9adbf"], "line-width": ["case", ["get", "on"], 1.5, 1], "line-dasharray": [3, 3] } });
      map.addLayer({ id: "pick-line", type: "line", source: "pick", paint: { "line-color": "#d98277", "line-width": 2, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "poi-points", type: "circle", source: "pois", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "state"], "nodata"], 1.8, 2.7], 16, ["case", ["==", ["get", "state"], "nodata"], 3.2, 5], 18, 6.5],
        "circle-color": ["get", "fill"], "circle-opacity": ["case", ["==", ["get", "state"], "nodata"], 0.55, 0.94],
        "circle-stroke-color": ["get", "stroke"], "circle-stroke-width": ["case", ["==", ["get", "state"], "closed"], 1.6, 1.2] } });
      map.on("mouseenter", "poi-points", (e) => { map.getCanvas().style.cursor = "pointer"; hoverPoi(e); });
      map.on("mousemove", "poi-points", hoverPoi);
      map.on("mouseleave", "poi-points", () => { map.getCanvas().style.cursor = ""; hoverPopup && hoverPopup.remove(); });
      map.on("click", "poi-points", (e) => { const id = e.features?.[0]?.properties?.id; if (id && !S.picking) { go("records"); openPoi(id); } });
      map.on("click", (e) => { if (S.picking) pickAt(e.lngLat); });
      mapReady = true;
      // day / night: the basemap darkens with the Explore hour; open POIs stay lit, closed ones go dark
      if (window.TCDayNight) TCDayNight.addMap(map, { ownSources: ["areas", "pois", "pick"], night: [
        ["areas-line", "line-color", ["case", ["get", "on"], "#ad91ed", "#5e6783"]],
        ["areas-fill", "fill-color", "#ad91ed"],
        ["poi-points", "circle-color", ["match", ["get", "fill"], "#ffffff", "#1c2434", "#b4bbb0", "#4e5669", ["get", "fill"]]],
        ["poi-points", "circle-stroke-color", ["match", ["get", "stroke"], "#ffffff", "#0e1423", ["get", "stroke"]]],
      ] });
      drawAreas(); drawPois();
      fitAreas(S.areas);
    });
  }
}
function hoverPoi(e) {
  const p = e.features?.[0]?.properties; if (!p) return;
  if (!hoverPopup) hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "280px", className: "poi-hover-popup" });
  hoverPopup.setLngLat(e.features[0].geometry.coordinates).setHTML(`<div class="poi-hover"><div class="poi-hover-name"><i style="background:${CAT_COLOR[p.category]}"></i><strong>${esc(p.name)}</strong></div><div class="poi-hover-meta">${esc(p.category)} · <span style="color:${LAB_COLOR[p.label]}">${esc(p.label)}</span></div><div class="poi-hover-hours">${esc(p.hours || "No usable opening hours")}</div><small>Click for sources and evidence</small></div>`).addTo(map);
}
function pickAt(ll) {
  $("#customLat").value = ll.lat.toFixed(6);
  $("#customLon").value = ll.lng.toFixed(6);
  S.picking = false;
  $("#pickHint").hidden = true;
  showPick(ll.lat, ll.lng, +$("#customRadius").value || 400);
}
function showPick(lat, lon, r) { if (mapReady) map.getSource("pick").setData(lat == null ? fc([]) : fc([{ type: "Feature", geometry: circlePolygon(lat, lon, r), properties: {} }])); }

function drawAreas() {
  if (!mapReady) return;
  map.getSource("areas").setData(fc(S.areas.flatMap((a) => areaGeometries(a).map((g) => ({ type: "Feature", geometry: g, properties: { id: a.id, name: a.name, on: S.sel.has(a.id) } })))));
}

function poiColor(p) {
  if (S.mapMode === "label") return LAB_COLOR[p.final_label] || "#999";
  if (S.mapMode === "state") {
    const st = S.states[p.id];
    return st === "open" ? CAT_COLOR[p.category] : st === "closed" ? "#ffffff" : "#b4bbb0";
  }
  return CAT_COLOR[p.category] || "#999";
}

function drawPois() {
  drawLegend();
  if (!mapReady) return;
  const visible = S.pois.filter((p) => p._areas.some((a) => S.sel.has(a)));
  map.getSource("pois").setData(fc(visible.map((p) => {
    const st = S.mapMode === "state" ? (S.states[p.id] || "nodata") : "any";
    return { type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { id: p.id, name: p.name || "(unnamed)", category: p.category, label: p.final_label, hours: p.hours_text, state: st,
        fill: poiColor(p), stroke: st === "closed" ? CAT_COLOR[p.category] : "#ffffff" } };
  })));
}

function flyToPoi(id, zoom) {
  const p = S.pois.find((x) => x.id === id);
  if (p && mapReady) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), zoom || 16), duration: 500 });
}

function drawLegend() {
  const el = $("#legend");
  if (S.mapMode === "label") {
    $("#overlayTitle").textContent = "Quality label";
    el.innerHTML = LABELS.map((l) => `<span><i class="dot" style="background:${LAB_COLOR[l]}"></i>${l}</span>`).join("");
  } else if (S.mapMode === "state") {
    $("#overlayTitle").textContent = `At ${$("#exHourLbl").textContent} · ${S.exDay === "weekday" ? "Wed" : S.exDay === "saturday" ? "Sat" : "Sun"}`;
    el.innerHTML = `<span><i class="dot" style="background:linear-gradient(135deg,${Object.values(CAT_COLOR).slice(0,6).join(',')})"></i>Open</span><span><i class="dot" style="background:#fff;box-shadow:inset 0 0 0 1.5px #8572ba"></i>Closed</span><span><i class="dot" style="background:#b4bbb0"></i>No record</span>`;
  } else {
    $("#overlayTitle").textContent = "Category";
    el.innerHTML = (S.meta ? S.meta.categories : []).map((c) => `<span><i class="dot" style="background:${CAT_COLOR[c]}"></i>${c}</span>`).join("");
  }
}

/* ------------------------------------------------------------------ tabs */
function go(tab) {
  S.tab = tab;
  if (window.TCDayNight) TCDayNight.setHour(tab === "explore" ? +$("#exHour").value : null);
  $$(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
  const mode = tab === "explore" ? "state" : ["records", "retrieve", "validate", "check"].includes(tab) ? "label" : "category";
  if (mode !== S.mapMode) { S.mapMode = mode; if (mode === "state") refreshExplore(); else drawPois(); }
  if (tab === "discover") renderDiscover();
  if (tab === "retrieve") { renderSources(); renderCoverage(); }
  if (tab === "records") renderRecords();
  if (tab === "check") renderQLabels();
  if (tab === "validate") renderValidation();
  if (tab === "explore") refreshExplore();
  if (tab === "settings") loadSettings();
  $("#panel").scrollTop = 0;
  renderSubtabs();
  renderStepbar();
}

/* ------------------------------------------------------------------ workflow: Setup + six stages */
const FLOW = [
  { tab: "settings", tabs: ["settings"], num: "00", name: "Setup", short: "APIs & proxy", optional: true,
    title: "Connect the data sources",
    how: "Optional, but best done first. Add a <b>Google Places API key</b> for the most complete opening hours, choose an <b>AI model</b> to read hours from website text, and set a <b>proxy</b> if OpenStreetMap is blocked on your network. Use <b>Test connections</b> at the bottom of this page." },
  { tab: "area", tabs: ["area"], num: "01", name: "Area", short: "Where to look",
    title: "Choose the study areas",
    how: "Add the three case studies, a MRT/LRT station catchment, a point on the map or a GeoJSON polygon. Tick the areas to work on — the next steps only use ticked areas." },
  { tab: "discover", tabs: ["discover"], num: "02", name: "Discover", short: "Find the POIs",
    title: "Find every amenity",
    how: "Queries OpenStreetMap for all amenities, shops and services inside the ticked areas, drops benches, parking and similar, and sorts the rest into six categories. About 2 s per area." },
  { tab: "retrieve", tabs: ["retrieve", "check"], num: "03", name: "Hours", short: "Opening hours",
    title: "Get the opening hours",
    how: "<b>Automatic retrieval</b> tries the OSM tag, then Google Places (if a key is set), then business websites (read by rules or AI). Then switch to <b>Google check</b> to paste hours by hand for the places still missing." },
  { tab: "records", tabs: ["records", "validate"], num: "04", name: "Review", short: "Check & validate",
    title: "Check the evidence",
    how: "Open any record to see every source, the exact evidence text and its link. In <b>Validate accuracy</b>, draw a random sample, mark each one correct or not, and the accuracy of each method is reported." },
  { tab: "explore", tabs: ["explore"], num: "05", name: "Explore", short: "Through the day",
    title: "See availability through the day",
    how: "Drag the hour to see which places are open on the map; the chart shows the share open in every hour, for weekdays and weekends." },
  { tab: "export", tabs: ["export"], num: "06", name: "Export", short: "CSV · Atlas",
    title: "Use the result",
    how: "Download CSV / GeoJSON for QGIS or the report, or open the ticked areas in the Atlas for maps, GFA and the comparison." },
];
const USABLE_LABELS = ["verified", "observed", "retrieved"];
const SUBTABS = { retrieve: [["retrieve", "Automatic retrieval"], ["check", "Google check (by hand)"]], records: [["records", "Records"], ["validate", "Validate accuracy"]] };
SUBTABS.check = SUBTABS.retrieve; SUBTABS.validate = SUBTABS.records;
function selectedPois() { return S.pois.filter((p) => p._areas.some((a) => S.sel.has(a))); }
function setupSeen() { try { return localStorage.getItem("tc-setup-seen") === "1"; } catch (e) { return false; } }
function setupParts() {
  const s = S.settings || {};
  return [
    ["Google Places", s.use_google === "1" && !!s.google_api_key],
    ["AI " + (s.llm_provider && s.llm_provider !== "none" ? s.llm_provider : "off"), !!s.llm_provider && s.llm_provider !== "none"],
    ["Proxy", !!s.proxy],
  ];
}
function stepStatus(i) {
  // [message, done?] — what this step has produced so far, for the ticked areas
  const inSel = selectedPois();
  const usable = inSel.filter((p) => USABLE_LABELS.includes(p.final_label)).length;
  const missing = inSel.filter((p) => ["missing", "pending"].includes(p.final_label)).length;
  const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  switch (FLOW[i].tab) {
    case "settings": { const on = setupParts().filter((x) => x[1]).map((x) => x[0]); return [on.length ? on.join(" · ") + " on" : setupSeen() ? "Checked · free sources only (OSM, websites)" : "Not set up yet (optional)", on.length > 0 || setupSeen()]; }
    case "area": return S.sel.size ? [`${pl(S.sel.size, "study area")} ticked`, true] : [S.areas.length ? "No area ticked" : "No study area yet", false];
    case "discover": return inSel.length ? [`${pl(inSel.length, "POI")} found`, true] : ["Not run yet for the ticked areas", false];
    case "retrieve": return inSel.length ? [`${usable} of ${inSel.length} with hours` + (missing ? ` · ${missing} missing` : ""), usable > 0] : ["Discover POIs first", false];
    case "records": return [inSel.length ? `${pl(inSel.length, "record")} to review` : "Nothing to review yet", inSel.length > 0 && usable > 0];
    case "explore": return [usable ? `${usable} POIs with hours` : "Needs opening hours", usable > 0];
    case "export": return [usable ? "Ready to export" : "Needs opening hours", usable > 0];
    default: return ["", false];
  }
}
function atlasHref() {
  // every collected study area; the Atlas has its own "Choose study areas" picker
  return "atlas.html?source=collector";
}
function renderSubtabs() {
  $$(".pane").forEach((pane) => {
    const set = SUBTABS[pane.dataset.pane]; if (!set) return;
    let bar = pane.querySelector(":scope > .subtabs");
    if (!bar) { bar = document.createElement("div"); bar.className = "subtabs"; pane.prepend(bar); }
    bar.innerHTML = set.map(([t, label]) => `<button type="button" class="${t === pane.dataset.pane ? "on" : ""}" data-goto="${t}">${label}</button>`).join("");
  });
}
function renderStepbar() {
  if (!$("#flowSteps")) return;
  const i = Math.max(0, FLOW.findIndex((f) => f.tabs.includes(S.tab)));
  if (S.tab === "settings") { try { localStorage.setItem("tc-setup-seen", "1"); } catch (e) {} }
  const st = FLOW.map((_, k) => stepStatus(k));
  // header tabs: numbers + ✓
  $$("#steps button").forEach((b) => {
    const k = FLOW.findIndex((f) => f.tab === b.dataset.tab);
    b.classList.toggle("on", k === i);
    b.classList.toggle("done", k >= 0 && st[k][1] && k !== i);
    if (k >= 0) b.dataset.num = FLOW[k].num;
  });
  $("#steps").style.setProperty("--prog", (i / (FLOW.length - 1) * 100).toFixed(1) + "%");
  document.querySelectorAll(".to-atlas, [data-atlas-link]").forEach((a) => (a.href = atlasHref()));
  // the flow diagram
  $("#flowSteps").innerHTML = FLOW.map((f, k) => `<li class="fs${k === i ? " now" : ""}${st[k][1] && k !== i ? " done" : ""}${f.optional ? " opt" : ""}">
      <button type="button" data-goto="${f.tab}" ${k === i ? 'aria-current="step"' : ""}>
        <span class="fs-num">${f.num}${st[k][1] && k !== i ? " ✓" : ""}</span><span class="fs-name">${f.name}</span><span class="fs-short">${f.short}</span>
        <span class="fs-status">${esc(st[k][0])}</span></button></li>`).join("");
  // the information box for the current step
  const f = FLOW[i], prev = FLOW[i - 1], next = FLOW[i + 1], [msg, done] = st[i];
  const chips = f.tab === "settings" ? `<div class="fi-chips">${setupParts().map(([t, on]) => `<span class="chip ${on ? "on" : "off"}">${esc(t)}</span>`).join("")}</div>` : "";
  const tip = f.tab === "area" && !setupSeen() && !setupParts().some((x) => x[1]) ? `<p class="fi-tip">Tip: open <button class="link" data-goto="settings">00 Setup</button> first to connect Google Places or an AI model — retrieval finds more hours with them.</p>` : "";
  const nextBtn = next
    ? `<button class="btn primary fi-next${done || f.optional ? " ready" : ""}" data-goto="${next.tab}">Next: ${next.num} ${next.name} <span aria-hidden="true">→</span></button>`
    : `<a class="btn primary fi-next ready" href="${atlasHref()}">Open in Atlas <span aria-hidden="true">→</span></a>`;
  $("#flowInfo").innerHTML = `<div class="fi-text">
      <div class="eyebrow">${f.optional ? "Step 00 · optional" : `Step ${f.num} of 06`} · ${f.name}</div>
      <h3>${f.title}</h3><p>${f.how}</p>${chips}
      <p class="fi-status${done ? " ok" : ""}">${done ? "✓ " : "● "}${esc(msg)}</p>${tip}</div>
    <div class="fi-btns">${prev ? `<button class="btn ghost fi-back" data-goto="${prev.tab}">← ${prev.name}</button>` : ""}${nextBtn}</div>`;
}
$$("#steps button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) go(g.dataset.goto); });

/* ------------------------------------------------------------------ areas */
async function loadAreas() {
  S.areas = await api("/api/areas");
  const ids = new Set(S.areas.map((a) => a.id));
  if (!S.selLoaded) { // restore the last selection on this computer
    S.selLoaded = true;
    try { const saved = JSON.parse(localStorage.getItem("tc-area-sel") || "null"); if (Array.isArray(saved)) { S.sel = new Set(saved.filter((id) => ids.has(id))); S.selTouched = true; } } catch (e) {}
  }
  for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
  if (!S.sel.size && !S.selTouched) S.areas.forEach((a) => S.sel.add(a.id));
  renderAreas();
  drawAreas();
  fillAreaSelects();
  renderStepbar();
}

function saveSel() { S.selTouched = true; try { localStorage.setItem("tc-area-sel", JSON.stringify([...S.sel])); } catch (e) {} }
function renderAreas() {
  $("#areaCount").textContent = S.areas.length ? `· ${S.sel.size} of ${S.areas.length} selected` : "";
  $("#selbar").hidden = S.areas.length < 2;
  $("#selHint").textContent = S.sel.size ? "" : "Nothing selected: tick the areas to work on.";
  renderStepbar();
  $("#areaList").innerHTML = S.areas.length ? S.areas.map((a) => `
    <div class="area">
      <input type="checkbox" data-sel="${a.id}" ${S.sel.has(a.id) ? "checked" : ""} title="Include in jobs">
      <div><b>${esc(a.name)}</b><div class="meta">${a.kind === "circle" ? `${a.radius} m radius` : "polygon"} · ${a.discovered_at ? `${a.n_pois} POIs` : "not discovered yet"}</div></div>
      <div class="acts"><button class="link" data-zoom="${a.id}">zoom</button><button class="link" data-del="${a.id}">remove</button></div>
    </div>`).join("") : `<p class="hint">No areas yet. Add one above.</p>`;
  $("#discoverSel").textContent = S.sel.size;
}

$("#areaList").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.sel) { t.checked ? S.sel.add(+t.dataset.sel) : S.sel.delete(+t.dataset.sel); saveSel(); renderAreas(); drawAreas(); drawPois(); }
  if (t.dataset.zoom) { const a = S.areas.find((x) => x.id === +t.dataset.zoom); fitAreas([a]); }
  if (t.dataset.del && confirmBox("Remove this area and POIs that only belong to it?")) { await api(`/api/areas/${t.dataset.del}`, { method: "DELETE" }); await loadAreas(); await loadPois(); }
});
function confirmBox(msg) { return window.confirm(msg); }
$("#selAll").onclick = () => { S.areas.forEach((a) => S.sel.add(a.id)); saveSel(); renderAreas(); drawAreas(); drawPois(); };
$("#selNone").onclick = () => { S.sel.clear(); saveSel(); renderAreas(); drawAreas(); drawPois(); };
function needSel() { if (S.sel.size) return true; go("area"); $("#selHint").textContent = "Select at least one study area first."; return false; }

async function addAreas(list) {
  try {
    const r = await api("/api/areas", { method: "POST", body: list });
    r.ids.forEach((id) => S.sel.add(id)); saveSel();
    await loadAreas();
    const last = S.areas.filter((a) => r.ids.includes(a.id));
    if (last.length) fitAreas(last);
  } catch (err) { alert(err.message); }
}

$("#addCases").onclick = () => addAreas(S.meta.case_studies.map((c) => ({ kind: "circle", ...c })));
$("#addStation").onclick = () => {
  const st = S.meta.stations.find((s) => s.name.toLowerCase() === $("#stationInput").value.trim().toLowerCase());
  if (!st) return alert("Pick a station from the list.");
  addAreas([{ kind: "circle", name: st.name.replace(/ (MRT|LRT)$/, ""), lat: st.lat, lon: st.lon, radius: +$("#stationRadius").value }]);
};
$("#addAllStations").onclick = () => {
  if (!confirmBox(`Add ${S.meta.stations.length} station catchments (${$("#stationRadius").value} m)?`)) return;
  addAreas(S.meta.stations.map((s) => ({ kind: "circle", name: s.name.replace(/ (MRT|LRT)$/, ""), lat: s.lat, lon: s.lon, radius: +$("#stationRadius").value })));
};
$("#pickOnMap").onclick = () => { S.picking = true; $("#pickHint").hidden = false; };
$("#pickCancel").onclick = () => { S.picking = false; $("#pickHint").hidden = true; };
$("#addCustom").onclick = () => {
  const lat = +$("#customLat").value, lon = +$("#customLon").value;
  if (!lat || !lon) return alert("Set a centre first (Pick on map).");
  showPick(null);
  addAreas([{ kind: "circle", name: $("#customName").value, lat, lon, radius: +$("#customRadius").value }]);
};
$("#addPoly").onclick = async () => {
  const f = $("#polyFile").files[0];
  if (!f) return alert("Choose a GeoJSON file.");
  try {
    const gj = JSON.parse(await f.text());
    const coords = JSON.stringify(gj).match(/-?\d+\.\d+/g) || [];
    if (coords.length && Math.abs(+coords[0]) > 180) return alert("Coordinates look projected (e.g. SVY21). Re-export the layer as EPSG:4326 in QGIS.");
    addAreas([{ kind: "polygon", name: $("#polyName").value || f.name.replace(/\.\w+$/, ""), geojson: gj }]);
  } catch (e) { alert("Could not read GeoJSON: " + e.message); }
};

function fillAreaSelects() {
  const opts = `<option value="">All areas</option>` + S.areas.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  for (const id of ["#exArea", "#expArea"]) { const v = $(id).value; $(id).innerHTML = opts; $(id).value = v; }
}

/* ------------------------------------------------------------------ POIs */
async function loadPois() {
  const all = await api("/api/pois");
  // area membership
  const byArea = await Promise.all(S.areas.map((a) => a.n_pois ? api(`/api/pois?area_id=${a.id}`).then((r) => [a.id, r.map((p) => p.id)]) : [a.id, []]));
  const mem = {};
  for (const [aid, ids] of byArea) for (const id of ids) (mem[id] = mem[id] || []).push(aid);
  all.forEach((p) => (p._areas = mem[p.id] || []));
  S.pois = all;
  const usable = all.filter((p) => ["verified", "observed", "retrieved"].includes(p.final_label)).length;
  $("#heroCount").innerHTML = `${all.length}<span>.</span>`;
  $("#heroCaption").textContent = all.length ? `POIs IN THE COLLECTOR · ${usable} WITH USABLE HOURS` : "POIs IN THE COLLECTOR · ADD A STUDY AREA TO START";
  drawPois();
  renderStepbar();
}

/* ------------------------------------------------------------------ discover */
function renderDiscover() {
  $("#discoverSel").textContent = S.sel.size;
  const rows = S.areas.filter((a) => a.discovery_stats);
  $("#discoverResults").innerHTML = rows.length ? `<h3 class="sec">Results</h3><table class="t"><tr><th>Area</th><th>Raw OSM</th><th>Removed</th><th>POIs</th><th>OSM hours</th></tr>` +
    rows.map((a) => { const s = a.discovery_stats; return `<tr><td>${esc(a.name)}</td><td>${s.raw}</td><td>${s.non_functional}</td><td><b>${s.kept}</b></td><td>${s.with_osm_hours} (${s.kept ? Math.round(100 * s.with_osm_hours / s.kept) : 0}%)</td></tr>`; }).join("") +
    `</table>` + catBreakdown(rows) : "";
}
function catBreakdown(rows) {
  const tot = {};
  rows.forEach((a) => Object.entries(a.discovery_stats.by_category || {}).forEach(([k, v]) => (tot[k] = (tot[k] || 0) + v)));
  return `<div class="chips" style="margin-top:10px">` + S.meta.categories.map((c) => `<span class="chip"><span class="dot" style="background:${CAT_COLOR[c]}"></span>${c} ${tot[c] || 0}</span>`).join("") + `</div>`;
}
$("#runDiscover").onclick = () => needSel() && startJob("discover", { area_ids: [...S.sel] });

/* ------------------------------------------------------------------ retrieve */
let SETTINGS = null;
async function renderSources() {
  SETTINGS = await api("/api/settings");
  const s = SETTINGS, on = (v) => v === "1";
  const items = [
    ["OSM opening_hours", true],
    ["Google Places", on(s.use_google) && !!s.google_api_key],
    ["Websites", on(s.use_web)],
    ["Web search", on(s.use_web) && on(s.use_search)],
    ["AI: " + (s.llm_provider === "none" ? "off" : s.llm_provider + (s.llm_model ? " · " + s.llm_model : "")), s.llm_provider !== "none"],
    ["Cross-check", on(s.cross_check)],
  ];
  $("#sourceSummary").innerHTML = items.map(([t, v]) => `<span class="chip ${v ? "on" : "off"}">${esc(t)}</span>`).join("");
  $("#retCats").innerHTML = S.meta.categories.map((c) => `<span class="chip ${S.retCats.size === 0 || S.retCats.has(c) ? "on" : "off"}" data-c="${esc(c)}"><span class="dot" style="background:${CAT_COLOR[c]}"></span>${c}</span>`).join("");
}
$("#retCats").addEventListener("click", (e) => {
  const c = e.target.closest(".chip")?.dataset.c; if (!c) return;
  if (S.retCats.size === 0) S.meta.categories.forEach((x) => S.retCats.add(x));
  S.retCats.has(c) ? S.retCats.delete(c) : S.retCats.add(c);
  if (S.retCats.size === S.meta.categories.length) S.retCats.clear();
  renderSources();
});
$("#runRetrieve").onclick = () => needSel() && startJob("retrieve", {
  area_ids: [...S.sel], limit: +$("#retLimit").value, only_new: $("#retOnlyNew").checked, categories: [...S.retCats],
});
$("#jobClose").onclick = async () => { const j = await api("/api/job"); if (j.status !== "running") { S.jobHidden = j.id; $("#job").hidden = true; } };
$("#stopJob").onclick = () => api("/api/jobs/stop", { method: "POST" });

async function renderCoverage() {
  const ids = [...S.sel];
  const tabs = !ids.length ? [] : await Promise.all((ids.length === S.areas.length ? [null] : ids).map((id) => api("/api/coverage" + (id ? `?area_id=${id}` : ""))));
  // sum across areas (a POI in two overlapping areas counts twice in that case)
  const tab = {};
  for (const t of tabs) for (const [c, v] of Object.entries(t)) { tab[c] = tab[c] || {}; for (const [k, n] of Object.entries(v)) tab[c][k] = (tab[c][k] || 0) + n; }
  const cols = ["verified", "observed", "retrieved", "conflict", "estimated", "missing", "pending"];
  const cats = [...S.meta.categories, "All"];
  $("#coverageTable").innerHTML = `<table class="t"><tr><th>Category</th>${cols.map((c) => `<th title="${c}"><span class="dot" style="background:${LAB_COLOR[c]}"></span>${c.slice(0, 4)}</th>`).join("")}<th>Total</th><th>Usable</th></tr>` +
    cats.map((c) => { const v = tab[c] || {}; const usable = (v.verified || 0) + (v.observed || 0) + (v.retrieved || 0);
      return `<tr class="${c === "All" ? "tot" : ""}"><td>${c}</td>${cols.map((k) => `<td>${v[k] || ""}</td>`).join("")}<td>${v.total || 0}</td><td>${v.total ? Math.round(100 * usable / v.total) + "%" : "–"}</td></tr>`; }).join("") + `</table>`;
}

/* ------------------------------------------------------------------ jobs */
let jobTimer = null, lastJobStatus = null;
async function startJob(kind, body) {
  try { await api(`/api/jobs/${kind}`, { method: "POST", body }); pollJob(); }
  catch (e) { alert(e.message); }
}
async function pollJob() {
  clearTimeout(jobTimer);
  const j = await api("/api/job");
  const box = $("#job");
  box.hidden = j.status === "idle" || (j.status !== "running" && S.jobHidden === j.id);
  if (!box.hidden) {
    const name = { discover: "Discovering POIs", retrieve: "Retrieving opening hours", estimate: "Estimating" }[j.kind] || j.kind;
    $("#jobTitle").textContent = `${name} · ${j.status}`;
    $("#jobCount").textContent = j.total ? `${j.done} / ${j.total}` : "";
    $("#jobBar").style.width = j.total ? `${(100 * j.done) / j.total}%` : "5%";
    $("#jobCur").textContent = j.status === "running" ? "▸ " + (j.current || "") : (j.error || "");
    if (j.status === "error" && /Overpass|connect/i.test(j.error || "")) $("#jobCur").textContent += "  → Settings → Test connections";
    const pre = $("#jobLog"); const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = j.log.join("\n"); if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
  const running = j.status === "running";
  if (running) {
    if (j.done !== S._lastDone && j.done % 5 === 0) refreshAfterJob(false);
    S._lastDone = j.done;
    jobTimer = setTimeout(pollJob, 1500);
  } else if (lastJobStatus === "running") refreshAfterJob(true);
  lastJobStatus = j.status;
  $("#runDiscover").disabled = $("#runRetrieve").disabled = running;
}
async function refreshAfterJob(full) {
  if (full) await loadAreas();
  await loadPois();
  if (S.tab === "discover") renderDiscover();
  if (S.tab === "retrieve") renderCoverage();
  if (S.tab === "records") renderRecords();
  if (S.tab === "validate" && full) renderValidation();
  if (S.mapMode === "state") refreshExplore();
}

/* ------------------------------------------------------------------ records */
function renderRecords() {
  const q = $("#recSearch").value.toLowerCase(), lab = $("#recLabel").value, cat = $("#recCat").value;
  const rows = S.pois.filter((p) => p._areas.some((a) => S.sel.has(a)) &&
    (!q || (p.name || "").toLowerCase().includes(q)) && (!lab || p.final_label === lab) && (!cat || p.category === cat))
    .sort((a, b) => (a.name || "~").localeCompare(b.name || "~"));
  $("#recCount").textContent = `${rows.length} POIs` + (rows.length > 400 ? " · showing first 400" : "");
  $("#recList").innerHTML = rows.slice(0, 400).map((p) => `<div class="rec ${S.selPoi === p.id ? "sel" : ""}" data-id="${esc(p.id)}">
    <span class="dot" style="background:${CAT_COLOR[p.category]}"></span>
    <div><div class="nm">${esc(p.name || "(unnamed)")}</div><div class="hrs">${esc(p.hours_text || p.subtype)}</div></div>
    <span class="lab ${p.final_label}">${p.final_label}</span></div>`).join("");
}
["#recSearch", "#recLabel", "#recCat"].forEach((s) => $(s).addEventListener("input", renderRecords));
$("#recList").addEventListener("click", (e) => { const r = e.target.closest(".rec"); if (r) openPoi(r.dataset.id); });

function heatmap(matrix) {
  let h = `<div class="heat"><span class="lbl"></span>` + Array.from({ length: 24 }, (_, i) => `<span class="lbl">${i % 6 === 0 ? i : ""}</span>`).join("");
  DAYS.forEach((d, di) => {
    h += `<span class="lbl">${DAYNAME[d]}</span>` + Array.from({ length: 24 }, (_, i) => { const v = matrix ? matrix[di][i] : null; return `<span class="${v === 1 ? "o" : v === null ? "u" : ""}" title="${DAYNAME[d]} ${i}:00"></span>`; }).join("");
  });
  return h + "</div>";
}

async function openPoi(id) {
  S.selPoi = id;
  renderRecords();
  const p = await api(`/api/pois/${encodeURIComponent(id)}`);
  flyToPoi(id);
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((p.name || "") + " " + p.lat + "," + p.lon)}`;
  const box = $("#recDetail");
  box.hidden = false;
  box.innerHTML = `
    <h3>${esc(p.name || "(unnamed)")}</h3>
    <div class="muted small">${esc(p.category)} · ${esc(p.subtype)} · ${esc(p.areas.join(", "))}${p.address ? " · " + esc(p.address) : ""}</div>
    <div class="row"><span class="lab ${p.final_label}">${p.final_label}</span>
      ${p.agreement != null ? `<span class="small muted">agreement ${Math.round(p.agreement * 100)}%</span>` : ""}
      ${p.perm_closed ? `<span class="lab conflict">permanently closed (Google)</span>` : ""}
      <a class="small" href="${gmaps}" target="_blank" rel="noopener">check on Google Maps ↗</a>
      <a class="small" href="https://www.openstreetmap.org/${esc(p.id)}" target="_blank" rel="noopener">OSM ↗</a></div>
    <div><b>${esc(p.hours_text || "No usable opening hours")}</b></div>
    ${heatmap(p.matrix)}
    <h3 class="sec">Sources (${p.sources.length})</h3>
    ${p.sources.map((s) => srcCard(s, p.final_source_id)).join("") || `<p class="hint">No source yielded hours yet.</p>`}
    <div class="card"><h3>Enter / correct hours manually</h3>
      <div class="row"><input id="manHours" placeholder="Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off"></div>
      <div class="row"><input id="manUrl" placeholder="Where you checked (URL / 'site visit' / 'phone')"><button class="btn" id="manSave">Save as verified</button></div>
      <div class="hint" id="manMsg"></div></div>
    <details><summary>Crawl log (${p.attempts.length})</summary><div class="attempts">${p.attempts.map((a) => `<div><b>${esc(a.step)}</b> ${esc(a.status)} ${a.url ? `<span class="muted">${esc(a.url)}</span>` : ""}</div>`).join("")}</div></details>`;
  $("#manSave").onclick = async () => {
    try { const r = await api(`/api/pois/${encodeURIComponent(id)}/manual`, { method: "POST", body: { hours: $("#manHours").value, url: $("#manUrl").value, note: $("#manUrl").value } });
      await loadPois(); openPoi(id); } catch (e) { $("#manMsg").textContent = e.message; }
  };
  box.querySelectorAll("[data-audit]").forEach((b) => b.addEventListener("click", () => doAudit(+b.dataset.sid, b.dataset.audit, () => openPoi(id))));
}

function srcCard(s, finalId) {
  const v = s.audit?.verdict;
  return `<div class="src ${s.id === finalId ? "final" : ""}">
    <div class="hd"><b>${esc(s.source)} / ${esc(s.method)}</b><span class="small muted">conf ${s.confidence ?? "–"}${s.id === finalId ? " · <b>used</b>" : ""}</span></div>
    <div>${esc(s.hours_text)}</div>
    ${s.evidence ? `<div class="ev">${esc(s.evidence)}</div>` : ""}
    ${s.url ? `<div class="url"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>` : ""}
    ${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ""}
    ${s.source !== "manual" ? `<div class="auditbtns" style="margin-top:6px"><span class="small muted">Audit:</span>
      ${["correct", "incorrect", "unsure"].map((k) => `<button class="btn small ghost ${v === k ? "on-" + k : ""}" data-audit="${k}" data-sid="${s.id}">${k}</button>`).join("")}</div>` : ""}
  </div>`;
}

async function doAudit(sid, verdict, after) {
  let corrected = "";
  if (verdict === "incorrect") corrected = prompt("Correct hours, if you know them (OSM syntax, e.g. 'Mo-Fr 09:00-18:00; Sa,Su off'). Leave empty if unknown:") || "";
  try { await api("/api/audits", { method: "POST", body: { source_id: sid, verdict, corrected } }); await loadPois(); after && after(); }
  catch (e) { alert(e.message); }
}

/* ------------------------------------------------------------------ Google check queue */
const Q = { labels: new Set(["missing", "pending", "conflict"]), list: [], i: 0, done: 0, win: null };
function renderQLabels() {
  $("#qLabels").innerHTML = ["missing", "pending", "conflict", "retrieved", "observed"].map((l) =>
    `<span class="chip ${Q.labels.has(l) ? "on" : "off"}" data-l="${l}"><span class="dot" style="background:${LAB_COLOR[l]}"></span>${l}</span>`).join("");
  if ($("#qCat").options.length < 2) $("#qCat").innerHTML += S.meta.categories.map((c) => `<option>${esc(c)}</option>`).join("");
}
$("#qLabels").addEventListener("click", (e) => { const l = e.target.closest(".chip")?.dataset.l; if (!l) return; Q.labels.has(l) ? Q.labels.delete(l) : Q.labels.add(l); renderQLabels(); });
$("#qLoad").onclick = async () => {
  const qs = new URLSearchParams({ labels: [...Q.labels].join(","), category: $("#qCat").value, area_ids: [...S.sel].join(",") });
  Q.list = await api("/api/queue?" + qs); Q.i = 0; Q.done = 0;
  showQ(true);
};
function openGoogle(item) {
  // re-use one named tab so the user's browser doesn't fill up with tabs
  Q.win = window.open(item.google_url, "tc_google");
}
function showQ(autoOpen) {
  const box = $("#qBox");
  if (!Q.list.length) { box.innerHTML = `<p class="hint">Queue is empty for these filters.</p>`; return; }
  if (Q.i >= Q.list.length) { box.innerHTML = `<div class="card"><b>Done ✓</b> ${Q.done} POIs saved this session.</div>`; loadPois(); return; }
  const it = Q.list[Q.i];
  box.innerHTML = `<div class="card qcard">
    <div class="row" style="justify-content:space-between"><span class="small muted">${Q.i + 1} / ${Q.list.length} · saved ${Q.done}</span><span class="lab ${it.label}">${it.label}</span></div>
    <h3 style="font-size:17px;margin:4px 0 0">${esc(it.name)}</h3>
    <div class="small muted">${esc(it.category)} · ${esc(it.subtype)}${it.address ? " · " + esc(it.address) : ""}</div>
    ${it.hours_text ? `<div class="small">Current: <b>${esc(it.hours_text)}</b></div>` : ""}
    <div class="row"><a class="btn small" href="${esc(it.google_url)}" target="tc_google" rel="noopener">Google search ↗</a>
      <a class="btn small ghost" href="${esc(it.maps_url)}" target="tc_google" rel="noopener">Google Maps ↗</a></div>
    <textarea id="qText" rows="7" placeholder="Paste the opening hours from Google here, e.g.&#10;Monday  11 am–10 pm&#10;Tuesday  11 am–10 pm …&#10;or 星期一 上午11:00–晚上10:00 …"></textarea>
    <div id="qPrev" class="small"></div>
    <div class="row">
      <button class="btn primary" id="qSave" disabled>Save &amp; next</button>
      <button class="btn ghost small" data-q="no_hours">No hours on Google</button>
      <button class="btn ghost small" data-q="not_found">Not found</button>
      <button class="btn ghost small" data-q="closed">Permanently closed</button>
      <button class="link" data-q="skip">Skip</button>
    </div><div class="hint" id="qMsg"></div></div>`;
  const ta = $("#qText");
  let tmr;
  ta.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(previewQ, 250); });
  ta.focus();
  flyToPoi(it.id, 17);
  if (autoOpen && $("#qAuto").checked) openGoogle(it);
}
async function previewQ() {
  const t = $("#qText").value;
  if (!t.trim()) { $("#qPrev").innerHTML = ""; $("#qSave").disabled = true; return; }
  const r = await api("/api/parse", { method: "POST", body: { text: t } });
  $("#qSave").disabled = !r.ok;
  $("#qPrev").innerHTML = r.ok ? `Parsed: <b>${esc(r.hours_text)}</b>${r.complete ? "" : ' <span style="color:#b3261e">· some days missing — check before saving</span>'}${heatmap(r.matrix)}`
    : `<span style="color:#b3261e">Could not read hours yet.</span>`;
}
async function actQ(action) {
  const it = Q.list[Q.i];
  if (action !== "skip") {
    try { await api(`/api/pois/${encodeURIComponent(it.id)}/google_check`, { method: "POST", body: { action, text: $("#qText")?.value || "", url: it.google_url } }); }
    catch (e) { $("#qMsg").textContent = e.message; return; }
    if (action === "save") Q.done++;
  }
  Q.i++;
  showQ(true);
  if (Q.i % 5 === 0) loadPois();
}
$("#qBox").addEventListener("click", (e) => {
  if (e.target.id === "qSave") return actQ("save");
  const a = e.target.closest("[data-q]")?.dataset.q; if (a) actQ(a);
});
document.addEventListener("keydown", (e) => {
  if (S.tab !== "check" || !Q.list.length || Q.i >= Q.list.length) return;
  if (e.ctrlKey && e.key === "Enter" && !$("#qSave").disabled) { e.preventDefault(); actQ("save"); }
  if (e.ctrlKey && e.key === "ArrowRight") { e.preventDefault(); actQ("skip"); }
});

/* ------------------------------------------------------------------ validate */
async function renderValidation() {
  const v = await api("/api/validation");
  $("#accTable").innerHTML = v.accuracy.length ? `<table class="t"><tr><th>Source / method</th><th>✓</th><th>✗</th><th>?</th><th>Accuracy</th><th>95% CI</th></tr>` +
    v.accuracy.map((a) => `<tr><td>${a.method}</td><td>${a.correct}</td><td>${a.incorrect}</td><td>${a.unsure}</td><td><b>${a.accuracy != null ? Math.round(a.accuracy * 100) + "%" : "–"}</b></td><td>${a.ci_low != null ? `${Math.round(a.ci_low * 100)}–${Math.round(a.ci_high * 100)}%` : "–"}</td></tr>`).join("") + `</table>` : `<p class="hint">No audits yet.</p>`;
  $("#agreeTable").innerHTML = v.agreement.length ? `<table class="t"><tr><th>Pair</th><th>POIs</th><th>Mean agreement</th><th>≥ 90 %</th></tr>` +
    v.agreement.map((a) => `<tr><td>${a.pair}</td><td>${a.n}</td><td>${Math.round(a.mean * 100)}%</td><td>${Math.round(a.share_ge_90 * 100)}%</td></tr>`).join("") + `</table>` : `<p class="hint">No POI has two independent sources yet.</p>`;
  const b = v.backtest;
  $("#backtestTable").innerHTML = b.by_subtype.length ? `<p class="stat">Overall hour-level accuracy of estimates: <b>${Math.round(b.overall * 100)}%</b> (n = ${b.n})</p><table class="t"><tr><th>Type</th><th>n</th><th>Hours right</th><th>Whole week right</th></tr>` +
    b.by_subtype.slice(0, 12).map((r) => `<tr><td>${r.subtype}</td><td>${r.n}</td><td>${Math.round(r.hour_accuracy * 100)}%</td><td>${Math.round(r.exact_week_share * 100)}%</td></tr>`).join("") + `</table>` : `<p class="hint">Needs ≥ 6 POIs of one type with known hours.</p>`;
}
$("#drawSample").onclick = async () => {
  const rows = await api(`/api/audit_sample?per=${+$("#auditN").value || 8}`);
  $("#auditList").innerHTML = rows.length ? rows.map((r) => {
    const gm = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name + " " + r.lat + "," + r.lon)}`;
    return `<div class="auditcard" id="ac${r.id}"><div class="top2"><b>${esc(r.name)}</b><span class="chip">${esc(r.stratum)}</span></div>
      <div class="small muted">${esc(r.category)}${r.address ? " · " + esc(r.address) : ""}</div>
      <div><b>${esc(r.weekly_text)}</b></div>
      ${r.evidence ? `<div class="src"><div class="ev">${esc(r.evidence)}</div></div>` : ""}
      <div class="row small">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">source ↗</a>` : ""}<a href="${gm}" target="_blank" rel="noopener">Google Maps ↗</a></div>
      <div class="auditbtns">${["correct", "incorrect", "unsure"].map((k) => `<button class="btn small ghost" data-a="${k}" data-sid="${r.id}">${k}</button>`).join("")}</div></div>`;
  }).join("") : `<p class="hint">Nothing left to audit — collect more records first.</p>`;
};
$("#auditList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]"); if (!b) return;
  doAudit(+b.dataset.sid, b.dataset.a, () => { const c = $("#ac" + b.dataset.sid); c.classList.add("done"); c.querySelectorAll("[data-a]").forEach((x) => x.classList.toggle("on-" + x.dataset.a, x === b)); renderValidation(); });
});
$("#runEstimate").onclick = () => { if (confirmBox("Create 'estimated' records for missing POIs? They stay excluded from analysis unless you tick them in.")) startJob("estimate", {}); };

/* ------------------------------------------------------------------ explore */
function renderExLabels() {
  $("#exLabels").innerHTML = ["verified", "observed", "retrieved", "conflict", "estimated"].map((l) =>
    `<span class="chip ${S.exLabels.has(l) ? "on" : "off"}" data-l="${l}"><span class="dot" style="background:${LAB_COLOR[l]}"></span>${l}</span>`).join("");
}
$("#exLabels").addEventListener("click", (e) => { const l = e.target.closest(".chip")?.dataset.l; if (!l) return; S.exLabels.has(l) ? S.exLabels.delete(l) : S.exLabels.add(l); renderExLabels(); refreshExplore(); });
for (const id of ["#exDay", "#exMetric"]) $(id).addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$(id + " button").forEach((x) => x.classList.toggle("on", x === b));
  if (id === "#exDay") S.exDay = b.dataset.v; else S.exMetric = b.dataset.v;
  refreshExplore();
});
$("#exArea").addEventListener("change", refreshExplore);
$("#exHour").addEventListener("input", () => { if (window.TCDayNight && S.tab === "explore") TCDayNight.setHour(+$("#exHour").value); $("#exHourLbl").textContent = String($("#exHour").value).padStart(2, "0") + ":00"; refreshStates(); renderExTable(); });
let playT = null;
$("#exPlay").onclick = () => {
  if (playT) { clearInterval(playT); playT = null; $("#exPlay").textContent = "▶ Play"; return; }
  $("#exPlay").textContent = "❚❚ Pause";
  playT = setInterval(() => { const r = $("#exHour"); r.value = (+r.value + 1) % 24; r.dispatchEvent(new Event("input")); }, 900);
};

let AV = null;
async function refreshExplore() {
  if (S.tab !== "explore") return;
  const aid = $("#exArea").value;
  const labels = [...S.exLabels].join(",");
  AV = await api(`/api/availability?daytype=${S.exDay}&labels=${labels}${aid ? "&area_id=" + aid : ""}`);
  drawChart();
  renderExTable();
  refreshStates();
}
async function refreshStates() {
  const aid = $("#exArea").value;
  const day = S.exDay === "weekday" ? "we" : S.exDay === "saturday" ? "sa" : "su";
  const st = await api(`/api/states?day=${day}&hour=${$("#exHour").value}&labels=${[...S.exLabels].join(",")}${aid ? "&area_id=" + aid : ""}`);
  S.states = Object.fromEntries(st.map((s) => [s.id, s.state]));
  if (S.mapMode === "state") drawPois();
}
function drawChart() {
  const metric = S.exMetric;
  const nightChart = document.documentElement.classList.contains("tc-night");
  const chartInk = nightChart ? "#d9daf0" : "#4d5870";
  const chartGrid = nightChart ? "#44475f" : "#dce2ed";
  const cats = [...S.meta.categories, "All"];
  const ds = cats.filter((c) => AV[c].usable > 0).map((c) => ({
    label: `${c} (${AV[c].usable})`, data: AV[c][metric].map((v) => (v == null ? null : metric === "share" ? +(v * 100).toFixed(1) : v)),
    borderColor: CAT_COLOR[c], backgroundColor: CAT_COLOR[c], borderWidth: c === "All" ? 3.4 : 2.6, pointRadius: 0, pointHoverRadius: 5, tension: 0.25,
    borderDash: c === "All" ? [5, 3] : undefined,
  }));
  const hourLine = { id: "hourLine", beforeDatasetsDraw(ch) { ch.ctx.save(); ch.ctx.shadowColor = "rgba(122,103,255,.45)"; ch.ctx.shadowBlur = document.documentElement.classList.contains("tc-night") ? 11 : 5; }, afterDatasetsDraw(ch) { ch.ctx.restore(); }, afterDraw(ch) { const x = ch.scales.x.getPixelForValue(+$("#exHour").value); const { top, bottom } = ch.chartArea; const c = ch.ctx; c.save(); c.strokeStyle = TC_PALETTE.hourLine; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); c.restore(); } };
  if (S.chart) S.chart.destroy();
  S.chart = new Chart($("#exChart"), {
    type: "line", data: { labels: Array.from({ length: 24 }, (_, i) => i), datasets: ds }, plugins: [hourLine],
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      scales: { x: { title: { display: true, text: "Hour of day", color: chartInk }, ticks: { color: chartInk }, grid: { display: false } },
        y: { beginAtZero: true, max: metric === "share" ? 100 : undefined, title: { display: true, text: metric === "share" ? "% open" : "Open POIs", color: chartInk }, ticks: { color: chartInk }, grid: { color: chartGrid } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, color: chartInk } } },
      onClick: (_, els, ch) => { const x = ch.scales.x.getValueForPixel(_.x); if (x >= 0 && x <= 23) { $("#exHour").value = Math.round(x); $("#exHour").dispatchEvent(new Event("input")); } },
    },
  });
}
function renderExTable() {
  if (!AV) return;
  const h = +$("#exHour").value;
  const cats = [...S.meta.categories, "All"];
  $("#exTable").innerHTML = `<table class="t"><tr><th>At ${String(h).padStart(2, "0")}:00</th><th>Open</th><th>With records</th><th>All POIs</th><th>Relative</th><th>Coverage</th></tr>` +
    cats.map((c) => { const v = AV[c]; return `<tr class="${c === "All" ? "tot" : ""}"><td><span class="dot" style="background:${CAT_COLOR[c]}"></span>${c}</td><td>${v.open[h]}</td><td>${v.usable}</td><td>${v.total}</td><td>${v.share[h] == null ? "–" : Math.round(v.share[h] * 100) + "%"}</td><td style="color:${v.coverage != null && v.coverage < 0.5 ? "#b3261e" : "inherit"}">${v.coverage == null ? "–" : Math.round(v.coverage * 100) + "%"}</td></tr>`; }).join("") + `</table>`;
  if (S.chart) S.chart.update("none");
  const low = cats.filter((c) => AV[c].total && AV[c].coverage < 0.5).map((c) => c);
  $("#exNote").innerHTML = (low.length ? `Coverage below 50 % for: <b>${low.join(", ")}</b> — relative values there rest on few records. ` : "") +
    `Weekday values average Mon–Fri; the map shows Wednesday. Absolute = number of open POIs; relative = open ÷ POIs with usable records.`;
}

/* ------------------------------------------------------------------ export */
$$(".exp").forEach((a) => a.addEventListener("click", () => {
  const aid = $("#expArea").value;
  const qs = new URLSearchParams();
  if (aid) qs.set("area_id", aid);
  if (a.dataset.k === "availability_profiles.csv") qs.set("labels", [...S.exLabels].join(","));
  if (window.TC_WEB_EXPORT) return TC_WEB_EXPORT(a.dataset.k, aid, [...S.exLabels]); window.location = `/export/${a.dataset.k}?${qs}`;
}));

/* ------------------------------------------------------------------ settings */
const PRESETS = {
  ollama: { llm_provider: "ollama", llm_base_url: "http://localhost:11434", llm_model: "qwen2.5:7b" },
  gemini: { llm_provider: "openai", llm_base_url: "https://generativelanguage.googleapis.com/v1beta/openai", llm_model: "gemini-2.5-flash" },
  groq: { llm_provider: "openai", llm_base_url: "https://api.groq.com/openai/v1", llm_model: "llama-3.3-70b-versatile" },
};
async function loadSettings() {
  const s = await api("/api/settings");
  const f = $("#settingsForm");
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = s[el.name] === "1"; else el.value = s[el.name] ?? "";
  }
}
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
  await api("/api/settings", { method: "POST", body });
  $("#saveMsg").textContent = "Saved ✓"; setTimeout(() => ($("#saveMsg").textContent = ""), 2000);
  loadSettings();
  S.settings = await api("/api/settings"); renderStepbar();
});
$("#llmPresets").addEventListener("click", (e) => {
  const p = PRESETS[e.target.dataset.p]; if (!p) return;
  const f = $("#settingsForm"); for (const [k, v] of Object.entries(p)) f.elements[k].value = v;
});
$("#llmTest").onclick = async () => {
  $("#llmTestOut").textContent = "Saving and testing…";
  $("#settingsForm").requestSubmit();
  await new Promise((r) => setTimeout(r, 400));
  try { const r = await api("/api/llm_test", { method: "POST" }); $("#llmTestOut").textContent = r.status === "ok" ? `OK → ${r.weekly_text}` : r.status; }
  catch (e) { $("#llmTestOut").textContent = e.message; }
};
$("#diagBtn").onclick = async () => {
  $("#diagMsg").textContent = "Testing (up to ~20 s)…"; $("#diagOut").innerHTML = "";
  try {
    const r = await api("/api/diagnose", { method: "POST" });
    $("#diagMsg").textContent = r.proxy ? `via proxy ${r.proxy}` : "no proxy";
    $("#diagOut").innerHTML = `<table class="t"><tr><th>Service</th><th>Used for</th><th>Result</th><th>ms</th></tr>` +
      r.results.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td style="color:${x.ok ? "#2e7d32" : "#b3261e"}"><b>${x.ok ? "✓" : "✗"}</b> ${esc(x.note)}</td><td>${x.ms}</td></tr>`).join("") + `</table>` +
      (r.results.slice(0, 3).every((x) => !x.ok) ? `<p class="hint warn">No OpenStreetMap server is reachable, so discovery cannot run. Set a proxy above and test again.</p>` : "");
  } catch (e) { $("#diagMsg").textContent = e.message; }
};
$("#resetDb").onclick = async () => {
  if (!confirmBox("Delete ALL areas, POIs, evidence and audits?")) return;
  try { await api("/api/reset", { method: "POST" }); S.sel.clear(); await loadAreas(); await loadPois(); go("area"); } catch (e) { alert(e.message); }
};

/* ------------------------------------------------------------------ init */
(async function init() {
  S.meta = await api("/api/meta");
  if (S.meta.demo) {
    $("#demoBanner").hidden = false;
    ["#runDiscover", "#runRetrieve", "#runEstimate", "#stopJob", "#addCases", "#addStation", "#addAllStations", "#addCustom", "#addPoly", "#resetDb", "#qSave"].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
  }
  $("#stationList").innerHTML = S.meta.stations.map((s) => `<option value="${esc(s.name)}">`).join("");
  $("#recLabel").innerHTML += LABELS.map((l) => `<option>${l}</option>`).join("");
  $("#recCat").innerHTML += S.meta.categories.map((c) => `<option>${esc(c)}</option>`).join("");
  renderExLabels();
  try { S.settings = await api("/api/settings"); } catch (e) { S.settings = {}; }
  await loadAreas();
  await loadPois();
  initMap();
  drawLegend();
  pollJob();
  go("settings");
})();

/* day / night: Chart.js colours follow the page theme */
window.addEventListener("tc-daynight", (e) => {
  if (!window.Chart) return;
  const night = e.detail.night;
  Chart.defaults.color = night ? "#d9daf0" : "#4d5870";
  Chart.defaults.borderColor = night ? "#44475f" : "#dce2ed";
  if (S.chart) { const sc = S.chart.options.scales || {}; for (const k in sc) { if (sc[k].grid) sc[k].grid.color = Chart.defaults.borderColor; if (sc[k].ticks) sc[k].ticks.color = Chart.defaults.color; if (sc[k].title) sc[k].title.color = Chart.defaults.color; } if (S.chart.options.plugins?.legend?.labels) S.chart.options.plugins.legend.labels.color = Chart.defaults.color; S.chart.update("none"); }
});
