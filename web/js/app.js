// Page logic: loads the catalog, keeps it live, derives the sequence and redraws.

import { EMSC, PLACES, REFERENCES, SEQUENCE } from './config.js';
import { LiveFeed, fetchSince, fetchUpdated } from './emsc.js';
import { MMI_COLORS, ROMAN, describeMmi, epicentralKm, estimateMmi, mmiLevel, placeName } from './intensity.js';
import { ago, fmtClock, fmtDay, fmtInt, fmtMag, fmtRate, fmtTime } from './format.js';
import { drawBands, drawIntensity, drawTimeline, drawWindows } from './charts.js';
import { QuakeMap } from './map.js';

const $ = (sel) => document.querySelector(sel);
const H = 3600e3;

const state = {
  events: new Map(), // id -> event
  loaded: false,
  error: null,
  live: 'connecting', // connecting | open | closed
  lastSync: null,
  ref: { ...REFERENCES[0] },
  sort: { key: 't', dir: -1 },
  search: '',
};

const inBox = (e, b) => e.lat >= b.minLat && e.lat <= b.maxLat && e.lon >= b.minLon && e.lon <= b.maxLon;

function upsert(ev) {
  ev.place = placeName(ev.lat, ev.lon, PLACES, ev.region.toUpperCase() === 'COSTA RICA' ? 'Costa Rica' : '');
  const prev = state.events.get(ev.id);
  state.events.set(ev.id, ev);
  return !prev;
}

/** Mainshock, aftershocks in the zone, everything else in the region. */
function derive() {
  const start = new Date(SEQUENCE.start).getTime();
  const all = [...state.events.values()].filter((e) => e.t.getTime() >= start && inBox(e, SEQUENCE.region));
  const zone = all.filter((e) => inBox(e, SEQUENCE.zone));
  if (!zone.length) return null;
  const main = zone.reduce((a, b) => (b.mag > a.mag ? b : a));
  const seq = zone.filter((e) => e.t > main.t).sort((a, b) => a.t - b.t);
  const others = all.filter((e) => !inBox(e, SEQUENCE.zone) && e.t >= main.t);
  const days = [];
  const dayOf = new Map();
  for (const e of [main, ...seq]) {
    const d = fmtDay(e.t);
    if (!dayOf.has(d)) { dayOf.set(d, days.length); days.push(d); }
  }
  const dayIndex = (e) => dayOf.get(fmtDay(e.t)) ?? 0;
  return { main, seq, others, days, dayIndex };
}

function stats({ main, seq }, now) {
  const hrs = (e) => (e.t - main.t) / H;
  const span = Math.max(1 / 60, (now - main.t) / H);
  const first12 = seq.filter((e) => hrs(e) < 12);
  const last12 = seq.filter((e) => hrs(e) >= span - 12);
  const big = seq.length ? seq.reduce((a, b) => (b.mag > a.mag ? b : a)) : null;
  const windows = [];
  for (let s = 0; s < span; s += 6) {
    const w = seq.filter((e) => hrs(e) >= s && hrs(e) < s + 6);
    windows.push({ label: `${s}`, start: s, count: w.length, m4: w.filter((e) => e.mag >= 4).length, maxMag: w.length ? Math.max(...w.map((e) => e.mag)) : null });
  }
  const bands = [[2.5, 3], [3, 3.5], [3.5, 4], [4, 4.5], [4.5, 5], [5, 6], [6, 99]].map(([lo, hi]) => ({
    label: hi === 99 ? '6.0+' : `${lo.toFixed(1)}–${(hi - 0.1).toFixed(1)}`,
    count: seq.filter((e) => e.mag >= lo && e.mag < hi).length,
  }));
  return {
    span, big, windows, bands,
    rateFirst12: first12.length / Math.min(12, span),
    rateLast12: last12.length / Math.min(12, span),
    m4First12: first12.filter((e) => e.mag >= 4).length / Math.min(12, span),
    m4Last12: last12.filter((e) => e.mag >= 4).length / Math.min(12, span),
    latest: seq[seq.length - 1] || null,
  };
}

// ------------------------------------------------------------------ rendering

const map = new QuakeMap({
  mapEl: $('#map'), playBtn: $('#map-play'), slider: $('#map-time'), timeLabel: $('#map-time-label'),
  viewBtns: [...document.querySelectorAll('[data-view]')], legendEl: $('#map-legend'), zone: SEQUENCE.zone,
});

let scheduled = false;
function scheduleRender() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

function setText(sel, text) { const n = $(sel); if (n) n.textContent = text; }

function renderStatus() {
  const pill = $('#live');
  const kind = state.error && !state.loaded ? 'bad' : state.live === 'open' ? 'ok' : 'warn';
  pill.dataset.kind = kind;
  const text = state.error && !state.loaded
    ? 'Sin conexión con EMSC'
    : state.live === 'open' ? 'En vivo' : state.loaded ? 'Reconectando… (se actualiza cada 2 min)' : 'Cargando…';
  setText('#live-text', text);
  setText('#synced', state.lastSync ? `Datos al ${fmtClock(state.lastSync)}` : '');
}

function render() {
  renderStatus();
  if (!state.loaded) return;
  const d = derive();
  document.body.classList.toggle('empty', !d);
  if (!d) return;
  const now = Date.now();
  const s = stats(d, now);
  const { main, seq } = d;
  const ref = state.ref;

  // headline + takeaway
  setText('#main-mag', `M${fmtMag(main.mag)}`);
  setText('#main-when', `${fmtTime(main.t)} · ${main.place}`);
  setText('#n-after', fmtInt(seq.length));
  setText('#n-after-sub', `en ${s.span < 48 ? `${Math.round(s.span)} horas` : `${(s.span / 24).toFixed(1)} días`} · M2.5 o más`);
  setText('#big-mag', s.big ? `M${fmtMag(s.big.mag)}` : '—');
  setText('#big-sub', s.big ? `${fmtTime(s.big.t)} · ${s.big.place}` : '');
  setText('#m4-rate', fmtRate(s.m4Last12));
  setText('#m4-sub', `M4+ por hora en las últimas 12 h (${fmtRate(s.m4First12)} en las primeras 12 h)`);
  setText('#last-ago', s.latest ? ago(s.latest.t, now) : '—');
  setText('#last-sub', s.latest ? `M${fmtMag(s.latest.mag)} · ${s.latest.place}` : '');

  const take = [];
  take.push(`Se han registrado ${fmtInt(seq.length)} réplicas desde el sismo principal del ${fmtTime(main.t)}`.replace(/\.?$/, '.'));
  if (s.span >= 24) {
    take.push(`Las fuertes (M4 o más) bajaron de ${fmtRate(s.m4First12)} a ${fmtRate(s.m4Last12)} por hora entre las primeras 12 horas y las últimas 12; el total, de ${fmtRate(s.rateFirst12)} a ${fmtRate(s.rateLast12)} por hora.`);
  }
  if (s.latest) take.push(`La más reciente: M${fmtMag(s.latest.mag)}, ${s.latest.place}, ${ago(s.latest.t, now)}.`);
  setText('#takeaway', take.join(' '));

  // reference point
  const rows = [main, ...seq].map((ev) => ({ ev, km: epicentralKm(ev.lat, ev.lon, ref.lat, ref.lon), mmi: estimateMmi(ev, ref.lat, ref.lon, ref.siteAdjust) }));
  const day = rows.filter((r) => r.ev !== main && now - r.ev.t < 24 * H);
  const top = day.length ? day.reduce((a, b) => (b.mmi > a.mmi ? b : a)) : null;
  const mainRow = rows[0];
  setText('#ref-name', ref.name);
  setText('#ref-main', `${describeMmi(mainRow.mmi)} a ${Math.round(mainRow.km)} km del epicentro`);
  setText('#ref-day', top ? `${describeMmi(top.mmi)} · M${fmtMag(top.ev.mag)}, ${ago(top.ev.t, now)}` : 'ninguna réplica en las últimas 24 h');
  const felt = rows.filter((r) => r.ev !== main && r.mmi >= 2.5).length;
  setText('#ref-felt', `${fmtInt(felt)} de ${fmtInt(seq.length)} réplicas probablemente se sintieron dentro de casa en ${ref.name}.`);
  const badge = $('#ref-badge');
  badge.textContent = ROMAN[mmiLevel(mainRow.mmi)];
  badge.style.background = MMI_COLORS[mmiLevel(mainRow.mmi)];

  // charts
  const opts = { seq, main, dayIndex: d.dayIndex, windows: s.windows, bands: s.bands, rows, ref };
  for (const [sel, fn] of [['#chart-timeline', drawTimeline], ['#chart-windows', drawWindows], ['#chart-bands', drawBands], ['#chart-intensity', drawIntensity]]) {
    const node = $(sel);
    node.classList.remove('skeleton');
    fn(node, opts);
  }
  map.setData({ main, seq, others: d.others, dayIndex: d.dayIndex, days: d.days, ref, now: Math.max(now, (s.latest || main).t.getTime()) });
  renderTable(rows);
}

// ------------------------------------------------------------------ table

const COLS = [
  { key: 't', label: 'Hora (Panamá)', val: (r) => r.ev.t.getTime(), text: (r) => fmtTime(r.ev.t) },
  { key: 'mag', label: 'Mag.', num: true, val: (r) => r.ev.mag, text: (r) => fmtMag(r.ev.mag) },
  { key: 'type', label: 'Tipo', hide: true, val: (r) => r.ev.magType, text: (r) => r.ev.magType },
  { key: 'agency', label: 'Agencia', hide: true, val: (r) => r.ev.agency, text: (r) => r.ev.agency },
  { key: 'depth', label: 'Prof. (km)', num: true, hide: true, val: (r) => r.ev.depth, text: (r) => String(r.ev.depth) },
  { key: 'place', label: 'Lugar', val: (r) => r.ev.place, text: (r) => r.ev.place },
  { key: 'km', label: 'Distancia (km)', num: true, hide: true, val: (r) => r.km, text: (r) => String(Math.round(r.km)) },
  { key: 'mmi', label: 'Intensidad est.', val: (r) => r.mmi, text: (r) => describeMmi(r.mmi) },
];

function renderTable(rows) {
  const table = $('#events');
  const head = table.querySelector('thead tr');
  if (!head.children.length) {
    for (const c of COLS) {
      const th = document.createElement('th');
      if (c.num) th.classList.add('n');
      if (c.hide) th.classList.add('hide-s');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.addEventListener('click', () => {
        state.sort = state.sort.key === c.key ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: c.num || c.key === 't' ? -1 : 1 };
        scheduleRender();
      });
      th.append(b);
      head.append(th);
    }
  }
  [...head.children].forEach((th, i) => th.setAttribute('aria-sort', COLS[i].key === state.sort.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'));
  const col = COLS.find((c) => c.key === state.sort.key);
  const q = state.search.trim().toLowerCase();
  const shown = rows
    .filter((r) => !q || COLS.map((c) => c.text(r)).join(' ').toLowerCase().includes(q))
    .sort((a, b) => { const x = col.val(a), y = col.val(b); return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir; });
  const body = table.querySelector('tbody');
  body.replaceChildren(...shown.map((r) => {
    const tr = document.createElement('tr');
    if (r.ev === rows[0].ev) tr.className = 'main';
    for (const c of COLS) {
      const td = document.createElement('td');
      if (c.num) td.classList.add('n');
      if (c.hide) td.classList.add('hide-s');
      if (c.key === 'mmi') {
        const sw = document.createElement('i');
        sw.className = 'sw';
        sw.style.background = MMI_COLORS[mmiLevel(r.mmi)];
        td.append(sw);
      }
      td.append(document.createTextNode(c.text(r)));
      tr.append(td);
    }
    return tr;
  }));
  setText('#events-count', `${fmtInt(shown.length)} de ${fmtInt(rows.length)} sismos`);
}

// ------------------------------------------------------------------ data

function toast(ev) {
  const box = $('#toast');
  box.textContent = `Nuevo sismo: M${fmtMag(ev.mag)} · ${ev.place} · ${fmtTime(ev.t)}`;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 12000);
}

async function load() {
  try {
    const evs = await fetchSince(SEQUENCE.start, SEQUENCE.region, SEQUENCE.minMag);
    evs.forEach(upsert);
    state.loaded = true;
    state.error = null;
    state.lastSync = new Date();
  } catch (e) {
    state.error = e;
    setTimeout(load, 30000);
  }
  scheduleRender();
}

async function poll() {
  if (!state.loaded) return;
  const since = new Date(state.lastSync.getTime() - 5 * 60e3);
  try {
    const evs = await fetchUpdated(since, SEQUENCE.start, SEQUENCE.region, SEQUENCE.minMag);
    evs.forEach(upsert);
    state.lastSync = new Date();
    scheduleRender();
  } catch { /* keep the last data; the status pill already says we're not live */ }
}

function startLive() {
  const feed = new LiveFeed({
    onStatus: (s) => { state.live = s; scheduleRender(); },
    onEvent: (ev) => {
      if (ev.t < new Date(SEQUENCE.start) || !inBox(ev, SEQUENCE.region) || ev.mag < SEQUENCE.minMag) return;
      const isNew = upsert(ev);
      state.lastSync = new Date();
      if (isNew && state.loaded) {
        toast(ev);
        map.flash(ev);
      }
      scheduleRender();
    },
  });
  feed.start();
  return feed;
}

// ------------------------------------------------------------------ controls

function setupReference() {
  const sel = $('#ref-select');
  for (const r of REFERENCES) sel.append(new Option(r.name, r.id));
  sel.append(new Option('Mi ubicación', 'me'));
  sel.addEventListener('change', () => {
    if (sel.value !== 'me') {
      state.ref = { ...REFERENCES.find((r) => r.id === sel.value) };
      scheduleRender();
      return;
    }
    if (!navigator.geolocation) { sel.value = state.ref.id; return; }
    setText('#ref-note', 'Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      // Use the Panama City calibration inside the metro area; the plain model elsewhere.
      const near = epicentralKm(lat, lon, REFERENCES[0].lat, REFERENCES[0].lon) < 35;
      state.ref = { id: 'me', name: 'tu ubicación', lat, lon, siteAdjust: near ? REFERENCES[0].siteAdjust : 0 };
      setText('#ref-note', 'Tu ubicación se usa solo en este navegador; no se envía a ningún servidor.');
      scheduleRender();
    }, () => {
      sel.value = state.ref.id;
      setText('#ref-note', 'No se pudo leer tu ubicación.');
    }, { maximumAge: 600000, timeout: 15000 });
  });
}

function setupTable() {
  $('#events-search').addEventListener('input', (e) => { state.search = e.target.value; scheduleRender(); });
}

// Redraw on width changes only (height changes come from our own redraws).
let resizeTimer, lastWidth = 0;
new ResizeObserver(() => {
  const w = document.body.clientWidth;
  if (w === lastWidth) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(scheduleRender, 150);
}).observe(document.body);
setInterval(scheduleRender, 60000); // keeps "hace N min" and the live time current

map.init();
setupReference();
setupTable();
renderStatus();
load();
startLive();
setInterval(poll, EMSC.pollSeconds * 1000);
