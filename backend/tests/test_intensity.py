import pytest

from app import intensity as gm

MAIN = dict(mag=7.7, depth=12.6, lat=7.5868, lon=-80.769)  # 2026-10-09 USGS solution


def _model(lat, lon):
    epi = gm.epicentral_km(MAIN["lat"], MAIN["lon"], lat, lon)
    return gm.mmi_aww2014(MAIN["mag"], gm.hypocentral_km(epi, MAIN["depth"]))


def test_distance_panama_city():
    assert gm.epicentral_km(MAIN["lat"], MAIN["lon"], 8.983, -79.517) == pytest.approx(207.6, abs=1)


@pytest.mark.parametrize("town,lat,lon,reported", [
    ("Chitré", 7.97, -80.42, 6.5),
    ("Santiago", 8.10, -80.97, 6.2),
])
def test_model_matches_dyfi_near_field(town, lat, lon, reported):
    assert _model(lat, lon) == pytest.approx(reported, abs=0.4), town


def test_panama_city_needs_site_adjustment():
    raw = _model(8.983, -79.517)
    assert raw == pytest.approx(4.6, abs=0.1)
    adjusted = gm.estimate_mmi(MAIN["mag"], MAIN["depth"], MAIN["lat"], MAIN["lon"], 8.983, -79.517, 0.6)
    assert adjusted == pytest.approx(5.2, abs=0.1)  # USGS DYFI reported 5.2
    assert gm.describe(adjusted) == "V (moderado)"


def test_arrivals():
    tp, ts = gm.arrival_seconds(210)
    assert tp == pytest.approx(35)
    assert ts == pytest.approx(60)


def test_levels_clip():
    assert gm.level(0.2) == 1
    assert gm.level(3.49) == 3
    assert gm.level(3.5) == 4
    assert gm.level(14) == 10
