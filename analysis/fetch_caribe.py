"""Check a viral 'precursor sequence' claim (temporary). USGS + EMSC, Caribbean."""
import os, sys, time, urllib.parse, urllib.request
OUT = "analysis/caribe/"; os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "sismo-alerta catalog study (github.com/nmlemus/sismo-alerta)"}
LOG = []
def get(url, timeout=180):
    for a in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            LOG.append(f"{a} {url} {e}"); print(LOG[-1], file=sys.stderr, flush=True)
            if "404" in str(e) or "204" in str(e): return None
            time.sleep(8 * (a + 1))
def save(n, t):
    if t: open(OUT + n, "w").write(t); print(n, len(t), flush=True)
U = "https://earthquake.usgs.gov/fdsnws/event/1/query?"
E = "https://www.seismicportal.eu/fdsnws/event/1/query?"
box = dict(minlatitude=5, maxlatitude=25, minlongitude=-90, maxlongitude=-60)
# 1) every quake deeper than 150 km in the Caribbean, all time
save("usgs_deep.csv", get(U + urllib.parse.urlencode(dict(format="csv", starttime="1900-01-01", endtime="2026-11-09", mindepth=150, **box))))
save("emsc_deep.txt", get(E + urllib.parse.urlencode({"start": "1998-01-01", "end": "2026-11-09", "minlat": 5, "maxlat": 25, "minlon": -90, "maxlon": -60, "mindepth": 150, "format": "text", "limit": 20000})))
# 2) everything M2.5+ in the region for the last 400 days (for the base rate of 'sequences')
save("usgs_recent.csv", get(U + urllib.parse.urlencode(dict(format="csv", starttime="2025-10-01", endtime="2026-11-09", minmagnitude=2.5, orderby="time-asc", limit=20000, **box))))
save("emsc_recent.txt", get(E + urllib.parse.urlencode({"start": "2025-10-01", "end": "2026-11-09", "minlat": 5, "maxlat": 25, "minlon": -90, "maxlon": -60, "minmag": 2.5, "format": "text", "limit": 20000})))
# 3) world deep quakes M4+ >= 300 km for context
save("usgs_world_deep.csv", get(U + urllib.parse.urlencode(dict(format="csv", starttime="2016-01-01", endtime="2026-11-09", mindepth=300, minmagnitude=4))))
open(OUT + "log.txt", "w").write("\n".join(LOG) + "\n")
