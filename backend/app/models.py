"""Earthquake origins from the different feeds, and how they merge into one event."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


def parse_time(s: str) -> datetime:
    s = s.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@dataclass
class Origin:
    """One agency's solution for an earthquake."""

    source: str        # feed it came through: "emsc" or "usgs"
    source_id: str     # id inside that feed
    author: str        # agency that located it: IGC, UNA, EMSC, NEIC, us, ...
    time: datetime
    lat: float
    lon: float
    depth_km: float
    mag: float
    mag_type: str
    region: str = ""
    updated: datetime | None = None

    @property
    def key(self) -> str:
        return f"{self.source}:{self.source_id}"

    def as_dict(self) -> dict:
        return {
            "source": self.source, "sourceId": self.source_id, "author": self.author,
            "time": self.time, "lat": self.lat, "lon": self.lon, "depthKm": self.depth_km,
            "mag": self.mag, "magType": self.mag_type, "region": self.region,
            "updated": self.updated,
        }


# Local networks know Panama best for small events; for large ones a moment
# magnitude (Mw) from a global agency is the most reliable size.
_AUTHOR_RANK = {"IGC": 0, "UNA": 1, "OVSICORI": 1, "INETER": 2, "SGC": 2,
                "EMSC": 3, "NEIC": 4, "US": 4, "USGS": 4}


def _rank(o: Origin) -> tuple:
    is_big_mw = o.mag >= 6.0 and o.mag_type.lower().startswith("mw")
    return (0 if is_big_mw else 1, _AUTHOR_RANK.get(o.author.upper(), 5))


@dataclass
class Event:
    """An earthquake as the app sees it: every origin plus the preferred one."""

    id: str
    origins: dict[str, Origin] = field(default_factory=dict)
    first_seen: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def preferred(self) -> Origin:
        return min(self.origins.values(), key=_rank)

    def add(self, o: Origin) -> bool:
        """Add or replace an origin. Returns True if the preferred solution changed."""
        before = self._pref_sig()
        self.origins[o.key] = o
        return self._pref_sig() != before

    def _pref_sig(self):
        if not self.origins:
            return None
        p = self.preferred
        return (p.key, round(p.mag, 2), round(p.lat, 3), round(p.lon, 3), round(p.depth_km, 1))

    def to_doc(self) -> dict:
        p = self.preferred
        latency = (self.first_seen - p.time).total_seconds()
        return {
            "time": p.time, "lat": p.lat, "lon": p.lon, "depthKm": p.depth_km,
            "mag": p.mag, "magType": p.mag_type, "author": p.author, "region": p.region,
            "origins": {k.replace(":", "_"): o.as_dict() for k, o in self.origins.items()},
            "firstSeenAt": self.first_seen,
            "latencySeconds": round(latency, 1),
        }
