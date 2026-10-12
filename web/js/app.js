// Page logic: loads the catalog, keeps it live, derives the sequence and redraws.

import { EMSC, PLACES, REFERENCES, SEQUENCE } from './config.js';
import { LiveFeed, emscLink, fetchSince, fetchUpdated } from './emsc.js';
import { MMI_COLORS, ROMAN, describeMmi, epicentralKm, estimateMmi, mmiLevel, placeName } from './intensity.js';
import { ago, duration, fmtClock, fmtDay, fmtInt, fmtMag, fmtPct, fmtRate, fmtTime } from './format.js';
import { dayLegend, drawBands, drawCumulative, drawDyfi, drawIntensity, drawTimeline, drawWindows, mmiLegend } from './charts.js';
import { QuakeMap } from './map.js';
import { buildCsv } from './csv.js';
import { fetchUsgs } from './usgs.js';
import { dayPalette, onThemeChange } from './theme.js';
import { applyStatic, lang, localName, setLang, t, tOr } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const H = 3600e3;
// Load the week before too, so it can be shown on demand.
const LOAD_START = new Date(Date.parse(SEQUENCE.start) - SEQUENCE.preDays * 24 * H);

const state = {
  events: new Map(), // id -> event
  loaded: false,
  error: null,
  live: 'connecting', // connecting | open | closed
  lastSync: null,
  ref: { ...REFERENCES[0] }, // .name is set in the page's language by localRef()
  sort: { key: 't', dir: -1 },
  search: '',
  usgs: null, // { dyfi, dyfiCount, forecast, url } once loaded
  usgsError: false,
  rows: [],
  showPre: false,
};

const inBox = (e, b) => e.lat >= b.minLat && e.lat <= b.maxLat && e.lon >= b.minLon && e.lon <= b.maxLon;

function upsert(ev) {
  ev.place = placeName(ev.lat, ev.lon, PLACES, ev.region.toUpperCase() === 'COSTA RICA' ? 'Costa Rica' : '');
  const prev = state.events.get(ev.id);
  state.events.set(ev.id, ev);
  return !prev;
}

/** Mainshock, aftershocks in the zone, everything else in the region, and the week before. */
function derive() {
  const start = new Date(SEQUENCE.start).getTime();
  const all = [...state.events.values()].filter((e) => e.t >= LOAD_START && inBox(e, SEQUENCE.region));
  const zone = all.filter((e) => e.t.getTime() >= start && inBox(e, SEQUENCE.zone));
  if (!zone.length) return null;
  const main = zone.reduce((a, b) => (b.mag > a.mag ? b : a));
  const seq = zone.filter((e) => e.t > main.t).sort((a, b) => a.t - b.t);
  const others = all.filter((e) => !inBox(e, SEQUENCE.zone) && e.t >= main.t);
  const pre = all.filter((e) => e.t < main.t && e !== main).sort((a, b) => a.t - b.t);
  pre.forEach((e) => { e.inZone = inBox(e, SEQUENCE.zone); });
  const days = [];
  const dayOf = new Map();
  for (const e of [main, ...seq]) {
    const d = fmtDay(e.t);
    if (!dayOf.has(d)) { dayOf.set(d, days.length); days.push(d); }
  }
  const dayIndex = (e) => dayOf.get(fmtDay(e.t)) ?? 0;
  return { main, seq, others, pre, days, dayIndex };
}

function stats({ main, seq, pre }, now) {
  const hrs = (e) => (e.t - main.t) / H;
  const span = Math.max(1 / 60, (now - main.t) / H);
  const first12 = seq.filter((e) => hrs(e) < 12);
  const last12 = seq.filter((e) => hrs(e) >= span - 12);
  const big = seq.length ? seq.reduce((a, b) => (b.mag > a.mag ? b : a)) : null;
  const windows = [];
  if (state.showPre) {
    // Same 6-hour windows for the week before, inside the aftershock zone.
    const preZone = pre.filter((e) => e.inZone);
    for (let s = -SEQUENCE.preDays * 24; s < 0; s += 6) {
      const w = preZone.filter((e) => hrs(e) >= s && hrs(e) < s + 6);
      windows.push({ label: `${s}`, start: s, count: w.length, m4: w.filter((e) => e.mag >= 4).length, maxMag: w.length ? Math.max(...w.map((e) => e.mag)) : null });
    }
  }
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
    m5: seq.filter((e) => e.mag >= 5).length,
    m6: seq.filter((e) => e.mag >= 6).length,
    rateFirst12: first12.length / Math.min(12, span),
    rateLast12: last12.length / Math.min(12, span),
    m4First12: first12.filter((e) => e.mag >= 4).length / Math.min(12, span),
    m4Last12: last12.filter((e) => e.mag >= 4).length / Math.min(12, span),
    latest: seq[seq.length - 1] || null,
  };
}

/** The DYFI town that stands for the reference point (within 8 km), if any. */
function dyfiFor(ref) {
  const rows = state.usgs?.dyfi;
  if (!rows?.length) return null;
  let best = null, bestKm = Infinity;
  for (const r of rows) {
    const d = epicentralKm(r.lat, r.lon, ref.lat, ref.lon);
    if (d < bestKm) { bestKm = d; best = r; }
  }
  return bestKm <= 8 ? best : null;
}

// ------------------------------------------------------------------ rendering

const map = new QuakeMap({
  mapEl: $('#map'), playBtn: $('#map-play'), slider: $('#map-time'), ticks: $('#map-ticks'), timeLabel: $('#map-time-label'),
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
    ? t('st.offline')
    : state.live === 'open' ? t('st.live') : state.loaded ? t('st.reconnecting') : t('st.loading');
  setText('#live-text', text);
  setText('#synced', state.lastSync ? t('st.synced', fmtClock(state.lastSync)) : '');
}

function chart(sel, fn, opts) {
  const node = $(sel);
  node.classList.remove('skeleton');
  fn(node, opts);
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

  // headline figures + takeaway
  setText('#main-mag', `M${fmtMag(main.mag)}`);
  setText('#main-when', `${fmtTime(main.t)} · ${main.place}`);
  setText('#n-after', fmtInt(seq.length));
  const span = s.span < 48 ? t('span.hours', Math.round(s.span)) : t('span.days', (s.span / 24).toFixed(1));
  setText('#n-after-sub', t('after.sub', span, fmtInt(s.m5), fmtInt(s.m6)));
  setText('#big-mag', s.big ? `M${fmtMag(s.big.mag)}` : '—');
  setText('#big-sub', s.big ? `${fmtTime(s.big.t)} · ${s.big.place}` : '');
  setText('#m4-rate', fmtRate(s.m4Last12));
  setText('#m4-sub', t('m4.sub', fmtRate(s.m4First12)));
  setText('#last-ago', s.latest ? ago(s.latest.t, now) : '—');
  setText('#last-sub', s.latest ? `M${fmtMag(s.latest.mag)} · ${s.latest.place}` : '');

  const take = [t('take.count', fmtInt(seq.length), fmtTime(main.t)).replace(/\.\.$/, '.')];
  if (s.span >= 24) take.push(t('take.rate', fmtRate(s.m4First12), fmtRate(s.m4Last12), fmtRate(s.rateFirst12), fmtRate(s.rateLast12)));
  if (s.latest) take.push(t('take.latest', fmtMag(s.latest.mag), s.latest.place, ago(s.latest.t, now)));
  setText('#takeaway', take.join(' '));

  // reference point: reported (DYFI) when the town has reports, estimated always
  const rows = [main, ...seq].map((ev) => ({ ev, km: epicentralKm(ev.lat, ev.lon, ref.lat, ref.lon), mmi: estimateMmi(ev, ref.lat, ref.lon, ref.siteAdjust) }));
  state.rows = rows;
  const mainRow = rows[0];
  const reported = dyfiFor(ref);
  setText('#ref-name', ref.name);
  setText('#ref-reported', reported
    ? t('ref.reported', ROMAN[mmiLevel(reported.cdi)], reported.cdi.toFixed(1), fmtInt(reported.n), reported.name)
    : state.usgs ? t('ref.noReports') : state.usgsError ? t('ref.usgsFail') : t('ref.usgsLoading'));
  setText('#ref-main', t('ref.mainEst', describeMmi(mainRow.mmi), Math.round(mainRow.km)));
  const day = rows.filter((r) => r.ev !== main && now - r.ev.t < 24 * H);
  const top = day.length ? day.reduce((a, b) => (b.mmi > a.mmi ? b : a)) : null;
  setText('#ref-day', top ? `${describeMmi(top.mmi)} · M${fmtMag(top.ev.mag)}, ${ago(top.ev.t, now)}` : t('ref.dayNone'));
  const felt = rows.filter((r) => r.ev !== main && r.mmi >= 2.5).length;
  setText('#ref-felt', t('ref.felt', fmtInt(felt), fmtInt(seq.length), ref.name));
  const badgeMmi = reported ? reported.cdi : mainRow.mmi;
  const badge = $('#ref-badge');
  badge.textContent = ROMAN[mmiLevel(badgeMmi)];
  badge.style.background = MMI_COLORS[mmiLevel(badgeMmi)];
  setText('#ref-badge-cap', reported ? t('badge.reported') : t('badge.estimated'));

  // charts
  const palette = dayPalette(d.days);
  const opts = {
    seq, main, now, windows: s.windows, bands: s.bands, rows, ref,
    pre: d.pre, showPre: state.showPre, preDays: SEQUENCE.preDays, dayIndex: d.dayIndex, palette,
  };
  chart('#chart-timeline', drawTimeline, opts);
  dayLegend($('#legend-timeline'), opts);
  const preZone = d.pre.filter((e) => e.inZone);
  setText('#pre-note', state.showPre
    ? t('pre.note', SEQUENCE.preDays, fmtInt(d.pre.length), fmtInt(preZone.length), preZone.length ? duration(main.t - preZone[preZone.length - 1].t) : '')
    : '');
  chart('#chart-windows', drawWindows, opts);
  chart('#chart-cumulative', drawCumulative, opts);
  chart('#chart-bands', drawBands, opts);
  chart('#chart-intensity', drawIntensity, opts);
  mmiLegend($('#legend-intensity'), 1, Math.max(5, Math.min(10, mmiLevel(mainRow.mmi) + 1)));
  renderDyfi(main, reported);
  renderForecast();
  map.setData({
    main, seq, others: d.others, pre: d.pre, dayIndex: d.dayIndex, days: d.days, ref, showPre: state.showPre,
    now: Math.max(now, (s.latest || main).t.getTime()),
  });
  renderTable(rows);
}

function renderDyfi(main, reported) {
  const node = $('#chart-dyfi');
  const dyfi = state.usgs?.dyfi;
  if (!dyfi?.length) {
    node.classList.toggle('skeleton', !state.usgsError && !state.usgs);
    node.replaceChildren();
    if (state.usgsError || state.usgs) node.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: t('dyfi.unavailable') }));
    return;
  }
  node.classList.remove('skeleton');
  drawDyfi(node, { dyfi, main, refRow: reported });
  mmiLegend($('#legend-dyfi'), 3, 8);
  const total = state.usgs.dyfiCount;
  setText('#dyfi-count', total ? t('dyfi.count', fmtInt(total), fmtInt(dyfi.length)) : '');
}

function renderForecast() {
  const box = $('#forecast');
  const f = state.usgs?.forecast;
  if (!f) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: state.usgs || state.usgsError ? t('fc.unavailable') : t('fc.loading'),
    }));
    return;
  }
  const wins = f.windows.filter((w) => ['1 Day', '1 Week', '1 Month'].includes(w.key));
  const table = document.createElement('table');
  table.className = 'fc';
  const head = table.createTHead().insertRow();
  head.append(Object.assign(document.createElement('th'), { textContent: '' }));
  for (const w of wins) head.append(Object.assign(document.createElement('th'), { textContent: tOr(`fc.${w.key}`, w.label), className: 'n' }));
  const body = table.createTBody();
  for (const mag of [5, 6, 7]) {
    const tr = body.insertRow();
    tr.append(Object.assign(document.createElement('th'), { textContent: t('fc.row', mag), scope: 'row' }));
    for (const w of wins) {
      const b = w.bins[mag];
      const td = tr.insertCell();
      td.className = 'n';
      if (!b) { td.textContent = '—'; continue; }
      const p = Object.assign(document.createElement('b'), { textContent: fmtPct(b.p) });
      const range = b.max > 0 ? t('fc.range', b.min, b.max) : t('fc.none');
      td.append(p, Object.assign(document.createElement('div'), { className: 'muted', textContent: range }));
    }
  }
  const week = f.windows.find((w) => w.key === '1 Week');
  const parts = [table];
  if (week?.aboveMain) {
    parts.push(Object.assign(document.createElement('p'), {
      textContent: t('fc.above', fmtMag(week.aboveMain.mag), fmtPct(week.aboveMain.p)),
    }));
  }
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.append(t('fc.meta', fmtTime(f.created), f.next ? fmtTime(f.next) : ''));
  const a = Object.assign(document.createElement('a'), { textContent: t('fc.link'), target: '_blank', rel: 'noopener' });
  a.href = `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(SEQUENCE.usgsEventId)}/oaf/forecast`;
  meta.append(a);
  parts.push(meta);
  box.replaceChildren(...parts);
}

// ------------------------------------------------------------------ table + CSV

const COLS = [
  { key: 't', val: (r) => r.ev.t.getTime(), text: (r) => fmtTime(r.ev.t) },
  { key: 'mag', num: true, val: (r) => r.ev.mag, text: (r) => fmtMag(r.ev.mag) },
  { key: 'type', hide: true, val: (r) => r.ev.magType, text: (r) => r.ev.magType },
  { key: 'agency', hide: true, val: (r) => r.ev.agency, text: (r) => r.ev.agency },
  { key: 'depth', num: true, hide: true, val: (r) => r.ev.depth, text: (r) => String(r.ev.depth) },
  { key: 'place', val: (r) => r.ev.place, text: (r) => r.ev.place },
  { key: 'km', num: true, hide: true, val: (r) => r.km, text: (r) => String(Math.round(r.km)) },
  { key: 'mmi', val: (r) => r.mmi, text: (r) => describeMmi(r.mmi) },
  { key: 'link', nosort: true, val: () => 0, text: () => '' },
];

function renderTable(rows) {
  const table = $('#events');
  const head = table.querySelector('thead tr');
  if (!head.children.length) {
    for (const c of COLS) {
      const th = document.createElement('th');
      if (c.num) th.classList.add('n');
      if (c.hide) th.classList.add('hide-s');
      if (c.nosort) { th.append(Object.assign(document.createElement('span'), { className: 'th', textContent: t(`col.${c.key}`) })); head.append(th); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(`col.${c.key}`);
      b.addEventListener('click', () => {
        state.sort = state.sort.key === c.key ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: c.num || c.key === 't' ? -1 : 1 };
        scheduleRender();
      });
      th.append(b);
      head.append(th);
    }
  }
  [...head.children].forEach((th, i) => { if (!COLS[i].nosort) th.setAttribute('aria-sort', COLS[i].key === state.sort.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'); });
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
      if (c.key === 'link') {
        const a = Object.assign(document.createElement('a'), { textContent: 'EMSC ↗', target: '_blank', rel: 'noopener', href: emscLink(r.ev) });
        a.setAttribute('aria-label', t('link.aria', fmtTime(r.ev.t)));
        td.append(a);
      } else {
        td.append(document.createTextNode(c.text(r)));
      }
      tr.append(td);
    }
    return tr;
  }));
  setText('#events-count', t('events.count', fmtInt(shown.length), fmtInt(rows.length)));
}

function downloadCsv() {
  if (!state.rows.length) return;
  const blob = new Blob(['\ufeff', buildCsv(state.rows, state.ref, fmtTime)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  a.download = `${t('csv.file')}_${stamp}.csv`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ------------------------------------------------------------------ data

function toast(ev) {
  const box = $('#toast');
  box.textContent = t('toast', fmtMag(ev.mag), ev.place, fmtTime(ev.t));
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 12000);
}

async function load() {
  try {
    const evs = await fetchSince(LOAD_START, SEQUENCE.region, SEQUENCE.minMag);
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

async function loadUsgs() {
  try {
    state.usgs = await fetchUsgs(SEQUENCE.usgsEventId);
    state.usgsError = false;
  } catch {
    state.usgsError = true;
  }
  scheduleRender();
}

async function poll() {
  if (!state.loaded) return;
  const since = new Date(state.lastSync.getTime() - 5 * 60e3);
  try {
    const evs = await fetchUpdated(since, LOAD_START, SEQUENCE.region, SEQUENCE.minMag);
    evs.forEach(upsert);
    state.lastSync = new Date();
    scheduleRender();
  } catch { /* keep the last data; the status pill already says we're not live */ }
}

function startLive() {
  const feed = new LiveFeed({
    onStatus: (s) => { state.live = s; scheduleRender(); },
    onEvent: (ev) => {
      if (ev.t < LOAD_START || !inBox(ev, SEQUENCE.region) || ev.mag < SEQUENCE.minMag) return;
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
  fillReferenceOptions();
  sel.addEventListener('change', () => {
    if (sel.value !== 'me') {
      state.ref = localRef(REFERENCES.find((r) => r.id === sel.value));
      scheduleRender();
      return;
    }
    if (!navigator.geolocation) { sel.value = state.ref.id; return; }
    setText('#ref-note', t('ref.locating'));
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      // Use the Panama City calibration inside the metro area; the plain model elsewhere.
      const near = epicentralKm(lat, lon, REFERENCES[0].lat, REFERENCES[0].lon) < 35;
      state.ref = { id: 'me', name: t('ref.meName'), lat, lon, siteAdjust: near ? REFERENCES[0].siteAdjust : 0 };
      setText('#ref-note', t('ref.private'));
      scheduleRender();
    }, () => {
      sel.value = state.ref.id;
      setText('#ref-note', t('ref.locFail'));
    }, { maximumAge: 600000, timeout: 15000 });
  });
}

/** A reference point with its name in the page's language. */
function localRef(r) {
  const base = REFERENCES.find((x) => x.id === r.id) || r;
  return { ...base, name: localName(base) };
}

function fillReferenceOptions() {
  const sel = $('#ref-select');
  const value = sel.value;
  sel.replaceChildren(...REFERENCES.map((r) => new Option(localName(r), r.id)), new Option(t('ref.me'), 'me'));
  if (value) sel.value = value;
}

/** Everything that holds text: fixed page text, place names in the data, map, table header. */
function switchLanguage(l) {
  if (l === lang()) return;
  setLang(l);
  applyStatic();
  for (const ev of state.events.values()) upsert(ev);
  state.ref = state.ref.id === 'me' ? { ...state.ref, name: t('ref.meName') } : localRef(state.ref);
  fillReferenceOptions();
  $('#events thead tr').replaceChildren();
  map.relabel();
  if (state.live !== 'open' || !state.loaded) renderStatus();
  scheduleRender();
}

function setupLanguage() {
  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => switchLanguage(b.dataset.lang)));
}

function setupPre() {
  $('#show-pre').addEventListener('change', (e) => { state.showPre = e.target.checked; scheduleRender(); });
}

function setupTable() {
  $('#events-search').addEventListener('input', (e) => { state.search = e.target.value; scheduleRender(); });
  $('#csv').addEventListener('click', downloadCsv);
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
onThemeChange(() => { map.restyle(); scheduleRender(); });
setInterval(scheduleRender, 60000); // keeps "hace N min" and the live time current

state.ref = localRef(state.ref);
applyStatic();
map.init();
map.relabel();
setupLanguage();
setupReference();
setupPre();
setupTable();
renderStatus();
load();
loadUsgs();
startLive();
setInterval(poll, EMSC.pollSeconds * 1000);
setInterval(loadUsgs, 30 * 60e3); // DYFI and the forecast change slowly
