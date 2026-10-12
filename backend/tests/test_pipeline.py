import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.models import Origin, parse_time
from app.pipeline import Pipeline
from app.store import Device, LogSender, MemoryStore

T0 = datetime(2026, 10, 9, 17, 56, 6, tzinfo=timezone.utc)
VISTA_ALEGRE = dict(lat=8.93, lon=-79.70)


def origin(src="emsc", sid="a", author="IGC", dt=0.0, lat=7.59, lon=-80.77, mag=4.5, mt="m", depth=10.0):
    return Origin(source=src, source_id=sid, author=author, time=T0 + timedelta(seconds=dt),
                  lat=lat, lon=lon, depth_km=depth, mag=mag, mag_type=mt, region="PANAMA")


def make(devices=None, now=T0 + timedelta(minutes=3)):
    store = MemoryStore(devices or [Device(id="noel", token="tok", threshold_level=3, **VISTA_ALEGRE)])
    sender = LogSender()
    return Pipeline(store, sender, now=lambda: now), store, sender


async def test_three_agencies_one_event():
    pipe, store, sender = make()
    await pipe.handle(origin(sid="1", author="IGC", mag=7.2, depth=4))
    await pipe.handle(origin(src="emsc", sid="2", author="EMSC", dt=1.3, lat=7.56, lon=-80.67, mag=7.7, mt="mw"))
    await pipe.handle(origin(src="usgs", sid="us6000u18k", author="US", dt=0.04, mag=7.7, mt="mww", depth=12.6))
    assert len(store.events) == 1
    ev, _ = next(iter(store.events.values()))
    assert len(ev.origins) == 3
    assert ev.preferred.mag_type.startswith("mw")  # big event: moment magnitude wins over local ml
    # One push: the M7.2 -> M7.7 revision raises the estimate here by < 1 MMI unit (RENOTIFY_DELTA).
    assert len(sender.sent) == 1


async def test_big_revision_sends_update():
    pipe, _, sender = make()
    await pipe.handle(origin(sid="1", author="IGC", mag=5.0))
    await pipe.handle(origin(src="usgs", sid="u", author="US", dt=1, mag=6.4, mt="mww"))
    assert [d["kind"] for *_, d in sender.sent] == ["new", "update"]
    assert sender.sent[1][1].startswith("Actualización: Sismo M6.4")


async def test_small_local_event_prefers_igc():
    pipe, store, sender = make()
    await pipe.handle(origin(src="usgs", sid="u1", author="US", mag=4.6, mt="mb"))
    await pipe.handle(origin(sid="e1", author="IGC", dt=2, mag=4.3))
    ev, _ = next(iter(store.events.values()))
    assert ev.preferred.author == "IGC"


async def test_threshold_and_distance():
    pipe, _, sender = make([Device(id="d", token="t", threshold_level=4, **VISTA_ALEGRE)])
    await pipe.handle(origin(sid="weak", mag=4.5))          # ~II at 190 km -> no push
    assert sender.sent == []
    await pipe.handle(origin(sid="strong", dt=600, mag=6.6))  # ~IV -> push
    assert len(sender.sent) == 1
    _, title, body, data = sender.sent[0]
    assert title.startswith("Sismo M6.6")
    assert "IV (leve)" in body and data["kind"] == "new"


async def test_always_mag_overrides_threshold():
    pipe, _, sender = make([Device(id="d", token="t", threshold_level=9, always_mag=6.0, lat=13.0, lon=-74.0)])
    await pipe.handle(origin(sid="big", mag=6.2))
    assert len(sender.sent) == 1


async def test_old_events_and_outside_area_are_not_pushed():
    pipe, store, sender = make(now=T0 + timedelta(hours=2))
    await pipe.handle(origin(sid="old", mag=7.0))
    assert sender.sent == [] and len(store.events) == 1  # stored, not pushed
    await pipe.handle(origin(sid="far", lat=35.0, lon=139.0, mag=7.0))
    assert len(store.events) == 1


async def test_duplicate_origin_is_idempotent():
    pipe, store, sender = make()
    await pipe.handle(origin(sid="x", mag=6.0))
    await pipe.handle(origin(sid="x", mag=6.0))
    assert len(sender.sent) == 1 and len(store.events) == 1


async def test_device_without_token_or_disabled_is_skipped():
    devs = [Device(id="a", token=None, threshold_level=1, **VISTA_ALEGRE),
            Device(id="b", token="t", threshold_level=1, enabled=False, **VISTA_ALEGRE)]
    pipe, _, sender = make(devs)
    await pipe.handle(origin(sid="y", mag=6.0))
    assert sender.sent == []


async def test_replay_2026_10_09_sequence():
    """Replay every USGS M4+ event of the sequence as if it arrived 2 minutes after origin."""
    rows = list(csv.DictReader((Path(__file__).parent / "data" / "usgs_2026-10-09_sequence.csv").open()))
    sent = []
    for r in rows:
        t = parse_time(r["time_utc"])
        pipe, _, sender = make([Device(id="noel", token="t", threshold_level=3, **VISTA_ALEGRE)],
                               now=t + timedelta(minutes=2))
        await pipe.handle(Origin(source="usgs", source_id=r["id"], author="US", time=t,
                                 lat=float(r["latitude"]), lon=float(r["longitude"]),
                                 depth_km=float(r["depth_km"]), mag=float(r["mag"]),
                                 mag_type=r["mag_type"], region=r["place"]))
        sent += sender.sent
    # Threshold III at Vista Alegre: the mainshock plus the largest aftershocks, not the M4 swarm.
    assert 8 <= len(sent) <= 20, len(sent)
    assert any("M7.7" in title for _, title, _, _ in sent)
