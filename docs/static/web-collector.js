/* Temporal City · Collector in the browser (public site)

   The Collector normally talks to the local Python server (app.py). GitHub Pages cannot run that server,
   so on the public site this file answers the same /api/... calls inside the browser, using the same rules:

   - 01 Area      any MRT/LRT catchment, point or GeoJSON polygon
   - 02 Discover  OpenStreetMap Overpass API, same six categories (core/discovery.py)
   - 03 Hours     OSM opening_hours tag, and Google Places if the visitor enters their own key
                  (core/pipeline.py). Reading business websites, and the AI that reads them, need the
                  local app: browsers do not allow a page to read other websites.
   - 04 Review    sources, evidence, quality labels (core/pipeline.py reconcile), audits
   - 05 Explore   hourly availability (core/analysis.py)
   - 06 Export    the same CSV / GeoJSON files (core/export.py), built in the browser

   The three case areas use the project's pre-collected Google Places sample (docs/static/demo/data.json).
   Everything is stored in this browser only (IndexedDB); API keys never leave it except to call Google. */
(function () {
  'use strict';
  const realFetch = window.fetch.bind(window);
  const BASE = document.currentScript.src.replace(/static\/web-collector\.js.*$/, '');
  const DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
  const USABLE = ['verified', 'observed', 'retrieved'];
  const AGREE = 0.9;
  const PRIORITY = { 'manual/manual': 9, 'manual/google_copy': 9, 'google/places_api': 5, 'osm/osm_tag': 4, 'web/jsonld': 4, 'web/llm': 3, 'web/rules': 2, 'estimate/peer_majority': 0 };

  /* ================================================================ hours (port of core/hours.py) */
  const hm2min = s => { const [h, m] = s.split(':'); return +h * 60 + +m; };
  const min2hm = v => { v = Math.max(0, Math.min(v, 1440)); return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0'); };
  const dayRange = (a, b) => { const i = DAYS.indexOf(a), j = DAYS.indexOf(b); return i <= j ? DAYS.slice(i, j + 1) : DAYS.slice(i).concat(DAYS.slice(0, j + 1)); };
  const isComplete = w => !!w && DAYS.every(d => d in w);
  function cleanHM(v) {
    if (v == null) return null;
    const m = String(v).match(/^\s*(\d{1,2})(?::|\.)?(\d{2})?(?::\d{2})?\s*$/);
    if (!m) return null;
    const h = +m[1], mi = +(m[2] || 0);
    if (h > 24 || mi > 59 || (h === 24 && mi)) return null;
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }
  function normalise(w) {
    const out = {};
    for (const d of DAYS) if (d in w) {
      const ivs = [];
      for (const [s0, e0] of w[d] || []) {
        const s = cleanHM(s0); let e = cleanHM(e0);
        if (s == null || e == null || (s === e && s !== '00:00')) continue;
        if (s === '00:00' && e === '00:00') e = '24:00';
        ivs.push([s, e]);
      }
      out[d] = ivs.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    }
    return out;
  }
  function toMatrix(w) {
    const m = Array.from({ length: 7 }, () => Array(24).fill(null));
    if (!w) return m;
    DAYS.forEach((d, di) => { if (d in w) for (let h = 0; h < 24; h++) m[di][h] = 0; });
    DAYS.forEach((d, di) => {
      for (const [a, b] of w[d] || []) {
        const s = hm2min(a); let e = hm2min(b); if (e <= s) e += 1440;
        for (let slot = Math.floor(s / 60); slot <= Math.floor((e - 1) / 60); slot++) {
          if (slot < 24) m[di][slot] = 1; else m[(di + 1) % 7][slot - 24] = 1;
        }
      }
    });
    return m;
  }
  function agreement(a, b) {
    const ma = toMatrix(a), mb = toMatrix(b); let same = 0, total = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { if (ma[d][h] == null || mb[d][h] == null) continue; total++; if (ma[d][h] === mb[d][h]) same++; }
    return total ? Math.round(same / total * 1e4) / 1e4 : null;
  }
  function toText(w) {
    if (!w) return '';
    const key = d => !(d in w) ? null : (w[d].length ? w[d].map(([s, e]) => s + '-' + e).join(',') : 'off');
    if (DAYS.every(d => key(d) === '00:00-24:00')) return '24/7';
    const cap = d => d[0].toUpperCase() + d[1];
    const parts = []; let i = 0;
    while (i < 7) { const k = key(DAYS[i]); let j = i; while (j + 1 < 7 && key(DAYS[j + 1]) === k) j++;
      if (k !== null) parts.push((i === j ? cap(DAYS[i]) : cap(DAYS[i]) + '-' + cap(DAYS[j])) + ' ' + k); i = j + 1; }
    return parts.join('; ');
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function parseOsm(value) {
    const warnings = [];
    if (!value || !value.trim()) return [null, ['empty']];
    let v = value.trim().replace(/[–—]/g, '-').replace(/"[^"]*"/g, '');
    if (['24/7', '24/7 open', 'open 24/7'].includes(v.toLowerCase())) return [Object.fromEntries(DAYS.map(d => [d, [['00:00', '24:00']]])), warnings];
    const weekly = {};
    for (const raw of v.split(/;|\|\|/)) {
      const rule = raw.trim(); if (!rule) continue;
      const low = rule.toLowerCase();
      if (MONTHS.some(m => low.startsWith(m)) || /^\d{4}/.test(low) || low.startsWith('week')) { warnings.push('skipped seasonal rule: ' + rule); continue; }
      const m = low.match(/^((?:(?:mo|tu|we|th|fr|sa|su|ph|sh)(?:\[[^\]]*\])?(?:\s*-\s*(?:mo|tu|we|th|fr|sa|su))?\s*,?\s*)+)(.*)$/);
      let daypart = '', rest = low;
      if (m && /^(mo|tu|we|th|fr|sa|su|ph|sh)\b/.test(low)) { daypart = m[1]; rest = m[2].trim(); }
      let days = [], onlyHoliday = !!daypart;
      if (daypart) for (let tok of daypart.trim().replace(/^,+|,+$/g, '').split(/\s*,\s*/)) {
        tok = tok.replace(/\[[^\]]*\]/g, '').trim(); if (!tok || tok === 'ph' || tok === 'sh') continue;
        onlyHoliday = false;
        if (tok.includes('-')) { const [a, b] = tok.split('-').map(t => t.trim()); if (DAYS.includes(a) && DAYS.includes(b)) days = days.concat(dayRange(a, b)); }
        else if (DAYS.includes(tok)) days.push(tok);
      }
      if (daypart && onlyHoliday) { warnings.push('skipped holiday rule: ' + rule); continue; }
      if (!daypart) days = DAYS.slice();
      rest = rest.trim().replace(/^,+|,+$/g, '').trim();
      if (rest === 'off' || rest === 'closed') { days.forEach(d => weekly[d] = []); continue; }
      if (rest === '24/7' || rest === '') {
        if (rest === '24/7' || daypart) days.forEach(d => weekly[d] = rest === '24/7' ? [['00:00', '24:00']] : (weekly[d] || [['00:00', '24:00']]));
        if (rest === '' && daypart) warnings.push('day selector without times treated as 24h: ' + rule);
        continue;
      }
      rest = rest.replace(/sunrise/g, '07:00').replace(/sunset/g, '19:00');
      const ivs = [];
      for (let span of rest.split(/\s*,\s*/)) {
        span = span.trim();
        let mm = span.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\+)?$/);
        if (mm) { ivs.push([cleanHM(mm[1]), cleanHM(mm[2])]); continue; }
        mm = span.match(/^(\d{1,2}:\d{2})\+$/);
        if (mm) { ivs.push([cleanHM(mm[1]), '24:00']); warnings.push('open-ended time treated as until midnight'); continue; }
        warnings.push('unparsed time span: ' + span);
      }
      const ok = ivs.filter(iv => iv[0] && iv[1]);
      if (ok.length) days.forEach(d => weekly[d] = ok);
    }
    if (!Object.keys(weekly).length) return [null, warnings.length ? warnings : ['nothing parsed']];
    return [normalise(weekly), warnings];
  }
  /* free text (pasted Google listings, English or Chinese) */
  const DAY_WORDS = [['mo', 'mon(?:day)?s?'], ['tu', 'tue(?:s(?:day)?)?s?'], ['we', 'wed(?:nesday)?s?'], ['th', 'thu(?:r(?:s(?:day)?)?)?s?'], ['fr', 'fri(?:day)?s?'], ['sa', 'sat(?:urday)?s?'], ['su', 'sun(?:day)?s?']];
  const DAY_RE = DAY_WORDS.map(([k, p]) => `(?<${k}>${p})`).join('|');
  const TIME = String.raw`(?:\d{4}\s*(?:hrs|hr|h)\b|\d{1,2}(?:[:.]\d{2})?\s*(?:am\b|pm\b|a\.m\.|p\.m\.|nn\b|noon\b|hrs\b|h\b)?|noon|midnight)`;
  const GROUP_WORDS = [[/\b(daily|every\s*day|everyday|7 days a week|all days|mon(?:day)?\s*(?:-|–|to)\s*sun(?:day)?)\b/i, DAYS], [/\b(weekdays?)\b/i, DAYS.slice(0, 5)], [/\b(weekends?)\b/i, DAYS.slice(5)]];
  const HOURS_KEYWORDS = /opening hours|operating hours|business hours|open(?:ing)? times|hours of operation|store hours|\bhours\b|\bopen\b|\bdaily\b|\bclosed\b|mon(?:day)?\b|\bweekdays?\b|24 hours/i;
  function parseTime(tok, isEnd = false, ref = null) {
    const t = tok.trim().toLowerCase().replace(/ /g, '').replace('a.m.', 'am').replace('p.m.', 'pm');
    if (['noon', '12nn', '12noon'].includes(t)) return 720;
    if (t === 'midnight') return isEnd ? 1440 : 0;
    const m4 = t.match(/^(\d{2})(\d{2})(?:hrs|hr|h)$/);
    if (m4) { const h = +m4[1], mi = +m4[2]; return h <= 24 && mi < 60 ? h * 60 + mi : null; }
    const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?(am|pm|nn|noon|hrs|h)?$/);
    if (!m) return null;
    let h = +m[1]; const mi = +(m[2] || 0); let suf = m[3] || ref;
    if (suf === 'hrs' || suf === 'h') { suf = null; if (m[2] == null) return h <= 24 ? h * 60 : null; }
    if (mi > 59) return null;
    if (suf === 'nn' || suf === 'noon') return h === 12 ? 720 + mi : null;
    if (suf === 'am') { if (h > 12) return null; h = h === 12 ? 0 : h; if (isEnd && h === 0 && mi === 0) return 1440; }
    else if (suf === 'pm') { if (h > 12) return null; h = h === 12 ? 12 : h + 12; }
    else if (suf == null && m[1].length <= 2 && m[2] == null) return null;
    if (h > 24) return null;
    return h * 60 + mi;
  }
  function parseRange(aRaw, bRaw) {
    const SUF = /(am|pm|a\.m\.|p\.m\.)/i, as = aRaw.match(SUF), bs = bRaw.match(SUF), b = parseTime(bRaw, true);
    let a;
    if (as || !bs) a = parseTime(aRaw);
    else { const suf = bs[1].toLowerCase().replace(/\./g, ''); a = parseTime(aRaw, false, suf); if (a != null && b != null && suf === 'pm' && a >= b) a = parseTime(aRaw, false, 'am'); }
    if (a == null || b == null || a === b || a >= 1440) return null;
    return [min2hm(a), b >= 1440 ? '24:00' : min2hm(b)];
  }
  function daysIn(seg) {
    for (const [rx, days] of GROUP_WORDS) { const m = seg.match(rx); if (m && m.index < 40) return days.slice(); }
    const toks = [...seg.matchAll(new RegExp(String.raw`\b(?:${DAY_RE})\b\.?`, 'gi'))].filter(t => t.index < 60);
    if (!toks.length) return [];
    const chain = [toks[0]];
    for (const t of toks.slice(1)) { const prev = chain[chain.length - 1]; const gap = seg.slice(prev.index + prev[0].length, t.index);
      if (/^\s*(?:-|to|till|through|thru|,|&|and|\/)?\s*$/i.test(gap)) chain.push(t); else break; }
    const dayOf = t => Object.entries(t.groups).find(([, v]) => v)[0];
    const days = []; let i = 0;
    while (i < chain.length) {
      const between = i + 1 < chain.length ? seg.slice(chain[i].index + chain[i][0].length, chain[i + 1].index) : '';
      if (i + 1 < chain.length && /^\s*(?:-|to|till|through|thru)\s*$/i.test(between)) { days.push(...dayRange(dayOf(chain[i]), dayOf(chain[i + 1]))); i += 2; }
      else { days.push(dayOf(chain[i])); i++; }
    }
    return [...new Set(days)];
  }
  function normaliseCn(text) {
    if (!/[一-鿿]/.test(text || '')) return text;
    let t = text.replace(/：/g, ':').replace(/～/g, '-').replace(/至/g, '-').replace(/，/g, ',').replace(/；/g, ';');
    [['一', 'Monday'], ['二', 'Tuesday'], ['三', 'Wednesday'], ['四', 'Thursday'], ['五', 'Friday'], ['六', 'Saturday'], ['日', 'Sunday'], ['天', 'Sunday']]
      .forEach(([cn, en]) => { t = t.replace(new RegExp(`(?:星期|周|礼拜)${cn}`, 'g'), en); });
    t = t.replace(/(?:24\s*小时营业|营业\s*24\s*小时|全天营业|24\s*小时)/g, ' Open 24 hours ').replace(/休息|休业|不营业|关闭|闭店|已打烊/g, ' Closed ')
      .replace(/每天|每日/g, ' Daily ').replace(/工作日/g, ' Weekdays ').replace(/周末/g, ' Weekends ')
      .replace(/午夜\s*(?:12(?:[:点]00)?)?|半夜\s*12(?:[:点]00)?/g, '12:00am')
      .replace(/(上午|早上|凌晨|中午|下午|晚上|傍晚)\s*(\d{1,2})(?:[:点](\d{2}))?/g, (_, word, hh, mm) => {
        hh = +hh; mm = mm || '00';
        const suf = ['上午', '早上', '凌晨'].includes(word) ? 'am' : word === '中午' ? (hh === 12 || hh < 3 ? 'pm' : 'am') : 'pm';
        return word === '凌晨' && hh === 12 ? `12:${mm}am` : `${hh}:${mm}${suf}`;
      });
    return t;
  }
  function parseText(text) {
    const notes = [];
    if (!text) return { weekly: null, confidence: 0, evidence: '', notes: ['no text'] };
    let t = normaliseCn(text).replace(/[–—]/g, '-').replace(/[  ]/g, ' ').replace(/[ \t]+/g, ' ');
    const segs = t.split(/[\n|;•]+|(?<=[a-z0-9])\.\s+(?=[A-Z])|(?<=[0-9mMdD])\s*,\s*(?=(?:[Mm]on|[Tt]ue|[Ww]ed|[Tt]hu|[Ff]ri|[Ss]at|[Ss]un|[Dd]aily|[Ww]eek|[Pp]ublic|[Pp][Hh]\b|[Cc]losed))/).map(s => s.trim()).filter(Boolean);
    let weekly = {}; const evidence = [], timedNoDays = []; let pending = [];
    for (const seg of segs) {
      if (seg.length > 300) continue;
      const low = seg.toLowerCase(), days = daysIn(seg);
      if (/public holiday|\bph\b|eve of/.test(low) && !days.length) continue;
      if (low.includes('24 hours') || low.replace(/ /g, '').includes('24hrs') || low.includes('open 24')) {
        let tgt = days.length ? days : (pending.length ? pending : null);
        if (!tgt && /open 24 hours|24 hours daily|24\/7/.test(low)) tgt = DAYS.slice();
        if (tgt) { tgt.forEach(d => weekly[d] = [['00:00', '24:00']]); evidence.push(seg); pending = []; continue; }
      }
      const ranges = [];
      for (const m of seg.matchAll(new RegExp(`(?<a>${TIME})\\s*(?:-|–|—|~|to|till|until)\\s*(?<b>${TIME})`, 'gi'))) { const iv = parseRange(m.groups.a, m.groups.b); if (iv) ranges.push(iv); }
      const closed = /\bclosed\b|\boff\b/.test(low) && !ranges.length;
      if (days.length && closed) { days.forEach(d => weekly[d] = []); evidence.push(seg); pending = []; continue; }
      if (days.length && ranges.length) { days.forEach(d => weekly[d] = ranges); evidence.push(seg); pending = []; }
      else if (days.length) pending = days;
      else if (ranges.length && pending.length) { pending.forEach(d => weekly[d] = ranges); evidence.push(seg); pending = []; }
      else if (ranges.length) { timedNoDays.push(ranges); evidence.push(seg); }
    }
    let conf = 0;
    if (Object.keys(weekly).length) { conf = Object.keys(weekly).length >= 5 ? 0.6 : 0.45; if (Object.keys(weekly).length < 7) notes.push('some days not stated'); }
    else if (timedNoDays.length && HOURS_KEYWORDS.test(t)) { weekly = Object.fromEntries(DAYS.map(d => [d, timedNoDays[0]])); conf = 0.3; notes.push('times found without day names; assumed daily'); }
    if (!Object.keys(weekly).length) return { weekly: null, confidence: 0, evidence: '', notes: notes.length ? notes : ['no schedule found'] };
    return { weekly: normalise(weekly), confidence: conf, evidence: evidence.join(' | ').slice(0, 600), notes };
  }
  function parseAny(text) {
    const t = (text || '').trim();
    if (/^[\sA-Za-z0-9:,;\-/+]+$/.test(t)) { const [w, warn] = parseOsm(t); if (w && isComplete(w)) return { weekly: w, confidence: 0.9, evidence: t.slice(0, 600), notes: warn }; }
    return parseText(text);
  }
  function fromGooglePeriods(periods) {
    if (!periods || !periods.length) return null;
    const g = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
    if (periods.length === 1 && !periods[0].close) return Object.fromEntries(DAYS.map(d => [d, [['00:00', '24:00']]]));
    const w = Object.fromEntries(DAYS.map(d => [d, []]));
    const p2 = n => String(n || 0).padStart(2, '0');
    for (const p of periods) {
      const o = p.open, c = p.close; if (!o) continue;
      let e = c ? p2(c.hour) + ':' + p2(c.minute) : '24:00';
      if (c && e === '00:00' && c.day !== o.day) e = '24:00';
      w[g[o.day || 0]].push([p2(o.hour) + ':' + p2(o.minute), e]);
    }
    return normalise(w);
  }

  /* ================================================================ discovery (port of core/discovery.py) */
  const S = s => new Set(s.split(' '));
  const RULES = [
    ['amenity', S('bench parking parking_space parking_entrance bicycle_parking motorcycle_parking toilets waste_basket waste_disposal recycling drinking_water shelter atm vending_machine telephone post_box fountain clock taxi bus_station charging_station loading_dock smoking_area bicycle_rental grit_bin letter_box parcel_locker photo_booth water_point hunting_stand lounger dog_toilet'), null],
    ['tourism', S('hotel hostel guest_house apartment motel information artwork viewpoint picnic_site camp_site'), null],
    ['leisure', S('pitch playground garden park picnic_table outdoor_seating track common dog_park swimming_area slipway marina nature_reserve firepit bandstand'), null],
    ['amenity', S('restaurant cafe fast_food bar pub food_court ice_cream biergarten juice_bar canteen hawker_centre'), 'Food & Beverage'],
    ['shop', S('bakery pastry coffee tea bubble_tea confectionery beverages chocolate dessert'), 'Food & Beverage'],
    ['amenity', S('school university college kindergarten library language_school music_school driving_school training prep_school dancing_school research_institute'), 'Education'],
    ['amenity', S('community_centre social_centre social_facility townhall police fire_station courthouse place_of_worship clinic doctors dentist hospital childcare public_building nursing_home embassy'), 'Community & Civic'],
    ['office', S('government diplomatic'), 'Community & Civic'],
    ['amenity', S('bank bureau_de_change money_transfer pharmacy post_office veterinary car_wash car_rental fuel internet_cafe studio payment_centre'), 'Services'],
    ['shop', S('hairdresser beauty massage laundry dry_cleaning travel_agency tailor copyshop funeral_directors money_lender pawnbroker repair mobile_phone_repair tattoo nail_salon cosmetics_services photo optician_services shoe_repair locksmith'), 'Services'],
    ['craft', '*', 'Services'],
    ['healthcare', '*', 'Community & Civic'],
    ['amenity', S('cinema theatre arts_centre nightclub casino karaoke_box events_venue conference_centre exhibition_centre planetarium music_venue gambling'), 'Culture & Recreation'],
    ['tourism', S('museum gallery attraction zoo aquarium theme_park'), 'Culture & Recreation'],
    ['leisure', S('fitness_centre sports_centre swimming_pool bowling_alley amusement_arcade escape_game dance sauna fitness_station ice_rink golf_course trampoline_park adult_gaming_centre hackerspace water_park miniature_golf'), 'Culture & Recreation'],
    ['amenity', S('marketplace'), 'Retail'],
    ['shop', '*', 'Retail'],
  ];
  function classify(tags) {
    for (const [k, vals, cat] of RULES) { const v = tags[k]; if (v == null) continue; if (vals === '*' || vals.has(v)) return [cat, `${k}=${v}`]; }
    for (const k of ['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft', 'healthcare']) if (k in tags) return [null, `${k}=${tags[k]}`];
    return [null, ''];
  }
  function haversine(la1, lo1, la2, lo2) {
    const r = 6371008.8, p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180, dp = p2 - p1, dl = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }
  function polygonRings(g) {
    if (!g) return [];
    if (g.type === 'FeatureCollection') return (g.features || []).flatMap(polygonRings);
    if (g.type === 'Feature') return polygonRings(g.geometry || {});
    if (g.type === 'Polygon') return g.coordinates.map(r => r.slice());
    if (g.type === 'MultiPolygon') return g.coordinates.flatMap(p => p.map(r => r.slice()));
    return [];
  }
  function pointInPolygon(lat, lon, rings) {
    let inside = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }
  function buildQuery(area) {
    let f;
    if (area.kind === 'circle') f = `(around:${Math.round(area.radius)},${(+area.lat).toFixed(6)},${(+area.lon).toFixed(6)})`;
    else { const outer = polygonRings(area.geojson).sort((a, b) => b.length - a.length)[0]; f = `(poly:"${outer.slice(0, -1).map(([lo, la]) => la.toFixed(6) + ' ' + lo.toFixed(6)).join(' ')}")`; }
    return `[out:json][timeout:120];(${['amenity', 'shop', 'tourism', 'leisure', 'craft', 'healthcare', 'office'].map(k => `nwr["${k}"]${f};`).join('')});out center tags;`;
  }
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  async function runOverpass(query, log) {
    const errors = [];
    for (const url of OVERPASS) {
      if (job.stop) throw new Error('stopped');
      const host = url.split('/')[2], t0 = Date.now(); log(`  Overpass → ${host} …`);
      const sig = jobSignal(75000);
      try {
        const r = await realFetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: sig.signal });
        sig.done();
        if (r.ok) { log(`  Overpass OK (${host}, ${Math.round((Date.now() - t0) / 1000)} s)`); return await r.json(); }
        const msg = `HTTP ${r.status}` + ([429, 504].includes(r.status) ? ' (server busy)' : ''); log(`  ✗ ${host}: ${msg}`); errors.push(`${host}: ${msg}`);
      } catch (e) { sig.done(); if (job.stop) throw new Error('stopped'); const msg = e.name === 'AbortError' ? 'no answer in 75 s' : 'cannot connect'; log(`  ✗ ${host}: ${msg}`); errors.push(`${host}: ${msg}`); }
    }
    throw new Error('All Overpass servers failed (' + errors.join(' | ') + '). Check your network or VPN and try again.');
  }
  function elementsToPois(data, area) {
    const pois = [], stats = { raw: 0, outside: 0, non_functional: 0, kept: 0 };
    const rings = area.kind === 'polygon' ? polygonRings(area.geojson) : null;
    for (const el of data.elements || []) {
      stats.raw++;
      const tags = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      if (area.kind === 'circle' ? haversine(lat, lon, +area.lat, +area.lon) > +area.radius : !pointInPolygon(lat, lon, rings)) { stats.outside++; continue; }
      const [cat, sub] = classify(tags);
      if (!cat) { stats.non_functional++; continue; }
      stats.kept++;
      pois.push({ id: `${el.type}/${el.id}`, name: tags['name:en'] || tags.name || '', lat, lon, category: cat, subtype: sub,
        website: tags.website || tags['contact:website'] || tags.url || '',
        address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:unit'], tags['addr:postcode']].filter(Boolean).join(' '),
        brand_wikidata: tags['brand:wikidata'] || '', osm_opening_hours: tags.opening_hours || '', tags });
    }
    return [pois, stats];
  }

  /* ================================================================ store (IndexedDB, one record) */
  const DBN = 'temporal-city-collector', STORE = 'state';
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DBN, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function loadState() { try { const db = await idb(); return await new Promise(res => { const t = db.transaction(STORE).objectStore(STORE).get('s'); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); } catch (e) { return null; } }
  let saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(async () => { try { const db = await idb(); db.transaction(STORE, 'readwrite').objectStore(STORE).put(st, 's'); } catch (e) {} }, 300); }
  const fresh = () => ({ seq: { area: 0, source: 0, audit: 0 }, areas: [], pois: {}, poiArea: {}, sources: [], attempts: [], audits: [], settings: {}, checked: [] });
  let st = fresh(), D = null, ready = null;
  async function init() {
    D = await realFetch(BASE + 'static/demo/data.json').then(r => r.json());
    const saved = await loadState(); if (saved && saved.seq) st = Object.assign(fresh(), saved);
  }
  const SAMPLE_NAMES = () => D.areas.map(a => a.name.toLowerCase());

  /* ================================================================ records */
  const now = () => Date.now() / 1000;
  function addSource(pid, source, method, url, evidence, weekly, confidence, notes = '') {
    const s = { id: ++st.seq.source, poi_id: pid, source, method, url, evidence, weekly: weekly ? JSON.stringify(weekly) : null, confidence, notes, created: now() };
    st.sources.push(s); return s.id;
  }
  const logAttempt = (pid, step, url, status) => st.attempts.push({ poi_id: pid, step, url, status, created: now() });
  const sourcesOf = pid => st.sources.filter(s => s.poi_id === pid);
  const independent = (a, b) => a.source !== b.source || host(a.url) !== host(b.url);
  const host = u => { try { return new URL(u).host; } catch (e) { return ''; } };
  function reconcile(pid) {
    const p = st.pois[pid]; if (!p) return null;
    const audits = {}; st.audits.filter(a => a.poi_id === pid).sort((a, b) => a.created - b.created).forEach(a => audits[a.source_id] = a);
    const srcs = sourcesOf(pid).filter(s => s.weekly).map(s => ({ ...s, w: JSON.parse(s.weekly), prio: (PRIORITY[s.source + '/' + s.method] ?? 1) + s.confidence, audit: audits[s.id]?.verdict }));
    const real = srcs.filter(s => s.source !== 'estimate' && s.audit !== 'incorrect'), est = srcs.filter(s => s.source === 'estimate');
    let label = 'missing', final = null, agree = null;
    const maxBy = (arr, f) => arr.reduce((a, b) => (f(b) > f(a) ? b : a));
    const manual = real.filter(s => s.source === 'manual'), confirmed = real.filter(s => s.audit === 'correct');
    if (manual.length) { final = maxBy(manual, s => s.created); label = 'verified'; }
    else if (confirmed.length) { final = maxBy(confirmed, s => s.prio); label = 'verified'; }
    else if (real.length) {
      let best = null, bestAg = -1;
      for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
        if (!independent(real[i], real[j])) continue;
        const ag = agreement(real[i].w, real[j].w); if (ag != null && ag > bestAg) { bestAg = ag; best = [real[i], real[j]]; }
      }
      if (best && bestAg >= AGREE) { final = maxBy(best, s => s.prio); label = 'verified'; agree = bestAg; }
      else if (best) { final = maxBy(real, s => s.prio); label = 'conflict'; agree = bestAg; }
      else { final = maxBy(real, s => s.prio); label = final.source === 'osm' ? 'observed' : 'retrieved'; }
    } else if (est.length) { final = est[est.length - 1]; label = 'estimated'; }
    else if (!p.retrieved_at && !st.attempts.some(a => a.poi_id === pid && a.step !== 'osm')) label = 'pending';
    Object.assign(p, { final_weekly: final ? JSON.stringify(final.w) : null, final_label: label, final_source_id: final ? final.id : null, agreement: agree, n_sources: real.length });
    return label;
  }
  function ingestOsm(pid, value) {
    if (!value) return;
    if (sourcesOf(pid).some(s => s.source === 'osm' && s.evidence === value)) return;
    st.sources = st.sources.filter(s => !(s.poi_id === pid && s.source === 'osm'));
    const [w, warn] = parseOsm(value);
    if (w) addSource(pid, 'osm', 'osm_tag', `https://www.openstreetmap.org/${pid}`, value, w, warn.length ? 0.65 : 0.8, warn.join('; '));
    else logAttempt(pid, 'osm', '', 'unparseable opening_hours: ' + value.slice(0, 120));
  }

  /* ================================================================ queries */
  const areaIdsOf = pid => st.poiArea[pid] || [];
  function poisOf(aid) { const all = Object.values(st.pois); return aid ? all.filter(p => areaIdsOf(p.id).includes(+aid)) : all; }
  const listRow = p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, category: p.category, subtype: p.subtype, final_label: p.final_label, agreement: p.agreement,
    n_sources: p.n_sources, perm_closed: p.perm_closed || 0, retrieved_at: p.retrieved_at || null, hours_text: p.final_weekly ? toText(JSON.parse(p.final_weekly)) : '' });
  function areasOut() { return st.areas.map(a => ({ ...a, n_pois: Object.keys(st.poiArea).filter(pid => st.poiArea[pid].includes(a.id)).length })); }
  function detail(pid) {
    const p = st.pois[pid]; if (!p) return null;
    const w = p.final_weekly ? JSON.parse(p.final_weekly) : null;
    const audits = {}; st.audits.filter(a => a.poi_id === pid).forEach(a => audits[a.source_id] = a);
    return { ...p, tags: p.tags || {}, hours_text: toText(w), matrix: w ? toMatrix(w) : null,
      sources: sourcesOf(pid).map(s => ({ ...s, hours_text: s.weekly ? toText(JSON.parse(s.weekly)) : '', audit: audits[s.id] || null })),
      attempts: st.attempts.filter(a => a.poi_id === pid).map(({ step, url, status }) => ({ step, url, status })),
      areas: st.areas.filter(a => areaIdsOf(pid).includes(a.id)).map(a => a.name) };
  }
  const CATS = () => D.meta.categories;
  const DAYTYPES = { weekday: [0, 1, 2, 3, 4], saturday: [5], sunday: [6], weekend: [5, 6] }; DAYS.forEach((d, i) => DAYTYPES[d] = [i]);
  function availability(aid, labels, daytype) {
    labels = labels || USABLE; const days = DAYTYPES[daytype] || DAYTYPES.weekday, cats = [...CATS(), 'All'];
    const total = {}, usable = {}, open = {}; cats.forEach(c => { total[c] = 0; usable[c] = 0; open[c] = Array(24).fill(0); });
    for (const p of poisOf(aid)) {
      if (p.perm_closed) continue;
      total[p.category]++; total.All++;
      if (!labels.includes(p.final_label) || !p.final_weekly) continue;
      const m = toMatrix(JSON.parse(p.final_weekly)); if (days.some(d => m[d][0] == null)) continue;
      usable[p.category]++; usable.All++;
      for (let h = 0; h < 24; h++) { const v = days.reduce((a, d) => a + m[d][h], 0) / days.length; open[p.category][h] += v; open.All[h] += v; }
    }
    const out = {};
    cats.forEach(c => out[c] = { total: total[c], usable: usable[c], coverage: total[c] ? +(usable[c] / total[c]).toFixed(3) : null, open: open[c].map(v => +v.toFixed(2)), share: open[c].map(v => usable[c] ? +(v / usable[c]).toFixed(3) : null) });
    return out;
  }
  function states(aid, labels, day, hour) {
    labels = labels || USABLE; const di = Math.max(0, DAYS.indexOf(day));
    return poisOf(aid).filter(p => !p.perm_closed).map(p => {
      let s = 'nodata';
      if (labels.includes(p.final_label) && p.final_weekly) { const v = toMatrix(JSON.parse(p.final_weekly))[di][hour]; s = v === 1 ? 'open' : v === 0 ? 'closed' : 'nodata'; }
      return { id: p.id, state: s };
    });
  }
  function coverage(aid) {
    const L = ['verified', 'observed', 'retrieved', 'conflict', 'estimated', 'missing', 'pending'], tab = {};
    [...CATS(), 'All'].forEach(c => { tab[c] = { total: 0 }; L.forEach(l => tab[c][l] = 0); });
    for (const p of poisOf(aid)) if (!p.perm_closed) for (const c of [p.category, 'All']) { tab[c][p.final_label || 'pending']++; tab[c].total++; }
    return tab;
  }
  function wilson(k, n, z = 1.96) {
    if (!n) return [null, null, null];
    const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    const r = x => Math.round(x * 1000) / 1000; return [r(p), r(Math.max(0, c - h)), r(Math.min(1, c + h))];
  }
  function validation() {
    const acc = {};
    for (const a of st.audits) { const s = st.sources.find(x => x.id === a.source_id); if (!s) continue; const k = s.source + '/' + s.method; acc[k] = acc[k] || { correct: 0, incorrect: 0, unsure: 0 }; acc[k][a.verdict]++; }
    const accuracy = Object.keys(acc).sort().map(k => { const v = acc[k], n = v.correct + v.incorrect, [p, lo, hi] = wilson(v.correct, n); return { method: k, ...v, n, accuracy: p, ci_low: lo, ci_high: hi }; });
    const byPoi = {}; st.sources.filter(s => s.weekly && !['estimate', 'manual'].includes(s.source)).forEach(s => (byPoi[s.poi_id] = byPoi[s.poi_id] || []).push(s));
    const pairs = {};
    for (const lst of Object.values(byPoi)) for (let i = 0; i < lst.length; i++) for (let j = i + 1; j < lst.length; j++) {
      const a = lst[i], b = lst[j]; if (!independent(a, b)) continue;
      const ag = agreement(JSON.parse(a.weekly), JSON.parse(b.weekly)); if (ag == null) continue;
      const k = [a.source + '/' + a.method, b.source + '/' + b.method].sort().join(' vs '); (pairs[k] = pairs[k] || []).push(ag);
    }
    const agree = Object.keys(pairs).sort().map(k => { const v = pairs[k]; return { pair: k, n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3), share_ge_90: +(v.filter(x => x >= 0.9).length / v.length).toFixed(3) }; });
    return { accuracy, agreement: agree, n_audits: st.audits.length, backtest: backtest() };
  }
  function backtest(minPeers = 5) {
    const mats = {};
    for (const p of Object.values(st.pois)) { if (!USABLE.includes(p.final_label) || !p.final_weekly) continue; const w = JSON.parse(p.final_weekly); if (isComplete(w)) (mats[p.subtype] = mats[p.subtype] || []).push(toMatrix(w)); }
    const res = [], all = [];
    for (const [sub, ms] of Object.entries(mats)) {
      if (ms.length < minPeers + 1) continue;
      const scores = ms.map((m, i) => { const peers = ms.filter((_, j) => j !== i); let same = 0;
        for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) if ((peers.reduce((a, q) => a + q[d][h], 0) * 2 > peers.length ? 1 : 0) === m[d][h]) same++; return same / 168; });
      all.push(...scores); res.push({ subtype: sub, n: ms.length, hour_accuracy: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3), exact_week_share: +(scores.filter(x => x === 1).length / scores.length).toFixed(3) });
    }
    res.sort((a, b) => b.n - a.n);
    return { by_subtype: res, overall: all.length ? +(all.reduce((a, b) => a + b, 0) / all.length).toFixed(3) : null, n: all.length };
  }
  function auditSample(per) {
    const audited = new Set(st.audits.map(a => a.source_id)), groups = {};
    st.sources.filter(s => s.weekly && s.source !== 'manual' && !audited.has(s.id)).forEach(s => { const k = s.source + '/' + s.method; (groups[k] = groups[k] || []).push(s); });
    const out = [];
    Object.keys(groups).sort().forEach(k => { const g = groups[k].slice().sort(() => Math.random() - 0.5);
      g.slice(0, per).forEach(s => { const p = st.pois[s.poi_id] || {}; out.push({ ...s, name: p.name, category: p.category, address: p.address, lat: p.lat, lon: p.lon, stratum: k, weekly_text: toText(JSON.parse(s.weekly)) }); }); });
    return out;
  }
  const googleUrl = p => 'https://www.google.com/search?hl=en&q=' + encodeURIComponent(`${p.name} ${(p.tags || {})['addr:street'] || ''} Singapore opening hours`.replace(/\s+/g, ' '));
  function queue(q) {
    const labels = (q.get('labels') || 'missing,pending').split(','), cat = q.get('category') || '', aids = (q.get('area_ids') || '').split(',').filter(Boolean).map(Number);
    const checked = new Set(st.attempts.filter(a => a.step === 'google_check').map(a => a.poi_id));
    return Object.values(st.pois).filter(p => (!aids.length || areaIdsOf(p.id).some(a => aids.includes(a))) && labels.includes(p.final_label) && p.name && !p.perm_closed && (!cat || p.category === cat) && (!checked.has(p.id) || q.get('include_checked') === '1'))
      .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name))
      .map(p => ({ id: p.id, name: p.name, category: p.category, subtype: p.subtype, address: p.address, label: p.final_label, lat: p.lat, lon: p.lon,
        hours_text: p.final_weekly ? toText(JSON.parse(p.final_weekly)) : '', google_url: googleUrl(p),
        maps_url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${p.name} ${p.lat},${p.lon}`) }));
  }

  /* ================================================================ jobs */
  let job = { id: 0, kind: null, status: 'idle', total: 0, done: 0, current: '', log: [] };
  const stamp = () => new Date().toTimeString().slice(0, 8) + ' ';
  const log = m => { job.log.push(stamp() + m); job.log = job.log.slice(-400); };
  /* signal for one request: aborted by its own timeout or by Stop (job.ctrl) */
  function jobSignal(ms) {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms), j = job.ctrl;
    if (j) { if (j.signal.aborted) c.abort(); else j.signal.addEventListener('abort', () => c.abort(), { once: true }); }
    return { signal: c.signal, done: () => clearTimeout(t) };
  }
  function start(kind, fn) {
    if (job.status === 'running') return [false, 'A job is already running'];
    job = { id: job.id + 1, kind, status: 'running', total: 0, done: 0, current: '', log: [], started: now(), stop: false, ctrl: new AbortController() };
    (async () => {
      try { await fn(); job.status = job.stop ? 'stopped' : 'finished'; }
      catch (e) { if (job.stop) job.status = 'stopped'; else { job.status = 'error'; job.error = e.message; log('ERROR: ' + e.message); } }
      job.finished = now(); save();
    })();
    return [true, 'started'];
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function isSample(a) { return SAMPLE_NAMES().includes(String(a.name).toLowerCase()) && a.kind === 'circle'; }
  async function jobDiscover(ids, redo) {
    const all = st.areas.filter(a => ids.includes(a.id)), areas = redo ? all : all.filter(a => !a.discovered_at);
    if (all.length > areas.length) log(`${all.length - areas.length} area(s) already discovered, skipped: ${all.filter(a => !areas.includes(a)).map(a => a.name).join(', ')}`);
    job.total = areas.length;
    for (const a of areas) {
      if (job.stop) break;
      job.current = a.name;
      let pois, stats;
      if (isSample(a)) {
        log(`Discovering POIs in “${a.name}” … (case area: pre-collected Google Places sample)`);
        const sa = D.areas.find(x => x.name.toLowerCase() === a.name.toLowerCase());
        const ids2 = new Set(D.poiAreas[String(sa.id)] || []);
        pois = D.pois.filter(p => ids2.has(p.id)).map(p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, category: p.category, subtype: p.subtype, website: '', address: '', brand_wikidata: '', osm_opening_hours: '', tags: {}, sample: true }));
        stats = { raw: pois.length, outside: 0, non_functional: 0, kept: pois.length };
        await sleep(400);
      } else {
        log(`Discovering POIs in “${a.name}” …`);
        const data = await runOverpass(buildQuery(a), log);
        [pois, stats] = elementsToPois(data, a);
      }
      let added = 0;
      for (const p of pois) {
        const old = st.pois[p.id];
        if (!old) { added++; st.pois[p.id] = { ...p, discovered_at: now(), retrieved_at: null, final_weekly: null, final_label: 'pending', final_source_id: null, agreement: null, n_sources: 0, perm_closed: 0 }; }
        else Object.assign(old, { name: p.name, lat: p.lat, lon: p.lon, category: p.category, subtype: p.subtype, website: p.website, address: p.address, osm_opening_hours: p.osm_opening_hours, tags: p.tags });
        const ar = st.poiArea[p.id] = st.poiArea[p.id] || []; if (!ar.includes(a.id)) ar.push(a.id);
        ingestOsm(p.id, p.osm_opening_hours); reconcile(p.id);
      }
      const by = {}; pois.forEach(p => by[p.category] = (by[p.category] || 0) + 1);
      Object.assign(stats, { new: added, by_category: by, with_osm_hours: pois.filter(p => p.osm_opening_hours).length });
      a.discovered_at = now(); a.discovery_stats = stats;
      log(`  ${stats.raw} raw objects → ${stats.kept} functional POIs (${stats.non_functional} non-functional removed, ${stats.outside} outside area); ${stats.with_osm_hours} carry OSM opening_hours`);
      job.done++; save();
    }
  }
  function sim(a, b) { // difflib-like ratio (longest common subsequence based)
    const n = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ''); a = n(a); b = n(b); if (!a && !b) return 1; if (!a || !b) return 0;
    const dp = Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = t; } }
    return 2 * dp[b.length] / (a.length + b.length);
  }
  async function googleLookup(p, key) {
    const body = { textQuery: `${p.name} Singapore`, locationBias: { circle: { center: { latitude: p.lat, longitude: p.lon }, radius: 120 } }, maxResultCount: 5, languageCode: 'en' };
    let r;
    const sig = jobSignal(30000);
    try { r = await realFetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', signal: sig.signal, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.businessStatus,places.googleMapsUri' }, body: JSON.stringify(body) }); }
    catch (e) { sig.done(); return { status: job.stop ? 'stopped' : 'error: cannot reach Google Places' }; }
    sig.done();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: `HTTP ${r.status} ${(j.error || {}).message || ''}`.slice(0, 180) };
    let best = null, bestScore = 0, bestD = 0;
    for (const pl of j.places || []) { const loc = pl.location || {}, d = haversine(p.lat, p.lon, loc.latitude || 0, loc.longitude || 0), s = sim(p.name, (pl.displayName || {}).text);
      const score = s * (d <= 60 ? 1 : d <= 150 ? 0.8 : 0.3); if (score > bestScore) { best = pl; bestScore = score; bestD = d; } }
    if (!best || bestScore < 0.45) return { status: 'no confident match' };
    if (best.businessStatus === 'CLOSED_PERMANENTLY') return { status: 'permanently closed', url: best.googleMapsUri || '', permanently_closed: true };
    const roh = best.regularOpeningHours || {}, w = fromGooglePeriods(roh.periods);
    if (!w) return { status: 'matched but no hours' };
    return { status: 'ok', weekly: w, url: best.googleMapsUri || '', evidence: (roh.weekdayDescriptions || []).join(' | ').slice(0, 600), confidence: Math.round(Math.min(0.9, 0.55 + 0.35 * bestScore) * 100) / 100, place_name: best.displayName.text, distance: Math.round(bestD * 10) / 10 };
  }
  const SERVER = 'https://temporal-city.onrender.com';
  const settings = () => ({ ...D.settings, use_server: '1', ...st.settings });
  /* websites + AI through the online server (core/pipeline.py web_lookup): keys go with the request only */
  async function serverLookup(p, s) {
    const send = {}; ['use_search', 'search_engine', 'use_wikidata', 'extraction', 'cross_check', 'max_pages', 'crawl_delay', 'llm_provider', 'llm_base_url', 'llm_model', 'llm_api_key'].forEach(k => { if (s[k] != null) send[k] = s[k]; });
    const sig = jobSignal(150000);
    try {
      const r = await realFetch(SERVER + '/api/web_lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: sig.signal,
        body: JSON.stringify({ poi: { id: p.id, name: p.name, lat: p.lat, lon: p.lon, address: p.address, category: p.category, website: p.website, brand_wikidata: p.brand_wikidata }, settings: send }) });
      sig.done(); const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || ('HTTP ' + r.status) };
      return j;
    } catch (e) { sig.done(); if (job.stop) return { error: 'stopped' }; return { error: e.name === 'AbortError' ? 'the online server did not answer in time' : 'cannot reach the online server' }; }
  }
  async function jobRetrieve(ids, limit, onlyNew, cats) {
    const s = settings(), cross = s.cross_check === '1';
    let pois = Object.values(st.pois).filter(p => areaIdsOf(p.id).some(a => ids.includes(a)) && !p.perm_closed);
    if (cats && cats.length) pois = pois.filter(p => cats.includes(p.category));
    if (onlyNew) pois = pois.filter(p => !p.retrieved_at);
    if (limit) pois = pois.slice(0, limit);
    job.total = pois.length;
    let googleLeft = +(s.google_max_calls || 200), webNote = false;
    const useGoogle = s.use_google === '1' && s.google_api_key;
    log(`Retrieving opening hours for ${pois.length} POIs …` + (useGoogle ? ' (OSM + Google Places)' : ' (OSM tags; add a Google key in 00 Setup for more)'));
    for (const p of pois) {
      if (job.stop) break;
      job.current = p.name || p.id;
      const have = new Set(sourcesOf(p.id).map(x => x.source + '/' + x.method));
      const hasHours = () => sourcesOf(p.id).some(x => x.weekly && x.source !== 'estimate');
      if (p.sample) {  // case areas: the stored Google Places record
        const d = D.details[p.id];
        if (!have.has('google/places_api')) {
          const src = (d.sources || []).find(x => x.source === 'google');
          if (src) addSource(p.id, 'google', 'places_api', src.url, src.evidence, JSON.parse(src.weekly), src.confidence, src.notes);
          else logAttempt(p.id, 'google', 'https://www.google.com/maps/place/?q=place_id:' + p.id, 'no opening hours in Google Places');
        }
        log(`${p.name}: ${hasHours() ? 'Google Places (sample) → ' + toText(JSON.parse(sourcesOf(p.id).find(x => x.weekly).weekly)) : 'no opening hours in Google Places'}`);
        await sleep(15);
      } else {
        ingestOsm(p.id, p.osm_opening_hours);
        if (!p.name) logAttempt(p.id, 'web', '', 'skipped: POI has no name');
        else if (useGoogle && !have.has('google/places_api') && (cross || !hasHours())) {
          if (googleLeft <= 0) logAttempt(p.id, 'google', '', 'skipped: call cap reached');
          else { googleLeft--; const g = await googleLookup(p, s.google_api_key); logAttempt(p.id, 'google', g.url || '', g.status);
            if (g.permanently_closed) p.perm_closed = 1;
            if (g.status === 'ok') addSource(p.id, 'google', 'places_api', g.url, g.evidence, g.weekly, g.confidence, `matched “${g.place_name}” at ${g.distance} m`);
            if (/HTTP 40[0-3]/.test(g.status)) { log('  Google Places refused the key: ' + g.status); googleLeft = 0; } }
        }
        const wantWeb = s.use_web === '1' && p.name && !have.has('web/jsonld') && !have.has('web/rules') && !have.has('web/llm') && (cross || !hasHours());
        if (wantWeb && s.use_server === '1') {
          if (!webNote) { webNote = true; log('  Reading business websites through the online server' + (llmOn() ? ' (schema.org, rules and your AI model)' : ' (schema.org and rules; add an AI model in 00 Setup to read free text)') + ' — the first request can take about a minute while it wakes up.'); }
          const w = await serverLookup(p, s);
          if (w.error) { logAttempt(p.id, 'web', '', 'online server: ' + w.error); log(`  ${p.name}: websites not read (${w.error})`); if (/cannot reach|did not answer/.test(w.error)) { s.use_server = '0'; log('  Website reading switched off for this run. Use 03 → Google check to paste text instead.'); } }
          else {
            (w.attempts || []).forEach(a => logAttempt(p.id, a.step, a.url, a.status));
            (w.sources || []).forEach(x => addSource(p.id, x.source, x.method, x.url, x.evidence, x.weekly, x.confidence, x.notes));
            if ((w.sources || []).length) log(`  ${p.name}: website → ${w.sources.map(x => x.method === 'llm' ? 'AI' : x.method).join(', ')}`);
          }
        } else if (wantWeb && !webNote) { webNote = true; log('  Website reading is off (00 Setup → Online server). Use 03 → Google check to paste text, which the AI can read.'); }
        log(`${p.name || p.id}: ${hasHours() ? toText(JSON.parse(sourcesOf(p.id).filter(x => x.weekly).slice(-1)[0].weekly)) : 'no hours found'}`);
      }
      if (job.stop) { reconcile(p.id); break; }  // cut off by Stop: run this POI again next time
      p.retrieved_at = now(); reconcile(p.id); job.done++;
      if (job.done % 20 === 0) save();
    }
    log(job.stop ? 'Stopped. POIs not finished are run again next time.' : 'Done.'); save();
  }

  /* ================================================================ exports (port of core/export.py) */
  const csv = (rows, fields) => '﻿' + [fields.join(','), ...rows.map(r => fields.map(f => { const v = r[f] == null ? '' : String(r[f]); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','))].join('\r\n') + '\r\n';
  const POI_FIELDS = ['id', 'name', 'category', 'subtype', 'lat', 'lon', 'address', 'areas', 'final_label', 'final_source', 'confidence', 'agreement', 'n_sources', 'hours_text', ...DAYS, 'source_url', 'website', 'osm_opening_hours', 'perm_closed'];
  function poiRows(aid) {
    return poisOf(aid).sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name)).map(p => {
      const w = p.final_weekly ? JSON.parse(p.final_weekly) : null, s = st.sources.find(x => x.id === p.final_source_id) || {};
      const row = { ...p, areas: st.areas.filter(a => areaIdsOf(p.id).includes(a.id)).map(a => a.name).join('; '), hours_text: toText(w), final_source: s.source ? s.source + '/' + s.method : '', source_url: s.url || '', confidence: s.confidence ?? '' };
      DAYS.forEach(d => row[d] = !w || !(d in w) ? '' : (w[d].map(([a, b]) => a + '-' + b).join(',') || 'closed'));
      return row;
    });
  }
  function makeExport(kind, aid, labels) {
    if (kind === 'pois.csv') return [csv(poiRows(aid), POI_FIELDS), 'text/csv'];
    if (kind === 'pois.geojson') return [JSON.stringify({ type: 'FeatureCollection', features: poiRows(aid).map(r => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: Object.fromEntries(POI_FIELDS.filter(k => k !== 'lat' && k !== 'lon').map(k => [k, r[k] ?? null])) })) }), 'application/geo+json'];
    if (kind === 'hourly_matrix.csv') { const rows = []; poiRows(aid).forEach(r => { if (!r.final_weekly) return; const m = toMatrix(JSON.parse(r.final_weekly)); DAYS.forEach((d, di) => { for (let h = 0; h < 24; h++) if (m[di][h] != null) rows.push({ poi_id: r.id, name: r.name, category: r.category, label: r.final_label, day: d, hour: h, open: m[di][h] }); }); }); return [csv(rows, ['poi_id', 'name', 'category', 'label', 'day', 'hour', 'open']), 'text/csv']; }
    if (kind === 'availability_profiles.csv') { const rows = []; st.areas.forEach(a => ['weekday', 'saturday', 'sunday'].forEach(dt => { const av = availability(a.id, labels, dt); Object.entries(av).forEach(([c, v]) => { for (let h = 0; h < 24; h++) rows.push({ area: a.name, category: c, daytype: dt, hour: h, open_count: v.open[h], usable_records: v.usable, total_pois: v.total, relative_availability: v.share[h], record_coverage: v.coverage }); }); })); return [csv(rows, ['area', 'category', 'daytype', 'hour', 'open_count', 'usable_records', 'total_pois', 'relative_availability', 'record_coverage']), 'text/csv']; }
    if (kind === 'evidence_sources.csv') return [csv(st.sources.map(s => ({ ...s, name: (st.pois[s.poi_id] || {}).name, hours_text: s.weekly ? toText(JSON.parse(s.weekly)) : '' })), ['id', 'poi_id', 'name', 'source', 'method', 'hours_text', 'confidence', 'url', 'evidence', 'notes']), 'text/csv'];
    if (kind === 'crawl_attempts.csv') return [csv(st.attempts.map(a => ({ ...a, name: (st.pois[a.poi_id] || {}).name })), ['poi_id', 'name', 'step', 'url', 'status']), 'text/csv'];
    if (kind === 'audits.csv') return [csv(st.audits.map(a => { const s = st.sources.find(x => x.id === a.source_id) || {}; return { ...a, name: (st.pois[a.poi_id] || {}).name, source: s.source, method: s.method, url: s.url }; }), ['id', 'poi_id', 'name', 'source', 'method', 'verdict', 'corrected', 'note', 'url']), 'text/csv'];
    return null;
  }
  window.TC_WEB_EXPORT = async (kind, aid, labels) => {
    await ready; const r = makeExport(kind, aid ? +aid : null, labels); if (!r) return;
    const url = URL.createObjectURL(new Blob([r[0]], { type: r[1] + ';charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `temporal_city_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${kind}`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };


  /* ================================================================ AI reader (port of core/llm.py) */
  const PROMPT = (name, address, category, title, snippet) => `You extract opening hours for ONE specific place from web page text.

Place: ${name}
Address hint: ${address || 'unknown'}
Category: ${category}

Page title: ${title}
Page text (excerpts):
<<<
${snippet}
>>>

Rules:
- Only use what the text states. Never guess. If the text does not give hours for this place, set "found": false.
- If the page lists several branches, use only the branch matching the address hint; if you cannot tell which branch, set "branch_match": "unclear".
- Times in 24h "HH:MM". Past midnight: end time may be smaller than start (e.g. "18:00"-"02:00"). Closed day = [].
- Ignore public-holiday-only rules.
- "evidence_quote": copy the exact sentence(s) from the text you relied on (verbatim).

Return ONLY JSON:
{"found": true, "branch_match": "yes|no|unclear|single-location",
 "weekly": {"mo": [["09:00","18:00"]], "tu": [], "we": [], "th": [], "fr": [], "sa": [], "su": []},
 "evidence_quote": "...", "notes": "..."}`;
  const llmOn = () => { const p = settings().llm_provider; return !!p && p !== 'none'; };
  async function callLLM(prompt) {
    const s = settings(), p = s.llm_provider, model = s.llm_model || '';
    let r, j;
    if (p === 'ollama') {
      const base = (s.llm_base_url || 'http://localhost:11434').replace(/\/+$/, '');
      r = await realFetch(base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model || 'qwen2.5:7b', prompt, stream: false, format: 'json', options: { temperature: 0 } }) });
      j = await r.json(); if (!r.ok) throw new Error('HTTP ' + r.status); return j.response || '';
    }
    if (p === 'openai') {
      const base = (s.llm_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
      r = await realFetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.llm_api_key || '') }, body: JSON.stringify({ model: model || 'gpt-4o-mini', temperature: 0, messages: [{ role: 'user', content: prompt }] }) });
      j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ((j.error || (Array.isArray(j) && j[0] && j[0].error) || {}).message || '')); return j.choices[0].message.content;
    }
    if (p === 'anthropic') {
      r = await realFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': s.llm_api_key || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: model || 'claude-haiku-5-5', max_tokens: 800, temperature: 0, messages: [{ role: 'user', content: prompt }] }) });
      j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ((j.error || {}).message || '')); return (j.content || []).map(b => b.text || '').join('');
    }
    throw new Error('AI model not configured (00 Setup → AI model)');
  }
  const qnorm = t => (t || '').toLowerCase().replace(/[^a-z0-9:]/g, ' ').replace(/\s+/g, ' ').trim();
  function quoteInSource(quote, source) {
    const q = qnorm(quote), s = qnorm(source); if (q.length < 6) return false; if (s.includes(q)) return true;
    const w = q.split(' '), chunks = []; for (let i = 0; i < Math.max(1, w.length - 3); i += 4) chunks.push(w.slice(i, i + 4).join(' '));
    return chunks.every(c => s.includes(c));
  }
  async function extractAI(poi, title, snippet) {
    snippet = (snippet || '').slice(0, 3500);
    let raw;
    try { raw = await callLLM(PROMPT(poi.name || '', poi.address, poi.category || '', title || '', snippet)); }
    catch (e) { return { status: 'llm error: ' + e.message.slice(0, 160) + (/Failed to fetch/i.test(e.message) ? ' (the provider may block browser calls; try Gemini or Groq, or the full version)' : '') }; }
    const m = (raw || '').match(/\{[\s\S]*\}/); if (!m) return { status: 'llm returned no JSON' };
    let d; try { d = JSON.parse(m[0]); } catch (e) { return { status: 'llm returned invalid JSON' }; }
    if (!d.found) return { status: 'llm: no hours for this place' };
    if (d.branch_match === 'no') return { status: 'llm: hours belong to another branch' };
    const quote = String(d.evidence_quote || '');
    if (!quoteInSource(quote, snippet)) return { status: 'rejected: quote not found in source (possible hallucination)' };
    const w = normalise(d.weekly || {}); if (!Object.keys(w).length) return { status: 'llm: empty schedule' };
    let conf = ['yes', 'single-location'].includes(d.branch_match) ? 0.65 : 0.45; if (!isComplete(w)) conf -= 0.1;
    return { status: 'ok', weekly: w, confidence: Math.round(conf * 100) / 100, evidence: quote.slice(0, 600), notes: `branch_match=${d.branch_match}; ${String(d.notes || '').slice(0, 200)}` };
  }
  /* pasted text: rules first; where they cannot read it (or are unsure), the AI reads it and must quote it */
  async function readPasted(poi, text, url, how) {
    const r = parseAny(text);
    if (r.weekly && r.confidence >= 0.6) return { kind: 'rules', weekly: r.weekly, notes: r.notes };
    if (llmOn()) {
      const a = await extractAI(poi, how, text);
      logAttempt(poi.id, 'llm', url, a.status);
      if (a.status === 'ok') { addSource(poi.id, 'web', 'llm', url, a.evidence, a.weekly, a.confidence, 'text pasted by researcher, read by AI; ' + a.notes); return { kind: 'ai', weekly: a.weekly, notes: [a.notes] }; }
      if (!r.weekly) return { kind: 'fail', error: 'Neither the rules nor the AI could read hours from this text (' + a.status + ')' };
    }
    if (r.weekly) return { kind: 'rules', weekly: r.weekly, notes: r.notes };
    return { kind: 'fail', error: 'Could not read any hours from the pasted text. Add an AI model in 00 Setup to read free-form text.' };
  }

  /* ================================================================ API router */
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const LOCAL_ONLY = 'This needs the full version (https://temporal-city.onrender.com/collector.html) or the local app: browsers cannot reach other websites or run the AI reader from a public page.';
  const mask = s => { const o = { ...s }; ['google_api_key', 'llm_api_key'].forEach(k => { if (o[k]) o[k] = '••••' + o[k].slice(-4); }); return o; };
  async function answer(url, opt) {
    await ready;
    const u = new URL(url, location.href), q = u.searchParams, path = u.pathname.replace(/^.*\/api\//, ''), method = (opt.method || 'GET').toUpperCase();
    let body = {}; try { body = opt.body ? JSON.parse(opt.body) : {}; } catch (e) {}
    const labels = q.get('labels') ? q.get('labels').split(',') : null, aid = q.get('area_id') ? +q.get('area_id') : null;
    if (method === 'GET') {
      if (path === 'meta') return json({ ...D.meta, demo: false, web: true });
      if (path === 'settings') return json(mask(settings()));
      if (path === 'job') { const { stop, ctrl, ...j } = job; return json(j); }
      if (path === 'areas') return json(areasOut());
      if (path === 'pois') return json(poisOf(aid).map(listRow));
      if (path.startsWith('pois/')) { const d = detail(decodeURIComponent(path.slice(5))); return d ? json(d) : json({ error: 'not found' }, 404); }
      if (path === 'coverage') return json(coverage(aid));
      if (path === 'validation') return json(validation());
      if (path === 'audit_sample') return json(auditSample(+(q.get('per') || 8)));
      if (path === 'queue') return json(queue(q));
      if (path === 'availability') return json(availability(aid, labels, q.get('daytype') || 'weekday'));
      if (path === 'states') return json(states(aid, labels, q.get('day') || 'mo', +(q.get('hour') ?? 12)));
      return json({ error: 'not available' }, 404);
    }
    if (path === 'areas' && method === 'POST') {
      const items = Array.isArray(body) ? body : [body], ids = [];
      for (const a of items) {
        if (a.kind === 'polygon') {
          if (!polygonRings(a.geojson).length) return json({ error: 'GeoJSON contains no Polygon/MultiPolygon' }, 400);
          const x = { id: ++st.seq.area, name: a.name || 'Polygon area', kind: 'polygon', geojson: a.geojson, lat: null, lon: null, radius: null, created: now(), discovered_at: null, discovery_stats: null };
          st.areas.push(x); ids.push(x.id);
        } else {
          const r = +(a.radius || 400); if (!(r >= 50 && r <= 3000)) return json({ error: 'radius must be between 50 and 3000 m' }, 400);
          const x = { id: ++st.seq.area, name: a.name || 'Area', kind: 'circle', lat: +a.lat, lon: +a.lon, radius: r, geojson: null, created: now(), discovered_at: null, discovery_stats: null };
          st.areas.push(x); ids.push(x.id);
        }
      }
      save(); return json({ ids });
    }
    if (path.startsWith('areas/') && method === 'DELETE') {
      const id = +path.slice(6); st.areas = st.areas.filter(a => a.id !== id);
      for (const pid of Object.keys(st.poiArea)) { st.poiArea[pid] = st.poiArea[pid].filter(a => a !== id); if (!st.poiArea[pid].length) { delete st.poiArea[pid]; delete st.pois[pid]; } }
      const alive = pid => !!st.pois[pid];
      st.sources = st.sources.filter(s => alive(s.poi_id)); st.attempts = st.attempts.filter(s => alive(s.poi_id)); st.audits = st.audits.filter(s => alive(s.poi_id));
      save(); return json({ ok: true });
    }
    if (path.startsWith('jobs/')) {
      const kind = path.slice(5);
      if (kind === 'stop') { if (job.status === 'running') { job.stop = true; job.current = 'stopping…'; log('Stopped by the researcher.'); if (job.ctrl) job.ctrl.abort(); } return json({ ok: true }); }
      const ids = (body.area_ids || st.areas.map(a => a.id)).map(Number);
      if ((kind === 'discover' || kind === 'retrieve') && !ids.length) return json({ ok: false, message: 'Add a study area first' }, 400);
      let r;
      if (kind === 'discover') r = start(kind, () => jobDiscover(ids, !!body.redo));
      else if (kind === 'retrieve') r = start(kind, () => jobRetrieve(ids, +(body.limit || 0), body.only_new !== false, body.categories || []));
      else return json({ ok: false, message: 'Estimating missing hours runs in the local app (py app.py).' }, 400);
      return json({ ok: r[0], message: r[1] }, r[0] ? 200 : 409);
    }
    if (path === 'settings' && method === 'POST') {
      const d = { ...body }; ['google_api_key', 'llm_api_key'].forEach(k => { if (String(d[k] || '').startsWith('••')) delete d[k]; });
      st.settings = { ...st.settings, ...d }; save(); return json(mask(settings()));
    }
    if (path === 'parse' && method === 'POST') { const r = parseAny(body.text || ''), w = r.weekly; return json({ ok: !!w, complete: isComplete(w), hours_text: toText(w), matrix: w ? toMatrix(w) : null, notes: r.notes || [] }); }
    let m = path.match(/^pois\/(.+)\/manual$/);
    if (m && method === 'POST') {
      const pid = decodeURIComponent(m[1]), p = st.pois[pid]; if (!p) return json({ error: 'not found' }, 404);
      const r = await readPasted(p, body.hours || '', body.url || '', 'Entered by researcher');
      if (r.kind === 'fail') return json({ error: r.error }, 400);
      if (r.kind === 'rules') addSource(pid, 'manual', 'manual', body.url || '', body.note || body.hours, r.weekly, 1.0, 'entered by researcher');
      const label = reconcile(pid); save(); return json({ label, hours_text: toText(r.weekly), warnings: r.notes || [], via: r.kind });
    }
    m = path.match(/^pois\/(.+)\/google_check$/);
    if (m && method === 'POST') {
      const pid = decodeURIComponent(m[1]), p = st.pois[pid]; if (!p) return json({ error: 'not found' }, 404);
      const gurl = body.url || googleUrl(p);
      if (body.action === 'save') { const r = await readPasted(p, body.text || '', gurl, 'Pasted text (Google listing or business website)'); if (r.kind === 'fail') return json({ error: r.error }, 400);
        if (r.kind === 'rules') addSource(pid, 'manual', 'google_copy', gurl, (body.text || '').slice(0, 600), r.weekly, 1.0, 'copied from Google listing by researcher');
        logAttempt(pid, 'google_check', gurl, r.kind === 'ai' ? 'pasted text read by AI' : 'hours copied from Google'); }
      else if (body.action === 'no_hours') logAttempt(pid, 'google_check', gurl, 'Google shows no opening hours');
      else if (body.action === 'closed') { p.perm_closed = 1; logAttempt(pid, 'google_check', gurl, 'permanently closed / not found on Google'); }
      else if (body.action === 'not_found') logAttempt(pid, 'google_check', gurl, 'place not found on Google');
      else return json({ error: 'bad action' }, 400);
      p.retrieved_at = p.retrieved_at || now(); const label = reconcile(pid); save(); return json({ label });
    }
    if (path === 'audits' && method === 'POST') {
      const s = st.sources.find(x => x.id === +body.source_id); if (!s) return json({ error: 'source not found' }, 404);
      if (!['correct', 'incorrect', 'unsure'].includes(body.verdict)) return json({ error: 'bad verdict' }, 400);
      st.audits = st.audits.filter(a => a.source_id !== s.id);
      st.audits.push({ id: ++st.seq.audit, source_id: s.id, poi_id: s.poi_id, verdict: body.verdict, corrected: body.corrected || '', note: body.note || '', created: now() });
      if (body.verdict === 'incorrect' && body.corrected) { const [w] = parseOsm(body.corrected); if (w) addSource(s.poi_id, 'manual', 'manual', body.url || '', body.corrected, w, 1.0, `correction during audit of source #${s.id}`); }
      const label = reconcile(s.poi_id); save(); return json({ label });
    }
    if (path === 'reset' && method === 'POST') { if (job.status === 'running') return json({ error: 'stop the running job first' }, 409); const keep = st.settings; st = fresh(); st.settings = keep; save(); return json({ ok: true }); }
    if (path === 'diagnose' && method === 'POST') {
      const checks = [['OpenStreetMap Overpass (DE)', 'POI discovery', 'https://overpass-api.de/api/status'], ['Overpass mirror (kumi)', 'POI discovery', 'https://overpass.kumi.systems/api/status'], ['Google Places API', 'optional source', 'https://places.googleapis.com/']];
      const results = await Promise.all(checks.map(async ([name, role, url]) => { const t0 = Date.now(); try { await realFetch(url, { mode: 'no-cors' }); return { name, role, ok: true, note: 'reachable', ms: Date.now() - t0 }; } catch (e) { return { name, role, ok: false, note: 'blocked', ms: Date.now() - t0 }; } }));
      results.push({ name: 'Business websites', role: 'website crawling', ok: false, note: 'local app only', ms: 0 });
      return json({ results, proxy: '' });
    }
    if (path === 'llm_test' && method === 'POST') {
      if (!llmOn()) return json({ status: 'Choose an AI model and save the settings first.' });
      const res = await extractAI({ name: 'Test Cafe', address: '1 Test Road', category: 'Food & Beverage' }, 'Test Cafe', 'Test Cafe, 1 Test Road\nOpening hours: Mon-Fri 8am-6pm, Sat 9am-3pm, Sun closed');
      if (res.weekly) res.weekly_text = toText(res.weekly);
      return json(res);
    }
    if (path.startsWith('jobs')) return json({ ok: false, message: LOCAL_ONLY }, 400);
    return json({ error: LOCAL_ONLY }, 400);
  }
  window.fetch = function (input, opt = {}) {
    const url = typeof input === 'string' ? input : input.url, u = new URL(url, location.href);
    if (u.origin === location.origin && /(^|\/)api\//.test(u.pathname)) return answer(url, opt);
    return realFetch(input, opt);
  };
  ready = init();
  window.TC_WEB_COLLECTOR = true;
  window.TC_WEB_TEST = { parseOsm, parseText, parseAny, toMatrix, toText, classify, agreement };
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('demoBanner');
    if (b) { b.hidden = false; b.innerHTML = 'Browser version: your data and keys stay in this browser. Any area via OpenStreetMap; Google Places with your own key; the three case areas load the project’s sample. <b>Websites + AI:</b> with <i>00 Setup → Online server</i> on, business websites are read through the project’s server and your AI model turns the text into weekly schedules (the server may take about a minute to wake up). You can also paste text in 03 → Google check.'; }
  });
})();
