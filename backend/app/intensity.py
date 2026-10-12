"""Ground-motion helpers shared by the ingestor and mirrored in the Flutter app.

Intensity model: Atkinson, Worden & Wald (2014), "Intensity Prediction
Equations for North America", BSSA 104(6). Hypocentral-distance form:

    R    = sqrt(Rhyp^2 + 14^2)
    B    = max(0, log10(R / 50))
    MMI  = c1 + c2*M + c3*log10(R) + c4*R + c5*B + c6*M*log10(R)

Checked against USGS "Did You Feel It?" for the 2026-10-09 M7.7 Panama
earthquake: the model gives 6.5 at Chitré (reported 6.5) and 4.6 in Panama
City (reported 5.2). A per-site adjustment (default +0.6 for Panama City)
is applied on top; see `site_adjust` in each device document.

Wave speeds are crustal averages; they are good to a few seconds at the
distances that matter here (< 500 km) and are only used for the arrival-time
estimates and the animation, never for anything safety-critical.
"""

from __future__ import annotations

import math

EARTH_RADIUS_KM = 6371.0
VP_KM_S = 6.0   # average P-wave speed in the crust
VS_KM_S = 3.5   # average S-wave speed in the crust

_C1, _C2, _C3, _C4, _C5, _C6 = 0.309, 1.864, -1.672, -0.00219, 1.77, -0.383

ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
LABEL_ES = {
    1: "no sentido",
    2: "débil",
    3: "débil",
    4: "leve",
    5: "moderado",
    6: "fuerte",
    7: "muy fuerte",
    8: "severo",
    9: "violento",
    10: "extremo",
}


def epicentral_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def hypocentral_km(epi_km: float, depth_km: float) -> float:
    return math.hypot(epi_km, max(0.0, depth_km))


def mmi_aww2014(mag: float, rhyp_km: float) -> float:
    """Predicted Modified Mercalli Intensity (unclipped, may be < 1)."""
    r = math.sqrt(rhyp_km * rhyp_km + 14.0 * 14.0)
    lr = math.log10(r)
    b = max(0.0, math.log10(r / 50.0))
    return _C1 + _C2 * mag + _C3 * lr + _C4 * r + _C5 * b + _C6 * mag * lr


def estimate_mmi(mag: float, depth_km: float, ev_lat: float, ev_lon: float,
                 lat: float, lon: float, site_adjust: float = 0.0) -> float:
    """Intensity expected at (lat, lon), clipped to [1, 10]."""
    rhyp = hypocentral_km(epicentral_km(ev_lat, ev_lon, lat, lon), depth_km)
    return max(1.0, min(10.0, mmi_aww2014(mag, rhyp) + site_adjust))


def level(mmi: float) -> int:
    """Integer MMI level a value rounds to (1..10)."""
    return max(1, min(10, int(math.floor(mmi + 0.5))))


def describe(mmi: float) -> str:
    lv = level(mmi)
    return f"{ROMAN[lv]} ({LABEL_ES[lv]})"


def arrival_seconds(rhyp_km: float) -> tuple[float, float]:
    """Seconds after origin time for the P and S waves to travel rhyp_km."""
    return rhyp_km / VP_KM_S, rhyp_km / VS_KM_S
