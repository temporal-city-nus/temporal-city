"""Serve the atlas with the Collector's own data instead of the embedded Google Places sample.

The atlas expects DATA = [{id, n, d, c, lat, lng, v, days[7], s[168]}] for the three case-study
districts, and parcels whose properties.poi_idx index into DATA. Both are rebuilt here.
Hourly rule: core.hours.to_matrix (open in hour h if any part of [h:00, h+1:00) is covered), shared with the Collector.
"""
from __future__ import annotations

import json
import math
import os

from . import db, hours, landuse
from .discovery import point_in_polygon, polygon_rings

DISTRICTS = {"bencoolen": "Bencoolen", "明古连": "Bencoolen", "tanjong pagar": "Tanjong Pagar", "tanjongpagar": "Tanjong Pagar",
             "丹戎巴葛": "Tanjong Pagar", "promenade": "Promenade", "宝门廊": "Promenade", "海滨坊": "Promenade"}
USABLE = ("verified", "observed", "retrieved")
# case-study catchment centres (same as app.CASE_STUDIES); POIs inside these circles count even if
# the study area was given another name (e.g. a custom point or a station picked from the list)
CENTRES = {"Bencoolen": (1.298365, 103.849892), "Tanjong Pagar": (1.276506, 103.846433), "Promenade": (1.293226, 103.860349)}
RADIUS_M = 400


def _district(area_name: str) -> str | None:
    low = (area_name or "").lower()
    for k, v in DISTRICTS.items():
        if k in low:
            return v
    return None


def _district_at(lat, lon) -> str | None:
    if lat is None or lon is None:
        return None
    best, bd = None, RADIUS_M + 1
    for name, (clat, clon) in CENTRES.items():
        dy = (lat - clat) * 111_320
        dx = (lon - clon) * 111_320 * math.cos(math.radians(clat))
        d = math.hypot(dx, dy)
        if d <= RADIUS_M and d < bd:
            best, bd = name, d
    return best


def hourly_any(weekly: dict | None) -> list:
    """168 values (Mon 00h … Sun 23h): 1 open, 0 closed, None unknown — the same rule as the Collector
    (hours.to_matrix: open if any part of the hour is covered)."""
    return [v for row in hours.to_matrix(weekly) for v in row]


def _days_text(weekly: dict | None) -> list[str]:
    if not weekly:
        return ["Unknown"] * 7
    out = []
    for d in hours.DAYS:
        if d not in weekly:
            out.append("Unknown")
        elif not weekly[d]:
            out.append("Closed")
        else:
            out.append("; ".join(f"{a}-{b}" for a, b in weekly[d]))
    return out


MAX_AREAS = 8  # the Atlas compares at most this many study areas side by side


def collector_data() -> list[dict]:
    return collector_dataset()[0]


def _area_district(name: str | None, lat, lon) -> str | None:
    """A study area IS a case study when it is named after one or centred within 150 m of its centre."""
    d = _district(name)
    if d:
        return d
    if lat is not None and lon is not None:
        for cname, (clat, clon) in CENTRES.items():
            if _dist_m(lat, lon, clat, clon) <= 150:
                return cname
    return None


ROW_KEYS = ("id", "name", "category", "subtype", "lat", "lon", "final_label", "final_weekly",
            "area_id", "area_name", "a_lat", "a_lon", "a_r")


def rows_from_payload(items) -> list[dict]:
    """POI-area rows sent by the browser Collector (GitHub Pages), shaped like the SQL rows below.
    Nothing is stored; only the fields the Atlas needs are kept."""
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict) or it.get("id") is None or it.get("area_id") is None:
            continue
        try:
            r = {k: it.get(k) for k in ROW_KEYS}
            r["id"], r["area_id"] = str(r["id"])[:200], int(r["area_id"])
            r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])
            for k in ("a_lat", "a_lon", "a_r"):
                r[k] = float(r[k]) if r[k] not in (None, "") else None
            for k in ("name", "category", "subtype", "final_label", "area_name"):
                r[k] = None if r[k] is None else str(r[k])[:300]
            w = r["final_weekly"]
            r["final_weekly"] = w if isinstance(w, str) else (json.dumps(w) if isinstance(w, dict) else None)
            if r["final_weekly"]:
                json.loads(r["final_weekly"])
        except (TypeError, ValueError):
            continue
        out.append(r)
    out.sort(key=lambda r: r["area_id"])
    return out


def collector_dataset(area_ids: list[int] | None = None, rows: list[dict] | None = None):
    """POIs for the Atlas plus the study areas they belong to.

    Every Collector study area with POIs can be shown; `area_ids` (from the Collector's selection or the
    Atlas area picker) chooses which. Without it, the areas with the most POIs are shown. At most
    MAX_AREAS areas, largest first. Areas that are a case study (by name or centre) take its name and
    catchment. Returns (data, areas, dropped_poi_count, choices)."""
    if rows is None:
        rows = db.q("SELECT p.*, a.id AS area_id, a.name AS area_name, a.lat AS a_lat, a.lon AS a_lon, a.radius AS a_r "
                    "FROM pois p JOIN poi_area pa ON pa.poi_id=p.id JOIN areas a ON a.id=pa.area_id "
                    "WHERE p.perm_closed=0 ORDER BY a.id")
    # one district per study area; names made unique
    dist_of, info, used = {}, {}, {}
    for r in rows:
        aid = r["area_id"]
        if aid in dist_of:
            continue
        d = _area_district(r["area_name"], r["a_lat"], r["a_lon"]) or (r["area_name"] or "").strip() or f"Area {aid}"
        if d in used and used[d] != aid and d not in CENTRES:
            d = f"{d} #{aid}"
        used.setdefault(d, aid)
        dist_of[aid] = d
        info.setdefault(d, (r["a_lat"], r["a_lon"], r["a_r"]))
    counts_by_area: dict = {}
    for r in rows:
        counts_by_area[r["area_id"]] = counts_by_area.get(r["area_id"], 0) + 1
    choices = [{"id": aid, "name": dist_of[aid], "n": n} for aid, n in sorted(counts_by_area.items(), key=lambda x: -x[1])]
    wanted = set(area_ids) if area_ids else None
    seen, data = set(), []
    for r in rows:
        if wanted is not None and r["area_id"] not in wanted:
            continue
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        weekly = json.loads(r["final_weekly"]) if r["final_weekly"] and r["final_label"] in USABLE else None
        data.append({"id": r["id"], "n": r["name"] or "(unnamed)", "d": dist_of[r["area_id"]], "c": r["category"],
                     "lat": r["lat"], "lng": r["lon"], "type": r["subtype"], "v": bool(weekly),
                     "q": r["final_label"], "days": _days_text(weekly), "s": hourly_any(weekly),
                     "landUse": "", "landUseDesc": "", "buildingName": ""})
    counts: dict = {}
    for p in data:
        counts[p["d"]] = counts.get(p["d"], 0) + 1
    names = sorted(counts, key=lambda d: -counts[d])[:MAX_AREAS]
    dropped = sum(counts[d] for d in counts if d not in names)
    data = [p for p in data if p["d"] in names]
    data.sort(key=lambda x: (names.index(x["d"]), x["c"], x["n"]))
    areas = []
    for d in names:
        aid = used.get(d)
        if d in CENTRES:
            areas.append({"name": d, "id": aid, "lat": CENTRES[d][0], "lon": CENTRES[d][1], "r": RADIUS_M, "case": True})
            continue
        pts = [p for p in data if p["d"] == d]
        lat, lon, r = info.get(d, (None, None, None))
        if lat is None or lon is None:  # polygon areas: centre on their POIs
            lat, lon = sum(p["lat"] for p in pts) / len(pts), sum(p["lng"] for p in pts) / len(pts)
        if not r:
            r = max(_dist_m(lat, lon, p["lat"], p["lng"]) for p in pts) + 30
        areas.append({"name": d, "id": aid, "lat": lat, "lon": lon, "r": float(r), "case": False})
    return data, areas, dropped, choices


def _dist_m(lat1, lon1, lat2, lon2) -> float:
    dy = (lat2 - lat1) * 111_320
    dx = (lon2 - lon1) * 111_320 * math.cos(math.radians(lat1))
    return math.hypot(dx, dy)


def overview(areas: list[dict]) -> tuple[list[float], float]:
    """Centre and zoom that fit every study area in the Atlas map (about 900 px wide)."""
    lat = sum(a["lat"] for a in areas) / len(areas)
    lon = sum(a["lon"] for a in areas) / len(areas)
    span = max(2 * max(_dist_m(lat, lon, a["lat"], a["lon"]) + a["r"] for a in areas), 800)
    zoom = math.log2(156_543.03 * math.cos(math.radians(lat)) * 820 / span)
    return [lat, lon], round(max(10.5, min(15.4, zoom)), 2)


def _replace_json(html: str, marker: str, value) -> str:
    start = html.index(marker) + len(marker)
    _, end = json.JSONDecoder().raw_decode(html[start:])
    return html[:start] + json.dumps(value, ensure_ascii=False, separators=(",", ":")) + html[start + end:]


def _join_buildings(html: str, data: list[dict]) -> int:
    """Point-in-polygon join of POIs to the OSM building footprints embedded in the Atlas."""
    marker = "const OSM_BUILDINGS="
    start = html.index(marker) + len(marker)
    blds, _ = json.JSONDecoder().raw_decode(html[start:])
    shapes = []
    for f in blds.get("features", []):
        rings = polygon_rings(f.get("geometry") or {})
        if not rings:
            continue
        pts = [pt for ring in rings for pt in ring]
        lons, lats = [pt[0] for pt in pts], [pt[1] for pt in pts]
        shapes.append((min(lats), max(lats), min(lons), max(lons), rings, f.get("properties") or {}))
    n = 0
    for p in data:
        for la0, la1, lo0, lo1, rings, props in shapes:
            if la0 <= p["lat"] <= la1 and lo0 <= p["lng"] <= lo1 and point_in_polygon(p["lat"], p["lng"], rings):
                p["buildingId"] = props.get("osm_id")
                p["buildingName"] = props.get("name") or ""
                n += 1
                break
    return n


_cache: dict = {}


def _parcels_and_spatial(html: str, data: list[dict], areas: list[dict]):
    """Parcels (Atlas PARCEL_GEOJSON format) and ANALYSIS.spatial for the shown areas.
    With data/mp2025_landuse.json.gz: every area from URA Master Plan 2025, clipped to its catchment.
    Without it: the sample's prepared parcels (three case studies only, Master Plan 2019 amendment)."""
    marker = "const PARCEL_GEOJSON="
    start = html.index(marker) + len(marker)
    sample_parcels, _ = json.JSONDecoder().raw_decode(html[start:])
    if landuse.available() and areas:
        feats, spatial = [], {}
        for a in areas:
            key = (a["name"], round(a["lat"], 6), round(a["lon"], 6), round(a["r"], 1))
            if key not in _lu_cache:
                f, catch = landuse.parcels_for(a["name"], a["lat"], a["lon"], a["r"])
                _lu_cache[key] = (f, landuse.spatial_summary(f, catch))
            f, sm = _lu_cache[key]
            feats += [json.loads(json.dumps(x)) for x in f]
            spatial[a["name"]] = sm
        parcels = {"type": "FeatureCollection", "name": "URA Master Plan 2025 parcels clipped to the study areas", "features": feats}
        source = "URA Master Plan 2025"
    else:
        names = {a["name"] for a in areas}
        parcels = {**sample_parcels, "features": [f for f in sample_parcels["features"] if f["properties"].get("district") in names]}
        spatial, source = None, "URA Master Plan 2019 (amended), case studies only"
    # POI -> parcel join, per area with a bounding-box test first
    by_d: dict = {}
    for i, p in enumerate(data):
        by_d.setdefault(p["d"], []).append(i)
    for f in parcels["features"]:
        rings = polygon_rings(f.get("geometry") or {})
        idx = []
        if rings:
            xs = [pt[0] for pt in rings[0]]
            ys = [pt[1] for pt in rings[0]]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            for i in by_d.get(f["properties"].get("district"), []):
                p = data[i]
                if x0 <= p["lng"] <= x1 and y0 <= p["lat"] <= y1 and point_in_polygon(p["lat"], p["lng"], rings):
                    idx.append(i)
        f["properties"]["poi_idx"] = idx
        f["properties"]["poi_total"] = len(idx)
        for i in idx:  # land use of the parcel each POI sits in (shown in POI popups)
            data[i]["landUse"] = f["properties"].get("land_use") or ""
            data[i]["landUseDesc"] = f["properties"].get("land_use_desc") or ""
    return parcels, spatial, source


_lu_cache: dict = {}


def atlas_html(static_dir: str, source: str, area_ids: list[int] | None = None, rows: list[dict] | None = None) -> str:
    """`rows`: POIs sent by the browser Collector instead of this server's database (see rows_from_payload)."""
    path = os.path.join(static_dir, "atlas.html")
    mtime = os.path.getmtime(path)
    if _cache.get("mtime") != mtime:
        _cache.clear()
        _cache.update(mtime=mtime, html=open(path, encoding="utf-8").read())
    html = _cache["html"].replace('https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.js', '/static/vendor/maplibre-gl.js')
    if source != "collector":
        return html
    data, areas, dropped, choices = collector_dataset(area_ids, rows)
    parcels, spatial, lu_source = _parcels_and_spatial(html, data, areas)
    parcel_joined = len({i for f in parcels["features"] for i in f["properties"]["poi_idx"]})
    building_joined = _join_buildings(html, data)
    html = _replace_json(html, "const PARCEL_GEOJSON=", parcels)
    html = _replace_json(html, "const DATA=", data)
    # COMPARE figures (profiles, coverage tables, joins, land use) recomputed for the Collector areas
    a_marker = "const ANALYSIS="
    a_start = html.index(a_marker) + len(a_marker)
    sample, _ = json.JSONDecoder().raw_decode(html[a_start:])
    names = [a["name"] for a in areas] or ["Bencoolen", "Tanjong Pagar", "Promenade"]
    html = _replace_json(html, a_marker, build_analysis(data, sample, parcel_joined, building_joined, names, spatial))
    cfg = {"areas": areas, "dropped": dropped, "max": MAX_AREAS, "choices": choices,
           "selected": sorted(area_ids) if area_ids else None, "landuse": lu_source}
    js = "window.TC_AREA_INFO=" + json.dumps(cfg, ensure_ascii=False).replace("</", "<\\/") + ";"
    if areas:
        centre, zoom = overview(areas)
        js += ("window.TC_AREAS=TC_AREA_INFO.areas;window.TC_OVERVIEW=" + json.dumps(centre)
               + ";window.TC_OV_ZOOM=" + json.dumps(zoom) + ";")
    html = html.replace("</head>", "<script>" + js + "</script></head>", 1)
    if not data:  # explain an empty result in the Atlas banner
        if rows is None:
            diag = db.summary()
            diag["labels"] = db.q("SELECT final_label AS label, COUNT(*) AS n FROM pois GROUP BY final_label")
        else:  # data from the browser Collector
            per_area, labels, pois = {}, {}, {}
            for r in rows:
                a = per_area.setdefault(r["area_id"], {"id": r["area_id"], "name": r["area_name"] or f"Area {r['area_id']}", "n": 0})
                a["n"] += 1
                pois[r["id"]] = r["final_label"]
            for lab in pois.values():
                labels[lab] = labels.get(lab, 0) + 1
            diag = {"path": "this browser (Collector on GitHub Pages)", "pois": len(pois), "areas": list(per_area.values()),
                    "labels": [{"label": k, "n": v} for k, v in labels.items()]}
        html = html.replace("</head>", "<script>window.COLLECTOR_DIAG=" + json.dumps(diag, ensure_ascii=False).replace("</", "<\\/") + "</script></head>", 1)
    return html.replace('window.ATLAS_SOURCE="sample";', 'window.ATLAS_SOURCE="collector";', 1)


# ------------------------------------------------------------------ COMPARE / analysis figures
# The Atlas ships ANALYSIS = {meta, spatial, temporal} precomputed for the Google Places sample.
# `spatial` (URA land use, GPR / GFA) does not depend on POIs and is kept. `meta` and `temporal`
# describe POIs, so for the Collector they are rebuilt here with the same definitions
# (checked against the sample: tests/test_core.py::test_atlas_analysis_matches_sample).
PERIODS = {"weekday": range(0, 5), "weekend": range(5, 7), "all_days": range(0, 7)}
LATE = [22, 23, 0, 1, 2, 3, 4, 5]
DAYTIME = list(range(9, 19))


def _entropy(counts: list[float], k: int) -> float:
    t = sum(counts)
    if t <= 0 or k <= 1:
        return 0.0
    return -sum(c / t * math.log(c / t) for c in counts if c > 0) / math.log(k)


def _temporal(pts: list[dict], cats: list[str]) -> dict:
    total, known = len(pts), sum(1 for p in pts if p["v"])
    cat_summary = []
    for c in cats:
        tot = sum(1 for p in pts if p["c"] == c)
        kn = sum(1 for p in pts if p["c"] == c and p["v"])
        cat_summary.append({"category": c, "total": tot, "known": kn, "unknown": tot - kn,
                            "coverage_pct": kn / tot * 100 if tot else 0.0})
    profiles, summary = {}, {}
    for per, days in PERIODS.items():
        nd, rows = len(days), []
        for h in range(24):
            by = {c: sum(1 for d in days for p in pts if p["c"] == c and p["s"][d * 24 + h] == 1) / nd for c in cats}
            open_avg = sum(by.values())
            rows.append({"hour": h, "open_pois_avg": open_avg,
                         "availability_pct": open_avg / known * 100 if known else 0.0,
                         "functional_diversity": _entropy(list(by.values()), len(cats)),
                         "open_by_category_avg": by})
        mean = lambda key, hs=range(24): sum(rows[h][key] for h in hs) / len(hs)  # noqa: E731
        summary[per] = {
            "mean_open_pois_per_hour": mean("open_pois_avg"), "mean_relative_availability_pct": mean("availability_pct"),
            "mean_functional_diversity": mean("functional_diversity"),
            "late_night_22_05_mean_open_pois": mean("open_pois_avg", LATE), "late_night_22_05_mean_availability_pct": mean("availability_pct", LATE),
            "daytime_09_18_mean_open_pois": mean("open_pois_avg", DAYTIME), "daytime_09_18_mean_availability_pct": mean("availability_pct", DAYTIME),
            "open_pois_at_03_avg": rows[3]["open_pois_avg"], "availability_at_03_pct": rows[3]["availability_pct"],
            "open_pois_at_12_avg": rows[12]["open_pois_avg"], "availability_at_12_pct": rows[12]["availability_pct"],
            "open_pois_at_20_avg": rows[20]["open_pois_avg"], "availability_at_20_pct": rows[20]["availability_pct"]}
        profiles[per] = rows
    return {"total": total, "known": known, "unknown": total - known,
            "coverage_pct": known / total * 100 if total else 0.0,
            "category_summary": cat_summary, "profiles": profiles, "summary": summary}


NO_SPATIAL = {"catchment_area_m2": None, "six_class_area_m2": None, "six_class_coverage_pct": None, "land_area_entropy": None,
              "land_area_by_class_m2": {}, "land_area_by_class_pct": {}, "other_unclassified_area_m2": None,
              "excluded_road_other_area_m2": None, "numeric_gpr_area_m2": None, "numeric_gpr_coverage_pct": None,
              "partial_gfa_m2": None, "partial_gfa_entropy": None, "partial_gfa_by_class_m2": {},
              "numeric_gpr_coverage_by_class_pct": {}, "no_parcels": True}


def build_analysis(data: list[dict], sample: dict, parcel_joined: int, building_joined: int,
                   order: list[str] | None = None, spatial_override: dict | None = None) -> dict:
    cats = sample["meta"]["categories"]
    order = order or ["Bencoolen", "Tanjong Pagar", "Promenade"]
    temporal = {d: _temporal([p for p in data if p["d"] == d], cats) for d in order}
    spatial = {d: (spatial_override or {}).get(d) or sample["spatial"].get(d, NO_SPATIAL) for d in order}
    n, k = len(data), sum(1 for p in data if p["v"])
    meta = dict(sample["meta"])
    meta.update({"source": "collector", "api_retrieved_pois": n, "api_retrieved_known_hours": k,
                 "api_retrieved_missing_hours": n - k, "excluded_outside_official_400m": 0,
                 "excluded_outside_by_district": {d: 0 for d in order}, "excluded_outside_known_hours": 0,
                 "excluded_outside_missing_hours": 0, "in_scope_pois": n, "in_scope_known_hours": k,
                 "in_scope_missing_hours": n - k, "in_scope_coverage_pct": k / n * 100 if n else 0.0,
                 "parcel_joined": parcel_joined, "building_joined": building_joined})
    return {**sample, "meta": meta, "temporal": temporal, "spatial": spatial}
