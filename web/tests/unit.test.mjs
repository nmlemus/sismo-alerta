// Run with: node --test web/tests/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EMSC, PLACES } from '../js/config.js';
import { featureToEvent, fetchSince, isConfirmed, parseQuakeML } from '../js/emsc.js';
import { toQuakeML } from './quakeml.mjs';
import {
  describeMmi, epicentralKm, estimateMmi, hypocentralKm, mmiAww2014, mmiLevel, placeName,
} from '../js/intensity.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/emsc_2026-10-09.json', import.meta.url)));
const MAIN = { lat: 7.5868, lon: -80.769, depth: 12.6, mag: 7.7 }; // USGS solution, as in the other tests
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('intensity model matches the backend and app tests', () => {
  close(epicentralKm(MAIN.lat, MAIN.lon, 8.983, -79.517), 207.6, 1);
  const model = (lat, lon) => mmiAww2014(MAIN.mag, hypocentralKm(epicentralKm(MAIN.lat, MAIN.lon, lat, lon), MAIN.depth));
  close(model(7.97, -80.42), 6.5, 0.4); // Chitré, DYFI 6.5
  close(model(8.1, -80.97), 6.2, 0.4); // Santiago, DYFI 6.2
  close(model(8.983, -79.517), 4.6, 0.1); // Panama City before adjustment
  const adjusted = estimateMmi(MAIN, 8.983, -79.517, 0.6);
  close(adjusted, 5.2, 0.1); // Panama City DYFI 5.2
  assert.equal(describeMmi(adjusted), 'V (moderado)');
  assert.equal(mmiLevel(3.49), 3);
  assert.equal(mmiLevel(3.5), 4);
  assert.equal(mmiLevel(0.1), 1);
});

test('place names point from the nearest town', () => {
  assert.equal(placeName(7.5794, -80.7741, PLACES), '26 km al SE de Mariato');
  assert.equal(placeName(8.984, -79.521, PLACES), 'cerca de Ciudad de Panamá');
  assert.equal(placeName(9.68, -83.99, PLACES, 'Costa Rica'), 'Costa Rica');
});

test('EMSC features become events; non-earthquakes are dropped', () => {
  const ev = featureToEvent(fixture.features[0]);
  assert.equal(ev.id, '20261009_0000264');
  assert.equal(ev.mag, 7.7);
  assert.equal(ev.magType, 'mw');
  assert.equal(ev.agency, 'EMSC');
  assert.equal(ev.t.toISOString(), '2026-10-09T17:56:07.680Z');
  const blast = structuredClone(fixture.features[1]);
  blast.properties.evtype = 'qb';
  assert.equal(featureToEvent(blast), null);
});

test('fetchSince pages past the 300-event limit without duplicates', async () => {
  const all = fixture.features;
  let calls = 0;
  const fakeFetch = async (url) => {
    calls++;
    const q = new URL(url).searchParams;
    const start = new Date(`${q.get('start')}Z`).getTime();
    const page = all.filter((f) => new Date(f.properties.time).getTime() >= start).slice(0, Number(q.get('limit')));
    return { ok: true, status: page.length ? 200 : 204, text: async () => toQuakeML(page) };
  };
  const evs = await fetchSince('2026-10-09T17:50:00Z', { minLat: 5, maxLat: 10, minLon: -84, maxLon: -77 }, 2.5, fakeFetch);
  assert.equal(EMSC.pageSize, 300);
  assert.equal(evs.length, all.length);
  assert.equal(new Set(evs.map((e) => e.id)).size, all.length);
  assert.ok(calls >= 2 && calls <= 3, `calls=${calls}`);
});

// ---------------------------------------------------------------- USGS + CSV
import { buildCsv } from '../js/csv.js';
import { parseDyfi, parseForecast } from '../js/usgs.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('DYFI keeps only Panamanian towns, with their reports', () => {
  const rows = parseDyfi(read('usgs_cdi_zip.txt'));
  assert.equal(rows.length, 10);
  const pty = rows.find((r) => r.name === 'Panamá');
  assert.deepEqual([pty.cdi, pty.n, pty.hypoKm], [5.1, 169, 205]);
  assert.ok(!rows.some((r) => r.name === 'Atencingo' || r.name === '32405'));
});

test('USGS forecast windows and magnitude bins', () => {
  const f = parseForecast(JSON.parse(read('usgs_forecast.json')));
  assert.deepEqual(f.windows.map((w) => w.label), ['Próximo día', 'Próxima semana', 'Próximo mes', 'Próximo año']);
  const week = f.windows[1];
  assert.equal(week.bins[5].p, 0.9365);
  assert.deepEqual([week.bins[5].min, week.bins[5].max], [0, 11]);
  assert.equal(week.aboveMain.mag, 7.7);
  assert.equal(f.created.toISOString(), '2026-10-12T15:55:29.045Z');
});

test('CSV export escapes text and links each event to EMSC', () => {
  const ev = { id: '20261009_0000264', t: new Date('2026-10-09T17:56:07Z'), lat: 7.5794, lon: -80.7741, depth: 15, mag: 7.7, magType: 'mw', agency: 'EMSC', place: '26 km al SE de Mariato, "costa"' };
  const csv = buildCsv([{ ev, km: 208.4, mmi: 5.23 }], { name: 'Ciudad de Panamá' }, () => '9 oct, 12:56 p. m.');
  const [head, row] = csv.trim().split('\n');
  assert.ok(head.startsWith('id,hora_utc,hora_panama'));
  assert.ok(head.includes('intensidad_estimada_Ciudad de Panamá'));
  assert.ok(row.includes('"26 km al SE de Mariato, ""costa"""'));
  assert.ok(row.includes(',208,5.2,https://www.seismicportal.eu/eventdetails.html?unid=20261009_0000264'));
  assert.ok(row.includes('"9 oct, 12:56 p. m."'));
});

// ---------------------------------------------------------------- English
import { setLang } from '../js/i18n.js';

test('English: place names, intensity labels, forecast windows and CSV header', () => {
  setLang('en', { persist: false });
  try {
    assert.equal(placeName(7.5794, -80.7741, PLACES), '26 km SE of Mariato');
    assert.equal(placeName(8.984, -79.521, PLACES), 'near Panama City');
    assert.equal(placeName(7.3, -81.9, PLACES), '22 km SW of Coiba Island');
    assert.equal(describeMmi(5.2), 'V (moderate)');
    const f = parseForecast(JSON.parse(read('usgs_forecast.json')));
    assert.deepEqual(f.windows.map((w) => w.label), ['Next day', 'Next week', 'Next month', 'Next year']);
    const csv = buildCsv([], { name: 'Panama City' }, String);
    assert.ok(csv.startsWith('id,time_utc,time_panama,') && csv.includes('estimated_intensity_Panama City') && csv.includes('emsc_page'));
  } finally {
    setLang('es', { persist: false });
  }
});

// ---------------------------------------------------------------- frequency
import { rateSeries } from '../js/stats.js';

test('frequency: rolling 6-hour window, per hour, with means once there are enough events', () => {
  const t0 = Date.parse('2026-10-09T18:00:00Z');
  const at = (h, mag) => ({ t: new Date(t0 + h * 3600e3), mag });
  const evs = [at(0.5, 5), at(1.5, 3), at(2.5, 4), at(3.5, 3), at(7.5, 3)];
  const s = rateSeries(evs, { start: t0, end: t0 + 8 * 3600e3, windowH: 6, mmiOf: (e) => e.mag - 1 });
  assert.equal(s.length, 8);
  // at 4 h: 4 events in the 4 hours since the start (window can't reach back further)
  assert.equal(s[3].n, 4);
  assert.equal(s[3].rate, 1);
  assert.equal(s[3].rateM4, 0.5);
  assert.equal(s[3].meanMag, 3.75);
  assert.equal(s[3].meanMmi, 2.75);
  // at 8 h: window 2–8 h holds 2.5, 3.5 and 7.5 → 3 events / 6 h
  assert.equal(s[7].n, 3);
  assert.equal(s[7].rate, 0.5);
  // fewer than 3 events: no mean
  assert.equal(s[0].meanMag, null);
});

// ---------------------------------------------------------------- confirmation
test('EMSC QuakeML: every solution is read, and lone automatic foreign ones are not confirmed', () => {
  const [fake, border] = parseQuakeML(read('emsc_quakeml_2026-10-13.xml'));
  // the false M4.0 near Panama City: one automatic UNA solution
  assert.equal(fake.id, '20261013_0000413');
  assert.deepEqual([fake.mag, fake.lat, fake.lon, fake.depth, fake.agency], [4, 8.9766, -79.3632, 20, 'UNA']);
  assert.equal(fake.t.toISOString(), '2026-10-13T21:25:48.000Z');
  assert.equal(fake.confirmed, false);
  // a real M4.6 at the border: UCR (preferred), INET, UNA and IGC
  assert.equal(border.agency, 'UCR');
  assert.deepEqual(border.origins.map((o) => o.author), ['UCR', 'INET', 'UNA', 'IGC']);
  assert.equal(border.confirmed, true);
});

test('confirmation rule', () => {
  const o = (author, mode = 'automatic') => ({ author, mode });
  assert.equal(isConfirmed([o('IGC')]), true); // the national network, even automatic
  assert.equal(isConfirmed([o('UNA'), o('UCR')]), true); // two agencies
  assert.equal(isConfirmed([o('NEIC', 'manual')]), true); // reviewed by an analyst
  assert.equal(isConfirmed([o('UNA')]), false); // one automatic foreign solution
  assert.equal(isConfirmed([o('UNA'), o('UNA')]), false); // the same agency twice
  assert.equal(isConfirmed([]), null);
  assert.equal(featureToEvent(fixture.features[0]).confirmed, null); // live, not IGC: unknown yet
});

// ---------------------------------------------------------------- IGC feed
import { igcOnly, parseIgcFeed } from '../js/igc.js';

test('IGC feed: events are confirmed and dropped once EMSC has the same quake', () => {
  const feed = { events: [
    { id: 'igc-1', time: '2026-10-14T06:54:06Z', lat: 7.754, lon: -80.735, depth: 10, mag: 3.7, reviewed: false, url: 'https://sismosgeociencias.up.ac.pa/ultimosismo.html?x=1' },
    { id: 'igc-2', time: '2026-10-14T05:42:51Z', lat: 7.185, lon: -81.345, depth: 10, mag: 4.2, reviewed: true, url: 'u' },
    { id: 'bad', time: 'nope', lat: 1, lon: 1, mag: 3 },
  ] };
  const igc = parseIgcFeed(feed);
  assert.equal(igc.length, 2);
  assert.deepEqual([igc[0].confirmed, igc[0].agency, igc[0].source, igc[1].origins[0].mode], [true, 'IGC', 'igc', 'manual']);
  // EMSC has the second one, 20 s later and 15 km away (another solution of the same quake)
  const emsc = [{ t: new Date('2026-10-14T05:43:11Z'), lat: 7.3, lon: -81.3 }, { t: new Date('2026-10-14T06:30:00Z'), lat: 7.75, lon: -80.73 }];
  assert.deepEqual(igcOnly(igc, emsc).map((e) => e.id), ['igc-1']);
});
