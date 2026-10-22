"""Downloads USGS (ComCat) data for the seismicity analysis of Central America.

1. Every M4.0+ earthquake from 1990 on in a box from southern Mexico to northern
   Colombia (3–20° N, 100–75° W): data/region_m4.csv.
2. Every shallow (≤70 km) M7.4+ earthquake worldwide since 1995, with how many M4.0+
   and M4.5+ USGS located within one rupture length (at least 100 km) of it in the
   first 12.8 days, 30 days and 1 day: data/big_quakes.csv. 12.8 days is the time
   from the Panama M7.7 (Oct 9, 2026, 17:56 UTC) to Oct 22, 2026, 13:00 UTC.
"""
import csv, io, json, math, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://earthquake.usgs.gov/fdsnws/event/1/"
OUT = "analysis/data/"
NOW = datetime(2026, 10, 22, 13, 0, tzinfo=timezone.utc)


LOG = []


def iso(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def get(kind, **q):
    url = BASE + kind + "?" + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode()
        except Exception as e:  # noqa: BLE001
            body = ""
            if hasattr(e, "read"):
                try:
                    body = e.read().decode()[:300]
                except Exception:  # noqa: BLE001
                    pass
            LOG.append(f"retry {attempt} {url} {e} {body}")
            print(LOG[-1], file=sys.stderr, flush=True)
            time.sleep(4 * (attempt + 1))
    return None


def region():
    rows, header = [], None
    for year in range(1990, 2027):
        start, end = f"{year}-01-01", f"{year + 1}-01-01"
        text = get("query", format="csv", starttime=start, endtime=end, minlatitude=3, maxlatitude=20,
                   minlongitude=-100, maxlongitude=-75, minmagnitude=4.0, orderby="time-asc", limit=20000)
        if text is None:
            continue
        r = list(csv.reader(io.StringIO(text)))
        header = header or r[0]
        rows += r[1:]
        print(year, len(r) - 1, flush=True)
        time.sleep(0.5)
    with open(OUT + "region_m4.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def big():
    text = get("query", format="csv", starttime="1995-01-01", endtime=iso(NOW), minmagnitude=7.4,
               maxdepth=70, orderby="time-asc", limit=20000)
    quakes = list(csv.DictReader(io.StringIO(text)))
    print("big quakes", len(quakes), flush=True)
    out = []
    for q in quakes:
        t = datetime.fromisoformat(q["time"].replace("Z", "+00:00"))
        mag = float(q["mag"])
        radius = max(100.0, 10 ** (-2.44 + 0.59 * mag))  # Wells & Coppersmith (1994) rupture length
        row = {k: q[k] for k in ("time", "latitude", "longitude", "depth", "mag", "magType", "place", "id")}
        row["radius_km"] = round(radius)
        for label, days in (("1d", 1), ("12d8", 12.8), ("30d", 30)):
            end = min(t + timedelta(days=days), NOW)
            for mmin in (4.0, 4.5):
                text = get("count", format="geojson", starttime=iso(t + timedelta(seconds=1)),
                           endtime=iso(end), latitude=q["latitude"], longitude=q["longitude"],
                           maxradiuskm=round(radius), minmagnitude=mmin)
                row[f"n{mmin:g}_{label}"] = json.loads(text)["count"] if text else ""
                time.sleep(0.15)
            row[f"complete_{label}"] = t + timedelta(days=days) <= NOW
        out.append(row)
        print(q["time"][:10], mag, q["place"], row["n4_12d8"], flush=True)
    with open(OUT + "big_quakes.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)


if __name__ == "__main__":
    import os
    os.makedirs(OUT, exist_ok=True)
    try:
        region()
        big()
    finally:
        with open(OUT + "log.txt", "w") as f:
            f.write("\n".join(LOG) + "\n")
