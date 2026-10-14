"""Cloud Run entry point for the IGC monitor.

Cloud Scheduler calls POST /tick every minute. Each tick asks IGC whether its
page changed (ETag), and only if it did: reads it, finds new and revised quakes,
posts new ones to Telegram (editing the message when IGC revises them), and
writes the public feed the web page reads. State lives in Cloud Storage next to
the feed, so the service can scale to zero between ticks.

Environment:
  BUCKET               Cloud Storage bucket for igc/latest.json (public) and igc/state.json.
                       Empty: files in ./monitor-data (for local runs).
  TELEGRAM_BOT_TOKEN   Bot token from @BotFather. Empty: messages are only logged.
  TELEGRAM_CHAT_ID     Channel, e.g. @mi_canal or -100123... (the bot must be an admin).
  NOTIFY_MIN_MAG       3.5   Smallest magnitude announced.
  LOUD_MIN_MAG         4.0   Below this the message arrives silently.
  NOTIFY_MAX_KM        400   Only quakes this close to Panama City.
  NOTIFY_MAX_AGE_MIN   30    Never announce anything older (e.g. after downtime).
  DASHBOARD_URL        Link in every message.
  IGC_URL              https://sismosgeociencias.up.ac.pa/
  EMSC_FDSN_URL        Backup: IGC's solutions as EMSC relays them, read when IGC's page is
                       down (maintenance, errors) or hasn't changed for STALE_MIN minutes.
  DOWN_NOTICE_MIN      10    Minutes IGC's list must be unavailable before the channel is told.
  STALE_MIN            15    Minutes without any change in IGC's page before checking EMSC too.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import html
import re

import aiohttp
from aiohttp import web

from .feeds import origin_from_emsc_feature
from .igc import IGC_URL, IgcQuake, parse_list, quake_from_emsc
from .monitor import (Known, MergeResult, buttons, cluster_note, edited_footer, feed, merge, merge_backup, message,
                      nearby_earlier, revision_note, signature, to_notify)
from .telegram import LogOnly, Telegram

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sismo.monitor")

ENV = os.environ.get
CFG = {
    "igc_url": ENV("IGC_URL", IGC_URL),
    "bucket": ENV("BUCKET", ""),
    "min_mag": float(ENV("NOTIFY_MIN_MAG", "3.5")),
    "loud_mag": float(ENV("LOUD_MIN_MAG", "4.0")),
    "max_km": float(ENV("NOTIFY_MAX_KM", "400")),
    "max_age": float(ENV("NOTIFY_MAX_AGE_MIN", "30")),
    "dashboard": ENV("DASHBOARD_URL", "https://sismo-alerta-235ca.web.app"),
    "emsc_url": ENV("EMSC_FDSN_URL", "https://www.seismicportal.eu/fdsnws/event/1/query"),
    "down_notice_min": float(ENV("DOWN_NOTICE_MIN", "10")),
    "stale_min": float(ENV("STALE_MIN", "15")),
    "agent": ENV("USER_AGENT", "SismoAlerta/1.0 (+https://github.com/nmlemus/sismo-alerta; checks once a minute with ETag)"),
}


# ---------------------------------------------------------------- storage

class FileStore:
    def __init__(self, root: str = "monitor-data"):
        self.root = Path(root)

    async def read(self, name: str) -> str | None:
        p = self.root / name
        return p.read_text() if p.exists() else None

    async def write(self, name: str, text: str, public: bool = False) -> None:
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)


class GcsStore:
    def __init__(self, bucket: str):
        from google.cloud import storage  # installed with firebase-admin

        self.bucket = storage.Client().bucket(bucket)

    async def read(self, name: str) -> str | None:
        def _get():
            blob = self.bucket.blob(name)
            return blob.download_as_text() if blob.exists() else None
        return await asyncio.to_thread(_get)

    async def write(self, name: str, text: str, public: bool = False) -> None:
        def _put():
            blob = self.bucket.blob(name)
            # The feed must never be stale in a browser or CDN (it revalidates with ETag),
            # and goes up gzipped: Cloud Storage serves it compressed to browsers.
            blob.cache_control = "no-cache, max-age=0" if public else "no-store"
            data = text.encode()
            if public:
                blob.content_encoding = "gzip"
                data = gzip.compress(data)
            blob.upload_from_string(data, content_type="application/json; charset=utf-8")
        await asyncio.to_thread(_put)


# ---------------------------------------------------------------- state

def _q_to_dict(q: IgcQuake) -> dict:
    return {"time": q.time.isoformat(), "lat": q.lat, "lon": q.lon, "depth_km": q.depth_km, "mag": q.mag,
            "reviewed": q.reviewed, "place": q.place, "url": q.url}


def _q_from_dict(d: dict) -> IgcQuake:
    return IgcQuake(datetime.fromisoformat(d["time"]), d["lat"], d["lon"], d["depth_km"], d["mag"],
                    d["reviewed"], d["place"], d["url"])


@dataclass
class State:
    etag: str | None = None
    known: dict[str, Known] = field(default_factory=dict)
    last_ok: str | None = None  # last time IGC's list was read
    last_change: str | None = None  # last time IGC's page had changed
    down_since: str | None = None  # IGC's list unavailable since then
    down_reason: str | None = None
    down_notice_id: int | None = None  # the channel message that says so

    _EXTRA = ("last_change", "down_since", "down_reason", "down_notice_id")

    def dumps(self) -> str:
        return json.dumps({
            "etag": self.etag, "last_ok": self.last_ok, **{k: getattr(self, k) for k in self._EXTRA},
            "known": [{"id": k.id, "message_id": k.message_id, "sent": k.sent_signature, "quake": _q_to_dict(k.quake)}
                      for k in self.known.values()],
        })

    @classmethod
    def loads(cls, text: str | None) -> "State":
        if not text:
            return cls()
        d = json.loads(text)
        known = {k["id"]: Known(k["id"], _q_from_dict(k["quake"]), k.get("message_id"), k.get("sent"))
                 for k in d.get("known", [])}
        st = cls(d.get("etag"), known, d.get("last_ok"))
        for k in cls._EXTRA:
            setattr(st, k, d.get(k))
        return st


# ---------------------------------------------------------------- the tick

class IgcUnavailable(Exception):
    """IGC's page answered, but without the list (maintenance page, error, empty)."""


_HEAD = re.compile(r"<(head|script|style)\b.*?</\1>", re.S | re.I)


def page_text(page: str, limit: int = 160) -> str:
    """What a page says to a person, short: 'Estamos en mantenimiento hasta las 4:30pm.'"""
    text = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", _HEAD.sub(" ", page))).split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


async def fetch_igc(session: aiohttp.ClientSession, etag: str | None) -> tuple[list[IgcQuake] | None, str | None]:
    """(quakes, etag), or (None, etag) when the page hasn't changed. Raises IgcUnavailable
    or a network error when there is no list to read."""
    headers = {"User-Agent": CFG["agent"]}
    if etag:
        headers["If-None-Match"] = etag
    async with session.get(CFG["igc_url"], headers=headers, timeout=aiohttp.ClientTimeout(total=25)) as r:
        if r.status == 304:
            return None, etag
        page = await r.text(errors="replace")
        if r.status >= 400:
            said = page_text(page)
            raise IgcUnavailable(f"la página dice: «{said}»" if said and len(said) < 120 else f"la página responde con error {r.status}")
        new_etag = r.headers.get("ETag")
    try:
        quakes = parse_list(page)
    except ValueError:
        said = page_text(page)
        raise IgcUnavailable(f"la página dice: «{said}»" if said else "la página no trae la lista de sismos") from None
    if not quakes:
        raise IgcUnavailable("la lista de sismos vino vacía")
    return quakes, new_etag


async def fetch_emsc_igc(session: aiohttp.ClientSession, now: datetime) -> list[IgcQuake]:
    """IGC's own solutions for the last 2 hours as EMSC relays them (author IGC only:
    another agency's automatic solution is how a false quake got in once)."""
    params = {"format": "json", "limit": "200", "orderby": "time",
              "minlat": "5", "maxlat": "10.5", "minlon": "-84", "maxlon": "-77", "minmag": "2.5",
              "start": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")}
    async with session.get(CFG["emsc_url"], params=params, headers={"User-Agent": CFG["agent"]},
                           timeout=aiohttp.ClientTimeout(total=20)) as r:
        if r.status == 204:
            return []
        r.raise_for_status()
        data = await r.json(content_type=None)
    origins = [o for f in data.get("features", []) if (o := origin_from_emsc_feature(f))]
    return [quake_from_emsc(o) for o in origins if o.author.upper() == "IGC"]


async def announce(tg, before: dict[str, Known], res: MergeResult) -> tuple[int, int]:
    """New quakes worth a message get one; revised ones get their message edited and a
    silent reply saying what changed. Returns (sent, edited)."""
    sent = edited = 0
    due = to_notify(res.new + [k for k in res.changed if k.message_id is None],
                    min_mag=CFG["min_mag"], max_age_min=CFG["max_age"], max_km=CFG["max_km"])
    for k in due:
        text = message(k.quake)
        near = nearby_earlier(k.quake, list(res.known.values()))
        if near:
            text += "\n\n" + cluster_note(k.quake, near.quake)
        k.message_id = await tg.send(text, silent=k.quake.mag < CFG["loud_mag"], reply_to=near.message_id if near else None,
                                     buttons=buttons(k.quake, CFG["dashboard"]))
        k.sent_signature = signature(k.quake)
        sent += 1
    for k in res.changed:
        if k.message_id and k.sent_signature != signature(k.quake):
            old = before[k.id].quake
            # The original message shows the current data, and a silent reply to it
            # says what changed, so the chat keeps the order of what happened.
            await tg.edit(k.message_id, message(k.quake) + "\n\n" + edited_footer(old), buttons(k.quake, CFG["dashboard"]))
            note = revision_note(old, k.quake)
            if note:
                await tg.send(note, silent=True, reply_to=k.message_id)
            k.sent_signature = signature(k.quake)
            edited += 1
    return sent, edited


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds")


def _minutes_since(iso: str | None, now: datetime) -> float:
    return (now - datetime.fromisoformat(iso)).total_seconds() / 60 if iso else 0.0


def _duration(minutes: float) -> str:
    m = max(1, round(minutes))
    return f"{m} min" if m < 60 else f"{m // 60} h {m % 60} min" if m % 60 else f"{m // 60} h"


def down_notice(reason: str) -> str:
    return ("⚠️ <b>La lista de sismos del IGC no está disponible</b>\n\n"
            f"Motivo: {reason[:1].lower() + reason[1:]}\n\n"
            "Mientras tanto, los avisos salen con los datos del IGC que publica EMSC, unos minutos más tarde.")


def back_notice(minutes: float) -> str:
    return (f"✅ <b>La lista del IGC volvió</b> después de {_duration(minutes)}.\n\n"
            "Los avisos vuelven a salir directo del IGC.")


async def _save(store, state: State) -> None:
    # latest.json: the week, read once by the page; recent.json: 6 h, re-read every minute.
    await store.write("igc/latest.json", json.dumps(feed(state.known), ensure_ascii=False), public=True)
    await store.write("igc/recent.json", json.dumps(feed(state.known, hours=6), ensure_ascii=False), public=True)
    await store.write("igc/state.json", state.dumps())


async def tick(app: web.Application) -> dict:
    async with app["lock"]:
        store, tg, session = app["store"], app["telegram"], app["session"]
        state: State = app.get("state") or State.loads(await store.read("igc/state.json"))
        app["state"] = state
        now = datetime.now(timezone.utc).replace(microsecond=0)
        try:
            quakes, etag = await fetch_igc(session, state.etag)
        except (IgcUnavailable, aiohttp.ClientError, asyncio.TimeoutError) as e:
            reason = str(e) if isinstance(e, IgcUnavailable) else "la página no responde"
            return await backup_tick(app, state, now, reason)
        if quakes is None:
            if state.last_change and _minutes_since(state.last_change, now) >= CFG["stale_min"]:
                return await backup_tick(app, state, now, None)  # IGC's page has stopped changing
            return {"changed": False}

        first_run = not state.known
        res = merge(state.known, quakes, now=now)
        sent, edited = (0, 0) if first_run else await announce(tg, state.known, res)  # the first look only learns
        state.known, state.etag = res.known, etag
        state.last_ok = state.last_change = _iso(now)
        if state.down_since:
            if state.down_notice_id:
                await tg.send(back_notice(_minutes_since(state.down_since, now)), silent=True, reply_to=state.down_notice_id)
            state.down_since = state.down_reason = state.down_notice_id = None
        await _save(store, state)
        summary = {"changed": True, "quakes": len(quakes), "new": len(res.new), "revised": len(res.changed),
                   "sent": sent, "edited": edited, "first_run": first_run}
        log.info("tick %s", summary)
        return summary


async def backup_tick(app: web.Application, state: State, now: datetime, reason: str | None) -> dict:
    """IGC's list can't be read (reason) or has stopped changing (None): announce the
    IGC quakes EMSC relays, and tell the channel once if IGC stays down. When IGC's
    list is back, merge() matches these quakes with IGC's rows and edits the messages."""
    tg = app["telegram"]
    summary: dict = {"changed": False, "igc": "down" if reason else "stale", "reason": reason}
    try:
        backup = await fetch_emsc_igc(app["session"], now)
    except Exception as e:  # noqa: BLE001 - EMSC down too: still record that IGC is
        log.warning("EMSC backup failed: %s", e)
        backup, summary["backup_error"] = None, str(e)
    if backup is not None:
        first_run = not state.known
        res = merge_backup(state.known, backup)
        sent, edited = (0, 0) if first_run else await announce(tg, state.known, res)
        state.known = res.known
        summary.update(backup=len(backup), new=len(res.new), sent=sent, edited=edited, changed=bool(res.new or res.changed))
    if reason:
        state.down_since = state.down_since or _iso(now)
        state.down_reason = reason
        if not state.down_notice_id and _minutes_since(state.down_since, now) >= CFG["down_notice_min"]:
            state.down_notice_id = await tg.send(down_notice(reason), silent=True)
            summary["notice_sent"] = True
    await _save(app["store"], state)
    log.warning("tick (IGC %s) %s", summary["igc"], summary)
    return summary


async def handle_tick(request: web.Request) -> web.Response:
    try:
        return web.json_response(await tick(request.app))
    except Exception as e:  # noqa: BLE001 - report, Scheduler retries next minute
        log.exception("tick failed")
        return web.json_response({"error": str(e)}, status=500)


TEST_BANNER = "🧪 <b>PRUEBA — no es un sismo real</b>\n\n"


async def run_test(app: web.Application, keep_s: float = 30, edit_after_s: float = 5) -> dict:
    """Sends a clearly labelled test quake through the same filters and message code,
    edits it as an IGC revision would, then deletes it. Never touches the state or
    the public feed, so neither the page nor the list of known quakes changes."""
    tg = app["telegram"]
    now = datetime.now(timezone.utc).replace(microsecond=0)
    q = IgcQuake(now - timedelta(minutes=1), 7.55, -80.65, 10.0, max(4.5, CFG["min_mag"]), False,
                 "Localizado en Panamá a 25km al noroeste de Tonosí", CFG["igc_url"])
    state: State = app.get("state") or State()
    due = to_notify(merge(dict(state.known), [q]).new, min_mag=CFG["min_mag"], max_age_min=CFG["max_age"], max_km=CFG["max_km"])
    steps = {"passes_filters": bool(due), "telegram": isinstance(tg, Telegram)}
    mid = await tg.send(TEST_BANNER + message(q), silent=q.mag < CFG["loud_mag"], buttons=buttons(q, CFG["dashboard"]))
    steps["sent_message_id"] = mid
    if mid is not None and edit_after_s:
        await asyncio.sleep(edit_after_s)
        revised = IgcQuake(q.time, q.lat, q.lon, 8.0, round(q.mag + 0.1, 1), True, q.place, q.url)
        await tg.edit(mid, TEST_BANNER + message(revised) + "\n\n" + edited_footer(q), buttons(revised, CFG["dashboard"]))
        steps["reply_message_id"] = await tg.send("🧪 " + revision_note(q, revised), silent=True, reply_to=mid)
        steps["edited"] = True
    if mid is not None and keep_s:
        await asyncio.sleep(keep_s)
        for m in (steps.get("reply_message_id"), mid):
            if m:
                await tg.delete(m)
        steps["deleted"] = True
    log.info("test %s", steps)
    return steps


async def handle_test(request: web.Request) -> web.Response:
    keep = min(45.0, max(0.0, float(request.query.get("keep", "30"))))  # 0 = leave it in the channel
    try:
        return web.json_response(await run_test(request.app, keep_s=keep))
    except Exception as e:  # noqa: BLE001
        log.exception("test failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_status(request: web.Request) -> web.Response:
    st: State | None = request.app.get("state")
    return web.json_response({"last_ok": st.last_ok if st else None, "known": len(st.known) if st else None,
                              "igc_down_since": st.down_since if st else None, "igc_down_reason": st.down_reason if st else None,
                              "telegram": isinstance(request.app["telegram"], Telegram)})


async def on_startup(app: web.Application) -> None:
    app["session"] = aiohttp.ClientSession()
    app["lock"] = asyncio.Lock()
    app["store"] = GcsStore(CFG["bucket"]) if CFG["bucket"] else FileStore()
    token, chat = ENV("TELEGRAM_BOT_TOKEN", ""), ENV("TELEGRAM_CHAT_ID", "")
    app["telegram"] = Telegram(app["session"], token, chat) if token and chat else LogOnly()


async def on_cleanup(app: web.Application) -> None:
    await app["session"].close()


def make_app() -> web.Application:
    app = web.Application()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_post("/tick", handle_tick)
    app.router.add_post("/test", handle_test)
    app.router.add_get("/", handle_status)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), port=int(ENV("PORT", "8080")))
