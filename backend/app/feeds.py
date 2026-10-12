"""Parsers and fetchers for the EMSC and USGS feeds.

EMSC (seismicportal.eu) relays origins from local networks within minutes,
including Panama's Instituto de Geociencias (author "IGC") and Costa Rica's
UNA. Its WebSocket pushes every new or updated event worldwide; the FDSN
endpoint is polled as a safety net. USGS is a slower but independent backup.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import aiohttp

from .config import SETTINGS
from .models import Origin, parse_time

log = logging.getLogger(__name__)


def origin_from_emsc_feature(feat: dict) -> Origin | None:
    """EMSC GeoJSON feature (WebSocket `data` or FDSN json) -> Origin."""
    p = feat.get("properties") or {}
    try:
        if p.get("evtype", "ke") not in ("ke", "se", "ls"):  # skip explosions, quarry blasts
            return None
        lat = float(p.get("lat", feat["geometry"]["coordinates"][1]))
        lon = float(p.get("lon", feat["geometry"]["coordinates"][0]))
        mag = p.get("mag")
        if mag is None:
            return None
        return Origin(
            source="emsc",
            source_id=str(p.get("unid") or feat.get("id")),
            author=str(p.get("auth") or "EMSC"),
            time=parse_time(p["time"]),
            lat=lat,
            lon=lon,
            depth_km=float(p.get("depth") or 10.0),
            mag=float(mag),
            mag_type=str(p.get("magtype") or "m"),
            region=str(p.get("flynn_region") or ""),
            updated=parse_time(p["lastupdate"]) if p.get("lastupdate") else None,
        )
    except (KeyError, TypeError, ValueError) as exc:
        log.warning("bad EMSC feature skipped: %s", exc)
        return None


def origin_from_emsc_ws(raw: str) -> tuple[str, Origin | None]:
    """WebSocket message -> (action, Origin). Action is 'create' or 'update'."""
    msg = json.loads(raw)
    return str(msg.get("action", "")), origin_from_emsc_feature(msg.get("data") or {})


def origin_from_usgs_feature(feat: dict) -> Origin | None:
    p = feat.get("properties") or {}
    try:
        if p.get("type", "earthquake") != "earthquake" or p.get("mag") is None:
            return None
        lon, lat, depth = feat["geometry"]["coordinates"][:3]
        return Origin(
            source="usgs",
            source_id=str(feat["id"]),
            author=str(p.get("net") or "us").upper(),
            time=datetime.fromtimestamp(p["time"] / 1000, tz=timezone.utc),
            lat=float(lat),
            lon=float(lon),
            depth_km=float(depth or 10.0),
            mag=float(p["mag"]),
            mag_type=str(p.get("magType") or ""),
            region=str(p.get("place") or ""),
            updated=datetime.fromtimestamp(p["updated"] / 1000, tz=timezone.utc) if p.get("updated") else None,
        )
    except (KeyError, TypeError, ValueError) as exc:
        log.warning("bad USGS feature skipped: %s", exc)
        return None


async def fetch_emsc_recent(session: aiohttp.ClientSession, since: datetime) -> list[Origin]:
    """Origins in the watch area created or updated since `since`."""
    s = SETTINGS
    params = {
        "format": "json", "limit": "300", "orderby": "time",
        "minlat": s.min_lat, "maxlat": s.max_lat, "minlon": s.min_lon, "maxlon": s.max_lon,
        "updatedafter": since.strftime("%Y-%m-%dT%H:%M:%S"),
        "start": (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S"),
    }
    async with session.get(s.emsc_fdsn_url, params=params, timeout=aiohttp.ClientTimeout(total=30)) as r:
        if r.status == 204:
            return []
        r.raise_for_status()
        data = await r.json(content_type=None)
    return [o for f in data.get("features", []) if (o := origin_from_emsc_feature(f))]


async def fetch_usgs_recent(session: aiohttp.ClientSession) -> list[Origin]:
    async with session.get(SETTINGS.usgs_feed_url, timeout=aiohttp.ClientTimeout(total=30)) as r:
        r.raise_for_status()
        data = await r.json(content_type=None)
    return [o for f in data.get("features", []) if (o := origin_from_usgs_feature(f))]
