"""Every aftershock of the Panama M7.7 down to M2, for the migration analysis.

- EMSC (seismicportal.eu) FDSN, preferred solutions, in and around the aftershock
  zone (5.5–9° N, 83.5–78.5° W) since the mainshock: data/emsc_small.txt (pipe-separated,
  with the author of each solution; most are IGC's).
- The Sismo Alerta monitor's archive (IGC's list, X posts and EMSC backups as seen):
  data/igc_archive_*.jsonl, and IGC's last week as published: data/igc_latest.json.
"""
import os, sys, time, urllib.request, urllib.parse

OUT = "analysis/data/"
os.makedirs(OUT, exist_ok=True)
LOG = []


def get(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sismo-alerta analysis (github.com/nmlemus/sismo-alerta)"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode()
        except Exception as e:  # noqa: BLE001
            LOG.append(f"{attempt} {url} {e}")
            print(LOG[-1], file=sys.stderr, flush=True)
            if "404" in str(e):
                return None
            time.sleep(5 * (attempt + 1))
    return None


q = urllib.parse.urlencode({"start": "2026-10-09T17:50:00", "end": "2026-10-23T00:00:00", "minlat": 5.5, "maxlat": 9.0,
                            "minlon": -83.5, "maxlon": -78.5, "minmag": 1.5, "format": "text", "limit": 20000,
                            "orderby": "time-asc"})
text = get("https://www.seismicportal.eu/fdsnws/event/1/query?" + q)
if text:
    open(OUT + "emsc_small.txt", "w").write(text)
    print("emsc lines", text.count("\n"))
B = "https://storage.googleapis.com/sismo-alerta-235ca-sismo-feed/"
for day in range(9, 23):
    t = get(B + f"archive/raw/2026-10-{day:02d}.jsonl")
    if t:
        open(OUT + f"igc_archive_2026-10-{day:02d}.jsonl", "w").write(t)
        print("archive", day, t.count("\n"))
for name in ("igc/latest.json", "igc/state.json"):
    t = get(B + name)
    if t:
        open(OUT + name.replace("/", "_"), "w").write(t)
        print(name, len(t))
open(OUT + "log_small.txt", "w").write("\n".join(LOG) + "\n")
