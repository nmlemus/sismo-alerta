"""Data for the stress study of the 2026 Panama sequence.

- Every event with a moment tensor or focal mechanism in USGS ComCat in and around
  Panama (3.5-12 N, 85-76 W) since 1990, with its preferred mechanism: mechanisms.json
- The finite-fault model(s) of the M7.7 (us6000u18k) and M6.6 (us6000u19w): ffm_*
- ComCat catalog M2.5+ in the same box since 2026-08-01: usgs_recent.csv
- EMSC M1.5+ since 2026-08-01 (most Panamanian solutions are IGC's): emsc_recent.txt
- The Sismo Alerta monitor's IGC archive (Oct 15 on) and state: igc_archive_*, igc_state.json
"""
import json, os, sys, time, urllib.parse, urllib.request

OUT = "analysis/stress/"
os.makedirs(OUT, exist_ok=True)
LOG = []
UA = {"User-Agent": "sismo-alerta stress study (github.com/nmlemus/sismo-alerta)"}


def get(url, binary=False):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                b = r.read()
                return b if binary else b.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            LOG.append(f"{attempt} {url} {e}")
            print(LOG[-1], file=sys.stderr, flush=True)
            if "404" in str(e):
                return None
            time.sleep(6 * (attempt + 1))
    return None


FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query?"
BOX = dict(minlatitude=3.5, maxlatitude=12, minlongitude=-85, maxlongitude=-76)
ids = {}
for ptype in ("moment-tensor", "focal-mechanism"):
    for start, end in (("1990-01-01", "2010-01-01"), ("2010-01-01", "2026-10-29")):
        t = get(FDSN + urllib.parse.urlencode(dict(format="geojson", starttime=start, endtime=end, producttype=ptype, **BOX)))
        if t:
            for f in json.loads(t)["features"]:
                ids[f["id"]] = f
print("events with mechanisms:", len(ids), flush=True)

KEYS = ["nodal-plane-1-strike", "nodal-plane-1-dip", "nodal-plane-1-rake", "nodal-plane-2-strike", "nodal-plane-2-dip",
        "nodal-plane-2-rake", "p-axis-azimuth", "p-axis-plunge", "t-axis-azimuth", "t-axis-plunge", "n-axis-azimuth",
        "n-axis-plunge", "tensor-mrr", "tensor-mtt", "tensor-mpp", "tensor-mrt", "tensor-mrp", "tensor-mtp",
        "scalar-moment", "derived-magnitude", "derived-magnitude-type", "derived-depth", "derived-latitude",
        "derived-longitude", "beachball-source", "percent-double-couple"]
mechs = []
for i, (eid, f) in enumerate(sorted(ids.items(), key=lambda kv: kv[1]["properties"]["time"])):
    t = get(f["properties"]["detail"])
    time.sleep(0.7)
    if not t:
        continue
    d = json.loads(t)
    p = d["properties"]
    row = {"id": eid, "time": p["time"], "mag": p["mag"], "magType": p.get("magType"), "place": p.get("place"),
           "lon": d["geometry"]["coordinates"][0], "lat": d["geometry"]["coordinates"][1], "depth": d["geometry"]["coordinates"][2],
           "mechanisms": []}
    for ptype in ("moment-tensor", "focal-mechanism"):
        for prod in p.get("products", {}).get(ptype, []):
            pp = prod.get("properties", {})
            m = {"type": ptype, "source": prod.get("source"), "preferredWeight": prod.get("preferredWeight"),
                 "method": pp.get("derived-magnitude-type") or pp.get("beachball-type") or pp.get("method")}
            m.update({k: pp.get(k) for k in KEYS if k in pp})
            row["mechanisms"].append(m)
    mechs.append(row)
    if i % 25 == 0:
        print(i, p["time"], p["mag"], p.get("place"), len(row["mechanisms"]), flush=True)
json.dump(mechs, open(OUT + "mechanisms.json", "w"))

for eid in ("us6000u18k", "us6000u19w"):
    t = get(f"https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{eid}.geojson")
    if not t:
        continue
    d = json.loads(t)
    json.dump(d, open(OUT + f"detail_{eid}.json", "w"))
    for prod in d["properties"]["products"].get("finite-fault", []):
        for name, c in prod.get("contents", {}).items():
            if name.endswith((".param", ".fsp", ".geojson", ".txt", ".json", ".inp")) and c.get("length", 0) < 20_000_000:
                b = get(c["url"], binary=True)
                if b:
                    safe = name.replace("/", "_")
                    open(OUT + f"ffm_{eid}_{safe}", "wb").write(b)
                    print("ffm", eid, name, len(b), flush=True)

t = get(FDSN + urllib.parse.urlencode(dict(format="csv", starttime="2026-08-01", endtime="2026-10-29", minmagnitude=2.5,
                                            orderby="time-asc", limit=20000, **BOX)))
if t:
    open(OUT + "usgs_recent.csv", "w").write(t)
q = urllib.parse.urlencode({"start": "2026-08-01T00:00:00", "end": "2026-10-29T00:00:00", "minlat": 3.5, "maxlat": 12,
                            "minlon": -85, "maxlon": -76, "minmag": 1.5, "format": "text", "limit": 20000, "orderby": "time-asc"})
t = get("https://www.seismicportal.eu/fdsnws/event/1/query?" + q)
if t:
    open(OUT + "emsc_recent.txt", "w").write(t)
B = "https://storage.googleapis.com/sismo-alerta-235ca-sismo-feed/"
for day in range(15, 29):
    t = get(B + f"archive/raw/2026-10-{day:02d}.jsonl")
    if t:
        open(OUT + f"igc_archive_2026-10-{day:02d}.jsonl", "w").write(t)
t = get(B + "igc/state.json")
if t:
    open(OUT + "igc_state.json", "w").write(t)
open(OUT + "log.txt", "w").write("\n".join(LOG) + "\n")
