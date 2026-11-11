"""Temporal City — opening-hours data collection platform (local web app).

Run:  py app.py   →  open http://127.0.0.1:8765 (opens automatically)
"""
from __future__ import annotations

import json
import re
import os
import threading
import time
import traceback

from flask import Flask, Response, jsonify, request, send_from_directory

from core import analysis, db, export, hours, net, pipeline
from core.discovery import CATEGORIES

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "v24-story"
PUBLIC_DEMO = os.environ.get("TC_PUBLIC_DEMO") == "1"  # read-only mode for a public URL
app = Flask(__name__, static_folder=os.path.join(ROOT, "static"), static_url_path="/static")

CASE_STUDIES = [
    {"name": "Bencoolen", "lat": 1.298365, "lon": 103.849892, "radius": 400},
    {"name": "Tanjong Pagar", "lat": 1.276506, "lon": 103.846433, "radius": 400},
    {"name": "Promenade", "lat": 1.293226, "lon": 103.860349, "radius": 400},
]

# ------------------------------------------------------------------ jobs
JOB = {"id": 0, "kind": None, "status": "idle", "total": 0, "done": 0, "current": "", "log": [],
       "started": None, "finished": None, "error": None}
_stop = threading.Event()
_job_lock = threading.Lock()


def _log(msg: str):
    JOB["log"].append(time.strftime("%H:%M:%S ") + msg)
    JOB["log"] = JOB["log"][-400:]


def _start(kind: str, target, *args) -> tuple[bool, str]:
    with _job_lock:
        if JOB["status"] == "running":
            return False, "Another job is running"
        JOB.update(id=JOB["id"] + 1, kind=kind, status="running", total=0, done=0, current="", log=[],
                   started=time.time(), finished=None, error=None)
        _stop.clear()

    def run():
        try:
            net.configure(db.get_settings().get("proxy", ""))
            target(*args)
            JOB["status"] = "stopped" if _stop.is_set() else "finished"
        except Exception as e:
            JOB["status"], JOB["error"] = "error", str(e)
            _log("ERROR: " + str(e))
            traceback.print_exc()
        JOB["finished"] = time.time()
        db.checkpoint()  # write the job's results into temporal_city.db itself

    threading.Thread(target=run, daemon=True).start()
    return True, "started"


def job_discover(area_ids):
    areas = db.q(f"SELECT * FROM areas WHERE id IN ({','.join('?' * len(area_ids))})", area_ids)
    JOB["total"] = len(areas)
    for a in areas:
        if _stop.is_set():
            break
        if a["kind"] == "polygon":
            a["geojson"] = json.loads(a["geojson"])
        JOB["current"] = a["name"]
        pipeline.discover_area(a, log=_log, stop=_stop.is_set)
        JOB["done"] += 1
        time.sleep(2)  # be gentle with the public Overpass servers
    for r in db.q("SELECT id FROM pois WHERE final_label='pending'"):
        pipeline.reconcile(r["id"])


def job_retrieve(area_ids, limit, only_new, categories):
    s = db.get_settings()
    sql = ("SELECT DISTINCT p.* FROM pois p JOIN poi_area a ON a.poi_id=p.id WHERE a.area_id IN (%s)"
           % ",".join("?" * len(area_ids)))
    pois = db.q(sql, area_ids)
    if categories:
        pois = [p for p in pois if p["category"] in categories]
    if only_new:
        pois = [p for p in pois if not p["retrieved_at"]]
    # POIs with no hours first, so a limited run fills the biggest gaps
    pois.sort(key=lambda p: (bool(p["osm_opening_hours"]), p["category"], p["name"] or "~"))
    if limit:
        pois = pois[:limit]
    JOB["total"] = len(pois)
    budget = pipeline.Budget(int(s.get("google_max_calls") or 0))
    sources = [k for k, v in (("OSM", "1"), ("Google", s["use_google"]), ("web", s["use_web"])) if v == "1"]
    _log(f"Retrieving hours for {len(pois)} POIs · sources: {', '.join(sources)} · extraction: {s['extraction']}"
         f" · LLM: {s['llm_provider']}")
    labels_run: dict = {}
    t_start = time.time()
    for p in pois:
        if _stop.is_set():
            _log("Stopped by user.")
            break
        JOB["current"] = p["name"] or p["id"]
        try:
            pipeline.retrieve_poi(p, s, budget, log=_log, stop=_stop.is_set)
            db.x("UPDATE pois SET retrieved_at=? WHERE id=?", (time.time(), p["id"]))
            label = pipeline.reconcile(p["id"])
            db.x("UPDATE pois SET last_status=? WHERE id=?", (label, p["id"]))
            labels_run[label] = labels_run.get(label, 0) + 1
            _log(f"{p['name'] or p['id']}: {label}")
        except Exception as e:
            _log(f"{p['name']}: error {e}")
        JOB["done"] += 1
    _log("──── Summary ────")
    _log("Labels this run: " + ", ".join(f"{k} {v}" for k, v in sorted(labels_run.items())))
    rows = db.q("SELECT step, status, COUNT(*) n FROM attempts WHERE created>=? GROUP BY step, status ORDER BY n DESC",
                (t_start,))
    for r in rows[:15]:
        _log(f"  {r['n']:>4} × {r['step']}: {r['status'][:90]}")
    if any(r["step"] == "search" and r["status"].startswith("0 results") for r in rows) and \
            not any(r["step"] == "search" and not r["status"].startswith("0 results") for r in rows):
        _log("  ⚠ Web search returned nothing for every POI — search engine blocked? Settings → Test connections, "
             "set Search engine = Bing, or set a proxy.")


def job_estimate():
    JOB["total"] = 1
    pipeline.reconcile_all()
    pipeline.estimate_missing(log=_log)
    JOB["done"] = 1


# ------------------------------------------------------------------ routes
def _page(name: str) -> Response:
    html = open(os.path.join(app.static_folder, name), encoding="utf-8").read().replace("__VER__", VERSION)
    return Response(html, mimetype="text/html")


@app.get("/")
@app.get("/index.html")
def story():
    return _page("index.html")


@app.get("/atlas")
@app.get("/atlas.html")
def atlas():
    from core import atlas_bridge
    ids = [int(x) for x in request.args.get("areas", "").split(",") if x.strip().isdigit()] or None
    html = atlas_bridge.atlas_html(app.static_folder, request.args.get("source", "sample"), ids)
    return Response(html, mimetype="text/html")


@app.get("/collector")
@app.get("/collector.html")
def collector():
    return _page("collector.html")


@app.get("/information")
@app.get("/information.html")
def information():
    return _page("information.html")


@app.get("/api/author-avatar/<slug>")
def author_avatar(slug):
    """The four team portraits. They are set in the source code (static/avatars/<slug>.image), not uploaded."""
    if slug not in {"bao-yihan", "li-jingyao", "lin-keyu", "yan-linhao"}:
        return jsonify(error="Unknown author"), 404
    path = os.path.join(app.static_folder, "avatars", slug + ".image")
    if not os.path.isfile(path):
        return jsonify(error="No portrait"), 404
    with open(path, "rb") as stream:
        data = stream.read()
    kind = ("image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else "image/gif" if data.startswith((b"GIF87a", b"GIF89a"))
            else "image/jpeg" if data.startswith(b"\xff\xd8\xff") else "application/octet-stream")
    return Response(data, mimetype=kind)


@app.before_request
def _read_only_demo():
    """On a public URL, visitors can browse everything but cannot start jobs or change data."""
    if PUBLIC_DEMO and request.method in ("POST", "DELETE", "PUT") and request.path not in ("/api/parse", "/api/web_lookup", "/api/atlas_html"):
        return jsonify(error="This is a read-only public demo. Run the app locally to collect data.",
                       message="Read-only public demo"), 403


@app.after_request
def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store"  # always load the current version's files
    return resp


# ---------------------------------------------------------------- website reading for the browser version
# The public site (GitHub Pages) cannot fetch other websites; its Collector can ask this server to read a
# place's website instead. Keys come with each request and are never stored here.
WEB_ORIGINS = [o.strip() for o in os.environ.get("TC_WEB_ORIGINS", "https://temporal-city-nus.github.io").split(",") if o.strip()]
_web_lock = threading.Semaphore(3)


def _cors(resp):
    origin = request.headers.get("Origin", "")
    if origin in WEB_ORIGINS or origin.startswith(("http://127.0.0.1", "http://localhost")):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Vary"] = "Origin"
    return resp


def _public_http(url: str) -> bool:
    import ipaddress
    import socket
    from urllib.parse import urlparse
    u = urlparse(url if "://" in url else "https://" + url)
    if u.scheme not in ("http", "https") or not u.hostname:
        return False
    try:
        for info in socket.getaddrinfo(u.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
    except Exception:
        return False
    return True


@app.route("/api/web_lookup", methods=["POST", "OPTIONS"])
def web_lookup():
    if request.method == "OPTIONS":
        return _cors(Response(status=204))
    d = request.get_json(silent=True) or {}
    p = d.get("poi") or {}
    if not p.get("name"):
        return _cors(jsonify(error="poi.name is required")), 400
    if p.get("website") and not _public_http(p["website"]):
        p["website"] = ""
    c = d.get("settings") or {}
    s = dict(db.DEFAULT_SETTINGS)  # never the keys saved on this server
    for k in ("use_search", "search_engine", "use_wikidata", "extraction", "cross_check",
              "llm_provider", "llm_base_url", "llm_model", "llm_api_key"):
        if k in c:
            s[k] = str(c[k])
    if s.get("llm_provider") == "ollama":
        s["llm_provider"] = "none"  # a local model cannot be reached from this server
    s["max_pages"] = str(min(4, int(c.get("max_pages") or 3)))
    s["crawl_delay"] = str(max(1.0, float(c.get("crawl_delay") or 1.5)))
    poi = {k: p.get(k) for k in ("id", "name", "lat", "lon", "address", "category", "website", "brand_wikidata")}
    poi["lat"], poi["lon"] = float(poi.get("lat") or 0), float(poi.get("lon") or 0)
    with _web_lock:
        try:
            res = pipeline.web_lookup(poi, s)
        except Exception as e:
            return _cors(jsonify(error=f"{type(e).__name__}: {str(e)[:160]}")), 500
    return _cors(jsonify(res))


@app.route("/api/atlas_html", methods=["POST", "OPTIONS"])
def atlas_from_browser():
    """The Atlas built from POIs sent by the browser Collector (GitHub Pages), which keeps its data in the
    visitor's browser. Same computation as /atlas.html?source=collector; nothing is stored here.
    Paths in the page are relative, so it works when shown on the public site."""
    if request.method == "OPTIONS":
        return _cors(Response(status=204))
    if request.content_length and request.content_length > 25_000_000:
        return _cors(jsonify(error="Too much data for the Atlas (over 25 MB)")), 413
    from core import atlas_bridge
    d = request.get_json(silent=True) or {}
    rows = atlas_bridge.rows_from_payload(d.get("rows"))
    ids = [int(x) for x in (d.get("area_ids") or []) if str(x).strip().lstrip("-").isdigit()] or None
    try:
        html = atlas_bridge.atlas_html(app.static_folder, "collector", ids, rows)
    except Exception as e:
        return _cors(jsonify(error=f"{type(e).__name__}: {str(e)[:160]}")), 500
    html = re.sub(r'(["\'(])/static/', r'\1static/', html)
    return _cors(Response(html, mimetype="text/html"))


@app.get("/api/meta")
def meta():
    stations = json.load(open(os.path.join(ROOT, "data", "stations.json"), encoding="utf-8"))
    return jsonify(categories=CATEGORIES, stations=stations, case_studies=CASE_STUDIES, demo=PUBLIC_DEMO,
                   version=VERSION)


@app.route("/api/settings", methods=["GET", "POST"])
def settings():
    if request.method == "POST":
        data = request.get_json(force=True)
        for k in ("google_api_key", "llm_api_key"):  # masked value from the UI = unchanged
            if data.get(k, "").startswith("••"):
                data.pop(k)
        db.save_settings(data)
    s = db.get_settings()
    net.configure(s.get("proxy", ""))
    for k in ("google_api_key", "llm_api_key"):
        if s.get(k):
            s[k] = "••••" + s[k][-4:]
    return jsonify(s)


@app.post("/api/diagnose")
def diagnose():
    """Check which external services this computer can reach (with the current proxy)."""
    from concurrent.futures import ThreadPoolExecutor
    s = db.get_settings()
    net.configure(s.get("proxy", ""))
    checks = [
        ("OpenStreetMap Overpass (DE)", "POI discovery", "https://overpass-api.de/api/status"),
        ("Overpass mirror (kumi)", "POI discovery", "https://overpass.kumi.systems/api/status"),
        ("Overpass mirror (mail.ru)", "POI discovery", "https://maps.mail.ru/osm/tools/overpass/api/status"),
        ("DuckDuckGo", "web search", "https://html.duckduckgo.com/html/"),
        ("Bing", "web search (fallback)", "https://www.bing.com/"),
        ("cn.bing.com", "web search (fallback, China)", "https://cn.bing.com/"),
        ("Google Places API", "optional source", "https://places.googleapis.com/"),
        ("Wikidata", "brand websites", "https://www.wikidata.org/"),
        ("Example SG business site", "website crawling", "https://www.fairprice.com.sg/"),
        ("Map tiles (CARTO)", "map background", "https://a.basemaps.cartocdn.com/light_all/14/12936/8172.png"),
    ]

    def one(c):
        name, role, url = c
        t0 = time.time()
        try:
            r = net.session.get(url, timeout=(8, 12), allow_redirects=True, stream=True)
            ok = r.status_code < 500
            note = f"HTTP {r.status_code}"
            r.close()
        except Exception as e:
            ok, note = False, type(e).__name__
        return {"name": name, "role": role, "ok": ok, "note": note, "ms": int((time.time() - t0) * 1000)}

    with ThreadPoolExecutor(10) as ex:
        res = list(ex.map(one, checks))
    return jsonify(results=res, proxy=s.get("proxy", ""))


@app.post("/api/llm_test")
def llm_test():
    from core import llm
    s = db.get_settings()
    poi = {"name": "Test Cafe", "address": "1 Test Road", "category": "Food & Beverage"}
    res = llm.extract(s, poi, "Test Cafe", "Test Cafe, 1 Test Road\nOpening hours: Mon-Fri 8am-6pm, Sat 9am-3pm, Sun closed")
    if res.get("weekly"):
        res["weekly_text"] = hours.to_text(res["weekly"])
    return jsonify(res)


@app.get("/api/areas")
def areas():
    rows = db.q("SELECT a.*, (SELECT COUNT(*) FROM poi_area pa WHERE pa.area_id=a.id) AS n_pois FROM areas a ORDER BY id")
    for r in rows:
        r["geojson"] = json.loads(r["geojson"]) if r["geojson"] else None
        r["discovery_stats"] = json.loads(r["discovery_stats"]) if r["discovery_stats"] else None
    return jsonify(rows)


@app.post("/api/areas")
def add_area():
    d = request.get_json(force=True)
    items = d if isinstance(d, list) else [d]
    ids = []
    for a in items:
        if a.get("kind") == "polygon":
            from core.discovery import polygon_rings
            if not polygon_rings(a["geojson"]):
                return jsonify(error="GeoJSON contains no Polygon/MultiPolygon"), 400
            ids.append(db.x("INSERT INTO areas(name,kind,geojson,created) VALUES(?,?,?,?)",
                            (a.get("name") or "Polygon area", "polygon", json.dumps(a["geojson"]), time.time())))
        else:
            r = float(a.get("radius") or 400)
            if not (50 <= r <= 3000):
                return jsonify(error="radius must be between 50 and 3000 m"), 400
            ids.append(db.x("INSERT INTO areas(name,kind,lat,lon,radius,created) VALUES(?,?,?,?,?,?)",
                            (a.get("name") or "Area", "circle", float(a["lat"]), float(a["lon"]), r, time.time())))
    return jsonify(ids=ids)


@app.delete("/api/areas/<int:aid>")
def del_area(aid):
    db.x("DELETE FROM areas WHERE id=?", (aid,))
    db.x("DELETE FROM poi_area WHERE area_id=?", (aid,))
    orphans = "SELECT id FROM pois WHERE id NOT IN (SELECT poi_id FROM poi_area)"
    for t in ("sources", "attempts", "audits"):
        db.x(f"DELETE FROM {t} WHERE poi_id IN ({orphans})")
    db.x(f"DELETE FROM pois WHERE id IN ({orphans})")
    return jsonify(ok=True)


@app.post("/api/jobs/<kind>")
def jobs(kind):
    d = request.get_json(silent=True) or {}
    if kind == "stop":
        _stop.set()
        return jsonify(ok=True)
    ids = [int(i) for i in d.get("area_ids") or [r["id"] for r in db.q("SELECT id FROM areas")]]
    if kind in ("discover", "retrieve") and not ids:
        return jsonify(ok=False, message="Add a study area first"), 400
    if kind == "discover":
        ok, msg = _start(kind, job_discover, ids)
    elif kind == "retrieve":
        ok, msg = _start(kind, job_retrieve, ids, int(d.get("limit") or 0), bool(d.get("only_new", True)),
                         d.get("categories") or [])
    elif kind == "estimate":
        ok, msg = _start(kind, job_estimate)
    else:
        return jsonify(ok=False, message="unknown job"), 404
    return jsonify(ok=ok, message=msg), (200 if ok else 409)


@app.get("/api/job")
def job():
    return jsonify(JOB)


@app.get("/api/pois")
def pois():
    aid = request.args.get("area_id", type=int)
    if aid:
        rows = db.q("SELECT p.id,p.name,p.lat,p.lon,p.category,p.subtype,p.final_label,p.final_weekly,p.agreement,"
                    "p.n_sources,p.perm_closed,p.retrieved_at FROM pois p JOIN poi_area a ON a.poi_id=p.id WHERE a.area_id=?", (aid,))
    else:
        rows = db.q("SELECT id,name,lat,lon,category,subtype,final_label,final_weekly,agreement,n_sources,perm_closed,"
                    "retrieved_at FROM pois")
    for r in rows:
        r["hours_text"] = hours.to_text(json.loads(r["final_weekly"])) if r["final_weekly"] else ""
        r.pop("final_weekly")
    return jsonify(rows)


@app.get("/api/pois/<path:pid>")
def poi_detail(pid):
    p = db.q("SELECT * FROM pois WHERE id=?", (pid,))
    if not p:
        return jsonify(error="not found"), 404
    p = p[0]
    p["tags"] = json.loads(p["tags"] or "{}")
    p["hours_text"] = hours.to_text(json.loads(p["final_weekly"])) if p["final_weekly"] else ""
    p["matrix"] = hours.to_matrix(json.loads(p["final_weekly"])) if p["final_weekly"] else None
    srcs = db.q("SELECT * FROM sources WHERE poi_id=? ORDER BY id", (pid,))
    audits = {a["source_id"]: a for a in db.q("SELECT * FROM audits WHERE poi_id=?", (pid,))}
    for s in srcs:
        s["hours_text"] = hours.to_text(json.loads(s["weekly"])) if s["weekly"] else ""
        s["audit"] = audits.get(s["id"])
    p["sources"] = srcs
    p["attempts"] = db.q("SELECT step,url,status FROM attempts WHERE poi_id=? ORDER BY id", (pid,))
    p["areas"] = [r["name"] for r in db.q("SELECT a.name FROM areas a JOIN poi_area pa ON pa.area_id=a.id WHERE pa.poi_id=?", (pid,))]
    return jsonify(p)


@app.post("/api/pois/<path:pid>/manual")
def poi_manual(pid):
    d = request.get_json(force=True)
    r = hours.parse_any(d.get("hours", ""))
    weekly, warn = r.get("weekly"), r.get("notes", [])
    if not weekly:
        return jsonify(error="Could not parse. Use e.g. 'Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off' or '24/7'",
                       warnings=warn), 400
    db.add_source(pid, "manual", "manual", d.get("url", ""), d.get("note", "") or d.get("hours"), weekly, 1.0,
                  "entered by researcher")
    return jsonify(label=pipeline.reconcile(pid), hours_text=hours.to_text(weekly), warnings=warn)


# ---------------------------------------------------------------- Google check queue
def _google_url(p: dict) -> str:
    from urllib.parse import quote_plus
    tags = json.loads(p.get("tags") or "{}")
    street = tags.get("addr:street", "")
    return "https://www.google.com/search?hl=en&q=" + quote_plus(f"{p['name']} {street} Singapore opening hours".replace("  ", " "))


@app.get("/api/queue")
def queue():
    labels = (request.args.get("labels") or "missing,pending").split(",")
    cat = request.args.get("category") or ""
    aids = [int(a) for a in (request.args.get("area_ids") or "").split(",") if a]
    sql = "SELECT DISTINCT p.* FROM pois p JOIN poi_area a ON a.poi_id=p.id"
    args: list = []
    if aids:
        sql += " WHERE a.area_id IN (%s)" % ",".join("?" * len(aids))
        args += aids
    rows = [r for r in db.q(sql, args) if r["final_label"] in labels and r["name"] and not r["perm_closed"]
            and (not cat or r["category"] == cat)]
    checked = {r["poi_id"] for r in db.q("SELECT DISTINCT poi_id FROM attempts WHERE step='google_check'")}
    rows = [r for r in rows if r["id"] not in checked or request.args.get("include_checked") == "1"]
    rows.sort(key=lambda r: (r["category"], r["name"]))
    out = []
    for r in rows:
        out.append({"id": r["id"], "name": r["name"], "category": r["category"], "subtype": r["subtype"],
                    "address": r["address"], "label": r["final_label"], "lat": r["lat"], "lon": r["lon"],
                    "hours_text": hours.to_text(json.loads(r["final_weekly"])) if r["final_weekly"] else "",
                    "google_url": _google_url(r),
                    "maps_url": "https://www.google.com/maps/search/?api=1&query="
                                + __import__("urllib.parse").parse.quote_plus(f"{r['name']} {r['lat']},{r['lon']}")})
    return jsonify(out)


@app.post("/api/parse")
def parse_hours():
    r = hours.parse_any(request.get_json(force=True).get("text", ""))
    w = r.get("weekly")
    return jsonify(ok=bool(w), complete=hours.is_complete(w), hours_text=hours.to_text(w),
                   matrix=hours.to_matrix(w) if w else None, notes=r.get("notes", []))


@app.post("/api/pois/<path:pid>/google_check")
def google_check(pid):
    """Researcher looked the POI up on Google (search panel / Maps) and pasted or flagged the result."""
    d = request.get_json(force=True)
    action = d.get("action")
    p = db.q("SELECT * FROM pois WHERE id=?", (pid,))
    if not p:
        return jsonify(error="not found"), 404
    url = d.get("url") or _google_url(p[0])
    if action == "save":
        r = hours.parse_any(d.get("text", ""))
        if not r.get("weekly"):
            return jsonify(error="Could not read any hours from the pasted text"), 400
        db.add_source(pid, "manual", "google_copy", url, d.get("text", "")[:600], r["weekly"], 1.0,
                      "copied from Google listing by researcher")
        db.log_attempt(pid, "google_check", url, "hours copied from Google")
    elif action == "no_hours":
        db.log_attempt(pid, "google_check", url, "Google shows no opening hours")
    elif action == "closed":
        db.x("UPDATE pois SET perm_closed=1 WHERE id=?", (pid,))
        db.log_attempt(pid, "google_check", url, "permanently closed / not found on Google")
    elif action == "not_found":
        db.log_attempt(pid, "google_check", url, "place not found on Google")
    else:
        return jsonify(error="bad action"), 400
    db.x("UPDATE pois SET retrieved_at=COALESCE(retrieved_at, ?) WHERE id=?", (time.time(), pid))
    return jsonify(label=pipeline.reconcile(pid))


@app.post("/api/audits")
def add_audit():
    d = request.get_json(force=True)
    src = db.q("SELECT * FROM sources WHERE id=?", (int(d["source_id"]),))
    if not src:
        return jsonify(error="source not found"), 404
    src = src[0]
    if d["verdict"] not in ("correct", "incorrect", "unsure"):
        return jsonify(error="bad verdict"), 400
    db.x("DELETE FROM audits WHERE source_id=?", (src["id"],))
    db.x("INSERT INTO audits(source_id,poi_id,verdict,corrected,note,created) VALUES(?,?,?,?,?,?)",
         (src["id"], src["poi_id"], d["verdict"], d.get("corrected", ""), d.get("note", ""), time.time()))
    if d["verdict"] == "incorrect" and d.get("corrected"):
        weekly, _ = hours.parse_osm(d["corrected"])
        if weekly:
            db.add_source(src["poi_id"], "manual", "manual", d.get("url", ""), d["corrected"], weekly, 1.0,
                          f"correction during audit of source #{src['id']}")
    return jsonify(label=pipeline.reconcile(src["poi_id"]))


@app.get("/api/audit_sample")
def audit_sample():
    return jsonify(pipeline.audit_sample(request.args.get("per", 8, type=int)))


def _labels():
    l = request.args.get("labels")
    return l.split(",") if l else None


@app.get("/api/availability")
def availability():
    return jsonify(analysis.availability(request.args.get("area_id", type=int), _labels(),
                                         request.args.get("daytype", "weekday")))


@app.get("/api/states")
def states():
    return jsonify(analysis.poi_states(request.args.get("area_id", type=int), _labels(),
                                       request.args.get("day", "mo"), request.args.get("hour", 12, type=int)))


@app.get("/api/coverage")
def coverage():
    return jsonify(analysis.coverage(request.args.get("area_id", type=int)))


@app.get("/api/validation")
def validation():
    return jsonify(analysis.validation())


@app.post("/api/reset")
def reset():
    if JOB["status"] == "running":
        return jsonify(error="stop the running job first"), 409
    db.reset_all()
    return jsonify(ok=True)


@app.get("/export/<kind>")
def do_export(kind):
    aid = request.args.get("area_id", type=int)
    stamp = time.strftime("%Y%m%d")
    makers = {
        "pois.csv": lambda: export.pois_csv(aid),
        "hourly_matrix.csv": lambda: export.hourly_csv(aid),
        "availability_profiles.csv": lambda: export.profiles_csv(_labels()),
        "evidence_sources.csv": export.sources_csv,
        "crawl_attempts.csv": export.attempts_csv,
        "audits.csv": export.audits_csv,
        "pois.geojson": lambda: export.geojson(aid),
    }
    if kind not in makers:
        return "unknown export", 404
    mime = "application/geo+json" if kind.endswith("geojson") else "text/csv"
    return Response(makers[kind](), mimetype=mime + "; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=temporal_city_{stamp}_{kind}"})


def _free_port(start: int) -> int:
    import socket
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sk:
            if sk.connect_ex(("127.0.0.1", port)) != 0:  # nobody listening → free
                return port
    return start


def _init():
    db.con()
    net.configure(db.get_settings().get("proxy", ""))
    if not PUBLIC_DEMO:
        for r in db.q("SELECT id, osm_opening_hours FROM pois"):  # upgrade older databases
            pipeline._ingest_osm(r["id"], r["osm_opening_hours"])
            pipeline.reconcile(r["id"])


_init()  # also runs under gunicorn (public deployment)
db.checkpoint()  # fold any leftover -wal file into the .db at start-up

if __name__ == "__main__":
    import webbrowser
    port = _free_port(int(os.environ.get("PORT", 8765)))
    url = f"http://127.0.0.1:{port}"
    print("\n  ==============================================")
    print(f"   Temporal City {VERSION}  ·  Story / Atlas / Collector")
    print(f"   Open:  {url}")
    _s = db.summary()
    print(f"   Database: {_s['path']}")
    print(f"   {_s['pois']} POIs · areas: " + (", ".join(f"{x['name']} ({x['n']})" for x in _s['areas']) or "none"))
    print("   Keep this window open. Close it to stop.")
    print("  ==============================================\n")
    if not os.environ.get("TC_NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
