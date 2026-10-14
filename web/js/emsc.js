// Loading earthquakes from EMSC Seismic Portal: the FDSN catalog for history,
// the WebSocket for new events as they are published, and periodic polling
// as a safety net when the WebSocket drops.

import { EMSC } from './config.js';

const EARTHQUAKE_TYPES = new Set(['ke', 'se']); // known / suspected earthquake

/** EMSC GeoJSON feature -> plain event, or null if it isn't a usable earthquake. */
export function featureToEvent(f) {
  const p = (f && f.properties) || {};
  if (p.evtype && !EARTHQUAKE_TYPES.has(p.evtype)) return null;
  const mag = Number(p.mag);
  const lat = Number(p.lat ?? f.geometry?.coordinates?.[1]);
  const lon = Number(p.lon ?? f.geometry?.coordinates?.[0]);
  const t = new Date(p.time);
  if (!Number.isFinite(mag) || !Number.isFinite(lat) || !Number.isFinite(lon) || Number.isNaN(t.getTime())) return null;
  return {
    id: String(p.unid || f.id),
    t,
    lat,
    lon,
    depth: Number.isFinite(Number(p.depth)) ? Number(p.depth) : 10,
    mag,
    magType: String(p.magtype || ''),
    agency: String(p.auth || 'EMSC'),
    region: String(p.flynn_region || ''),
    updated: p.lastupdate ? new Date(p.lastupdate) : null,
    // The live feed only carries the preferred solution: confirmed at once if it is
    // the national network's, otherwise unknown until all solutions are fetched.
    origins: null,
    confirmed: EMSC.trustedAuthors.includes(String(p.auth || '')) ? true : null,
  };
}

const iso = (d) => d.toISOString().slice(0, 19);

/**
 * Confirmed when a trusted agency (the national network) located it, when two or more
 * agencies did, or when an analyst reviewed a solution. A single automatic solution
 * from another agency is what produced the false M4.0 of 2026-10-13: not confirmed.
 */
export function isConfirmed(origins, trusted = EMSC.trustedAuthors) {
  if (!origins || !origins.length) return null; // unknown yet
  const authors = new Set(origins.map((o) => o.author));
  return [...authors].some((a) => trusted.includes(a)) || authors.size >= 2 || origins.some((o) => o.mode === 'manual');
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (s, name) => { const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(s); return m ? unescape(m[1]) : null; };
const value = (s, name) => { const m = new RegExp(`<${name}>\\s*<value>\\s*([^<]*?)\\s*</value>`).exec(s); return m ? m[1] : null; };
const lastPart = (uri) => (uri || '').split('/').pop();

/**
 * EMSC QuakeML (format=xml&includeallorigins=true) -> events like featureToEvent's,
 * plus every agency's solution (origins: [{ author, mode }]) and `confirmed`.
 * EMSC's XML is regular, so a few regular expressions read it without an XML library.
 */
export function parseQuakeML(xml) {
  const out = [];
  for (const [, publicID, body] of xml.matchAll(/<event publicID="([^"]+)">([\s\S]*?)<\/event>/g)) {
    const own = body.replace(/<origin [\s\S]*?<\/origin>/g, '').replace(/<magnitude [\s\S]*?<\/magnitude>/g, '').replace(/<description>[\s\S]*?<\/description>/g, '');
    const type = tag(own, 'type');
    if (type && type !== 'earthquake') continue;
    const origins = [...body.matchAll(/<origin publicID="([^"]+)">([\s\S]*?)<\/origin>/g)].map(([, pid, o]) => ({
      pid,
      t: new Date(value(o, 'time')),
      lat: Number(value(o, 'latitude')),
      lon: Number(value(o, 'longitude')),
      depthKm: Number(value(o, 'depth')) / 1000,
      mode: tag(o, 'evaluationMode') || '',
      author: lastPart(tag(o, 'authorURI')),
    }));
    const mags = [...body.matchAll(/<magnitude publicID="([^"]+)">([\s\S]*?)<\/magnitude>/g)].map(([, pid, mm]) => ({
      pid, origin: tag(mm, 'originID'), mag: Number(value(mm, 'mag')), type: tag(mm, 'type') || '',
    }));
    const prefO = tag(own, 'preferredOriginID'), prefM = tag(own, 'preferredMagnitudeID');
    const o = origins.find((x) => x.pid === prefO) || origins[0];
    const m = mags.find((x) => x.pid === prefM) || mags.find((x) => x.origin === o?.pid) || mags[0];
    if (!o || !m || !Number.isFinite(m.mag) || !Number.isFinite(o.lat) || !Number.isFinite(o.lon) || Number.isNaN(o.t.getTime())) continue;
    const created = tag(own, 'creationTime');
    const list = origins.map(({ author, mode }) => ({ author, mode }));
    out.push({
      id: lastPart(publicID),
      t: o.t,
      lat: o.lat,
      lon: o.lon,
      depth: Number.isFinite(o.depthKm) ? Math.round(o.depthKm * 10) / 10 : 10,
      mag: m.mag,
      magType: m.type,
      agency: o.author || 'EMSC',
      region: (/<description>\s*<text>([^<]*)<\/text>/.exec(body) || [])[1] || '',
      updated: created ? new Date(created) : null,
      origins: list,
      confirmed: isConfirmed(list),
    });
  }
  return out;
}

/** EMSC page with every agency's solution for an event (or the IGC page for an IGC-only one). */
export const emscLink = (ev) => ev.url || `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(ev.id)}`;

function areaParams(area) {
  return { minlat: area.minLat, maxlat: area.maxLat, minlon: area.minLon, maxlon: area.maxLon };
}

async function query(params, fetchImpl) {
  // XML with every agency's solution, to tell confirmed events from lone automatic ones.
  const url = `${EMSC.fdsn}?${new URLSearchParams({ format: 'xml', includeallorigins: 'true', ...params })}`;
  const r = await fetchImpl(url);
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`EMSC respondió ${r.status}`);
  return parseQuakeML(await r.text());
}

/** One event with all its solutions (used for live events that aren't the national network's). */
export function fetchEvent(id, fetchImpl = fetch) {
  return query({ eventid: id }, fetchImpl);
}

/**
 * Every event in `area` since `start`, following EMSC's 300-per-request limit
 * by moving the start time forward to the last event received.
 */
export async function fetchSince(start, area, minMag, fetchImpl = fetch) {
  const out = new Map();
  let cursor = new Date(start);
  for (let page = 0; page < 60; page++) {
    const batch = await query({
      ...areaParams(area), minmag: minMag, orderby: 'time-asc', limit: EMSC.pageSize, start: iso(cursor),
    }, fetchImpl);
    for (const e of batch) out.set(e.id, e);
    if (batch.length < EMSC.pageSize) break;
    const last = new Date(Math.max(...batch.map((e) => e.t.getTime())));
    if (last.getTime() <= cursor.getTime()) break; // >300 events in the same second: give up paging
    cursor = last;
  }
  return [...out.values()];
}

/** Events created or revised since `since` (used by the safety-net poll). */
export function fetchUpdated(since, start, area, minMag, fetchImpl = fetch) {
  return query({
    ...areaParams(area), minmag: minMag, limit: EMSC.pageSize, start: iso(new Date(start)), updatedafter: iso(since),
  }, fetchImpl);
}

/** WebSocket that reconnects with backoff. onEvent(event, action); onStatus('open'|'closed');
 * onRemove(id) when EMSC deletes an event or reclassifies it as not an earthquake. */
export class LiveFeed {
  constructor({ onEvent, onStatus, onRemove = () => {}, url = EMSC.ws, WebSocketImpl = globalThis.WebSocket }) {
    this.onEvent = onEvent;
    this.onRemove = onRemove;
    this.onStatus = onStatus;
    this.url = url;
    this.WS = WebSocketImpl;
    this.backoff = 2000;
    this.stopped = false;
  }

  start() {
    if (!this.WS) { this.onStatus('closed'); return; }
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch {
      this._retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 2000; this.onStatus('open'); };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        const ev = featureToEvent(msg.data);
        const id = msg.data?.properties?.unid || msg.data?.id;
        if (msg.action === 'delete' || (!ev && id && msg.action === 'update')) { if (id) this.onRemove(String(id)); return; }
        if (ev) this.onEvent(ev, msg.action);
      } catch { /* ignore malformed messages */ }
    };
    ws.onclose = () => { this.onStatus('closed'); this._retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }

  _retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.backoff + Math.random() * 1000);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }
}
