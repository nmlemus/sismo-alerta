"""Was the IGC M4.9 of Oct 28, 2026 (2:35:46 PM local, 9.139 N, 80.357 W, 55 km SW of Colón)
reported elsewhere, and what did the Sismo Alerta monitor see?"""
import os, sys, time, urllib.request, urllib.parse

OUT = "analysis/check/"
os.makedirs(OUT, exist_ok=True)


def get(url, name):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "sismo-alerta check (github.com/nmlemus/sismo-alerta)"})
        with urllib.request.urlopen(req, timeout=90) as r:
            body = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        body = f"ERROR {e}"
        if hasattr(e, "read"):
            try:
                body += "\n" + e.read().decode()[:500]
            except Exception:  # noqa: BLE001
                pass
    open(OUT + name, "w").write(body)
    print(name, len(body), body[:200].replace("\n", " | "), flush=True)


box = dict(minlatitude=7, maxlatitude=11, minlongitude=-82.5, maxlongitude=-77.5)
get("https://earthquake.usgs.gov/fdsnws/event/1/query?" + urllib.parse.urlencode(
    dict(format="csv", starttime="2026-10-28T18:00:00", endtime="2026-10-29T00:00:00", **box)), "usgs.csv")
get("https://www.seismicportal.eu/fdsnws/event/1/query?" + urllib.parse.urlencode(
    dict(start="2026-10-28T18:00:00", end="2026-10-29T00:00:00", minlat=7, maxlat=11, minlon=-82.5, maxlon=-77.5,
         format="text", limit=500)), "emsc.txt")
# all solutions EMSC has for events near Colón in the window
get("https://www.seismicportal.eu/fdsnws/event/1/query?" + urllib.parse.urlencode(
    dict(start="2026-10-28T19:20:00", end="2026-10-28T20:30:00", lat=9.14, lon=-80.36, maxradius=1.5,
         format="text", limit=50, includeallorigins="true")), "emsc_near.txt")
get("https://sismosgeociencias.up.ac.pa/", "igc_list.html")
B = "https://storage.googleapis.com/sismo-alerta-235ca-sismo-feed/"
for name in ("igc/recent.json", "igc/state.json", "archive/raw/2026-10-28.jsonl"):
    get(B + name, name.replace("/", "_"))
