// Earthquakes straight from the Instituto de Geociencias (IGC), through the feed the
// IGC monitor writes every minute (backend/app/monitor_main.py). IGC publishes 2–3
// minutes after a quake; EMSC gets the same solution 3–10 minutes later. Until EMSC
// has it, the IGC version is shown; then the EMSC one (one event, never both).

import { IGC_FEED } from './config.js';
import { epicentralKm } from './intensity.js';

export const igcOn = () => Boolean((IGC_FEED.base || '').trim());

/** Feed JSON -> events shaped like the EMSC ones (always confirmed: national network). */
export function parseIgcFeed(json) {
  return (json.events || []).map((e) => ({
    id: String(e.id),
    t: new Date(e.time),
    lat: Number(e.lat),
    lon: Number(e.lon),
    depth: Number(e.depth) || 10,
    mag: Number(e.mag),
    magType: 'm',
    agency: 'IGC',
    region: '',
    updated: null,
    origins: [{ author: 'IGC', mode: e.reviewed ? 'manual' : 'automatic' }],
    confirmed: true,
    reviewed: Boolean(e.reviewed),
    url: e.url || 'https://sismosgeociencias.up.ac.pa/',
    source: 'igc',
  })).filter((e) => Number.isFinite(e.mag) && Number.isFinite(e.lat) && Number.isFinite(e.lon) && !Number.isNaN(e.t.getTime()));
}

export async function fetchIgc(file = 'latest.json', fetchImpl = fetch) {
  const base = IGC_FEED.base.trim().replace(/\/?$/, '/');
  const r = await fetchImpl(`${base}${file}`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`IGC feed ${r.status}`);
  return parseIgcFeed(await r.json());
}

/** The same quake reported by two networks: within a minute and 80 km. */
export const sameQuake = (a, b) => Math.abs(a.t - b.t) <= 60e3 && epicentralKm(a.lat, a.lon, b.lat, b.lon) <= 80;

/** IGC events that EMSC doesn't have yet (both lists sorted or not; small sizes). */
export function igcOnly(igc, emsc) {
  const byTime = [...emsc].sort((a, b) => a.t - b.t);
  const times = byTime.map((e) => e.t.getTime());
  const near = (q) => {
    // binary search the first EMSC event at or after q.t - 60 s
    let lo = 0, hi = times.length;
    const from = q.t.getTime() - 60e3;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < from) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < times.length && times[i] <= q.t.getTime() + 60e3; i++) if (sameQuake(q, byTime[i])) return true;
    return false;
  };
  return igc.filter((q) => !near(q));
}
