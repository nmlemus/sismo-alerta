"""Earthquakes from the Instituto de Geociencias (IGC) of the University of Panama.

IGC publishes its last 7 days at https://sismosgeociencias.up.ac.pa/ as an HTML
table, regenerated about once a minute, typically 2–3 minutes after each quake:
faster than EMSC, which gets the same solutions 3–10 minutes later. There is no
API and no event id, so rows are read from the first table (the desktop layout;
the page repeats each quake as a card for phones) and identified by time+place.
"""

from __future__ import annotations

import html
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
