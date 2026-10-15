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
  NOTIFY_MIN_MAG       3.5   Announced from this magnitude...
  NOTIFY_MIN_MMI       99    ...or if some town would feel at least this intensity (5 = V,
                             moderate). 99: off, magnitude alone decides.
  LOUD_MIN_MAG         4.0   With sound from this magnitude...
  LOUD_MIN_MMI         99    ...or this intensity in some town (99: off); the rest arrive silently.
  REVISION_REPLIES     off   on: besides editing the message, reply to it with what IGC
                             changed. Off by default: an edit notifies nobody, a reply does.
  NOTIFY_MAX_KM        400   Only quakes this close to Panama City.
  NOTIFY_MAX_AGE_MIN   30    Never announce anything older (e.g. after downtime).
  DASHBOARD_URL        Link in every message.
  IGC_URL              https://sismosgeociencias.up.ac.pa/
  EMSC_FDSN_URL        Backup: IGC's solutions as EMSC relays them, read when IGC's page is
                       down (maintenance, errors) or hasn't changed for STALE_MIN minutes.
  DOWN_NOTICE_MIN      10    Minutes IGC's list must be unavailable before the channel is told.
  STALE_MIN            15    Minutes without any change in IGC's page before checking EMSC too.
  MONITOR_KEY          Shared secret: header X-Monitor-Key on /tick and /test, and the token
                       Telegram sends with each update to /telegram. Empty: no checks (local).
  RELAY_USERS          Who may relay IGC's WhatsApp notices to the bot, in a private chat:
                       Telegram usernames (@noel) or numeric ids, comma-separated.
  RELAY_MAX_AGE_MIN    180   A relayed notice is published if the quake is at most this old.
  X_BEARER_TOKEN       X API token (developer.x.com, pay-per-use). With it, every tick reads
                       IGC's new posts on X (same text as its WhatsApp notices, minutes
                       before its web list). Only new posts are read, so it costs cents a day.
  X_USERNAME           igcpanamaup
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
from .intensity import ROMAN, describe
from .igc import IGC_URL, IgcQuake, NoticeError, parse_list, parse_notice, quake_from_emsc, same_quake, source
from .monitor import (Known, MergeResult, _clock, _esc, _place, apply_peaks, buttons, effective, known_signature, message_for,
                      significant, strongest_town, cluster_note, edited_footer, feed, merge, merge_backup, message,
                      nearby_earlier, revision_note, signature, to_notify)
from .telegram import LogOnly, Telegram

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sismo.monitor")

ENV = os.environ.get
CFG = {
    "igc_url": ENV("IGC_URL", IGC_URL),
    "bucket": ENV("BUCKET", ""),
    "min_mag": float(ENV("NOTIFY_MIN_MAG", "3.5")),
    "min_mmi": float(ENV("NOTIFY_MIN_MMI", "99")),
    "loud_mag": float(ENV("LOUD_MIN_MAG", "4.0")),
    "loud_mmi": float(ENV("LOUD_MIN_MMI", "99")),
    "revision_replies": ENV("REVISION_REPLIES", "off").lower() in ("on", "1", "true", "yes"),
    "max_km": float(ENV("NOTIFY_MAX_KM", "400")),
    "max_age": float(ENV("NOTIFY_MAX_AGE_MIN", "30")),
    "dashboard": ENV("DASHBOARD_URL", "https://sismo-alerta-235ca.web.app"),
    "emsc_url": ENV("EMSC_FDSN_URL", "https://www.seismicportal.eu/fdsnws/event/1/query"),
    "down_notice_min": float(ENV("DOWN_NOTICE_MIN", "10")),
    "stale_min": float(ENV("STALE_MIN", "15")),
    "key": ENV("MONITOR_KEY", ""),
    "relay_users": {u.strip().lstrip("@").lower() for u in ENV("RELAY_USERS", "").split(",") if u.strip()},
    "relay_max_age": float(ENV("RELAY_MAX_AGE_MIN", "180")),
    "x_token": ENV("X_BEARER_TOKEN", ""),
    "x_user": ENV("X_USERNAME", "igcpanamaup"),
    "x_api": ENV("X_API_URL", "https://api.x.com/2"),
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


# ---------------------------------------------------------------- archive

class Archive:
    """Append-only record of everything the monitor sees, so nothing IGC (or anyone)
    publishes is lost when it's revised, deleted or the page goes down: one JSON line
    per observation in archive/raw/YYYY-MM-DD.jsonl (UTC day it was seen). The clean
    catalog is derived from it, so it can always be rebuilt."""

    def __init__(self) -> None:
        self.pending: list[dict] = []

    def add(self, source_name: str, seen: datetime, quake: IgcQuake | None = None, raw: str | None = None,
            ref: str | None = None, note: str | None = None) -> None:
        rec = {"seen": seen.isoformat(timespec="seconds"), "source": source_name}
        if quake is not None:
            rec["quake"] = _q_to_dict(quake)
        if raw is not None:
            rec["raw"] = raw
        if ref:
            rec["ref"] = ref
        if note:
            rec["note"] = note
        self.pending.append(rec)

    async def flush(self, store) -> int:
        if not self.pending:
            return 0
        days: dict[str, list[str]] = {}
        for rec in self.pending:
            days.setdefault(rec["seen"][:10], []).append(json.dumps(rec, ensure_ascii=False) + "\n")
        for day, lines in days.items():
            name = f"archive/raw/{day}.jsonl"
            await store.write(name, (await store.read(name) or "") + "".join(lines))
        n, self.pending = len(self.pending), []
        return n


def archive_of(app: web.Application) -> Archive:
    if "archive" not in app:
        app["archive"] = Archive()
    return app["archive"]


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
    x_user_id: str | None = None  # IGC's account on X
    x_since_id: str | None = None  # newest post already read
    x_last_ok: str | None = None
    x_version: int | None = None  # X_VERSION that read up to x_since_id
    x_log: list = field(default_factory=list)  # what was done with the latest posts, newest first
    archive_since: str | None = None  # when the archive started (and got everything known then)

    _EXTRA = ("last_change", "down_since", "down_reason", "down_notice_id", "x_user_id", "x_since_id", "x_last_ok",
              "x_version", "x_log", "archive_since")

    def dumps(self) -> str:
        return json.dumps({
            "etag": self.etag, "last_ok": self.last_ok, **{k: getattr(self, k) for k in self._EXTRA},
            "known": [{"id": k.id, "message_id": k.message_id, "sent": k.sent_signature, "quake": _q_to_dict(k.quake),
                       **({"peak": k.peak_mag, "peak_src": k.peak_src} if k.peak_mag else {})}
                      for k in self.known.values()],
        })

    @classmethod
    def loads(cls, text: str | None) -> "State":
        if not text:
            return cls()
        d = json.loads(text)
        known = {k["id"]: Known(k["id"], _q_from_dict(k["quake"]), k.get("message_id"), k.get("sent"), k.get("peak"), k.get("peak_src"))
                 for k in d.get("known", [])}
        st = cls(d.get("etag"), known, d.get("last_ok"))
        for k in cls._EXTRA:
            setattr(st, k, d.get(k))
        st.x_log = st.x_log or []
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


def loud(q: IgcQuake) -> bool:
    """With sound only for strong ones."""
    return significant(q, CFG["loud_mag"], CFG["loud_mmi"])


async def announce(tg, before: dict[str, Known], res: MergeResult, max_age: float | None = None) -> tuple[int, int]:
    """New quakes worth a message get one (judged by the highest magnitude IGC gave
    them anywhere); revised ones get their message edited. Returns (sent, edited)."""
    sent = edited = 0
    seen, pending = set(), []
    for k in res.new + res.changed + res.peaked:
        if k.message_id is None and id(k) not in seen:
            seen.add(id(k))
            pending.append(k)
    due = to_notify(pending, min_mag=CFG["min_mag"], min_mmi=CFG["min_mmi"], max_age_min=max_age or CFG["max_age"], max_km=CFG["max_km"])
    for k in due:
        text = message_for(k)
        near = nearby_earlier(k.quake, list(res.known.values()))
        if near:
            text += "\n\n" + cluster_note(k.quake, near.quake)
        k.message_id = await tg.send(text, silent=not loud(effective(k)), reply_to=near.message_id if near else None,
                                     buttons=buttons(k.quake, CFG["dashboard"]))
        k.sent_signature = known_signature(k)
        sent += 1
    done = set()
    for k in res.changed + res.peaked:
        if not k.message_id or id(k) in done or k.sent_signature == known_signature(k):
            continue
        done.add(id(k))
        old = before[k.id].quake if k.id in before else k.quake
        # The original message is edited to show the current data, with a last line
        # saying what it said before. Editing notifies nobody; a reply with the full
        # before → after only goes out if REVISION_REPLIES is on.
        note = revision_note(old, k.quake)
        # With nothing a reader would notice (a nudge of the coordinates, or IGC's list
        # confirming a relayed notice), the message is just refreshed, without "Editado".
        footer = "\n\n" + edited_footer(old, k.quake) if note else ""
        await tg.edit(k.message_id, message_for(k) + footer, buttons(k.quake, CFG["dashboard"]))
        if note and CFG["revision_replies"]:
            await tg.send(note, silent=True, reply_to=k.message_id)
        k.sent_signature = known_signature(k)
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
            + ("Mientras tanto, los avisos salen de las publicaciones del IGC en X." if CFG["x_token"] else
               "Mientras tanto, los avisos salen con los datos del IGC que publica EMSC, unos minutos más tarde."))


def back_notice(minutes: float) -> str:
    return (f"✅ <b>La lista del IGC volvió</b> después de {_duration(minutes)}.\n\n"
            "Los avisos vuelven a salir directo del IGC.")


async def _save(store, state: State) -> None:
    # latest.json: the week, read once by the page. recent.json (6 h, re-read every
    # minute) is written once per tick by write_recent: Cloud Storage allows about
    # one write per second to the same object.
    await store.write("igc/latest.json", json.dumps(feed(state.known), ensure_ascii=False), public=True)
    await store.write("igc/state.json", state.dumps())


def sources_status(state: State, now: datetime) -> dict:
    """How each source is doing, for the page's status strip."""
    return {
        "checked": _iso(now),
        "igc": {"last_ok": state.last_ok, "down_since": state.down_since, "reason": state.down_reason},
        "x": {"on": bool(CFG["x_token"]), "last_ok": state.x_last_ok, "user": CFG["x_user"]},
    }


async def write_recent(store, state: State, now: datetime) -> None:
    """The last 6 hours plus the sources' status, every tick (the page reads it every minute)."""
    payload = feed(state.known, hours=6)
    payload["status"] = sources_status(state, now)
    await store.write("igc/recent.json", json.dumps(payload, ensure_ascii=False), public=True)


async def load_state(app: web.Application) -> State:
    if not app.get("state"):
        app["state"] = State.loads(await app["store"].read("igc/state.json"))
    return app["state"]


X_VERSION = 2  # bump to re-read the latest posts once after a fix in how they're handled


async def fetch_x(session: aiohttp.ClientSession, state: State) -> list[tuple[str, str]]:
    """IGC's posts on X newer than the last one read, oldest first, as (id, text).
    The first time it reads the latest few. It doesn't move x_since_id: the caller
    does, once the posts are handled."""
    headers = {"Authorization": f"Bearer {CFG['x_token']}", "User-Agent": CFG["agent"]}
    timeout = aiohttp.ClientTimeout(total=15)
    if not state.x_user_id:
        async with session.get(f"{CFG['x_api']}/users/by/username/{CFG['x_user']}", headers=headers, timeout=timeout) as r:
            r.raise_for_status()
            state.x_user_id = (await r.json())["data"]["id"]
    params = {"max_results": "20" if state.x_since_id else "10", "exclude": "replies,retweets",
              "tweet.fields": "created_at,note_tweet"}
    if state.x_since_id:
        params["since_id"] = state.x_since_id
    async with session.get(f"{CFG['x_api']}/users/{state.x_user_id}/tweets", params=params, headers=headers, timeout=timeout) as r:
        r.raise_for_status()
        body = await r.json()
    posts = body.get("data") or []
    return sorted(((p["id"], html.unescape((p.get("note_tweet") or {}).get("text") or p.get("text") or ""))
                   for p in posts), key=lambda p: int(p[0]))


async def x_tick(app: web.Application, state: State, now: datetime, fresh: bool) -> dict | None:
    """New IGC posts on X go through the same rules as its list: announced if new,
    edited if they revise an announced quake. Posts that aren't quake notices are skipped.
    What happened to each post is kept in state.x_log (state.json, /estado)."""
    if not CFG["x_token"]:
        return None
    if state.x_version != X_VERSION:
        state.x_since_id, state.x_version = None, X_VERSION
    try:
        posts = await fetch_x(app["session"], state)
    except Exception as e:  # noqa: BLE001 - X down or out of credit: IGC's list still works
        log.warning("X failed: %s", e)
        return {"error": str(e)}
    state.x_last_ok = _iso(now)
    if not posts:
        return {"posts": 0, "quakes": 0}
    entries, quakes = {}, {}
    for pid, text in posts:
        try:
            q = quakes[pid] = parse_notice(text, f"https://x.com/{CFG['x_user']}/status/{pid}")
            entries[pid] = {"id": pid, "seen": _iso(now), "text": f"M{q.mag:.1f} {_clock(q.time)}, {_place(q)}", "result": "leído"}
        except Exception as e:  # noqa: BLE001 - one odd post never stops the others
            entries[pid] = {"id": pid, "seen": _iso(now), "text": " ".join(text.split())[:50], "result": f"no es un aviso: {e}"}
    summary = {"posts": len(posts), "quakes": len(quakes)}
    try:
        before = state.known
        res = merge_backup(before, list(quakes.values()))
        state.known = res.known  # first, so nothing read is lost if Telegram fails below
        sent, edited = (0, 0) if fresh else await announce(app["telegram"], before, res)
        new = {id(k.quake): k for k in res.new}
        changed = {id(k.quake) for k in res.changed}
        for pid, q in quakes.items():
            k = new.get(id(q))
            peaked = next((x for x in res.peaked if x.peak_mag == q.mag and same_quake(q, x.quake.time, x.quake.lat, x.quake.lon)), None)
            entries[pid]["result"] = (
                "publicado" if k and k.message_id else
                "no se publica: " + skip_reason(q, CFG["max_age"], now) if k else
                "actualizó el mensaje" if id(q) in changed else
                (f"aquí el IGC le dio M{q.mag:.1f}, más que en su lista: " + ("publicado" if peaked.message_id else "no se publica: " + skip_reason(q, CFG["max_age"], now)))
                if peaked else "ya estaba")
        summary.update(new=len(res.new), sent=sent, edited=edited)
    except Exception as e:  # noqa: BLE001
        log.exception("X posts failed")
        for pid in quakes:
            entries[pid]["result"] += f"; error: {e}"
        summary["error"] = str(e)
    finally:
        for pid, text in posts:
            archive_of(app).add("x", now, quakes.get(pid), raw=text, ref=f"https://x.com/{CFG['x_user']}/status/{pid}",
                                note=entries[pid]["result"])
        state.x_since_id = max((pid for pid, _ in posts), key=int)
        state.x_log = (sorted(entries.values(), key=lambda e: int(e["id"]), reverse=True) + state.x_log)[:15]
        await _save(app["store"], state)
    log.info("X %s", summary)
    return summary


async def tick(app: web.Application) -> dict:
    async with app["lock"]:
        state = await load_state(app)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        fresh = not state.known  # the first look only learns what's there, without announcing it
        archive = archive_of(app)
        if not state.archive_since:
            # Start of the archive: everything known so far (IGC's list keeps only 7 days).
            for k in sorted(state.known.values(), key=lambda k: k.quake.time):
                archive.add(source(k.quake), now, k.quake, note="conocido al empezar el archivo")
            state.archive_since = _iso(now)
        try:
            x = await x_tick(app, state, now, fresh)  # IGC's posts on X: usually the first to know
            summary = await igc_tick(app, state, now, fresh)
            if summary.get("igc") not in ("down", "stale") and not fresh:
                # IGC's own list is working: EMSC only tells us if IGC gave a quake a
                # higher magnitude there (it has happened: M4.0 on the list, M4.7 at EMSC).
                peaks = await emsc_peaks(app, state, now)
                if peaks:
                    summary["emsc_peaks"] = peaks
                    summary["changed"] = True
        finally:
            await archive.flush(app["store"])
            await write_recent(app["store"], state, now)
        if x is not None:
            summary["x"] = x
            summary["changed"] = summary["changed"] or bool(x.get("new") or x.get("edited"))
        return summary


async def emsc_peaks(app: web.Application, state: State, now: datetime) -> dict | None:
    try:
        others = await fetch_emsc_igc(app["session"], now)
    except Exception as e:  # noqa: BLE001 - EMSC is only a check here
        log.info("EMSC check failed: %s", e)
        return None
    touched = apply_peaks(state.known, others)
    if not touched:
        return None
    for k in touched:
        archive_of(app).add("emsc", now, k.quake, note=f"el IGC le dio M{k.peak_mag:.1f} en EMSC")
    sent, edited = await announce(app["telegram"], dict(state.known), MergeResult(known=state.known, peaked=touched))
    await _save(app["store"], state)
    return {"raised": len(touched), "sent": sent, "edited": edited}


async def igc_tick(app: web.Application, state: State, now: datetime, fresh: bool) -> dict:
    """IGC's web list: new quakes and revisions; EMSC as backup when it is down."""
    store, tg, session = app["store"], app["telegram"], app["session"]
    try:
        quakes, etag = await fetch_igc(session, state.etag)
    except (IgcUnavailable, aiohttp.ClientError, asyncio.TimeoutError) as e:
        reason = str(e) if isinstance(e, IgcUnavailable) else "la página no responde"
        return await backup_tick(app, state, now, reason, fresh)
    if quakes is None:
        if state.last_change and _minutes_since(state.last_change, now) >= CFG["stale_min"]:
            return await backup_tick(app, state, now, None, fresh)  # IGC's page has stopped changing
        return {"changed": False}

    first_run = fresh
    res = merge(state.known, quakes, now=now)
    for k in res.new + res.changed:
        archive_of(app).add("igc", now, k.quake, ref=k.quake.url, note="nuevo" if k in res.new else "cambió")
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


async def backup_tick(app: web.Application, state: State, now: datetime, reason: str | None, fresh: bool = False) -> dict:
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
        first_run = fresh
        res = merge_backup(state.known, backup)
        for k in res.new + res.changed:
            archive_of(app).add("emsc", now, k.quake, ref=k.quake.url, note="nuevo" if k in res.new else "cambió")
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


# ---------------------------------------------------------------- relayed WhatsApp notices

HELP = ("Reenvíame (o pega aquí) el aviso del IGC tal como llega por WhatsApp y lo publico en el canal:\n\n"
        "<code>Estado: PRELIMINAR\nFecha: 2026-10-14\nHora: 2:53:09PM hora local\nMagnitud: 3.6\n"
        "Profundidad: 13km\nLocalizado en Panamá a 51km al sureste de Soná</code>\n\n"
        "• La ubicación sale del pueblo, la distancia y la dirección. Si no conozco el pueblo, agrega una línea con <code>lat, lon</code>.\n"
        "• Si empiezas con <b>prueba</b>, solo te muestro cómo quedaría, sin publicarlo.\n"
        "• Si el sismo ya está en el canal, actualizo ese mensaje en vez de repetirlo.\n"
        "• /estado dice si la lista del IGC está funcionando.")


def relay_allowed(user: dict) -> bool:
    users = CFG["relay_users"]
    return str(user.get("id")) in users or (user.get("username") or "").lower() in users


def status_text(state: State, now: datetime) -> str:
    def local(iso):
        return _clock(datetime.fromisoformat(iso)) if iso else "nunca"
    if state.down_since:
        head = f"⚠️ La lista del IGC no está disponible desde las {local(state.down_since)} ({state.down_reason})."
    else:
        head = f"✅ La lista del IGC funciona; última lectura a las {local(state.last_ok)}."
    if CFG["x_token"]:
        head += f"\nX (@{CFG['x_user']}): última lectura a las {local(state.x_last_ok)}."
        for e in state.x_log[:3]:
            head += f"\n  • {_esc(e['text'])} → {_esc(e['result'])}"
    recent = [k for k in state.known.values() if now - k.quake.time <= timedelta(hours=24)]
    return f"{head}\n\nSismos de las últimas 24 h: {len(recent)}; en el canal: {sum(1 for k in recent if k.message_id)}."


def skip_reason(q: IgcQuake, max_age: float, now: datetime) -> str:
    """Why a new quake wasn't announced (the rules of to_notify)."""
    reasons = []
    if not significant(q, CFG["min_mag"], CFG["min_mmi"]):
        if CFG["min_mmi"] > 10:  # intensity rule off
            reasons.append(f"M{q.mag:.1f} es menor que M{CFG['min_mag']:.1f}")
        else:
            town, mmi = strongest_town(q)
            reasons.append(f"M{q.mag:.1f} es menor que M{CFG['min_mag']:.1f} y no se sentiría con intensidad "
                           f"{ROMAN[round(CFG['min_mmi'])]} en ningún pueblo (lo más fuerte: {describe(mmi)} en {town})")
    if now - q.time > timedelta(minutes=max_age):
        reasons.append(f"es de hace más de {max_age:.0f} min")
    if not reasons:
        reasons.append(f"está a más de {CFG['max_km']:.0f} km de Ciudad de Panamá")
    return "; ".join(reasons)


async def relay_notice(app: web.Application, q: IgcQuake, raw: str | None = None) -> str:
    """Puts a relayed notice through the same rules as IGC's list. Returns what
    happened, to tell the person who sent it."""
    tg, now = app["telegram"], datetime.now(timezone.utc).replace(microsecond=0)
    async with app["lock"]:
        state = await load_state(app)
        match = next((k for k in state.known.values() if same_quake(q, k.quake.time, k.quake.lat, k.quake.lon)), None)
        res = merge_backup(state.known, [q])
        archive_of(app).add("whatsapp", now, q, raw=raw)
        try:
            sent, edited = await announce(tg, state.known, res, max_age=CFG["relay_max_age"])
        finally:
            state.known = res.known
            await _save(app["store"], state)
            await write_recent(app["store"], state, now)
            await archive_of(app).flush(app["store"])
    if sent:
        return "✅ Publicado en el canal."
    if edited:
        return "✏️ Ya estaba en el canal: actualicé ese mensaje."
    if match and not res.changed:
        where = "en el canal" if match.message_id else "registrado"
        origin = {"igc": "de la lista del IGC", "relay": "de un aviso anterior", "emsc": "de EMSC"}[source(match.quake)]
        return f"👍 Ya estaba {where} ({origin}); no hice nada."
    return "📝 Lo guardé para la página, pero no lo publico en el canal: " + skip_reason(q, CFG["relay_max_age"], now) + "."


async def handle_telegram(request: web.Request) -> web.Response:
    """Telegram webhook: private messages to the bot."""
    if not CFG["key"] or request.headers.get("X-Telegram-Bot-Api-Secret-Token") != CFG["key"]:
        return web.Response(status=403)
    app, tg = request.app, request.app["telegram"]
    try:
        update = await request.json()
        msg = update.get("message") or {}
        chat, user = msg.get("chat") or {}, msg.get("from") or {}
        text = (msg.get("text") or msg.get("caption") or "").strip()
        if chat.get("type") != "private" or not text:
            return web.json_response({"ok": True})

        async def reply(t: str) -> None:
            await tg.send(t, chat_id=chat["id"], reply_to=msg.get("message_id"))

        if not relay_allowed(user):
            await reply(f"Este bot publica los sismos del canal; solo sus administradores pueden mandarle avisos.\n\n"
                        f"Tu id de Telegram es <code>{user.get('id')}</code>.")
        elif text.startswith(("/start", "/ayuda", "/help")):
            await reply(HELP)
        elif text.startswith("/estado"):
            await reply(status_text(await load_state(app), datetime.now(timezone.utc)))
        else:
            preview = re.match(r"/?prueba\b", text, re.I) is not None
            try:
                q = parse_notice(text)
            except NoticeError as e:
                await reply(f"❓ No pude leer el aviso: {e}.\n\n/ayuda muestra el formato.")
            else:
                if preview:
                    await reply("👀 <b>Así quedaría</b> (no se publicó):\n\n" + message(q))
                else:
                    await reply(await relay_notice(app, q, raw=text))
    except Exception:  # noqa: BLE001 - answer 200 anyway, or Telegram resends it forever
        log.exception("telegram update failed")
    return web.json_response({"ok": True})


def authorized(request: web.Request) -> bool:
    return not CFG["key"] or request.headers.get("X-Monitor-Key") == CFG["key"]


async def handle_tick(request: web.Request) -> web.Response:
    if not authorized(request):
        return web.Response(status=403)
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
    due = to_notify(merge(dict(state.known), [q]).new, min_mag=CFG["min_mag"], min_mmi=CFG["min_mmi"], max_age_min=CFG["max_age"], max_km=CFG["max_km"])
    steps = {"passes_filters": bool(due), "telegram": isinstance(tg, Telegram)}
    mid = await tg.send(TEST_BANNER + message(q), silent=not loud(q), buttons=buttons(q, CFG["dashboard"]))
    steps["sent_message_id"] = mid
    if mid is not None and edit_after_s:
        await asyncio.sleep(edit_after_s)
        revised = IgcQuake(q.time, q.lat, q.lon, 8.0, round(q.mag + 0.1, 1), True, q.place, q.url)
        await tg.edit(mid, TEST_BANNER + message(revised) + "\n\n" + edited_footer(q, revised), buttons(revised, CFG["dashboard"]))
        if CFG["revision_replies"]:
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
    if not authorized(request):
        return web.Response(status=403)
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
    app.router.add_post("/telegram", handle_telegram)
    app.router.add_get("/", handle_status)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), port=int(ENV("PORT", "8080")))
