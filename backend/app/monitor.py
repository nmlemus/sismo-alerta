"""IGC monitor: what changed since the last look, and what to tell people.

Pure functions (no network), so the rules can be tested:
- merge(): matches the new list against the known quakes. A quake keeps the id
  it got when first seen, even if IGC later moves it a few seconds or kilometres.
- to_notify(): new quakes worth a Telegram message (recent, big enough, nearby).
- message(): the text, in Spanish, with the estimated intensity in Panama City.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone

from .igc import PANAMA_TZ, TOWNS, IgcQuake, from_emsc, from_relay, from_x, same_quake, source
from .intensity import describe, epicentral_km, estimate_mmi

PANAMA_CITY = (8.983, -79.52, 0.6)  # lat, lon, site adjustment (matches the web page)


@dataclass
class Known:
    """A quake the monitor has seen, with the Telegram message that announced it."""

    id: str
    quake: IgcQuake
    message_id: int | None = None
    sent_signature: str | None = None  # what the message showed, to edit it only when needed
    # IGC sometimes gives the same quake different magnitudes on its list, on X, on
    # WhatsApp and in what it sends to EMSC. The highest one decides whether to announce.
    peak_mag: float | None = None
    peak_src: str | None = None  # where it said so: x, whatsapp, emsc


@dataclass
class MergeResult:
    known: dict[str, Known]
    new: list[Known] = field(default_factory=list)
    changed: list[Known] = field(default_factory=list)  # magnitude, place or REVISADO changed
    peaked: list[Known] = field(default_factory=list)  # another IGC channel gave a higher magnitude


def signature(q: IgcQuake) -> str:
    sig = f"{q.mag:.1f}|{q.reviewed}|{q.place}|{q.lat:.2f},{q.lon:.2f}"
    return sig if source(q) == "igc" else f"{sig}|{source(q)}"  # a source change shows in the message


def merge(known: dict[str, Known], current: list[IgcQuake], keep_days: float = 8.0,
          now: datetime | None = None) -> MergeResult:
    now = now or datetime.now(timezone.utc)
    out = MergeResult(known={})
    pool = list(known.values())
    for q in current:
        match = next((k for k in pool if same_quake(q, k.quake.time, k.quake.lat, k.quake.lon)), None)
        if match:
            pool.remove(match)
            before = signature(match.quake)
            entry = Known(match.id, q, match.message_id, match.sent_signature, match.peak_mag, match.peak_src)
            if signature(q) != before:
                out.changed.append(entry)
        else:
            entry = Known(q.id, q)
            out.new.append(entry)
        out.known[entry.id] = entry
    # IGC lists 7 days; keep what dropped off for a while so it isn't "new" if it reappears.
    for k in pool:
        if from_emsc(k.quake) and now - k.quake.time > timedelta(minutes=EMSC_GRACE_MIN):
            continue  # taken from EMSC while IGC was down, and IGC's list never had it
        if now - k.quake.time < timedelta(days=keep_days):
            out.known[k.id] = k
    return out


EMSC_GRACE_MIN = 60  # how long IGC's list gets to show a quake first seen on EMSC


_RANK = {"emsc": 0, "relay": 1, "igc": 2}  # IGC's list > IGC's WhatsApp notice > EMSC


def merge_backup(known: dict[str, Known], backup: list[IgcQuake]) -> MergeResult:
    """Like merge(), for quakes from a secondary source (EMSC while IGC's list is
    down, or an IGC WhatsApp notice relayed by hand). They add what isn't known, and
    update a known quake only if it came from the same or a less reliable source."""
    out = MergeResult(known=dict(known))
    pool = list(known.values())
    for q in backup:
        match = next((k for k in pool if same_quake(q, k.quake.time, k.quake.lat, k.quake.lon)), None)
        if match:
            pool.remove(match)
            if _RANK[source(q)] >= _RANK[source(match.quake)] and signature(q) != signature(match.quake):
                entry = Known(match.id, q, match.message_id, match.sent_signature, match.peak_mag, match.peak_src)
                out.changed.append(entry)
                out.known[entry.id] = entry
            elif raise_peak(match, q):
                out.peaked.append(match)
        else:
            entry = Known(q.id, q)
            out.new.append(entry)
            out.known[entry.id] = entry
    return out


def channel(q: IgcQuake) -> str:
    return "emsc" if from_emsc(q) else "x" if from_x(q) else "whatsapp" if from_relay(q) else "igc"


def raise_peak(k: Known, q: IgcQuake) -> bool:
    """Another IGC version of a known quake: remember its magnitude if it is higher."""
    if q.mag > effective_mag(k) + 1e-6:
        k.peak_mag, k.peak_src = q.mag, channel(q)
        return True
    return False


def apply_peaks(known: dict[str, Known], others: list[IgcQuake]) -> list[Known]:
    """IGC's solutions as EMSC has them, against the known quakes: only raises peaks
    (they never replace what IGC's own list says). Returns the quakes that changed."""
    touched = []
    for q in others:
        match = next((k for k in known.values() if same_quake(q, k.quake.time, k.quake.lat, k.quake.lon)), None)
        if match and match.quake is not q and raise_peak(match, q):
            touched.append(match)
    return touched


def effective_mag(k: Known) -> float:
    return max(k.quake.mag, k.peak_mag or 0.0)


def effective(k: Known) -> IgcQuake:
    """The quake with the highest magnitude IGC gave it, to decide on announcing."""
    return k.quake if effective_mag(k) == k.quake.mag else replace(k.quake, mag=effective_mag(k))


def known_signature(k: Known) -> str:
    """What the message shows: the quake, and the higher magnitude if there is one."""
    sig = signature(k.quake)
    return f"{sig}|p{k.peak_mag:.1f}" if k.peak_mag and k.peak_mag > k.quake.mag else sig


_CHANNEL = {"emsc": "en lo que envió a EMSC", "x": "en X", "whatsapp": "por WhatsApp", "igc": "en su lista"}


def peak_note(k: Known) -> str | None:
    if not k.peak_mag or k.peak_mag <= k.quake.mag:
        return None
    return f"ℹ️ <i>El IGC también lo reportó como M{k.peak_mag:.1f} ({_CHANNEL.get(k.peak_src, 'en otra publicación')}).</i>"


def message_for(k: Known) -> str:
    note = peak_note(k)
    return message(k.quake) + (f"\n\n{note}" if note else "")


# Towns where people would feel it (the island of Coiba has almost nobody). The capital
# and Colón get the same +0.6 the page uses, from what people reported to USGS.
FELT_TOWNS = [(name, lat, lon, 0.6 if name in ("Ciudad de Panamá", "Colón") else 0.0)
              for name, lat, lon in TOWNS if name != "Coiba"]


def strongest_town(q: IgcQuake) -> tuple[str, float]:
    """The town where the quake would be felt most, and the intensity expected there."""
    return max(((name, estimate_mmi(q.mag, q.depth_km, q.lat, q.lon, lat, lon, adj)) for name, lat, lon, adj in FELT_TOWNS),
               key=lambda x: x[1])


def significant(q: IgcQuake, min_mag: float, min_mmi: float) -> bool:
    """Big enough, or felt at least at intensity min_mmi in some town (levels are
    rounded: V starts at 4.5)."""
    return q.mag >= min_mag or strongest_town(q)[1] >= min_mmi - 0.5


def to_notify(new: list[Known], *, min_mag: float, max_age_min: float, max_km: float,
              min_mmi: float = 99, now: datetime | None = None) -> list[Known]:
    """Recent significant quakes (min_mag, or min_mmi in some town) within max_km of
    Panama City, oldest first. The rest only go to the web page."""
    now = now or datetime.now(timezone.utc)
    lat, lon, _ = PANAMA_CITY
    keep = [k for k in new
            if significant(effective(k), min_mag, min_mmi)
            and now - k.quake.time <= timedelta(minutes=max_age_min)
            and epicentral_km(lat, lon, k.quake.lat, k.quake.lon) <= max_km]
    return sorted(keep, key=lambda k: k.quake.time)


def _clock(t: datetime) -> str:
    local = t.astimezone(PANAMA_TZ)
    h = local.hour % 12 or 12
    return f"{h}:{local:%M} {'a. m.' if local.hour < 12 else 'p. m.'}"


def _place(q: IgcQuake) -> str:
    """'Localizado en Panamá a 27km al noroeste de Tonosí' -> '27 km al noroeste de Tonosí, Panamá'."""
    p = q.place
    if p.startswith("Localizado en "):
        p = p[len("Localizado en "):]
    p = re.sub(r"(\d)km\b", r"\1 km", p)
    m = re.match(r"^(.+?) a (\d+ km .+)$", p)
    if m:
        p = f"{m.group(2)}, {m.group(1)}"
    return p[:1].upper() + p[1:]


_DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]


def _day(t: datetime) -> str:
    local = t.astimezone(PANAMA_TZ)
    return f"{_DAYS[local.weekday()]} {local.day} {_MONTHS[local.month - 1]}"


def badge(mag: float) -> str:
    return "🔴" if mag >= 6 else "🟠" if mag >= 5 else "🟡" if mag >= 4 else "⚪"


def message(q: IgcQuake, dashboard_url: str = "") -> str:
    """Telegram HTML message for a quake: headline, where/when/depth, felt in the capital.
    Links go in buttons() under the message, so the text stays clean."""
    lat, lon, adj = PANAMA_CITY
    mmi = estimate_mmi(q.mag, q.depth_km, q.lat, q.lon, lat, lon, adj)
    state = "✅ revisado" if q.reviewed else "🕒 preliminar"
    return "\n".join([
        f"{badge(q.mag)} <b>SISMO M{q.mag:.1f}</b>  ·  {state}",
        "",
        f"📍 {_esc(_place(q))}",
        f"🕐 {_day(q.time)} · {_clock(q.time)}",
        f"⬇️ {q.depth_km:.0f} km de profundidad",
        "",
        f"🏙️ En Ciudad de Panamá: intensidad <b>{describe(mmi)}</b>, estimada",
    ] + (["", "<i>ℹ️ Datos del IGC tomados de EMSC: la lista del IGC no está disponible ahora.</i>"] if from_emsc(q) else
         ["", "<i>ℹ️ De la publicación del IGC en X; ubicación aproximada.</i>"] if from_x(q) else
         ["", "<i>ℹ️ Del aviso del IGC por WhatsApp; ubicación aproximada.</i>"] if from_relay(q) else []))


def buttons(q: IgcQuake, dashboard_url: str) -> list[list[dict]]:
    """Inline buttons under the message (Telegram inline keyboard)."""
    label = ("🗺️ Ficha en EMSC" if from_emsc(q) else "𝕏 Publicación del IGC" if from_x(q)
             else "🌐 Sitio del IGC" if from_relay(q) else "🗺️ Ficha del IGC")
    return [[{"text": label, "url": q.url}, {"text": "📈 Réplicas en vivo", "url": dashboard_url}]]


MOVE_KM = 5  # a few km is within the usual location error: not worth a line


def _clock_s(t: datetime) -> str:
    local = t.astimezone(PANAMA_TZ)
    h = local.hour % 12 or 12
    return f"{h}:{local:%M:%S} {'a. m.' if local.hour < 12 else 'p. m.'}"


def revision_note(before: IgcQuake, after: IgcQuake) -> str | None:
    """Short reply to the original message: what IGC changed, in before → after form,
    and only what a reader would notice."""
    parts = []
    if f"{before.mag:.1f}" != f"{after.mag:.1f}":
        parts.append(f"Magnitud: M{before.mag:.1f} → <b>M{after.mag:.1f}</b>")
    else:
        parts.append(f"Magnitud: M{after.mag:.1f}, sin cambios")
    moved = epicentral_km(before.lat, before.lon, after.lat, after.lon)
    if source(before) != source(after):
        # Coordinates from EMSC or worked out from a notice aren't IGC's: compare the
        # place as IGC words it, and the wording EMSC's got from us only if it really moved.
        if _place(before) != _place(after) and (from_relay(before) or moved >= MOVE_KM):
            parts.append(f"Lugar: {_esc(_place(before))} → <b>{_esc(_place(after))}</b>")
    elif _place(before) != _place(after):
        parts.append(f"Lugar: {_esc(_place(before))} → <b>{_esc(_place(after))}</b>")
    elif moved >= MOVE_KM:
        parts.append(f"Epicentro ajustado {moved:.0f} km; sigue a {_esc(_place(after))}")
    if abs((after.time - before.time).total_seconds()) >= 2:
        parts.append(f"Hora: {_clock_s(before.time)} → <b>{_clock_s(after.time)}</b>")
    if abs(after.depth_km - before.depth_km) >= 5:
        parts.append(f"Profundidad: {before.depth_km:.0f} → <b>{after.depth_km:.0f} km</b>")
    newly_reviewed = after.reviewed and not before.reviewed
    if len(parts) == 1 and parts[0].endswith("sin cambios") and not newly_reviewed:
        return None  # only a small nudge of the coordinates: nothing a reader would notice
    head = ("✏️ <b>Revisado por el IGC</b>" if newly_reviewed
            else "✏️ <b>Ya en la lista del IGC</b>" if source(before) != "igc" and source(after) == "igc"
            else "✏️ <b>Actualizado por el IGC</b>")
    return head + "\n\n" + "\n".join(f"• {p}" for p in parts)


def edited_footer(before: IgcQuake, after: IgcQuake | None = None) -> str:
    """Last line of an edited message: what it said before, so the edit explains itself
    without another message (an edit doesn't notify anyone; a new message does)."""
    state = "revisado" if before.reviewed else "preliminar"
    via = (" (vía EMSC)" if from_emsc(before) else " (aviso en X)" if from_x(before)
           else " (aviso por WhatsApp)" if from_relay(before) else "")
    head = "Revisado por el IGC" if after is not None and after.reviewed and not before.reviewed else "Editado"
    return f"<i>✏️ {head} · antes: M{before.mag:.1f} {state}{via}, {_esc(_place(before))}</i>"


def nearby_earlier(q: IgcQuake, known: list["Known"], minutes: float = 10, km: float = 40) -> "Known | None":
    """An already announced quake shortly before and close to this one (same cluster,
    or a revision IGC listed as a new row): the new message replies to it."""
    best = None
    for k in known:
        if k.message_id is None or k.quake is q:
            continue
        dt = (q.time - k.quake.time).total_seconds()
        if 0 <= dt <= minutes * 60 and epicentral_km(q.lat, q.lon, k.quake.lat, k.quake.lon) <= km:
            if best is None or k.quake.time > best.quake.time:
                best = k
    return best


def cluster_note(q: IgcQuake, earlier: IgcQuake) -> str:
    d = epicentral_km(q.lat, q.lon, earlier.lat, earlier.lon)
    state = "revisado" if earlier.reviewed else "preliminar"
    return (f"↪️ <i>El IGC lo publica como un sismo distinto del de las {_clock(earlier.time)} "
            f"(M{earlier.mag:.1f} {state}, a {d:.0f} km)</i>")


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def feed(known: dict[str, Known], now: datetime | None = None, hours: float = 24 * 7) -> dict:
    """Public JSON for the web page: the last `hours` (7 days by default), newest first."""
    now = now or datetime.now(timezone.utc)
    events = sorted((k for k in known.values() if now - k.quake.time <= timedelta(hours=hours)),
                    key=lambda k: k.quake.time, reverse=True)
    return {
        "source": "Instituto de Geociencias, Universidad de Panamá",
        "url": "https://sismosgeociencias.up.ac.pa/",
        "updated": now.isoformat(timespec="seconds"),
        "events": [{
            "id": k.id,
            "time": k.quake.time.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "lat": k.quake.lat, "lon": k.quake.lon, "depth": k.quake.depth_km,
            "mag": k.quake.mag, "reviewed": k.quake.reviewed, "place": k.quake.place, "url": k.quake.url,
        } for k in events],
    }
