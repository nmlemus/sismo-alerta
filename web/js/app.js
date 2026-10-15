// Page logic: loads the catalog, keeps it live, derives the sequence and redraws.

import { ALARM, EMSC, IGC_FEED, PLACES, REFERENCES, SEQUENCE, TELEGRAM } from './config.js';
import { Alarm } from './alarm.js';
import { LiveFeed, emscLink, fetchEvent, fetchSince, fetchUpdated } from './emsc.js';
import { MMI_COLORS, ROMAN, describeMmi, epicentralKm, estimateMmi, mmiLevel, placeName } from './intensity.js';
import { ago, duration, wall, fmtClock, fmtDay, fmtInt, fmtMag, fmtPct, fmtRate, fmtTime } from './format.js';
import { dayLegend, drawDepth, drawRate, drawBands, drawCumulative, drawDyfi, drawIntensity, drawTimeline, drawWindows, mmiLegend } from './charts.js';
import { QuakeMap } from './map.js';
import { buildCsv } from './csv.js';
import { rateSeries } from './stats.js';
import { fetchIgcFeed, igcChannel, igcOn, igcOnly, sameQuake } from './igc.js';
import { playWave, renderHero, shareUrl } from './hero.js';
import { Propagation } from './propagation.js';
import { analyticsOn, track } from './analytics.js';
import { fetchUsgs } from './usgs.js';
import { dayPalette, onThemeChange, setTheme, themeMode } from './theme.js';
import { applyStatic, lang, localName, setLang, t, tOr } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const alarm = new Alarm(ALARM);
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
  excluded: new Map(), // id -> { es, en }: false events (data/excluded.json)
  igc: new Map(), // id -> event straight from IGC (feed of the IGC monitor)
  // Filters (also in the address: ?periodo=24h&mag=4). Period 'pre' shows the week before.
  area: 'zona', // zona | region | vista: which earthquakes count as the sequence
  areaBox: null, // for 'vista': the map view when it was chosen
  period: 'todo', // pre | todo | hoy | 24h | 6h
  minMag: 0, // 0 = all
  showPre: false,
  depthAxis: 'we', // depth section: west→east or south→north
  igcStatus: null, // the monitor's sources (recent.json)
  usgsAt: null,
  heroId: null, // latest earthquake shown in the hero
  heroNew: null, // id of a quake that arrived live while the page was open
};

const PERIODS = ['pre', 'todo', 'hoy', '24h', '6h'];

/** The area whose earthquakes are shown and counted. The mainshock is always found in SEQUENCE.zone. */
function areaBox() {
  if (state.area === 'region') return SEQUENCE.region;
  if (state.area === 'vista' && state.areaBox) return state.areaBox;
  return SEQUENCE.zone;
}
const MAGS = [0, 3, 4, 5];

/** Start of the period filter in ms; for the windows, also the start of the time axis. */
function periodStart(main, now) {
  switch (state.period) {
    case 'pre': return main.t.getTime() - SEQUENCE.preDays * 24 * H;
    case 'hoy': { const w = wall(new Date(now)); return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) + 5 * H; }
    case '24h': return now - 24 * H;
    case '6h': return now - 6 * H;
    default: return main.t.getTime();
  }
}

const inBox = (e, b) => e.lat >= b.minLat && e.lat <= b.maxLat && e.lon >= b.minLon && e.lon <= b.maxLon;

/** Adds or updates an event. Returns whether it just became confirmed (new to the counts). */
function upsert(ev) {
  if (state.excluded.has(ev.id)) return false;
  ev.place = placeName(ev.lat, ev.lon, PLACES, ev.region.toUpperCase() === 'COSTA RICA' ? 'Costa Rica' : '');
  const prev = state.events.get(ev.id);
  // A live update only has the preferred solution: keep what we knew about the others.
  if (ev.confirmed == null && prev && prev.origins) { ev.origins = prev.origins; ev.confirmed = prev.confirmed; }
  state.events.set(ev.id, ev);
  return ev.confirmed === true && !(prev && prev.confirmed === true);
}

/** Toast + pulse for an event that just entered the counts, if it is recent. */
function announce(ev) {
  if (!state.loaded || Date.now() - ev.t > 30 * 60e3 || !inBox(ev, SEQUENCE.region)) return;
  // already announced when it came straight from IGC, minutes before EMSC had it
  if (ev.source !== 'igc' && [...state.igc.values()].some((q) => sameQuake(q, ev))) return;
  toast(ev);
  map.flash(ev);
  state.heroNew = ev.id;
  if (alarm.ring(ev, { title: t('alarm.notify', fmtMag(ev.mag)), body: `${ev.place} · ${fmtTime(ev.t)}` })) track('alarm_rang', { mag: ev.mag });
}

/** Live events that aren't the national network's: fetch all solutions to decide. */
async function resolve(id, tries = 0) {
  try {
    const [ev] = await fetchEvent(id);
    if (ev && upsert(ev)) announce(ev);
    scheduleRender();
  } catch {
    if (tries < 3) setTimeout(() => resolve(id, tries + 1), 30000);
  }
}

/** Mainshock, aftershocks in the zone, everything else in the region, and the week before. */
function derive() {
  const start = new Date(SEQUENCE.start).getTime();
  const emsc = [...state.events.values()];
  // IGC published it too: the national network confirms what EMSC only has from one agency.
  const igcAll = [...state.igc.values()];
  for (const e of emsc) if (e.confirmed !== true && igcAll.some((q) => sameQuake(q, e))) e.confirmed = true;
  // IGC's own events, until EMSC publishes the same quake (then EMSC's, with all its solutions).
  const igc = igcOnly([...state.igc.values()].filter((e) => !state.excluded.has(e.id)), emsc);
  const loaded = [...emsc, ...igc].filter((e) => e.t >= LOAD_START && inBox(e, SEQUENCE.region));
  // Only confirmed events are shown as earthquakes and counted; the rest are listed apart.
  const all = loaded.filter((e) => e.confirmed === true);
  const unconfirmed = loaded.filter((e) => e.confirmed !== true).sort((a, b) => b.t - a.t);
  const zone = all.filter((e) => e.t.getTime() >= start && inBox(e, SEQUENCE.zone));
  if (!zone.length) return null;
  const main = zone.reduce((a, b) => (b.mag > a.mag ? b : a));
  const area = areaBox();
  const seq = all.filter((e) => e.t > main.t && inBox(e, area)).sort((a, b) => a.t - b.t);
  const others = all.filter((e) => !inBox(e, area) && e.t >= main.t && e !== main);
  const pre = all.filter((e) => e.t < main.t && e !== main).sort((a, b) => a.t - b.t);
  pre.forEach((e) => { e.inZone = inBox(e, area); });
  const days = [];
  const dayOf = new Map();
  for (const e of [main, ...seq]) {
    const d = fmtDay(e.t);
    if (!dayOf.has(d)) { dayOf.set(d, days.length); days.push(d); }
  }
  const dayIndex = (e) => dayOf.get(fmtDay(e.t)) ?? 0;
  return { main, seq, others, pre, days, dayIndex, unconfirmed: unconfirmed.filter((e) => e.t >= main.t || state.showPre) };
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
    // frequency now (last 6 h) and at the start (first 6 h), in earthquakes per hour
    rateLast6: seq.filter((e) => hrs(e) >= span - 6).length / Math.min(6, span),
    rateFirst6: seq.filter((e) => hrs(e) < 6).length / Math.min(6, span),
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
  renderSources(Date.now());
}

/** One chip per data source: green when current, amber when late, red when down. */
function renderSources(now) {
  const box = $('#sources');
  const chips = [];
  const add = (label, kind, text, title) => {
    const li = document.createElement('li');
    li.dataset.kind = kind;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    li.append(dot, `${label}: ${text}`);
    if (title) li.title = title;
    chips.push(li);
  };
  const clock = (iso) => fmtClock(new Date(iso));
  const st = state.igcStatus;
  if (igcOn() && st) {
    const stale = now - Date.parse(st.checked) > 10 * 60e3;
    if (stale) add(t('src.igc'), 'warn', t('src.stale', clock(st.checked)));
    else if (st.igc?.down_since) add(t('src.igc'), 'bad', t('src.down', clock(st.igc.down_since)), st.igc.reason || '');
    else add(t('src.igc'), 'ok', t('src.ok'), st.igc?.last_ok ? t('src.title', clock(st.igc.last_ok)) : '');
    if (st.x?.on) {
      const late = !st.x.last_ok || now - Date.parse(st.x.last_ok) > 5 * 60e3;
      if (stale) add(t('src.x'), 'warn', t('src.stale', clock(st.checked)));
      else add(t('src.x'), late ? 'bad' : 'ok', late ? t('src.down', st.x.last_ok ? clock(st.x.last_ok) : '—') : t('src.ok'),
        st.x.last_ok ? t('src.title', clock(st.x.last_ok)) : '');
    }
  }
  if (state.error && !state.loaded) add(t('src.emsc'), 'bad', t('src.offline'));
  else if (state.live === 'open') add(t('src.emsc'), 'ok', t('src.live'), state.lastSync ? t('src.title', fmtClock(state.lastSync)) : '');
  else add(t('src.emsc'), state.loaded ? 'warn' : 'warn', state.loaded ? t('src.poll') : t('src.loading'));
  if (state.usgs) add(t('src.usgs'), 'ok', t('src.ok'), state.usgsAt ? t('src.title', fmtClock(state.usgsAt)) : '');
  else add(t('src.usgs'), state.usgsError ? 'bad' : 'warn', state.usgsError ? t('src.offline') : t('src.loading'));
  box.replaceChildren(...chips);
}

/** The hero: latest aftershock in the chosen area (the one the headline talks about),
 * whatever the period and magnitude filters. */
function renderLatest(d, now) {
  const ev = d.seq.length ? d.seq[d.seq.length - 1] : d.main;
  const ref = state.ref;
  const km = epicentralKm(ev.lat, ev.lon, ref.lat, ref.lon);
  const mmi = estimateMmi(ev, ref.lat, ref.lon, ref.siteAdjust);
  const level = mmiLevel(mmi);
  const how = ev.source === 'igc' ? igcChannel(ev) : null;
  const refs = REFERENCES.map((r) => ({ name: localName(r), lat: r.lat, lon: r.lon }));
  const you = ref.id === 'me' ? { name: t('hero.you'), lat: ref.lat, lon: ref.lon, you: true } : null;
  if (you) refs.push(you);
  renderHero({
    box: $('#hero'), mag: $('#hero-mag'), ago: $('#hero-ago'), place: $('#hero-place'), time: $('#hero-time'),
    depth: $('#hero-depth'), energy: $('#hero-energy'), src: $('#hero-src'), mmi: $('#hero-mmi'), felt: $('#hero-felt'),
    locate: $('#hero-locate'), wa: $('#hero-wa'), arrivals: $('#hero-arrivals'),
  }, {
    ev, ago: ago(ev.t, now), time: fmtTime(ev.t), place: ev.place, refs, you,
    felt: { roman: ROMAN[level], color: MMI_COLORS[level], text: t('hero.felt', describeMmi(mmi), ref.name, Math.round(km)) },
    sourceText: t('hero.srcVal', ev.agency || 'EMSC', how ? t('hero.how')[how] : ''),
    shareText: t('hero.shareText', fmtMag(ev.mag), ev.place, fmtTime(ev.t), t('hero.shareFelt', describeMmi(mmi), ref.name), shareUrl()),
  });
  state.heroEv = ev;
  const fresh = state.heroNew === ev.id && now - ev.t < 30 * 60e3;
  $('#hero-new').hidden = !fresh;
  if (ev.id !== state.heroId) {
    const first = state.heroId == null;
    state.heroId = ev.id;
    playWave($('#hero-arrivals'));
    map.setLatest(ev);
    if (!first && fresh) {
      const box = $('#hero');
      box.classList.remove('arrived');
      void box.offsetWidth;
      box.classList.add('arrived');
    }
  } else if (you && state.heroYou !== `${you.lat},${you.lon}`) {
    playWave($('#hero-arrivals')); // the visitor's own row just appeared
  }
  state.heroYou = you ? `${you.lat},${you.lon}` : null;
}

function chart(sel, fn, opts) {
  const node = $(sel);
  node.classList.remove('skeleton');
  fn(node, opts);
}

function render() {
  renderStatus();
  renderExcluded();
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
  setText('#freq', fmtRate(s.rateLast6));
  setText('#freq-sub', t('freq.sub', fmtRate(s.rateFirst6)));
  setText('#m4-rate', fmtRate(s.m4Last12));
  setText('#m4-sub', t('m4.sub', fmtRate(s.m4First12)));
  renderLatest(d, now);

  const take = [t('take.count', fmtInt(seq.length), fmtTime(main.t)).replace(/\.\.$/, '.')];
  if (s.span >= 24) take.push(t('take.rate', fmtRate(s.m4First12), fmtRate(s.m4Last12), fmtRate(s.rateFirst12), fmtRate(s.rateLast12)));
  if (s.latest) take.push(t('take.latest', fmtMag(s.latest.mag), s.latest.place, ago(s.latest.t, now)));
  setText('#takeaway', take.join(' '));

  // reference point: reported (DYFI) when the town has reports, estimated always
  const rows = [main, ...seq].map((ev) => ({ ev, km: epicentralKm(ev.lat, ev.lon, ref.lat, ref.lon), mmi: estimateMmi(ev, ref.lat, ref.lon, ref.siteAdjust) }));
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
  // What the filters let through: map, timeline, intensity chart, table and CSV.
  const fromT = periodStart(main, now);
  const pass = (e) => e.t.getTime() >= fromT && e.mag >= state.minMag;
  const mainIn = main.t.getTime() >= fromT;
  const seqV = seq.filter(pass);
  const preV = state.showPre ? d.pre.filter(pass) : [];
  const rowsV = rows.filter((r) => (r.ev === main ? mainIn : pass(r.ev)));
  state.rows = rowsV;
  const windowed = ['hoy', '24h', '6h'].includes(state.period);
  const view = { ...opts, seq: seqV, pre: preV, rows: rowsV, mainIn, big: s.big, from: windowed ? new Date(fromT) : null };
  chart('#chart-timeline', drawTimeline, view);
  const depthNode = $('#chart-depth');
  depthNode.classList.remove('skeleton');
  const dep = drawDepth(depthNode, { ...view, axis: state.depthAxis, places: PLACES, box: areaBox() });
  setText('#depth-fixed', [dep.fixed ? t('depth.fixed', fmtInt(dep.fixed), fmtInt(dep.total)) : '',
    dep.clipped ? t('depth.clipped', fmtInt(dep.clipped), dep.maxDepth) : ''].filter(Boolean).join(' '));
  dayLegend($('#legend-timeline'), opts);
  const filtered = state.period !== 'todo' || state.minMag > 0;
  setText('#area-note', state.area === 'zona' ? '' : t('f.areaNote', t('f.areaDesc')[state.area]));
  setText('#view-note', filtered
    ? t('f.showing', t('f.desc')[state.period], state.minMag ? `M${state.minMag}+` : '', fmtInt(rowsV.length + preV.length))
    : '');
  const preZone = d.pre.filter((e) => e.inZone);
  setText('#pre-note', state.showPre
    ? t('pre.note', SEQUENCE.preDays, fmtInt(d.pre.length), fmtInt(preZone.length), preZone.length ? duration(main.t - preZone[preZone.length - 1].t) : '', state.area === 'zona')
    : '');
  const stepH = Math.max(1, Math.ceil((now - main.t) / H / 300)); // at most ~300 points
  const series = rateSeries(seq, { start: main.t.getTime(), end: now, windowH: 6, stepH, mmiOf: (e) => estimateMmi(e, ref.lat, ref.lon, ref.siteAdjust) });
  chart('#chart-rate', drawRate, { series, ref, main, now, windowH: 6 });
  chart('#chart-windows', drawWindows, opts);
  chart('#chart-cumulative', drawCumulative, opts);
  chart('#chart-bands', drawBands, opts);
  chart('#chart-intensity', drawIntensity, view);
  mmiLegend($('#legend-intensity'), 1, Math.max(5, Math.min(10, mmiLevel(mainRow.mmi) + 1)));
  renderDyfi(main, reported);
  renderForecast();
  map.setArea(areaBox());
  map.setData({
    main, seq: seqV, others: d.others.filter(pass), pre: preV, unconfirmed: d.unconfirmed, dayIndex: d.dayIndex, days: d.days, ref, showPre: state.showPre,
    now: Math.max(now, (s.latest || main).t.getTime()), from: windowed ? fromT : null,
  });
  renderTable(rowsV, main);
  renderUnconfirmed(d.unconfirmed);
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

function renderTable(rows, main) {
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
    if (r.ev === main) tr.className = 'main';
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
        const a = Object.assign(document.createElement('a'), { textContent: r.ev.source === 'igc' ? 'IGC ↗' : 'EMSC ↗', target: '_blank', rel: 'noopener', href: emscLink(r.ev) });
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
  track('csv_download', { rows: state.rows.length });
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

/** The whole catalog again. Replacing (not merging) drops events EMSC has since deleted
 * or reclassified; events that arrived live after the newest one in the catalog are kept. */
async function load() {
  try {
    const evs = await fetchSince(LOAD_START, SEQUENCE.region, SEQUENCE.minMag);
    const newest = evs.reduce((a, e) => Math.max(a, e.t.getTime()), 0);
    const live = [...state.events.values()].filter((e) => e.t.getTime() > newest);
    state.events = new Map();
    [...evs, ...live].forEach(upsert);
    state.loaded = true;
    state.error = null;
    state.lastSync = new Date();
  } catch (e) {
    state.error = e;
    setTimeout(load, 30000);
  }
  scheduleRender();
}

/** IGC monitor feed: the week once, then the last 6 h every minute. New quakes are announced. */
async function loadIgc(file = 'latest.json') {
  if (!igcOn()) return;
  try {
    const { events: evs, status } = await fetchIgcFeed(file);
    if (status) state.igcStatus = status;
    const emsc = [...state.events.values()];
    for (const ev of evs) {
      ev.place = placeName(ev.lat, ev.lon, PLACES, '');
      const isNew = !state.igc.has(ev.id);
      state.igc.set(ev.id, ev);
      if (isNew && file !== 'latest.json' && igcOnly([ev], emsc).length) announce(ev);
    }
    state.igcOk = new Date();
    scheduleRender();
  } catch { /* the EMSC data keeps the page going */ }
}

async function loadExcluded() {
  try {
    const r = await fetch('data/excluded.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const j = await r.json();
    state.excluded = new Map((j.events || []).filter((e) => e && e.id).map((e) => [String(e.id), e]));
    for (const id of state.excluded.keys()) state.events.delete(id);
    scheduleRender();
  } catch { /* keep the last list */ }
}

function renderUnconfirmed(list) {
  const box = $('#unconfirmed-note');
  box.hidden = !list.length;
  if (!list.length) return;
  const summary = Object.assign(document.createElement('summary'), { textContent: t('unconf.summary', fmtInt(list.length)) });
  const ul = document.createElement('ul');
  for (const e of list.slice(0, 20)) {
    const li = document.createElement('li');
    const who = [...new Set((e.origins || [{ author: e.agency }]).map((o) => o.author))].join(', ');
    li.append(`${fmtTime(e.t)} · M${fmtMag(e.mag)} · ${e.place} · ${e.confirmed == null ? t('unconf.pending') : t('unconf.only', who)} `);
    li.append(Object.assign(document.createElement('a'), { textContent: 'EMSC ↗', href: emscLink(e), target: '_blank', rel: 'noopener' }));
    ul.append(li);
  }
  box.replaceChildren(summary, Object.assign(document.createElement('p'), { textContent: t('unconf.why') }), ul);
}

function renderExcluded() {
  const box = $('#excluded-note');
  const items = [...state.excluded.entries()];
  box.hidden = !items.length;
  if (!items.length) return;
  const list = document.createElement('ul');
  for (const [id, e] of items) {
    const li = document.createElement('li');
    li.append(`${e[lang()] || e.es || id} `);
    li.append(Object.assign(document.createElement('a'), { textContent: 'EMSC ↗', href: emscLink({ id }), target: '_blank', rel: 'noopener' }));
    list.append(li);
  }
  box.replaceChildren(Object.assign(document.createElement('b'), { textContent: t('excluded.title') }), list);
}

async function loadUsgs() {
  try {
    state.usgs = await fetchUsgs(SEQUENCE.usgsEventId);
    state.usgsAt = new Date();
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
    for (const ev of evs) if (upsert(ev)) announce(ev);
    state.lastSync = new Date();
    scheduleRender();
  } catch { /* keep the last data; the status pill already says we're not live */ }
}

function startLive() {
  const feed = new LiveFeed({
    onStatus: (s) => { state.live = s; scheduleRender(); },
    onRemove: (id) => { if (state.events.delete(id)) scheduleRender(); },
    onEvent: (ev) => {
      if (state.excluded.has(ev.id)) return;
      if (ev.t < LOAD_START || !inBox(ev, SEQUENCE.region) || ev.mag < SEQUENCE.minMag) return;
      if (upsert(ev)) announce(ev);
      if (state.events.get(ev.id)?.confirmed == null) resolve(ev.id);
      state.lastSync = new Date();
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
    track('reference', { value: sel.value });
    if (sel.value !== 'me') {
      state.ref = localRef(REFERENCES.find((r) => r.id === sel.value));
      scheduleRender();
      return;
    }
    locateMe();
  });
}

/** Asks for the visitor's location and makes it the reference point (map, hero, charts, table). */
function locateMe() {
  const sel = $('#ref-select');
  if (!navigator.geolocation) { sel.value = state.ref.id; setText('#ref-note', t('ref.locFail')); return; }
  sel.value = 'me';
  setText('#ref-note', t('ref.locating'));
  const btn = $('#hero-locate');
  btn.disabled = true;
  const label = btn.querySelector('span');
  label.textContent = t('hero.locating');
  const done = () => { btn.disabled = false; label.textContent = t('hero.locate'); };
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    // Use the Panama City calibration inside the metro area; the plain model elsewhere.
    const near = epicentralKm(lat, lon, REFERENCES[0].lat, REFERENCES[0].lon) < 35;
    state.ref = { id: 'me', name: t('ref.meName'), lat, lon, siteAdjust: near ? REFERENCES[0].siteAdjust : 0 };
    setText('#ref-note', t('ref.private'));
    done();
    scheduleRender();
  }, () => {
    sel.value = state.ref.id;
    setText('#ref-note', t('ref.locFail'));
    done();
    $('#hero-felt').textContent = t('ref.locFail');
  }, { maximumAge: 600000, timeout: 15000 });
}

function setupAlarm() {
  const btn = $('#alarm');
  const sync = () => {
    btn.setAttribute('aria-pressed', String(alarm.on));
    const label = btn.querySelector('span');
    label.dataset.i18n = alarm.on ? 'alarm.on' : 'alarm.off';
    label.textContent = t(label.dataset.i18n);
  };
  btn.addEventListener('click', async () => { await alarm.toggle(); track('alarm', { on: alarm.on }); sync(); });
  sync();
}

function setupTheme() {
  const btns = [...document.querySelectorAll('[data-theme-btn]')];
  const sync = () => {
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeBtn === themeMode())));
    // the browser bar follows the page
    const dark = themeMode() === 'dark' || (themeMode() === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelectorAll('meta[name=theme-color]').forEach((m) => { m.content = dark ? '#0d0d0d' : '#f9f9f7'; m.removeAttribute('media'); });
  };
  btns.forEach((b) => b.addEventListener('click', () => { setTheme(b.dataset.themeBtn); track('theme', { value: b.dataset.themeBtn }); sync(); }));
  onThemeChange(sync);
  sync();
}

/** The towns a simulated wave marks as it reaches them (and the visitor, if located). */
function waveTowns() {
  const list = REFERENCES.map((r) => ({ name: localName(r), lat: r.lat, lon: r.lon, siteAdjust: r.siteAdjust }));
  const ref = state.ref;
  if (ref.id === 'me') list.push({ name: t('hero.you'), lat: ref.lat, lon: ref.lon, siteAdjust: ref.siteAdjust, you: true });
  return list;
}

let waves = null;
function startWave(ev) {
  if (!ev || !waves) return;
  map.stop();
  track('propagation', { mag: ev.mag });
  const card = $('#map-card');
  const r = card.getBoundingClientRect();
  if (r.top < 0 || r.top > innerHeight * 0.5) card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  waves.play(ev);
}

function setupWaves() {
  waves = new Propagation(map.map, {
    box: $('#wave-panel'), title: $('#wave-title'), clock: $('#wave-clock'), legend: $('#wave-legend'),
    replay: $('#wave-replay'), close: $('#wave-close'), speedBtns: [...document.querySelectorAll('[data-speed]')],
  }, waveTowns);
  map.onPropagate = startWave;
  $('#hero-wave').addEventListener('click', () => startWave(state.heroEv));
}

function setupHero() {
  $('#hero-locate').addEventListener('click', () => { track('locate', { from: 'hero' }); locateMe(); });
  $('#hero-map').addEventListener('click', () => {
    if (!state.heroEv) return;
    track('hero_map', {});
    $('#map-card').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    map.focus(state.heroEv);
  });
  $('#hero-wa').addEventListener('click', () => track('share', { method: 'whatsapp' }));
  const share = $('#hero-share');
  share.hidden = !navigator.share;
  share.addEventListener('click', async () => {
    track('share', { method: 'native' });
    try { await navigator.share({ title: document.title, text: decodeURIComponent($('#hero-wa').href.split('?text=')[1] || ''), url: shareUrl() }); } catch { /* cancelled */ }
  });
  const tg = $('#tg-cta');
  const channel = (TELEGRAM.channel || '').replace(/^@/, '').trim();
  tg.hidden = !channel;
  if (channel) {
    tg.href = `https://t.me/${encodeURIComponent(channel)}`;
    tg.addEventListener('click', () => track('telegram_cta', {}));
  }
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
  track('language', { value: l });
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

function setupFilters() {
  try {
    const q = new URLSearchParams(location.search);
    if (PERIODS.includes(q.get('periodo'))) state.period = q.get('periodo');
    if (MAGS.includes(Number(q.get('mag')))) state.minMag = Number(q.get('mag'));
    const a = q.get('area');
    if (a === 'region') state.area = 'region';
    const box = /^(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec(a || '');
    if (box) {
      const [minLat, minLon, maxLat, maxLon] = box.slice(1).map(Number);
      if (minLat < maxLat && minLon < maxLon) { state.area = 'vista'; state.areaBox = { minLat, minLon, maxLat, maxLon }; }
    }
  } catch { /* no query string */ }
  const sync = () => {
    state.showPre = state.period === 'pre';
    document.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
    document.querySelectorAll('[data-mag]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.mag) === state.minMag)));
    document.querySelectorAll('[data-area]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.area === state.area)));
    try {
      const u = new URL(location.href);
      if (state.period === 'todo') u.searchParams.delete('periodo'); else u.searchParams.set('periodo', state.period);
      if (state.minMag) u.searchParams.set('mag', String(state.minMag)); else u.searchParams.delete('mag');
      const ab = state.areaBox;
      if (state.area === 'zona') u.searchParams.delete('area');
      else u.searchParams.set('area', state.area === 'region' ? 'region' : [ab.minLat, ab.minLon, ab.maxLat, ab.maxLon].join(','));
      history.replaceState(history.state, '', u);
    } catch { /* not allowed here */ }
  };
  document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { state.period = b.dataset.period; sync(); scheduleRender(); track('filter', { kind: 'period', value: state.period }); }));
  document.querySelectorAll('[data-mag]').forEach((b) => b.addEventListener('click', () => { state.minMag = Number(b.dataset.mag); sync(); scheduleRender(); track('filter', { kind: 'magnitude', value: String(state.minMag) }); }));
  document.querySelectorAll('[data-area]').forEach((b) => b.addEventListener('click', () => {
    state.area = b.dataset.area;
    // "Map view" takes what the map shows right now; pressing it again after moving the map updates it.
    if (state.area === 'vista') state.areaBox = map.visibleBox(SEQUENCE.region);
    map.setArea(areaBox(), state.area !== 'vista');
    sync();
    scheduleRender();
    track('filter', { kind: 'area', value: state.area });
  }));
  sync();
}

function setupDepth() {
  document.querySelectorAll('[data-depth-axis]').forEach((b) => b.addEventListener('click', () => {
    state.depthAxis = b.dataset.depthAxis;
    document.querySelectorAll('[data-depth-axis]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    track('depth_axis', { value: state.depthAxis });
    scheduleRender();
  }));
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
document.querySelector('#analytics-note').hidden = !analyticsOn;
map.init();
map.relabel();
setupWaves();
setupLanguage();
setupReference();
setupHero();
setupTheme();
setupAlarm();
setupDepth();
setupFilters();
setupTable();
renderStatus();
loadExcluded().finally(load);
loadUsgs();
startLive();
setInterval(poll, EMSC.pollSeconds * 1000);
setInterval(load, 30 * 60e3); // full catalog: drops events EMSC deleted or reclassified
setInterval(loadExcluded, 5 * 60e3);
loadIgc();
setInterval(() => loadIgc('recent.json'), IGC_FEED.pollSeconds * 1000);
setInterval(loadUsgs, 30 * 60e3); // DYFI and the forecast change slowly
