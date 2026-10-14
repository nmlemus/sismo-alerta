"""Earthquakes from the Instituto de Geociencias (IGC) of the University of Panama.

IGC publishes its last 7 days at https://sismosgeociencias.up.ac.pa/ as an HTML
table, regenerated about once a minute, typically 2–3 minutes after each quake:
faster than EMSC, which gets the same solutions 3–10 minutes later. There is no
API and no event id, so rows are read from the first table (the desktop layout;
the page repeats each quake as a card for phones) and identified by time+place.
"""

from __future__ import annotations

import html
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

from .intensity import epicentral_km

IGC_URL = "https://sismosgeociencias.up.ac.pa/"
PANAMA_TZ = timezone(timedelta(hours=-5))  # no daylight saving

_TABLE = re.compile(r"<table\b[^>]*>(.*?)</table>", re.S | re.I)
_ROW = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S | re.I)
_CELL = re.compile(r"<td\b[^>]*>(.*?)</td>", re.S | re.I)
_HREF = re.compile(r'href="([^"]+)"', re.I)
_TAGS = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class IgcQuake:
    time: datetime  # UTC
    lat: float
    lon: float
    depth_km: float
    mag: float
    reviewed: bool  # REVISADO (checked by a seismologist) vs PRELIMINAR (automatic)
    place: str  # as IGC writes it, e.g. "Localizado en Panamá a 41km al suroeste de Chitré"
    url: str  # IGC's own map page for the quake

    @property
    def id(self) -> str:
        """Stable-enough id from the first time IGC published it (see monitor.merge)."""
        return f"igc-{int(self.time.timestamp())}"


def _text(cell: str) -> str:
    return html.unescape(_TAGS.sub("", cell)).strip()


def parse_local_time(date: str, clock: str) -> datetime:
    """'2026-10-14', '1:54:06AM' (Panama time) -> aware UTC datetime."""
    local = datetime.strptime(f"{date} {clock.replace(' ', '').upper()}", "%Y-%m-%d %I:%M:%S%p")
    return local.replace(tzinfo=PANAMA_TZ).astimezone(timezone.utc)


def parse_list(page: str, base_url: str = IGC_URL) -> list[IgcQuake]:
    """Rows of the first table on the page: Estado, Fecha, Hora Local, Latitud,
    Longitud, Profundidad, Magnitud, Región, Mapa. Unreadable rows are skipped."""
    table = _TABLE.search(page)
    if not table:
        raise ValueError("IGC page has no table (layout changed?)")
    out: list[IgcQuake] = []
    for row in _ROW.findall(table.group(1)):
        cells = _CELL.findall(row)
        if len(cells) < 8:
            continue  # header row
        estado, fecha, hora, lat, lon, prof, mag, region = (_text(c) for c in cells[:8])
        try:
            href = _HREF.search(cells[8]) if len(cells) > 8 else None
            out.append(IgcQuake(
                time=parse_local_time(fecha, hora),
                lat=float(lat), lon=float(lon),
                depth_km=float(re.sub(r"[^\d.]", "", prof) or 10),
                mag=float(mag),
                reviewed=estado.upper().startswith("REVIS"),
                place=" ".join(region.split()),
                # not html.unescape: IGC writes bare "&lt=" in its links, which would become "<="
                url=urljoin(base_url, href.group(1).replace("&amp;", "&")) if href else base_url,
            ))
        except ValueError:
            continue
    return out


def same_quake(a: IgcQuake, b_time: datetime, b_lat: float, b_lon: float) -> bool:
    """A revision moves a quake by seconds and kilometres, never by minutes."""
    return abs((a.time - b_time).total_seconds()) <= 60 and epicentral_km(a.lat, a.lon, b_lat, b_lon) <= 80


# ---------------------------------------------------------------- backup source: IGC solutions relayed by EMSC

# Towns IGC uses as references, so a quake from EMSC reads like one from IGC's list.
TOWNS = [
    ("Ciudad de Panamá", 8.983, -79.52), ("Colón", 9.359, -79.901), ("La Chorrera", 8.88, -79.783),
    ("Penonomé", 8.519, -80.357), ("Aguadulce", 8.241, -80.544), ("Santiago", 8.1, -80.983),
    ("Chitré", 7.961, -80.429), ("Las Tablas", 7.765, -80.275), ("Macaracas", 7.731, -80.553),
    ("Tonosí", 7.404, -80.442), ("Pedasí", 7.531, -80.026), ("Mariato", 7.717, -80.967),
    ("Montijo", 7.994, -81.059), ("Soná", 8.008, -81.319), ("Santa Catalina", 7.632, -81.256),
    ("Coiba", 7.45, -81.77), ("David", 8.427, -82.431), ("Puerto Armuelles", 8.283, -82.867),
    ("Bocas del Toro", 9.34, -82.242), ("La Palma", 8.409, -78.145),
]
_DIRECTIONS = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"]


def describe_place(lat: float, lon: float) -> str:
    """IGC-style text for a point: 'Localizado en Panamá a 35km al este de Coiba'."""
    name, tlat, tlon = min(TOWNS, key=lambda t: epicentral_km(lat, lon, t[1], t[2]))
    km = epicentral_km(lat, lon, tlat, tlon)
    if km < 3:
        return f"Localizado en Panamá cerca de {name}"
    north = lat - tlat
    east = (lon - tlon) * math.cos(math.radians(tlat))
    sector = round(math.degrees(math.atan2(east, north)) / 45) % 8
    return f"Localizado en Panamá a {km:.0f}km al {_DIRECTIONS[sector]} de {name}"


EMSC_EVENT = "https://www.seismicportal.eu/eventdetails.html?unid="


def from_emsc(q: IgcQuake) -> bool:
    """True for a quake taken from EMSC while IGC's own list was unavailable."""
    return q.url.startswith(EMSC_EVENT)


def quake_from_emsc(origin) -> IgcQuake:
    """An EMSC origin authored by IGC (feeds.Origin) as an IgcQuake. EMSC doesn't say
    whether IGC reviewed it, so it counts as preliminary."""
    return IgcQuake(origin.time.astimezone(timezone.utc).replace(microsecond=0), round(origin.lat, 3), round(origin.lon, 3),
                    round(origin.depth_km), round(origin.mag, 1), False, describe_place(origin.lat, origin.lon),
                    EMSC_EVENT + origin.source_id)
