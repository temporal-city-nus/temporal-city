# Temporal City

**When is a mixed-use city actually open?**

Mixed-use planning records which land uses sit together, not when their amenities are available. Temporal City builds hour-by-hour opening data for every amenity in an area and compares that 24-hour availability with the area's land-use mix.

- **Website:** https://temporal-city-nus.github.io/temporal-city/
- **Collector (browser version):** https://temporal-city-nus.github.io/temporal-city/collector.html (data and keys stay in your browser; turn on *00 Setup → Online server* to read business websites with AI; **View in Atlas** shows your own data)
- **Collector (server version):** https://temporal-city.onrender.com/collector.html (runs entirely on the free server, which may take about a minute to wake up; data is shared and may reset when the server restarts)

## Pages

| Page | What it shows |
| --- | --- |
| Story | Introduces the project’s central idea: access to everyday amenities depends on both where they are and when they are open. Three Singapore catchments illustrate how the same neighbourhood can offer different services over the course of a day. |
| Collector | Choose an area to study, find amenities and their opening hours, and review the sources. **View in Atlas** opens the collected data in the Atlas to map the results and compare study areas. |
| Atlas | Two data sources: the **Google Places sample** (three case areas) and the **Collector database** (every area you have collected). Maps the data so you can see which amenities are open, where they are concentrated, and how availability changes hour by hour. Explore hourly heatmaps alongside 3D and gross floor area (GFA) layers, and compare study areas across six research questions about access to amenities. |
| Information | Project team, research question, method, data, limitations and references. |

All pages share a day/night switch; **Auto** follows the hour shown on the page.

## Data

| Data | Source | Used for |
|---|---|---|
| Amenities and hours, three case areas | Google Places sample: 595 places, 466 with hours | Story, Atlas |
| Amenities, any other area | OpenStreetMap (Overpass API) | Collector |
| Opening hours, any other area | OSM tags, Google Places (your own key), business websites | Collector |
| Land use and plot ratio | URA Master Plan 2019 (case areas), 2025 (other areas) | Land-use mix, GFA |
| Station locations | LTA station exits | Study areas |

The case areas are 400 m catchments around Bencoolen, Tanjong Pagar and Promenade MRT stations.

## How AI is used

AI turns opening hours written as free text on websites ("Mon–Fri 9am to 6pm; closed at weekends") into a structured 7 × 24 weekly schedule. The Collector tries sources in this order and uses AI only where the earlier ones cannot read the text:

1. OpenStreetMap `opening_hours` tag
2. Google Places API (if a key is set)
3. Business website: schema.org data → rules → **AI model**

The model must quote the sentence it used; if the quote is not on the page, the result is rejected. It runs at temperature 0 and ranks below Google and OSM. Any model can be chosen in **00 Setup**: Gemini, Groq, DeepSeek, OpenAI, Claude, or Ollama on your own computer.

## Quality labels

| Label | Meaning | Analysed |
|---|---|---|
| `verified` | Two independent sources agree on ≥ 90% of the 168 weekly hours, or a researcher confirmed it | yes |
| `observed` | OSM tag only | yes |
| `retrieved` | One website or Google source | yes |
| `conflict` | Sources disagree | no |
| `estimated` | Inferred from similar places | no |
| `missing` | Nothing found | no |

## Measures

- **Open in hour h:** open for any part of that hour; past-midnight hours carry into the next day.
- **Relative availability(h)** = open places at h ÷ places with usable hours
- **Absolute availability(h)** = number of places open at h
- **Land-use mix (H)** = − Σ pᵢ ln pᵢ ÷ ln 6, over six planning classes (0 = one class, 1 = even mix)
- **GFA** = parcel area inside the study area × numeric plot ratio

Results are reported for weekdays (Mon–Fri average), Saturday and Sunday, by area and by six amenity categories. Places without usable hours are left out of the denominator, not counted as closed.

## Three ways to run the Collector

| Version | Where | Notes |
|---|---|---|
| **Browser version** | the website's `collector.html` | Data and keys stay in your browser. Any area via OSM; Google with your key. Websites + AI through the online server when **00 Setup → Online server** is ticked; or paste text in **03 → Google check** for the AI to read. **View in Atlas** sends the browser's data to the online server, which builds the Atlas (parcels, land use, GFA, COMPARE) and sends it back; nothing is stored there. |
| **Full online version** | Render | The complete server app. Shared by all visitors; data is cleared when the server restarts. The browser version can use this server for websites + AI through the switch **00 Setup → Online server**: on by default, untick it to work without the server. |
| **Local app** | your computer | The complete app, private to you. |

Collector steps: **00 Setup → 01 Area → 02 Discover → 03 Hours → 04 Review → 05 Explore → 06 Export** (CSV, GeoJSON).

### Collected data is kept

- Study areas and their POIs build up: adding a new area does not remove the earlier ones. The browser version keeps them in this browser until you delete them.
- **02 Discover** skips areas already discovered, so with two areas done and a third added only the third is run. Tick **Discover again areas already done** to run them again.
- **03 Hours** skips POIs already processed (**Skip POIs already processed**, on by default).
- **Stop** (in the job bar, 02 and 03) ends a running job at once; unfinished areas and POIs are run again next time.
- **01 Area:** the ticked areas are the ones jobs run on. **Delete selected** or **Delete all areas** removes areas with their POIs and hours; **00 Setup → Reset database** clears everything.
- **View in Atlas** shows every collected area (up to 8, largest first); **Choose study areas** in the Atlas picks which to compare.

## Run locally

1. On GitHub, click **Code → Download ZIP**. Extract the ZIP and open the extracted project folder.
2. On Windows, double-click `start.bat` to start the app. You can also open a terminal in the project folder and run:

   ```powershell
   py -m pip install -r requirements.txt
   py app.py
   ```

3. Once the app starts, open [http://127.0.0.1:8765](http://127.0.0.1:8765) in your browser.

Data is saved in `data/temporal_city.db`. API keys entered in Setup stay on your computer.
## Deployment

**GitHub Pages** (the website) is served from `docs/`. After changing files in `static/`:

```
py tools/build_pages.py
```

then upload the project to GitHub. Pages updates in 1–2 minutes.

**Render** (full online version) uses `render.yaml` and `Dockerfile`. After uploading to GitHub, open the service on Render and choose **Manual Deploy → Deploy latest commit**. Redeploy after any change to `app.py`, `core/` or `static/`: the browser version relies on the server for websites + AI and for building its Atlas.

| Environment variable | Meaning |
|---|---|
| `TC_PUBLIC_DEMO` | `0` = full Collector (current), `1` = read-only |
| `TC_WEB_ORIGINS` | Sites allowed to use the server for websites + AI and for the Atlas (default: the GitHub Pages site) |
| `TC_DB` | Path of the database file (default `data/temporal_city.db`) |
| `PORT` | Server port (set by Render) |

On Render, an API key saved in Setup is used by every visitor until removed; prefer the browser version, which sends your key with each request only.

## Repository structure

```
app.py               server: pages, Collector API, background jobs
core/                discovery (OSM), hours parsing, website crawler, AI reader, Google Places,
                     quality labels, availability analysis, land use / GFA, exports
static/              the four pages; web-collector.js runs the Collector in the browser,
                     web-atlas.js shows its data in the Atlas
docs/                built website for GitHub Pages
tools/               build scripts for the website, the Atlas and land use
data/                station list, simplified Master Plan 2025, local database
tests/               unit tests
Dockerfile, render.yaml   Render deployment
```

## Limitations

- **AI:** can misread text; accuracy not yet measured on a large sample; cannot read hours in images, PDFs or JavaScript pages.
- **Web search** sometimes finds the wrong pages; they are rejected when the place's name is not on the page.
- **Data:** small shops and hawkers are under-recorded; opening hours are not the same as actual use; holidays are not modelled.
- **Scope:** three Central Area catchments show an association, not a cause.
- **Google data:** the case-area sample is used for non-commercial research only.

The full list is on the Information page.

## Team

Bao Yihan, Li Jingyao, Lin Keyu, Yan Linhao · College of Design and Engineering, National University of Singapore.

Map data © OpenStreetMap contributors · Land use © URA · Places data © Google
