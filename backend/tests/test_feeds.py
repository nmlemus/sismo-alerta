import json

from app.feeds import origin_from_emsc_ws, origin_from_usgs_feature

# Shape of an EMSC feature as returned by seismicportal.eu (captured 2026-10-12).
EMSC_FEATURE = {
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [-80.4953, 7.6351, -10.0]},
    "id": "20261012_0000050",
    "properties": {
        "source_id": "2073260", "source_catalog": "EMSC-RTS",
        "lastupdate": "2026-10-12T03:25:10.622389Z", "time": "2026-10-12T03:19:29.0Z",
        "flynn_region": "PANAMA", "lat": 7.6351, "lon": -80.4953, "depth": 10.0,
        "evtype": "ke", "auth": "IGC", "mag": 4.2, "magtype": "m", "unid": "20261012_0000050",
    },
}


def test_emsc_ws_message():
    action, o = origin_from_emsc_ws(json.dumps({"action": "create", "data": EMSC_FEATURE}))
    assert action == "create"
    assert o.author == "IGC" and o.mag == 4.2 and o.depth_km == 10.0
    assert o.key == "emsc:20261012_0000050"
    assert o.time.isoformat() == "2026-10-12T03:19:29+00:00"


def test_emsc_skips_explosions():
    f = json.loads(json.dumps(EMSC_FEATURE))
    f["properties"]["evtype"] = "qb"
    _, o = origin_from_emsc_ws(json.dumps({"action": "create", "data": f}))
    assert o is None


def test_usgs_feature():
    feat = {
        "type": "Feature", "id": "us6000u18k",
        "geometry": {"type": "Point", "coordinates": [-80.769, 7.5868, 12.647]},
        "properties": {"mag": 7.7, "magType": "mww", "place": "12 km WSW of Pitaloza Arriba, Panama",
                       "time": 1791568566036, "updated": 1791776559524, "type": "earthquake", "net": "us"},
    }
    o = origin_from_usgs_feature(feat)
    assert o.author == "US" and o.mag_type == "mww" and o.depth_km == 12.647
    assert o.time.isoformat().startswith("2026-10-09T17:56:06")
