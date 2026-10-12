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
