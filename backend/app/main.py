"""Cloud Run entry point: an always-on listener plus a tiny HTTP server for health checks.

Deploy with min-instances=1, max-instances=1 and CPU always allocated, so the
WebSocket stays open between requests (see infra/deploy.sh).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from datetime import datetime, timedelta, timezone

import aiohttp
from aiohttp import web

from .config import SETTINGS
from .feeds import fetch_emsc_recent, fetch_usgs_recent, origin_from_emsc_ws
from .pipeline import Pipeline
from .store import FcmSender, FirestoreStore, LogSender, MemoryStore

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sismo")

STATE = {"ws_connected": False, "ws_last_msg": None, "poll_last_ok": None, "started": None}


def _iso(dt):
    return dt.isoformat() if dt else None


async def emsc_ws_loop(pipe: Pipeline, session: aiohttp.ClientSession) -> None:
    backoff = 2.0
    while True:
        try:
            async with session.ws_connect(SETTINGS.emsc_ws_url, heartbeat=30, timeout=aiohttp.ClientWSTimeout(ws_close=10)) as ws:
                STATE["ws_connected"] = True
                backoff = 2.0
                log.info("EMSC WebSocket connected")
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    STATE["ws_last_msg"] = datetime.now(timezone.utc)
                    try:
                        action, origin = origin_from_emsc_ws(msg.data)
                    except (ValueError, json.JSONDecodeError):
                        log.warning("unparseable WebSocket message skipped")
                        continue
                    if origin:
                        ev = await pipe.handle(origin)
                        if ev:
                            log.info("ws %s %s -> %s", action, origin.key, ev.id)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("EMSC WebSocket dropped")
        STATE["ws_connected"] = False
        await asyncio.sleep(backoff + random.random())
        backoff = min(backoff * 2, 60)


async def poll_loop(pipe: Pipeline, session: aiohttp.ClientSession) -> None:
    """Safety net: catches anything the WebSocket missed, plus USGS as an independent source."""
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    while True:
        started = datetime.now(timezone.utc)
        ok = True
        try:
            for o in await fetch_emsc_recent(session, since - timedelta(minutes=2)):
                await pipe.handle(o)
        except Exception:  # noqa: BLE001
            ok = False
            log.exception("EMSC poll failed")
        try:
            for o in await fetch_usgs_recent(session):
                await pipe.handle(o)
        except Exception:  # noqa: BLE001
            ok = False
            log.exception("USGS poll failed")
        if ok:
            since = started
            STATE["poll_last_ok"] = datetime.now(timezone.utc)
        await asyncio.sleep(SETTINGS.poll_seconds)


async def on_startup(app: web.Application) -> None:
    if SETTINGS.dry_run:
        store, sender = MemoryStore(), LogSender()
        log.warning("DRY_RUN: nothing is written to Firestore and no pushes are sent")
    else:
        import firebase_admin
        firebase_admin.initialize_app()
        store = FirestoreStore(SETTINGS.events_collection, SETTINGS.devices_collection)
        sender = FcmSender(store)
    pipe = Pipeline(store, sender)
    await pipe.warm_start()
    session = aiohttp.ClientSession(headers={"User-Agent": "sismo-alerta/1.0 (+github.com/nmlemus/sismo-alerta)"})
    app["pipe"], app["session"] = pipe, session
    app["tasks"] = [asyncio.create_task(emsc_ws_loop(pipe, session)),
                    asyncio.create_task(poll_loop(pipe, session))]
    STATE["started"] = datetime.now(timezone.utc)


async def on_cleanup(app: web.Application) -> None:
    for t in app.get("tasks", []):
        t.cancel()
    if "session" in app:
        await app["session"].close()


async def healthz(request: web.Request) -> web.Response:
    now = datetime.now(timezone.utc)
    poll_ok = STATE["poll_last_ok"] and (now - STATE["poll_last_ok"]).total_seconds() < SETTINGS.poll_seconds * 5
    warming = STATE["started"] and (now - STATE["started"]).total_seconds() < 300
    healthy = STATE["ws_connected"] or poll_ok or warming
    return web.json_response({"ok": bool(healthy)}, status=200 if healthy else 503)


async def status(request: web.Request) -> web.Response:
    pipe: Pipeline = request.app["pipe"]
    return web.json_response({
        "wsConnected": STATE["ws_connected"], "wsLastMessage": _iso(STATE["ws_last_msg"]),
        "pollLastOk": _iso(STATE["poll_last_ok"]), "started": _iso(STATE["started"]),
        "eventsInMemory": len(pipe.events), "stats": pipe.stats, "dryRun": SETTINGS.dry_run,
    })


def make_app() -> web.Application:
    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/status", status)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), port=int(os.environ.get("PORT", "8080")))
