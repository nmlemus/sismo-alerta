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

    async def send(self, text, silent=False, reply_to=None, buttons=None, chat_id=None):
        if chat_id is not None:  # a private answer, not the channel
            self.private = getattr(self, 'private', []) + [(chat_id, text)]
            return 1000 + len(self.private)
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
        assert tg.edits[0][1].endswith("<i>✏️ Editado · antes: M4.6 preliminar, 20 km al sur de Soná, Panamá</i>")
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


# ---------------------------------------------------------------- IGC down: EMSC as backup

def test_place_for_a_quake_from_emsc():
    from app.igc import describe_place, from_emsc, quake_from_emsc
    from app.feeds import origin_from_emsc_feature
    assert describe_place(7.2, -80.44) == "Localizado en Panamá a 23km al sur de Tonosí"
    assert describe_place(7.404, -80.442) == "Localizado en Panamá cerca de Tonosí"
    o = origin_from_emsc_feature(_emsc_feature(datetime(2026, 10, 14, 19, 31, 28, tzinfo=timezone.utc), 7.2, -80.44, 3.6, "IGC", "X1"))
    q = quake_from_emsc(o)
    assert from_emsc(q) and not q.reviewed and q.mag == 3.6 and q.url.endswith("unid=X1")
    assert "23 km al sur de Tonosí, Panamá" in message(q) and "tomados de EMSC" in message(q)


def test_maintenance_page_text():
    page = ("<html><head><title>IGC</title><style>b{color:red}</style></head><body><center>"
            "<b>Estamos en mantenimiento hasta las 4:30pm.</b></center></body></html>")
    assert monitor_main.page_text(page) == "Estamos en mantenimiento hasta las 4:30pm."


def _emsc_feature(t, lat, lon, mag, auth, unid):
    return {"type": "Feature", "id": unid, "geometry": {"type": "Point", "coordinates": [lon, lat, -5.0]},
            "properties": {"time": t.strftime("%Y-%m-%dT%H:%M:%S.0Z"), "lat": lat, "lon": lon, "depth": 5.0, "mag": mag,
                           "magtype": "ml", "auth": auth, "unid": unid, "flynn_region": "SOUTH OF PANAMA", "evtype": "ke"}}


@pytest.mark.asyncio
async def test_igc_down_emsc_backup_then_igc_back(tmp_path):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    old = (now - timedelta(hours=1), 7.6, -80.7, 4.0, True)
    igc_state = {"etag": '"v1"', "body": _page([old]), "status": 200}
    emsc_state = {"features": []}

    async def igc(request):
        if igc_state["status"] == 200 and request.headers.get("If-None-Match") == igc_state["etag"]:
            return web.Response(status=304)
        return web.Response(text=igc_state["body"], status=igc_state["status"], content_type="text/html",
                            headers={"ETag": igc_state["etag"]})

    async def emsc(request):
        return web.json_response({"type": "FeatureCollection", "features": emsc_state["features"]})

    srv = web.Application()
    srv.router.add_get("/", igc)
    srv.router.add_get("/emsc", emsc)
    runner = web.AppRunner(srv)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    monitor_main.CFG["igc_url"] = f"http://127.0.0.1:{port}/"
    monitor_main.CFG["emsc_url"] = f"http://127.0.0.1:{port}/emsc"

    app = monitor_main.make_app()
    tg = FakeTelegram()
    for fn in app.on_startup:
        await fn(app)
    app["store"], app["telegram"] = monitor_main.FileStore(str(tmp_path)), tg
    try:
        assert (await monitor_main.tick(app))["first_run"]
        # IGC goes into maintenance; EMSC has IGC's M3.6, an automatic UNA M4.5 (ignored)
        # and IGC's old M4.0 (already known: not repeated)
        igc_state.update(etag='"m"', body="<html><body><b>Estamos en mantenimiento hasta las 4:30pm.</b></body></html>")
        t = now - timedelta(minutes=2)
        emsc_state["features"] = [_emsc_feature(t, 7.45, -81.45, 3.6, "IGC", "A1"),
                                  _emsc_feature(now - timedelta(minutes=4), 7.0, -80.0, 4.5, "UNA", "B2"),
                                  _emsc_feature(old[0] + timedelta(seconds=2), 7.61, -80.71, 4.1, "IGC", "C3")]
        down = await monitor_main.tick(app)
        assert down["igc"] == "down" and down["sent"] == 1 and len(tg.sent) == 1
        text, silent = tg.sent[0]
        assert "M3.6" in text and "tomados de EMSC" in text and silent is True
        assert tg.buttons[0][0][0] == {"text": "🗺️ Ficha en EMSC", "url": "https://www.seismicportal.eu/eventdetails.html?unid=A1"}
        assert "notice_sent" not in down  # a short blip doesn't reach the channel
        feed_now = __import__("json").loads((tmp_path / "igc" / "recent.json").read_text())
        assert [e["mag"] for e in feed_now["events"]] == [3.6, 4.0]  # the web page gets it too
        # still down after 10 minutes: one silent notice quoting the page, only once
        app["state"].down_since = (now - timedelta(minutes=11)).isoformat()
        assert (await monitor_main.tick(app))["notice_sent"]
        assert tg.sent[1] == ("⚠️ <b>La lista de sismos del IGC no está disponible</b>\n\n"
                              "Motivo: la página dice: «Estamos en mantenimiento hasta las 4:30pm.»\n\n"
                              "Mientras tanto, los avisos salen con los datos del IGC que publica EMSC, unos minutos más tarde.", True)
        assert "notice_sent" not in await monitor_main.tick(app) and len(tg.sent) == 2
        # IGC is back, with the M3.6 revised to M3.7: the message is edited (not repeated),
        # a reply says what changed, and a reply to the notice says IGC is back
        igc_state.update(etag='"v2"', body=_page([(t + timedelta(seconds=3), 7.46, -81.44, 3.7, True), old]))
        back = await monitor_main.tick(app)
        assert back["new"] == 0 and back["sent"] == 0 and back["edited"] == 1
        assert tg.edits[0][0] == 1 and "M3.7" in tg.edits[0][1] and "tomados de EMSC" not in tg.edits[0][1]
        assert tg.edits[0][1].endswith("antes: M3.6 preliminar (vía EMSC), 29 km al suroeste de Santa Catalina, Panamá</i>")
        note = tg.sent[2][0]
        assert note.startswith("✏️ <b>Revisado por el IGC</b>\n\n• Magnitud: M3.6 → <b>M3.7</b>") and tg.replies[2] == 1
        assert "Lugar" not in note  # our wording vs IGC's is not a change
        assert tg.sent[3][0].startswith("✅ <b>La lista del IGC volvió</b> después de 11 min") and tg.replies[3] == 2
        assert app["state"].down_since is None and app["state"].down_notice_id is None
        for fn in app.on_cleanup:
            await fn(app)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_igc_error_status_and_no_network(tmp_path):
    async def igc(request):
        return web.Response(text="<html><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>", status=502, content_type="text/html")

    async def emsc(request):
        return web.Response(status=204)

    srv = web.Application()
    srv.router.add_get("/", igc)
    srv.router.add_get("/emsc", emsc)
    runner = web.AppRunner(srv)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    monitor_main.CFG["igc_url"] = f"http://127.0.0.1:{port}/"
    monitor_main.CFG["emsc_url"] = f"http://127.0.0.1:{port}/emsc"
    app = monitor_main.make_app()
    for fn in app.on_startup:
        await fn(app)
    app["store"], app["telegram"] = monitor_main.FileStore(str(tmp_path)), FakeTelegram()
    try:
        r = await monitor_main.tick(app)
        assert r["igc"] == "down" and r["reason"] == "la página dice: «502 Bad Gateway nginx»" and r["backup"] == 0
        monitor_main.CFG["igc_url"] = "http://127.0.0.1:1/"  # nothing listening
        r = await monitor_main.tick(app)
        assert r["reason"] == "la página no responde"
        for fn in app.on_cleanup:
            await fn(app)
    finally:
        await runner.cleanup()


# ---------------------------------------------------------------- IGC WhatsApp notices relayed to the bot

NOTICE = """El Instituto de Geociencias de la Universidad de Panamá,
Reporta el siguiente evento:
Estado: PRELIMINAR
Fecha: 2026-10-14
Hora: 2:53:09PM hora local
Magnitud: 3.6
Profundidad: 13km
Localizado en Panamá a 51km al sureste de Soná"""


def test_reads_a_whatsapp_notice():
    from app.igc import NoticeError, from_relay, parse_notice
    from app.intensity import epicentral_km
    q = parse_notice(NOTICE)
    assert q.time == datetime(2026, 10, 14, 19, 53, 9, tzinfo=timezone.utc) and q.mag == 3.6 and q.depth_km == 13
    assert not q.reviewed and from_relay(q) and q.place == "Localizado en Panamá a 51km al sureste de Soná"
    assert abs(epicentral_km(8.008, -81.319, q.lat, q.lon) - 51) < 1 and q.lat < 8.008 and q.lon > -81.319  # SE of Soná
    # WhatsApp bold marks, REVISADO, an island, a date with slashes, no seconds
    r = parse_notice("*Estado:* REVISADO\n*Fecha:* 14/10/2026\n*Hora:* 2:31PM\n*Magnitud:* 3,8\n"
                     "*Profundidad:* 5km\nLocalizado en Panamá a 35km al este de Isla Coiba")
    assert r.reviewed and r.mag == 3.8 and r.time == datetime(2026, 10, 14, 19, 31, tzinfo=timezone.utc)
    assert abs(r.lat - 7.45) < 0.01 and abs(epicentral_km(7.45, -81.77, r.lat, r.lon) - 35) < 1
    # an unknown town asks for coordinates, which then win
    with pytest.raises(NoticeError, match="no conozco «pueblo nuevo»"):
        parse_notice(NOTICE.replace("Soná", "Pueblo Nuevo"))
    c = parse_notice(NOTICE.replace("Soná", "Pueblo Nuevo") + "\n7.61, -80.95")
    assert (c.lat, c.lon) == (7.61, -80.95)
    with pytest.raises(NoticeError, match="falta magnitud"):
        parse_notice(NOTICE.replace("Magnitud: 3.6", ""))


@pytest.mark.asyncio
async def test_relay_from_whatsapp_through_the_bot(tmp_path):
    from aiohttp.test_utils import TestClient, TestServer
    now = datetime.now(timezone.utc).replace(microsecond=0, second=9)
    t = now - timedelta(minutes=3)
    local = t.astimezone(PANAMA_TZ)
    notice = (f"Estado: PRELIMINAR\nFecha: {local:%Y-%m-%d}\nHora: {local:%I:%M:%S%p} hora local\nMagnitud: 3.6\n"
              f"Profundidad: 10km\nLocalizado en Panamá a 20km al sur de Soná")
    igc_state = {"etag": '"m"', "body": "<b>Estamos en mantenimiento hasta las 4:30pm.</b>"}

    async def igc(request):
        if request.headers.get("If-None-Match") == igc_state["etag"]:
            return web.Response(status=304)
        return web.Response(text=igc_state["body"], content_type="text/html", headers={"ETag": igc_state["etag"]})

    async def emsc(request):
        return web.Response(status=204)

    srv = web.Application()
    srv.router.add_get("/", igc)
    srv.router.add_get("/emsc", emsc)
    runner = web.AppRunner(srv)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    cfg = dict(monitor_main.CFG)
    monitor_main.CFG.update(igc_url=f"http://127.0.0.1:{port}/", emsc_url=f"http://127.0.0.1:{port}/emsc",
                            key="k3y", relay_users={"noel", "42"})
    client = TestClient(TestServer(monitor_main.make_app()))
    await client.start_server()
    app, tg = client.server.app, FakeTelegram()
    app["store"], app["telegram"] = monitor_main.FileStore(str(tmp_path)), tg
    hook = {"X-Telegram-Bot-Api-Secret-Token": "k3y"}

    def update(text, user=None):
        user = user or {"id": 7, "username": "Noel"}
        return {"update_id": 1, "message": {"message_id": 5, "from": user, "chat": {"id": user["id"], "type": "private"}, "text": text}}

    try:
        # only Telegram (with the secret) and the scheduler (with the key) get in
        assert (await client.post("/telegram", json=update(notice))).status == 403
        assert (await client.post("/tick")).status == 403
        assert (await client.post("/tick", headers={"X-Monitor-Key": "k3y"})).status == 200
        # a stranger is told no, and given their id
        await client.post("/telegram", json=update(notice, {"id": 99, "username": "x"}), headers=hook)
        assert tg.sent == [] and "<code>99</code>" in tg.private[-1][1]
        # "prueba": a preview in the private chat only
        await client.post("/telegram", json=update("prueba\n" + notice), headers=hook)
        assert tg.sent == [] and tg.private[-1][1].startswith("👀 <b>Así quedaría</b>")
        # the notice: published in the channel, and the sender is told
        await client.post("/telegram", json=update(notice), headers=hook)
        assert len(tg.sent) == 1 and "M3.6" in tg.sent[0][0] and "aviso del IGC por WhatsApp" in tg.sent[0][0]
        assert tg.private[-1] == (7, "✅ Publicado en el canal.")
        # the same notice again (by id this time): nothing new
        await client.post("/telegram", json=update(notice, {"id": 42}), headers=hook)
        assert len(tg.sent) == 1 and tg.private[-1][1].startswith("👍 Ya estaba en el canal (de un aviso anterior)")
        # IGC revises it on WhatsApp: the message is edited and a reply says so
        await client.post("/telegram", json=update(notice.replace("PRELIMINAR", "REVISADO").replace("3.6", "3.7")), headers=hook)
        assert tg.private[-1][1] == "✏️ Ya estaba en el canal: actualicé ese mensaje."
        assert "M3.7" in tg.edits[-1][1] and tg.sent[1][0].startswith("✏️ <b>Revisado por el IGC</b>") and tg.replies[1] == 1
        # a small one is kept for the page only
        lt2 = (t - timedelta(minutes=10)).astimezone(PANAMA_TZ)
        small = notice.replace("3.6", "2.9").replace(f"{local:%I:%M:%S%p}", f"{lt2:%I:%M:%S%p}")
        await client.post("/telegram", json=update(small), headers=hook)
        assert len(tg.sent) == 2 and "M2.9 es menor que M3.5" in tg.private[-1][1]
        # IGC's list comes back with the same quake: the message is refreshed (the WhatsApp
        # note goes away) without "Editado" or a reply, since a reader would see no change
        igc_state.update(etag='"v2"', body=_page([(t, 7.83, -81.32, 3.7, True)]))
        r = await (await client.post("/tick", headers={"X-Monitor-Key": "k3y"})).json()
        assert r["sent"] == 0 and r["edited"] == 1 and len(tg.sent) == 2
        assert "WhatsApp" not in tg.edits[-1][1] and "Editado" not in tg.edits[-1][1]
        await client.post("/telegram", json=update("/estado"), headers=hook)
        assert tg.private[-1][1].startswith("✅ La lista del IGC funciona")
        # unreadable text
        await client.post("/telegram", json=update("hola"), headers=hook)
        assert tg.private[-1][1].startswith("❓ No pude leer el aviso: falta fecha")
    finally:
        await client.close()
        await runner.cleanup()
        monitor_main.CFG.clear()
        monitor_main.CFG.update(cfg)


# ---------------------------------------------------------------- IGC's posts on X

def _post(t, mag, place, estado="PRELIMINAR"):
    local = t.astimezone(PANAMA_TZ)
    return ("El Instituto de Geociencias de la Universidad de Panamá,\nReporta el siguiente evento:\n"
            f"Estado: {estado}\nFecha: {local:%Y-%m-%d}\nHora: {local:%I:%M:%S%p} hora local\n"
            f"Magnitud: {mag}\nProfundidad: 10km\nLocalizado en Panamá a {place}")


@pytest.mark.asyncio
async def test_posts_on_x(tmp_path):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    t = now - timedelta(minutes=2)
    x = {"posts": [("100", "#culturasismica Presentamos el significado del ESTADO"),
                   ("101", _post(now - timedelta(hours=3), 4.1, "6km al noroeste de Tonosí", "REVISADO"))],
         "calls": []}
    igc_state = {"etag": '"v1"', "body": _page([(now - timedelta(hours=5), 7.6, -80.7, 4.0, True)])}

    async def igc(request):
        if request.headers.get("If-None-Match") == igc_state["etag"]:
            return web.Response(status=304)
        return web.Response(text=igc_state["body"], content_type="text/html", headers={"ETag": igc_state["etag"]})

    async def user(request):
        assert request.headers["Authorization"] == "Bearer xt"
        return web.json_response({"data": {"id": "77", "username": "igcpanamaup"}})

    async def tweets(request):
        since = int(request.query.get("since_id", "0"))
        x["calls"].append(request.query.get("since_id"))
        data = [{"id": i, "text": txt} for i, txt in x["posts"] if int(i) > since]
        return web.json_response({"data": data} if data else {"meta": {"result_count": 0}})

    srv = web.Application()
    srv.router.add_get("/", igc)
    srv.router.add_get("/2/users/by/username/igcpanamaup", user)
    srv.router.add_get("/2/users/77/tweets", tweets)
    runner = web.AppRunner(srv)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    cfg = dict(monitor_main.CFG)
    monitor_main.CFG.update(igc_url=f"http://127.0.0.1:{port}/", x_api=f"http://127.0.0.1:{port}/2", x_token="xt")
    app = monitor_main.make_app()
    tg = FakeTelegram()
    for fn in app.on_startup:
        await fn(app)
    app["store"], app["telegram"] = monitor_main.FileStore(str(tmp_path)), tg
    try:
        first = await monitor_main.tick(app)
        assert first["x"] == {"posts": 2, "quakes": 1, "new": 1, "sent": 0, "edited": 0} and tg.sent == []  # learns only
        assert x["calls"] == [None]
        # IGC posts a new quake on X: announced at once, with a link to the post
        x["posts"].append(("102", _post(t, 4.5, "18km al noroeste de Tonosí")))
        second = await monitor_main.tick(app)
        assert second["x"]["sent"] == 1 and x["calls"][-1] == "101"
        assert "M4.5" in tg.sent[0][0] and "publicación del IGC en X" in tg.sent[0][0]
        assert tg.buttons[0][0][0] == {"text": "𝕏 Publicación del IGC", "url": "https://x.com/igcpanamaup/status/102"}
        # nothing new on X: nothing read, nothing sent
        third = await monitor_main.tick(app)
        assert third["x"] == {"posts": 0, "quakes": 0} and len(tg.sent) == 1
        # IGC posts the REVISADO version: the same message is edited
        x["posts"].append(("103", _post(t, 4.4, "18km al noroeste de Tonosí", "REVISADO")))
        fourth = await monitor_main.tick(app)
        assert fourth["x"]["edited"] == 1 and "M4.4" in tg.edits[-1][1] and tg.sent[1][0].startswith("✏️ <b>Revisado por el IGC</b>")
        # the same notice forwarded from WhatsApp is recognised
        q_wa = __import__("app.igc", fromlist=["parse_notice"]).parse_notice(_post(t, 4.4, "18km al noroeste de Tonosí", "REVISADO"))
        assert (await monitor_main.relay_notice(app, q_wa)).startswith("👍 Ya estaba en el canal")
        # X down: the tick goes on with IGC's list
        monitor_main.CFG["x_api"] = "http://127.0.0.1:1/2"
        fifth = await monitor_main.tick(app)
        assert "error" in fifth["x"] and fifth["changed"] is False
        for fn in app.on_cleanup:
            await fn(app)
    finally:
        await runner.cleanup()
        monitor_main.CFG.clear()
        monitor_main.CFG.update(cfg)
