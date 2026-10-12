"""Runtime settings, all overridable through environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _f(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _b(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Area watched: Panama plus Costa Rica, western Colombia and the nearby Pacific.
    min_lat: float = _f("WATCH_MIN_LAT", 2.0)
    max_lat: float = _f("WATCH_MAX_LAT", 13.0)
    min_lon: float = _f("WATCH_MIN_LON", -87.0)
    max_lon: float = _f("WATCH_MAX_LON", -73.0)
    # Events smaller than this are stored but never notified.
    min_mag_store: float = _f("MIN_MAG_STORE", 2.5)

    emsc_ws_url: str = os.environ.get(
        "EMSC_WS_URL", "wss://www.seismicportal.eu/standing_order/websocket")
    emsc_fdsn_url: str = os.environ.get(
        "EMSC_FDSN_URL", "https://www.seismicportal.eu/fdsnws/event/1/query")
    usgs_feed_url: str = os.environ.get(
        "USGS_FEED_URL",
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson")
    # Safety-net polling (catches anything the WebSocket missed while reconnecting).
    poll_seconds: float = _f("POLL_SECONDS", 30)

    # Never notify about events older than this (avoids alert storms after a backfill).
    max_notify_age_s: float = _f("MAX_NOTIFY_AGE_S", 20 * 60)
    # Re-notify a device if a revision raises its expected intensity by this much.
    renotify_delta: float = _f("RENOTIFY_DELTA", 1.0)
    # Two origins within these limits are treated as the same earthquake.
    assoc_seconds: float = _f("ASSOC_SECONDS", 30)
    assoc_km: float = _f("ASSOC_KM", 120)

    events_collection: str = os.environ.get("EVENTS_COLLECTION", "events")
    devices_collection: str = os.environ.get("DEVICES_COLLECTION", "devices")
    devices_refresh_s: float = _f("DEVICES_REFRESH_S", 60)

    # DRY_RUN=true: log what would be written/sent, touch nothing (local testing).
    dry_run: bool = _b("DRY_RUN", False)

    def in_area(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon


SETTINGS = Settings()
