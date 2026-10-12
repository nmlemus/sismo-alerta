// Run with: node --test web/tests/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EMSC, PLACES } from '../js/config.js';
import { featureToEvent, fetchSince } from '../js/emsc.js';
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
    return { ok: true, status: page.length ? 200 : 204, json: async () => ({ features: page }) };
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
