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
  };
}

const iso = (d) => d.toISOString().slice(0, 19);

/** EMSC page with every agency's solution for an event. */
export const emscLink = (ev) => `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(ev.id)}`;

function areaParams(area) {
  return { minlat: area.minLat, maxlat: area.maxLat, minlon: area.minLon, maxlon: area.maxLon };
}

async function query(params, fetchImpl) {
  const url = `${EMSC.fdsn}?${new URLSearchParams({ format: 'json', ...params })}`;
  const r = await fetchImpl(url);
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`EMSC respondió ${r.status}`);
  const j = await r.json();
  return (j.features || []).map(featureToEvent).filter(Boolean);
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
    const last = batch[batch.length - 1].t;
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
