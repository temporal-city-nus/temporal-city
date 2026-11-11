/* Temporal City · Atlas of the browser Collector (public site only)

   On GitHub Pages the Collector keeps its data in this browser (IndexedDB, see web-collector.js), and the
   Atlas page itself only holds the Google Places sample. For atlas.html?source=collector this script reads
   the browser's Collector data, asks the project's server to build the Atlas from it (the same computation
   as the local app: parcels, land use, GFA, COMPARE figures) and shows the page it returns.
   Nothing is stored on the server. Loaded first in <head>, so the sample page never runs in that case. */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  if (q.get('source') !== 'collector') return;
  var SERVER = 'https://temporal-city.onrender.com';
  var DBN = 'temporal-city-collector', STORE = 'state';

  // stop the sample Atlas below from loading: the rest of this document is swallowed as hidden text
  document.write('<plaintext style="display:none">');

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;' +
    'background:#f6f5f1;color:#1d1d1f;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;z-index:2147483647';
  box.innerHTML = '<div style="max-width:560px"><div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a">Temporal City · Atlas</div>' +
    '<h1 style="font-size:28px;margin:6px 0 12px;font-weight:600">Building the Atlas from your Collector data…</h1>' +
    '<p id="tcwaMsg" style="margin:0;color:#555">Reading the data saved in this browser.</p></div>';
  document.documentElement.appendChild(box);
  var msg = function (html) { var m = document.getElementById('tcwaMsg'); if (m) m.innerHTML = html; };
  var back = ' <a href="collector.html">Back to the Collector</a> · <a href="atlas.html">Google Places sample</a>';

  function loadState() {
    return new Promise(function (res) {
      var r;
      try { r = indexedDB.open(DBN, 1); } catch (e) { return res(null); }
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onerror = function () { res(null); };
      r.onsuccess = function () {
        try {
          var t = r.result.transaction(STORE).objectStore(STORE).get('s');
          t.onsuccess = function () { res(t.result || null); };
          t.onerror = function () { res(null); };
        } catch (e) { res(null); }
      };
    });
  }

  // one row per POI and study area, like the local app's SQL join (permanently closed places left out)
  function rowsOf(st) {
    var areas = {}, rows = [];
    (st.areas || []).forEach(function (a) { areas[a.id] = a; });
    Object.keys(st.poiArea || {}).forEach(function (pid) {
      var p = (st.pois || {})[pid];
      if (!p || p.perm_closed) return;
      st.poiArea[pid].forEach(function (aid) {
        var a = areas[aid];
        if (!a) return;
        rows.push({ id: p.id, name: p.name, category: p.category, subtype: p.subtype, lat: p.lat, lon: p.lon,
          final_label: p.final_label, final_weekly: p.final_weekly || null,
          area_id: a.id, area_name: a.name, a_lat: a.lat, a_lon: a.lon, a_r: a.radius });
      });
    });
    return rows;
  }

  function show(html) {
    document.open();
    document.write(html);
    document.close();
  }

  loadState().then(function (st) {
    var rows = st ? rowsOf(st) : [];
    if (!rows.length) {
      msg('No Collector data in this browser yet. Add a study area and run <b>02 Discover</b> and <b>03 Hours</b> in the Collector first.' + back);
      return;
    }
    var ids = (q.get('areas') || '').split(',').filter(function (x) { return /^\d+$/.test(x); }).map(Number);
    msg(rows.length + ' records found. The project’s server is computing the Atlas (parcels, land use, GFA, COMPARE); ' +
      'the free server may take about a minute to wake up. Your data is not stored there.');
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 180000);
    fetch(SERVER + '/api/atlas_html', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: rows, area_ids: ids }), signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        return r.text();
      })
      .then(show)
      .catch(function (e) {
        clearTimeout(timer);
        msg('The server could not build the Atlas (' + String(e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || e).replace(/[<>&]/g, '') +
          '). It may still be waking up: <a href="' + location.href.replace(/"/g, '&quot;') + '">try again</a>.' + back);
      });
  });
})();
