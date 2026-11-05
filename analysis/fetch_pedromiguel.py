"""Catalogs around Panama City for the Pedro Miguel M3.9 of 2026-11-04 (temporary).

Box 7.8-10.2 N, 81-78 W. USGS ComCat (all magnitudes, 1970-), EMSC (M1+, 1998-),
ISC (M2+, 1964-), the IGC page (last 7 days) and the Sismo Alerta monitor's IGC archive.
"""
import json, os, sys, time, urllib.parse, urllib.request

OUT = "analysis/pedromiguel/"
os.makedirs(OUT, exist_ok=True)
LOG = []
UA = {"User-Agent": "sismo-alerta catalog study (github.com/nmlemus/sismo-alerta)"}
BOX = dict(minlatitude=7.8, maxlatitude=10.2, minlongitude=-81.0, maxlongitude=-78.0)
END = "2026-11-06"


def get(url, binary=False, timeout=180):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                b = r.read()
                return b if binary else b.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            LOG.append(f"{attempt} {url} {e}")
            print(LOG[-1], file=sys.stderr, flush=True)
            if "404" in str(e) or "204" in str(e):
                return None
            time.sleep(8 * (attempt + 1))
    return None


def save(name, text):
    if text:
        open(OUT + name, "w").write(text)
        print(name, len(text), flush=True)


FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query?"
for a, b in (("1970-01-01", "2000-01-01"), ("2000-01-01", "2015-01-01"), ("2015-01-01", END)):
    save(f"usgs_{a[:4]}.csv", get(FDSN + urllib.parse.urlencode(dict(format="csv", starttime=a, endtime=b, orderby="time-asc", limit=20000, **BOX))))
    time.sleep(2)

for a, b in (("1998-01-01", "2012-01-01"), ("2012-01-01", "2020-01-01"), ("2020-01-01", "2025-01-01"), ("2025-01-01", END)):
    q = urllib.parse.urlencode({"start": a + "T00:00:00", "end": b + "T00:00:00", "minlat": 7.8, "maxlat": 10.2, "minlon": -81, "maxlon": -78,
                                "minmag": 1.0, "format": "text", "limit": 20000, "orderby": "time-asc"})
    save(f"emsc_{a[:4]}.txt", get("https://www.seismicportal.eu/fdsnws/event/1/query?" + q))
    time.sleep(2)

for a, b in (("1964-01-01", "2000-01-01"), ("2000-01-01", "2015-01-01"), ("2015-01-01", END)):
    q = urllib.parse.urlencode(dict(starttime=a, endtime=b, minmagnitude=2.0, format="text", **BOX))
    save(f"isc_{a[:4]}.txt", get("https://www.isc.ac.uk/fdsnws/event/1/query?" + q, timeout=300))
    time.sleep(3)

save("igc_page.html", get("https://sismosgeociencias.up.ac.pa/"))
B = "https://storage.googleapis.com/sismo-alerta-235ca-sismo-feed/"
import datetime as dt
d = dt.date(2026, 10, 1)
while d <= dt.date(2026, 11, 5):
    save(f"igc_archive_{d}.jsonl", get(B + f"archive/raw/{d}.jsonl"))
    d += dt.timedelta(days=1)
save("igc_state.json", get(B + "igc/state.json"))
open(OUT + "log.txt", "w").write("\n".join(LOG) + "\n")
