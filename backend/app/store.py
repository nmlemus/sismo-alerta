"""Persistence (Firestore) and push delivery (FCM), with in-memory stand-ins for tests and DRY_RUN."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from .models import Event, Origin

log = logging.getLogger(__name__)


@dataclass
class Device:
    id: str
    token: str | None
    lat: float
    lon: float
    threshold_level: int = 4     # notify when expected intensity rounds to this MMI level or more
    min_mag: float = 0.0         # ...and the magnitude is at least this
    always_mag: float = 6.0      # always notify for events this big anywhere in the watch area
    site_adjust: float = 0.6     # local amplification added to the model (Panama City calibration)
    enabled: bool = True

    @classmethod
    def from_doc(cls, doc_id: str, d: dict) -> "Device | None":
        try:
            return cls(
                id=doc_id,
                token=d.get("fcmToken"),
                lat=float(d["lat"]),
                lon=float(d["lon"]),
                threshold_level=int(d.get("thresholdLevel", 4)),
                min_mag=float(d.get("minMag", 0.0)),
                always_mag=float(d.get("alwaysMag", 6.0)),
                site_adjust=float(d.get("siteAdjust", 0.6)),
                enabled=bool(d.get("enabled", True)),
            )
        except (KeyError, TypeError, ValueError):
            return None  # device without a location yet


class Store(Protocol):
    async def save_event(self, ev: Event, notified: dict[str, float]) -> None: ...
    async def load_recent_events(self, hours: float) -> list[tuple[Event, dict[str, float]]]: ...
    async def load_devices(self) -> list[Device]: ...
    async def clear_token(self, device_id: str) -> None: ...


class Sender(Protocol):
    async def send(self, device: Device, title: str, body: str, data: dict[str, str], urgent: bool) -> bool: ...


# --------------------------------------------------------------------------- memory

class MemoryStore:
    def __init__(self, devices: list[Device] | None = None):
        self.events: dict[str, tuple[Event, dict[str, float]]] = {}
        self.devices = devices or []

    async def save_event(self, ev, notified):
        self.events[ev.id] = (ev, dict(notified))
        p = ev.preferred
        log.info("[store] %s M%.1f %s %s (%d origins)", ev.id, p.mag, p.author, p.region, len(ev.origins))

    async def load_recent_events(self, hours):
        return list(self.events.values())

    async def load_devices(self):
        return list(self.devices)

    async def clear_token(self, device_id):
        for d in self.devices:
            if d.id == device_id:
                d.token = None


class LogSender:
    def __init__(self):
        self.sent: list[tuple[str, str, str, dict]] = []

    async def send(self, device, title, body, data, urgent):
        self.sent.append((device.id, title, body, data))
        log.info("[push%s] %s | %s | %s", " URGENT" if urgent else "", device.id, title, body)
        return True


# --------------------------------------------------------------------------- firebase

class FirestoreStore:
    def __init__(self, events_collection: str, devices_collection: str):
        from firebase_admin import firestore  # imported lazily so tests need no credentials
        self._db = firestore.client()
        self._events = events_collection
        self._devices = devices_collection

    async def save_event(self, ev, notified):
        doc = ev.to_doc()
        doc["notified"] = notified
        await asyncio.to_thread(self._db.collection(self._events).document(ev.id).set, doc)

    async def load_recent_events(self, hours):
        from datetime import datetime, timedelta, timezone
        since = datetime.now(timezone.utc) - timedelta(hours=hours)

        def _q():
            return list(self._db.collection(self._events).where("time", ">=", since).stream())

        out = []
        for snap in await asyncio.to_thread(_q):
            d = snap.to_dict()
            ev = Event(id=snap.id, first_seen=d.get("firstSeenAt"))
            for o in (d.get("origins") or {}).values():
                ev.origins[f"{o['source']}:{o['sourceId']}"] = Origin(
                    source=o["source"], source_id=o["sourceId"], author=o["author"], time=o["time"],
                    lat=o["lat"], lon=o["lon"], depth_km=o["depthKm"], mag=o["mag"],
                    mag_type=o["magType"], region=o.get("region", ""), updated=o.get("updated"))
            if ev.origins:
                out.append((ev, dict(d.get("notified") or {})))
        return out

    async def load_devices(self):
        snaps = await asyncio.to_thread(lambda: list(self._db.collection(self._devices).stream()))
        return [d for s in snaps if (d := Device.from_doc(s.id, s.to_dict() or {}))]

    async def clear_token(self, device_id):
        from firebase_admin import firestore
        await asyncio.to_thread(
            self._db.collection(self._devices).document(device_id).update,
            {"fcmToken": firestore.DELETE_FIELD})


class FcmSender:
    def __init__(self, store: Store):
        self._store = store

    async def send(self, device, title, body, data, urgent):
        from firebase_admin import messaging
        if not device.token:
            return False
        msg = messaging.Message(
            token=device.token,
            notification=messaging.Notification(title=title, body=body),
            data=data,
            android=messaging.AndroidConfig(
                priority="high",
                notification=messaging.AndroidNotification(channel_id="sismos", sound="default"),
            ),
            apns=messaging.APNSConfig(
                headers={"apns-priority": "10"},
                payload=messaging.APNSPayload(aps=messaging.Aps(
                    sound="default",
                    custom_data={"interruption-level": "time-sensitive" if urgent else "active"},
                )),
            ),
        )
        try:
            await asyncio.to_thread(messaging.send, msg)
            return True
        except messaging.UnregisteredError:
            log.info("token for %s is no longer valid; clearing it", device.id)
            await self._store.clear_token(device.id)
        except Exception:  # noqa: BLE001 - one bad device must not stop the others
            log.exception("push to %s failed", device.id)
        return False
