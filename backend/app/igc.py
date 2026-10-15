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
import unicodedata
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


# ---------------------------------------------------------------- IGC's WhatsApp notices, relayed by hand

RELAY_URL = IGC_URL + "#aviso"  # marks a quake taken from a WhatsApp notice
_X_POST = re.compile(r"^https://x\.com/[^/]+/status/\d+$")


def from_x(q: IgcQuake) -> bool:
    """Taken from IGC's post on X (the url is the post)."""
    return bool(_X_POST.match(q.url))


def from_relay(q: IgcQuake) -> bool:
    """Taken from one of IGC's notices (WhatsApp, relayed by hand, or X): IGC's own
    text, with the place worked out from it."""
    return q.url == RELAY_URL or from_x(q)


def source(q: IgcQuake) -> str:
    """'igc' (its list), 'relay' (its WhatsApp notice, place approximate) or 'emsc'."""
    return "emsc" if from_emsc(q) else "relay" if from_relay(q) else "igc"


# Other places IGC may measure from (only to read notices; describe_place uses TOWNS).
MORE_TOWNS = [
    ("Boquete", 8.78, -82.44), ("Volcán", 8.77, -82.64), ("Concepción", 8.51, -82.62), ("Bugaba", 8.48, -82.62),
    ("Punta Burica", 8.03, -82.87), ("Remedios", 8.23, -81.83), ("Tolé", 8.24, -81.67), ("Las Lajas", 8.25, -81.87),
    ("Horconcitos", 8.31, -82.15), ("Boca Chica", 8.22, -82.21), ("Santa Fe", 8.51, -81.08), ("Atalaya", 8.04, -80.93),
    ("Ocú", 7.94, -80.78), ("Los Santos", 7.93, -80.42), ("Guararé", 7.81, -80.28), ("Pocrí", 7.66, -80.12),
    ("Cambutal", 7.27, -80.48), ("Punta Mala", 7.47, -80.0), ("Isla Iguana", 7.63, -79.99), ("Jicarón", 7.27, -81.79),
    ("Montuosa", 7.47, -82.24), ("Cébaco", 7.51, -81.19), ("Antón", 8.4, -80.26), ("Natá", 8.33, -80.52),
    ("El Valle", 8.6, -80.13), ("Chame", 8.58, -79.88), ("San Carlos", 8.48, -79.95), ("Arraiján", 8.95, -79.65),
    ("Panamá", 8.983, -79.52), ("Chepo", 9.17, -79.1), ("Portobelo", 9.55, -79.65), ("Taboga", 8.79, -79.55),
    ("Contadora", 8.63, -79.03), ("San Miguel", 8.45, -78.93), ("Isla del Rey", 8.38, -78.9), ("Jaqué", 7.52, -78.17),
    ("Garachiné", 8.07, -78.37), ("Yaviza", 8.16, -77.69), ("Metetí", 8.5, -77.98), ("Changuinola", 9.43, -82.52),
    ("Almirante", 9.3, -82.4), ("Chiriquí Grande", 8.95, -82.12), ("Golfito", 8.64, -83.17), ("Ciudad Neily", 8.65, -82.94),
    ("Paso Canoas", 8.53, -82.84), ("Puerto Jiménez", 8.53, -83.3), ("Juradó", 7.1, -77.76), ("Acandí", 8.51, -77.28),
    ("Bahía Solano", 6.23, -77.4), ("Turbo", 8.09, -76.73),
]
_BEARING = {"norte": 0, "nornoreste": 22.5, "noreste": 45, "estenoreste": 67.5, "este": 90, "estesureste": 112.5,
            "sureste": 135, "sursureste": 157.5, "sur": 180, "sursuroeste": 202.5, "suroeste": 225,
            "oestesuroeste": 247.5, "oeste": 270, "oestenoroeste": 292.5, "noroeste": 315, "nornoroeste": 337.5}


def _plain(s: str) -> str:
    """Lowercase without accents or extra spaces, to compare names."""
    s = unicodedata.normalize("NFKD", s.lower())
    return " ".join("".join(c for c in s if not unicodedata.combining(c)).split())


def _key(name: str) -> str:
    return re.sub(r"^(la )?islas? (de )?", "", _plain(name).strip(" .,;"))


def find_town(name: str) -> tuple[float, float] | None:
    want = _key(name)
    return next(((lat, lon) for n, lat, lon in TOWNS + MORE_TOWNS if _key(n) == want), None)


class NoticeError(ValueError):
    """A notice that can't be read; the message says what's missing, in Spanish."""


def _field(text: str, name: str, pattern: str) -> re.Match | None:
    return re.search(rf"{name}\s*:?\s*{pattern}", text, re.I)


def parse_notice(text: str, url: str = RELAY_URL) -> IgcQuake:
    """An IGC WhatsApp notice, pasted or forwarded as is:

        Estado: PRELIMINAR
        Fecha: 2026-10-14
        Hora: 2:53:09PM hora local
        Magnitud: 3.6
        Profundidad: 13km
        Localizado en Panamá a 51km al sureste de Soná

    The location comes from the town, distance and direction (a few km off at
    most), or from a "lat, lon" line if one is added."""
    # Posts on X with a picture (IGC's map) end with a t.co link; WhatsApp may add others.
    t = re.sub(r"https?://\S+", "", text)
    t = re.sub(r"[*_~]", "", t)
    missing = []
    estado = _field(t, "estado", r"([A-Za-zÁÉÍÓÚáéíóú]+)")
    fecha = _field(t, "fecha", r"(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{4})")
    hora = _field(t, "hora", r"(\d{1,2}:\d{2}(?::\d{2})?)\s*([ap])\.?\s*m\b")
    mag = _field(t, "magnitud", r"(\d+(?:[.,]\d+)?)")
    prof = _field(t, "profundidad", r"(\d+(?:[.,]\d+)?)\s*km")
    place = re.search(r"(localizad[oa]\s+en\s+[^\n]+)", t, re.I)
    for name, m in (("fecha", fecha), ("hora", hora), ("magnitud", mag), ("lugar (Localizado en …)", place)):
        if not m:
            missing.append(name)
    if missing:
        raise NoticeError("falta " + ", ".join(missing))
    date = fecha.group(1)
    if "/" in date:
        d, mo, y = date.split("/")
        date = f"{y}-{int(mo):02d}-{int(d):02d}"
    clock = hora.group(1) + ("" if hora.group(1).count(":") == 2 else ":00") + hora.group(2).upper() + "M"
    when = parse_local_time(date, clock)
    place_text = " ".join(place.group(1).split()).rstrip(" .")

    coords = re.search(r"(?<![\d.])(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{2,3}\.\d+)", t)
    if coords:
        lat, lon = float(coords.group(1)), float(coords.group(2))
        lon = -abs(lon)
    else:
        p = _plain(place_text)
        far = re.search(r"\ba\s+(\d+(?:[.,]\d+)?)\s*km\s+al\s+([a-z\- ]+?)\s+de\s+(.+)$", p)
        near = re.search(r"\bcerca\s+de\s+(.+)$", p)
        town_name = far.group(3) if far else near.group(1) if near else None
        town = find_town(town_name) if town_name else None
        if not town:
            raise NoticeError(f"no conozco «{town_name or place_text}». Vuelve a mandarlo con una línea extra: lat, lon (por ejemplo 7.55, -80.95)")
        lat, lon = town
        if far:
            bearing = _BEARING.get(far.group(2).replace("-", "").replace(" ", ""))
            if bearing is None:
                raise NoticeError(f"no entiendo la dirección «{far.group(2)}»")
            km = float(far.group(1).replace(",", "."))
            lat += km * math.cos(math.radians(bearing)) / 111.2
            lon += km * math.sin(math.radians(bearing)) / (111.2 * math.cos(math.radians(lat)))
    return IgcQuake(when, round(lat, 3), round(lon, 3), float(prof.group(1).replace(",", ".")) if prof else 10.0,
                    round(float(mag.group(1).replace(",", ".")), 1),
                    bool(estado and estado.group(1).upper().startswith("REVIS")), place_text, url)
