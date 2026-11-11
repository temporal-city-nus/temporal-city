"""Build the public, static version of the site for GitHub Pages.

    py tools/build_pages.py            # writes docs/  (commit it, then Settings > Pages > main /docs)

What is published
  index.html        Story          (same page as the local app)
  atlas.html        Atlas          (Google Places sample for the three case areas, fully interactive)
  information.html  Information    (method, AI, limitations; portraits as static images)
  collector.html    the real Collector, running in the browser: static/web-collector.js answers its API calls
                    (any area via OpenStreetMap, Google Places with the visitor's key; the three case areas
                    from the project's Google Places sample, tools/build_demo_data.py).

The footer of every page links to the GitHub repository. The address is worked out in the browser
from the Pages URL (https://USER.github.io/REPO/ -> https://github.com/USER/REPO), so nothing needs
to be filled in by hand.
"""
from __future__ import annotations

import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# the full Collector (Python server on Render): the public site's "Collector" links open it
FULL = "https://temporal-city.onrender.com/"
STATIC = os.path.join(ROOT, "static")
OUT = os.path.join(ROOT, "docs")
SHOTS = os.path.join(ROOT, "tools", "pages_shots")

VERSION = re.search(r'VERSION\s*=\s*"([^"]+)"', open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()).group(1)
# a new value on every build, so browsers fetch the new scripts and styles instead of cached ones
import time as _time
VERSION = f"{VERSION}-{_time.strftime('%Y%m%d%H%M')}"

REPO_JS = """/* Footer link to the GitHub repository, derived from the GitHub Pages address. */
(function () {
  var a = document.querySelectorAll('.tc-repo');
  if (!a.length) return;
  var h = location.hostname, m = h.match(/^([^.]+)\\.github\\.io$/i), url = 'https://github.com/';
  if (m) {
    var repo = location.pathname.split('/').filter(Boolean)[0];
    url += m[1] + '/' + (repo && !/\\.html$/i.test(repo) ? repo : m[1] + '.github.io');
  }
  if (m) a.forEach(function (el) { el.href = url; });
})();
"""

FOOTER_LINK = ('<span><a class="tc-repo" href="https://github.com/temporal-city-nus/temporal-city" '
               'style="color:inherit;text-decoration:underline;text-underline-offset:3px">Project repository on GitHub →</a></span>')


def rel_paths(html: str) -> str:
    html = html.replace("__VER__", VERSION)
    html = html.replace('https://unpkg.com/maplibre-gl@5.8.0/dist/maplibre-gl.js', 'static/vendor/maplibre-gl.js')
    html = re.sub(r'(["\'(])/static/', r'\1static/', html)
    html = re.sub(r'(static/[\w./-]+\.(?:js|css))\?v[\w-]*"', r'\1?' + VERSION + '"', html)
    # "Collector" links open the browser version on this site (websites + AI through the online server);
    # the full version on Render stays linked from Information as "server version"
    html = html.replace('<tr><td><a href="collector.html" data-needs-app>Collector</a></td>',
                        '<tr><td><a href="collector.html">Collector</a><br><a href="' + FULL + 'collector.html" class="small">server version</a></td>')
    html = html.replace('href="collector.html" data-needs-app', 'href="collector.html"')
    # Atlas: atlas.html?source=collector is built by the server from this browser's Collector data (web-atlas.js)
    return html


def add_footer_link(html: str) -> str:
    if "</div></footer>" in html:
        html = html.replace("</div></footer>", FOOTER_LINK + "</div></footer>", 1)
        html = html.replace("</body>", '<script src="static/repo-link.js"></script>\n</body>', 1)
    return html


def avatars() -> dict[str, str]:
    src, dst, out = os.path.join(STATIC, "avatars"), os.path.join(OUT, "static", "avatars"), {}
    os.makedirs(dst, exist_ok=True)
    for name in sorted(os.listdir(src)):
        slug, _ = os.path.splitext(name)
        data = open(os.path.join(src, name), "rb").read()
        ext = "png" if data.startswith(b"\x89PNG") else "gif" if data.startswith(b"GIF8") else "jpg" if data.startswith(b"\xff\xd8") else None
        if ext:
            open(os.path.join(dst, f"{slug}.{ext}"), "wb").write(data)
            out[slug] = f"static/avatars/{slug}.{ext}"
    return out


def information(html: str, pics: dict[str, str]) -> str:
    import json
    html = html.replace("const url = '/api/author-avatar/' + slug;",
                        "const url = (" + json.dumps(pics) + ")[slug]; if (!url) continue;")
    # portraits are fixed on the public site
    html = re.sub(r'<input type="file"([^>]*)>', r'<input type="file" disabled\1>', html)
    return html


STEPS = [
    ("00", "Setup", "Connect the data sources",
     "Optional, best done first. Add a <b>Google Places API key</b> for the most complete opening hours, choose an "
     "<b>AI model</b> (Ollama, Gemini, Groq, DeepSeek, OpenAI or Claude) to read hours from website text, and set a proxy "
     "if OpenStreetMap is blocked. <b>Test connections</b> checks each one.", "setup", False),
    ("01", "Area", "Choose the study areas",
     "Add the three case studies, an MRT/LRT station catchment, a point on the map or a GeoJSON polygon. "
     "Only ticked areas are used in the next steps.", "area", False),
    ("02", "Discover", "Find every amenity",
     "Queries OpenStreetMap for all amenities, shops and services inside the ticked areas, drops benches, parking and "
     "similar, and sorts the rest into six categories.", None, False),
    ("03", "Hours", "Get the opening hours",
     "Tries the OSM tag, then Google Places (if a key is set), then business websites. A website is read first from its "
     "structured data, then by rules; where the hours are only written as sentences, the <b>AI model turns the text into "
     "a 7 × 24 weekly schedule</b> and must quote the sentence it used. The quote is checked against the page, or the "
     "result is rejected. Places still missing can be filled by hand from Google.", "ai", True),
    ("04", "Review", "Check the evidence",
     "Every record shows all its sources, the exact evidence text and the link. Two sources agreeing on ≥ 90% of the 168 "
     "weekly hours makes a record <b>verified</b>; disagreement is flagged as a <b>conflict</b> for a person to resolve. "
     "<b>Validate accuracy</b> draws a random sample to check by hand.", None, False),
    ("05", "Explore", "See availability through the day",
     "Drag the hour to see which places are open on the map; the chart shows the share open in every hour.", None, False),
    ("06", "Export", "Use the result",
     "Download CSV / GeoJSON for QGIS or the report, or open the ticked areas in the Atlas for maps, GFA and the "
     "comparison.", None, False),
]


def collector(info_html: str) -> str:
    """The walkthrough page reuses the Information page's head, bar, styles and scripts."""
    head, rest = info_html.split("<main>", 1)
    _, tail = rest.split("</main>", 1)
    head = head.replace("<title>Temporal City Information</title>", "<title>Temporal City Collector</title>")
    head = head.replace('<a href="information.html" aria-current="page">', '<a href="information.html">')
    head = head.replace('<a href="collector.html">Collector</a>', '<a href="collector.html" aria-current="page">Collector</a>')
    # drop the portrait script (last script block) from the copied tail
    tail = re.sub(r"<script>\s*\(\(\) => \{\s*const status = document\.querySelector\('\.author-status'\);.*?</script>", "", tail, flags=re.S)
    toc = "\n".join(f'  <a href="#s{n}"><b>{n}</b>{name}</a>' for n, name, *_ in STEPS)
    toc += '\n  <a href="#run"><b>→</b>Run it yourself</a>'
    secs = []
    for n, name, title, text, shot, ai in STEPS:
        img = (f'<figure class="shot{' narrow' if shot == 'ai' else ''}"><img src="static/shots/{shot}.png" alt="Collector, step {n} {name}" loading="lazy">'
               f'<figcaption>{"The AI model setting in Setup (any compatible model can be used)." if shot == "ai" else f"Screenshot of the local Collector, step {n}."}</figcaption></figure>') if shot and os.path.exists(os.path.join(SHOTS, shot + ".png")) else ""
        badge = ' <span class="ai">AI</span>' if ai else ""
        secs.append(f'<section class="sec" id="s{n}"><div class="eyebrow">Step {n} · {name}{badge}</div>'
                    f'<h2>{title}</h2><p>{text}</p>{img}</section>')
    secs.append(
        '<section class="sec" id="run"><div class="eyebrow">Run it yourself</div><h2>The Collector runs on your own computer.</h2>'
        '<p>It needs a small Python server, because it calls OpenStreetMap, Google Places, websites and the AI model and '
        'keeps the results in a local database. GitHub Pages can only host static pages, so this public site shows the '
        'Story, the Atlas (Google Places sample for the three case areas) and the Information page, and explains the '
        'Collector here.</p>'
        '<div class="formula">py -m pip install -r requirements.txt<br>py app.py   →   open http://127.0.0.1:8765</div>'
        '<p>Full instructions are in the README of the <a class="tc-repo-inline" href="https://github.com/">project repository</a>. '
        'API keys are entered by each user in Setup and are never stored in the repository.</p></section>')
    main = (
        '<main>\n<div class="wrap hero">\n  <div class="eyebrow" style="color:var(--ink)">Collector · how the dataset is built</div>\n'
        '  <h1>Build the dataset.</h1>\n'
        '  <p class="lead">The Collector finds every amenity in a study area and retrieves its opening hours from OpenStreetMap, '
        'Google Places and business websites, using AI only to read hours that websites write as plain sentences. Every value '
        'keeps its source, evidence and quality label.</p>\n'
        '  <div class="rq"><span>On this public site</span><q>The Collector runs in the local app. This page walks through its seven steps.</q></div>\n'
        '</div>\n<div class="wrap layout">\n<nav class="toc" id="toc" aria-label="On this page">\n' + toc + '\n</nav>\n'
        '<div class="content">\n' + "\n".join(secs) + '\n</div>\n</div>\n</main>')
    css = ('<style>.shot{margin:18px 0 0}.shot img{display:block;width:100%;height:auto;border:1px solid var(--line);'
           'border-radius:14px;box-shadow:0 10px 30px rgba(20,30,50,.08)}.shot.narrow{max-width:380px}.shot figcaption{margin-top:8px;font-size:12px;'
           'color:var(--muted)}.sec .ai{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid currentColor;'
           'border-radius:6px;font:700 10px/1.6 var(--f-mono);letter-spacing:.06em}</style>\n</head>')
    head = head.replace("</head>", css, 1)
    page = head + main + tail
    page = page.replace('href="https://github.com/">project repository</a>',
                        'href="https://github.com/" class="tc-repo">project repository</a>')
    return page


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "static"))
    for name in os.listdir(STATIC):
        p = os.path.join(STATIC, name)
        if name == "avatars" or name.endswith(".html"):
            continue
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(OUT, "static", name))
        else:
            text = name.endswith((".js", ".css"))
            if text:
                s = open(p, encoding="utf-8").read()
                s = re.sub(r'(["\'(])/static/', r'\1static/', s).replace('collector.html#settings" data-needs-app', 'collector.html"')
                if name == "app.js":  # exports are pre-generated files on the public site
                    s = s.replace("window.location = `/export/${a.dataset.k}?${qs}`;",
                                  "if (window.TC_WEB_EXPORT) return TC_WEB_EXPORT(a.dataset.k, aid, [...S.exLabels]); window.location = `/export/${a.dataset.k}?${qs}`;")
                open(os.path.join(OUT, "static", name), "w", encoding="utf-8").write(s)
            else:
                shutil.copy2(p, os.path.join(OUT, "static", name))
    open(os.path.join(OUT, "static", "repo-link.js"), "w", encoding="utf-8").write(REPO_JS)
    pics = avatars()

    pages = {}
    for name in ("index.html", "atlas.html", "information.html"):
        pages[name] = rel_paths(open(os.path.join(STATIC, name), encoding="utf-8").read())
    pages["atlas.html"] = pages["atlas.html"].replace('<head><meta charset="UTF-8">',
        '<head><meta charset="UTF-8"><script src="static/web-atlas.js?' + VERSION + '"></script>', 1)
    assert "web-atlas.js" in pages["atlas.html"]
    pages["information.html"] = information(pages["information.html"], pics)
    # the real Collector running in the browser: web-collector.js answers its API calls (any area via OSM / Google)
    coll = rel_paths(open(os.path.join(STATIC, "collector.html"), encoding="utf-8").read())
    coll = coll.replace("<h2>Google check queue</h2>", "<h2>Google check queue · paste and AI</h2>", 1)
    coll = coll.replace('<div class="card">\n          <h3>Web pages</h3>',
        '<div class="card">\n          <h3>Online server <span class="muted">(websites + AI)</span></h3>'
        '\n          <label class="chk"><input type="checkbox" name="use_server"> Read business websites through the online server</label>'
        '\n          <p class="hint">A browser cannot open other websites, so the project’s server (temporal-city.onrender.com) searches and reads them for each place and returns the hours: schema.org data, rules, then your AI model below. Your API key is sent with each request and is not stored there. The free server may take about a minute to wake up.</p>'
        '\n        </div>\n        <div class="card">\n          <h3>Web pages</h3>', 1)
    coll = coll.replace('<p class="lead">For POIs the automatic sources could not fill.',
                        '<p class="lead"><b>Browser version:</b> you can paste hours text from Google <i>or from the business website</i>; where the rules cannot read it, the AI model chosen in 00 Setup reads it and must quote the sentence it used. For POIs the automatic sources could not fill.', 1)
    coll = coll.replace('<script src="static/daynight.js', '<script src="static/web-collector.js?' + VERSION + '"></script>\n<script src="static/daynight.js', 1)
    pages["collector.html"] = coll
    import subprocess, sys
    subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "build_demo_data.py")], check=True)
    for name, html in pages.items():
        open(os.path.join(OUT, name), "w", encoding="utf-8").write(add_footer_link(html))
    open(os.path.join(OUT, ".nojekyll"), "w").close()
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(OUT) for f in fs)
    print(f"docs/ written: {len(pages)} pages, {size / 1e6:.1f} MB, version {VERSION}")


if __name__ == "__main__":
    main()
