"""IGC monitor: what changed since the last look, and what to tell people.

Pure functions (no network), so the rules can be tested:
- merge(): matches the new list against the known quakes. A quake keeps the id
  it got when first seen, even if IGC later moves it a few seconds or kilometres.
- to_notify(): new quakes worth a Telegram message (recent, big enough, nearby).
- message(): the text, in Spanish, with the estimated intensity in Panama City.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .igc import PANAMA_TZ, IgcQuake, same_quake
from .intensity import describe, epicentral_km, estimate_mmi

PANAMA_CITY = (8.983, -79.52, 0.6)  # lat, lon, site adjustment (matches the web page)


@dataclass
class Known:
    """A quake the monitor has seen, with the Telegram message that announced it."""

    id: str
    quake: IgcQuake
    message_id: int | None = None
    sent_signature: str | None = None  # what the message showed, to edit it only when needed


@dataclass
class MergeResult:
    known: dict[str, Known]
    new: list[Known] = field(default_factory=list)
    changed: list[Known] = field(default_factory=list)  # magnitude, place or REVISADO changed


def signature(q: IgcQuake) -> str:
    return f"{q.mag:.1f}|{q.reviewed}|{q.place}|{q.lat:.2f},{q.lon:.2f}"


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
            entry = Known(match.id, q, match.message_id, match.sent_signature)
            if signature(q) != before:
                out.changed.append(entry)
        else:
            entry = Known(q.id, q)
            out.new.append(entry)
        out.known[entry.id] = entry
    # IGC lists 7 days; keep what dropped off for a while so it isn't "new" if it reappears.
    for k in pool:
        if now - k.quake.time < timedelta(days=keep_days):
            out.known[k.id] = k
    return out


def to_notify(new: list[Known], *, min_mag: float, max_age_min: float, max_km: float,
              now: datetime | None = None) -> list[Known]:
    """Recent quakes of at least min_mag within max_km of Panama City, oldest first."""
    now = now or datetime.now(timezone.utc)
    lat, lon, _ = PANAMA_CITY
    keep = [k for k in new
            if k.quake.mag >= min_mag
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
    ])


def buttons(q: IgcQuake, dashboard_url: str) -> list[list[dict]]:
    """Inline buttons under the message (Telegram inline keyboard)."""
    return [[{"text": "🗺️ Ficha del IGC", "url": q.url}, {"text": "📈 Réplicas en vivo", "url": dashboard_url}]]


def revision_note(before: IgcQuake, after: IgcQuake) -> str:
    """Short reply to the original message: what IGC changed."""
    parts = []
    if f"{before.mag:.1f}" != f"{after.mag:.1f}":
        parts.append(f"M{before.mag:.1f} → <b>M{after.mag:.1f}</b>")
    moved = epicentral_km(before.lat, before.lon, after.lat, after.lon)
    if moved >= 3 or before.place != after.place:
        parts.append(f"ahora {_esc(_place(after))}" + (f" (se movió {moved:.0f} km)" if moved >= 3 else ""))
    if abs((after.time - before.time).total_seconds()) >= 2:
        parts.append(f"hora {_clock(after.time)}")
    head = "✏️ <b>Revisado por el IGC</b>" if after.reviewed and not before.reviewed else "✏️ <b>Actualizado por el IGC</b>"
    return head + ("\n\n" + "\n".join(f"• {p}" for p in parts) if parts else "\n\nConfirmado sin cambios")


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
