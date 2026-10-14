from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from aiohttp import web

from app import monitor_main
from app.igc import PANAMA_TZ, parse_list, parse_local_time
from app.monitor import feed, merge, message, to_notify

PAGE = (Path(__file__).parent / "data" / "igc_list_2026-10-14.html").read_text()
NOW = datetime(2026, 10, 14, 7, 0, tzinfo=timezone.utc)


def test_reads_the_desktop_table_only():
    qs = parse_list(PAGE)
    assert len(qs) == 7  # the phone cards repeat the same quakes and are ignored
    first = qs[0]
    assert first.time.isoformat() == "2026-10-14T06:54:06+00:00"
    assert (first.lat, first.lon, first.depth_km, first.mag, first.reviewed) == (7.75407, -80.73508, 10.0, 3.7, False)
    assert first.place == "Localizado en Panamá a 41km al suroeste de Chitré"
    assert "&lt=7.75407&ln=-80.73508" in first.url and first.url.startswith("https://sismosgeociencias.up.ac.pa/ultimosismo.html")
    assert qs[4].reviewed and qs[5].depth_km == 161.0


def test_local_clock_to_utc():
    assert parse_local_time("2026-10-14", "12:42:51AM").isoformat() == "2026-10-14T05:42:51+00:00"
    assert parse_local_time("2026-10-13", "11:59:36PM").isoformat() == "2026-10-14T04:59:36+00:00"
    assert parse_local_time("2026-10-13", "12:05:00PM").isoformat() == "2026-10-13T17:05:00+00:00"


def test_merge_keeps_ids_through_revisions():
    qs = parse_list(PAGE)
    first = merge({}, qs, now=NOW)
    assert len(first.new) == 7 and not first.changed
    m50 = qs[2]  # M5.0 preliminary
    revised = m50.__class__(m50.time + timedelta(seconds=3), m50.lat + 0.04, m50.lon, 8.0, 5.2, True, m50.place, m50.url)
    newer = m50.__class__(NOW, 7.6, -80.7, 10.0, 4.1, False, "Localizado en Panamá a 30km al noroeste de Tonosí", m50.url)
    second = merge(first.known, [newer, revised] + [q for q in qs if q is not m50], now=NOW)
    assert [k.quake.mag for k in second.new] == [4.1]
    assert [k.id for k in second.changed] == [m50.id] and second.changed[0].quake.mag == 5.2
    assert m50.id in second.known and len(second.known) == 8


def test_who_gets_announced():
    qs = parse_list(PAGE)
    res = merge({}, qs, now=NOW)
    due = to_notify(res.new, min_mag=3.5, max_age_min=180, max_km=400, now=NOW)
    # within 3 h: 1:54 a.m. M3.7, 12:42 M4.2, 12:09 M5.0, 11:59 p.m. M4.4; not the M3.3; not Colombia (557 km)
    assert [k.quake.mag for k in due] == [4.4, 5.0, 4.2, 3.7]
    assert to_notify(res.new, min_mag=4.5, max_age_min=180, max_km=400, now=NOW)[0].quake.mag == 5.0
    # nothing older than 30 min: only the 1:54 a.m. one (6 min before NOW)
    assert [k.quake.mag for k in to_notify(res.new, min_mag=3.5, max_age_min=30, max_km=400, now=NOW)] == [3.7]


def test_message_text():
    from app.monitor import buttons
    q = parse_list(PAGE)[2]
    lines = message(q).split("\n")
    assert lines[0] == "🟠 <b>SISMO M5.0</b>  ·  🕒 preliminar"
    assert lines[1] == "" and lines[5] == ""  # blank lines between the blocks
    assert lines[2] == "📍 27 km al noroeste de Tonosí, Panamá"
    assert lines[3] == "🕐 mié 14 oct · 12:09 a. m."
    assert lines[4] == "⬇️ 5 km de profundidad"
    assert lines[6].startswith("🏙️ En Ciudad de Panamá: intensidad <b>")
    border = q.__class__(q.time, 9.03, -82.27, 10, 4.2, True, "Localizado en Región Fronteriza Panamá-Costa Rica a 19km al noroeste de Chiriquí Grande", q.url)
    assert "📍 19 km al noroeste de Chiriquí Grande, Región Fronteriza Panamá-Costa Rica" in message(border)
    assert "✅ revisado" in message(border)
    b = buttons(q, "https://example.org")
    assert b[0][0]["text"] == "🗺️ Ficha del IGC" and b[0][0]["url"] == q.url and b[0][1]["url"] == "https://example.org"


def test_feed_for_the_web_page():
    res = merge({}, parse_list(PAGE), now=NOW)
    f = feed(res.known, now=NOW)
    assert f["events"][0]["time"] == "2026-10-14T06:54:06Z" and f["events"][0]["reviewed"] is False
    assert len(f["events"]) == 7


# ---------------------------------------------------------------- whole tick

def _page(rows):
    tr = "".join(
        f"<tr><td>{'REVISADO' if r else 'PRELIMINAR'}</td><td>{t.astimezone(PANAMA_TZ):%Y-%m-%d}</td>"
        f"<td>{t.astimezone(PANAMA_TZ):%I:%M:%S%p}</td><td>{lat}</td><td>{lon}</td><td>10km</td><td>{m}</td>"
        f"<td>Localizado en Panamá a 20km al sur de Soná</td><td><a href='ultimosismo.html?x=1'>Ver</a></td></tr>"
        for t, lat, lon, m, r in rows)
    return f"<table><tr><th>Estado</th></tr>{tr}</table>"


class FakeTelegram:
    def __init__(self):
        self.sent, self.edits = [], []

    async def send(self, text, silent=False, reply_to=None, buttons=None):
        self.buttons = getattr(self, 'buttons', []) + [buttons]
        self.sent.append((text, silent))
        self.replies = getattr(self, 'replies', []) + [reply_to]
        return len(self.sent)

    async def edit(self, message_id, text, buttons=None):
        self.edits.append((message_id, text))

    async def delete(self, message_id):
        self.deleted = message_id


@pytest.mark.asyncio
async def test_tick_end_to_end(tmp_path, aiohttp_server=None):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    pages = {"etag": '"v1"', "body": _page([(now - timedelta(hours=2), 7.6, -80.7, 4.0, True)])}

    async def igc(request):
        if request.headers.get("If-None-Match") == pages["etag"]:
            return web.Response(status=304)
        return web.Response(text=pages["body"], content_type="text/html", headers={"ETag": pages["etag"]})

    srv = web.Application()
    srv.router.add_get("/", igc)
    runner = web.AppRunner(srv)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    monitor_main.CFG["igc_url"] = f"http://127.0.0.1:{port}/"
    app = monitor_main.make_app()
    tg = FakeTelegram()
    for fn in app.on_startup:
        await fn(app)
    app["store"], app["telegram"] = monitor_main.FileStore(str(tmp_path)), tg
    try:
        first = await monitor_main.tick(app)
        assert first["first_run"] and tg.sent == []  # learns what's there, announces nothing
        assert (await monitor_main.tick(app)) == {"changed": False}  # ETag: nothing new
        # a new M4.6 two minutes ago, and a small M3.0 (not announced)
        pages["etag"], pages["body"] = '"v2"', _page([
            (now - timedelta(minutes=2), 7.7, -81.3, 4.6, False),
            (now - timedelta(minutes=5), 7.5, -80.6, 3.0, False),
            (now - timedelta(hours=2), 7.6, -80.7, 4.0, True)])
        third = await monitor_main.tick(app)
        assert third["sent"] == 1 and "M4.6" in tg.sent[0][0] and tg.sent[0][1] is False and tg.buttons[0][0][1]["text"] == "📈 Réplicas en vivo"
        # IGC revises it to M4.8: the same message is edited
        pages["etag"], pages["body"] = '"v3"', _page([
            (now - timedelta(minutes=2), 7.7, -81.3, 4.8, True),
            (now - timedelta(minutes=5), 7.5, -80.6, 3.0, False),
            (now - timedelta(hours=2), 7.6, -80.7, 4.0, True)])
        fourth = await monitor_main.tick(app)
        assert fourth["edited"] == 1 and tg.edits[0][0] == 1 and "M4.8" in tg.edits[0][1] and "revisado" in tg.edits[0][1]
        # ...and a silent reply to the original says what changed
        assert tg.sent[1][0].startswith("✏️ <b>Revisado por el IGC</b>\n\n• Magnitud: M4.6 → <b>M4.8</b>") and tg.sent[1][1] is True and tg.replies[1] == 1
        # a new quake 3 minutes later and 10 km away replies to that message
        pages["etag"], pages["body"] = '"v4"', _page([
            (now + timedelta(minutes=1), 7.75, -81.25, 4.1, False),
            (now - timedelta(minutes=2), 7.7, -81.3, 4.8, True),
            (now - timedelta(minutes=5), 7.5, -80.6, 3.0, False),
            (now - timedelta(hours=2), 7.6, -80.7, 4.0, True)])
        fifth = await monitor_main.tick(app)
        assert fifth["sent"] == 1 and tg.replies[2] == 1 and "sismo distinto del de las" in tg.sent[2][0] and "M4.8 revisado" in tg.sent[2][0]
        # state and feed are on disk; a cold start picks them up without re-announcing
        assert (tmp_path / "igc" / "latest.json").exists() and (tmp_path / "igc" / "recent.json").exists()
        app2 = monitor_main.make_app()
        for fn in app2.on_startup:
            await fn(app2)
        app2["store"], app2["telegram"] = monitor_main.FileStore(str(tmp_path)), FakeTelegram()
        assert (await monitor_main.tick(app2)) == {"changed": False}
        for a in (app, app2):
            for fn in a.on_cleanup:
                await fn(a)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_test_message_never_touches_state_or_feed(tmp_path):
    app = monitor_main.make_app()
    for fn in app.on_startup:
        await fn(app)
    tg = FakeTelegram()
    app["store"], app["telegram"] = monitor_main.FileStore(str(tmp_path)), tg
    steps = await monitor_main.run_test(app, keep_s=0.01, edit_after_s=0.01)
    assert steps["passes_filters"] and steps["sent_message_id"] == 1 and steps["deleted"]
    assert tg.sent[0][0].startswith("🧪 <b>PRUEBA — no es un sismo real</b>\n\n🟡 <b>SISMO M4.5</b>")
    assert "M4.6" in tg.edits[0][1] and "revisado" in tg.edits[0][1] and tg.deleted == 1  # the original, deleted last
    assert tg.sent[1][0].startswith("🧪 ✏️ <b>Revisado por el IGC</b>\n\n• Magnitud: M4.5 → <b>M4.6</b>") and tg.replies[1] == 1
    assert not (tmp_path / "igc").exists()  # nothing written: no state, no feed
    for fn in app.on_cleanup:
        await fn(app)


def test_revision_note_and_cluster_note():
    from app.monitor import cluster_note, revision_note
    q = parse_list(PAGE)[2]  # M5.0 preliminar
    r = q.__class__(q.time + timedelta(seconds=4), q.lat + 0.05, q.lon, 8.0, 4.8, True, "Localizado en Panamá a 22km al noroeste de Tonosí", q.url)
    note = revision_note(q, r)
    assert note == ("✏️ <b>Revisado por el IGC</b>\n\n• Magnitud: M5.0 → <b>M4.8</b>"
                    "\n• Lugar: 27 km al noroeste de Tonosí, Panamá → <b>22 km al noroeste de Tonosí, Panamá</b>"
                    "\n• Hora: 12:09:35 a. m. → <b>12:09:39 a. m.</b>")
    assert revision_note(r, r) is None  # nothing a reader would notice: no reply
    # the real case of Oct 14, 10:35 a.m.: IGC moved it 4 km but it is still "24 km al este de Tonosí"
    pre = q.__class__(q.time, 7.4900, -80.2290, 10, 4.0, False, "Localizado en Panamá a 24km al este de Tonosí", q.url)
    rev = q.__class__(q.time, 7.4550, -80.2207, 10, 4.0, True, "Localizado en Panamá a 24km al este de Tonosí", q.url)
    assert revision_note(pre, rev) == "✏️ <b>Revisado por el IGC</b>\n\n• Magnitud: M4.0, sin cambios"
    far = q.__class__(q.time, 7.40, -80.22, 10, 4.0, True, "Localizado en Panamá a 24km al este de Tonosí", q.url)
    assert "• Epicentro ajustado 10 km; sigue a 24 km al este de Tonosí, Panamá" in revision_note(pre, far)
    assert cluster_note(r, q).startswith("↪️ <i>El IGC lo publica como un sismo distinto del de las 12:09 a. m. (M5.0 preliminar, a 6 km)")
