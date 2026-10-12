"""Turns a stream of origins into events, stores them and decides who gets a push."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import intensity as gm
from .config import SETTINGS, Settings
from .models import Event, Origin
from .store import Device, Sender, Store

log = logging.getLogger(__name__)
PANAMA_TZ = ZoneInfo("America/Panama")


def new_event_id(o: Origin) -> str:
    h = hashlib.sha1(o.key.encode()).hexdigest()[:6]
    return f"{o.time:%Y%m%dT%H%M%S}Z_{h}"


def headline(o: Origin) -> str:
    region = o.region.strip()
    if region.isupper():  # EMSC Flinn-Engdahl names come in capitals
        region = region.title()
    return f"Sismo M{o.mag:.1f}" + (f" · {region}" if region else "")


class Pipeline:
    def __init__(self, store: Store, sender: Sender, settings: Settings = SETTINGS,
                 now=lambda: datetime.now(timezone.utc)):
        self.store = store
        self.sender = sender
        self.s = settings
        self.now = now
        self.events: dict[str, Event] = {}
        self.notified: dict[str, dict[str, float]] = {}
        self._by_origin: dict[str, str] = {}
        self._devices: list[Device] = []
        self._devices_at: float | None = None
        self._lock = asyncio.Lock()
        self.stats = {"origins": 0, "events": 0, "pushes": 0, "ignored": 0}

    async def warm_start(self) -> None:
        """Reload the last day of events so a restart doesn't re-notify."""
        for ev, notified in await self.store.load_recent_events(hours=24):
            self._remember(ev)
            self.notified[ev.id] = notified
        log.info("warm start: %d recent events", len(self.events))

    def _remember(self, ev: Event) -> None:
        self.events[ev.id] = ev
        for k in ev.origins:
            self._by_origin[k] = ev.id

    def _associate(self, o: Origin) -> Event | None:
        if (eid := self._by_origin.get(o.key)) and eid in self.events:
            return self.events[eid]
        best, best_score = None, None
        for ev in self.events.values():
            p = ev.preferred
            dt = abs((p.time - o.time).total_seconds())
            if dt > self.s.assoc_seconds:
                continue
            dk = gm.epicentral_km(p.lat, p.lon, o.lat, o.lon)
            if dk > self.s.assoc_km:
                continue
            score = dt / self.s.assoc_seconds + dk / self.s.assoc_km
            if best_score is None or score < best_score:
                best, best_score = ev, score
        return best

    def _prune(self) -> None:
        cutoff = self.now() - timedelta(hours=48)
        for eid in [e for e, ev in self.events.items() if ev.preferred.time < cutoff]:
            ev = self.events.pop(eid)
            self.notified.pop(eid, None)
            for k in ev.origins:
                self._by_origin.pop(k, None)

    async def _devices_now(self) -> list[Device]:
        if self._devices_at is None or time.monotonic() - self._devices_at > self.s.devices_refresh_s:
            try:
                self._devices = await self.store.load_devices()
                self._devices_at = time.monotonic()
            except Exception:  # noqa: BLE001 - keep the last list if Firestore hiccups
                log.exception("could not refresh devices")
        return self._devices

    async def handle(self, o: Origin) -> Event | None:
        """Process one origin. Returns the event if it was stored."""
        self.stats["origins"] += 1
        if not self.s.in_area(o.lat, o.lon) or o.mag < self.s.min_mag_store:
            self.stats["ignored"] += 1
            return None
        async with self._lock:
            ev = self._associate(o)
            is_new = ev is None
            if is_new:
                ev = Event(id=new_event_id(o), first_seen=self.now())
                self.stats["events"] += 1
            changed = ev.add(o)
            self._remember(ev)
            if not (is_new or changed):
                return None
            notified = self.notified.setdefault(ev.id, {})
            await self._notify(ev, notified)
            await self.store.save_event(ev, notified)
            self._prune()
            return ev

    async def _notify(self, ev: Event, notified: dict[str, float]) -> None:
        p = ev.preferred
        age = (self.now() - p.time).total_seconds()
        if age > self.s.max_notify_age_s:
            return
        for d in await self._devices_now():
            if not (d.enabled and d.token):
                continue
            epi = gm.epicentral_km(p.lat, p.lon, d.lat, d.lon)
            mmi = gm.estimate_mmi(p.mag, p.depth_km, p.lat, p.lon, d.lat, d.lon, d.site_adjust)
            wanted = (gm.level(mmi) >= d.threshold_level and p.mag >= d.min_mag) or p.mag >= d.always_mag
            if not wanted:
                continue
            before = notified.get(d.id)
            if before is not None and mmi - before < self.s.renotify_delta:
                continue
            kind = "new" if before is None else "update"
            title = headline(p) if kind == "new" else f"Actualización: {headline(p)}"
            local = p.time.astimezone(PANAMA_TZ).strftime("%-I:%M %p").lower()
            body = (f"Intensidad estimada donde estás: {gm.describe(mmi)} · "
                    f"a {epi:.0f} km · {local}")
            rhyp = gm.hypocentral_km(epi, p.depth_km)
            tp, ts = gm.arrival_seconds(rhyp)
            data = {
                "eventId": ev.id, "kind": kind, "mag": f"{p.mag:.1f}", "magType": p.mag_type,
                "lat": f"{p.lat:.4f}", "lon": f"{p.lon:.4f}", "depthKm": f"{p.depth_km:.1f}",
                "time": p.time.isoformat(), "author": p.author, "mmi": f"{mmi:.1f}",
                "distanceKm": f"{epi:.0f}", "pSeconds": f"{tp:.0f}", "sSeconds": f"{ts:.0f}",
            }
            if await self.sender.send(d, title, body, data, urgent=gm.level(mmi) >= 5):
                notified[d.id] = round(mmi, 2)
                self.stats["pushes"] += 1
