// End-to-end smoke test: serves web/, fakes EMSC (catalog + WebSocket) with the
// 2026-10-09 fixture and checks the page loads, counts, plays back and takes a
// live event. Run: node web/tests/e2e.mjs [screenshot-dir]
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2];
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/emsc_2026-10-09.json')));
// The week before the mainshock: two events EMSC located in the zone (ids made up
// for the test) and one elsewhere in the region.
const preEvent = (id, time, lat, lon, mag) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat, -10] },
  properties: { unid: id, time, lastupdate: time, lat, lon, depth: 10, mag, magtype: 'm', auth: 'IGC', evtype: 'ke', flynn_region: 'PANAMA' } });
fixture.features.push(
  preEvent('PRE_1', '2026-10-03T06:49:01.0Z', 7.7158, -81.2937, 3.1),
  preEvent('PRE_2', '2026-10-09T05:53:27.0Z', 7.554, -80.7438, 2.6),
  preEvent('PRE_3', '2026-10-06T12:00:00.0Z', 8.5, -82.6, 3.0),
);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
// Serve with the same Content-Security-Policy as production, so violations fail the test.
const CSP = JSON.parse(readFileSync(join(ROOT, '../firebase.json'))).hosting.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    const body = readFileSync(join(ROOT, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'content-security-policy': CSP });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

function fdsn(url) {
  const q = new URL(url).searchParams;
  const start = new Date(`${q.get('start')}Z`).getTime();
  const after = q.get('updatedafter') ? new Date(`${q.get('updatedafter')}Z`).getTime() : null;
  let feats = fixture.features.filter((f) => new Date(f.properties.time).getTime() >= start);
  if (after) feats = feats.filter((f) => new Date(f.properties.lastupdate).getTime() > after);
  feats.sort((a, b) => new Date(a.properties.time) - new Date(b.properties.time));
  return feats.slice(0, Number(q.get('limit') || 300));
}

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch();
for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  // Spanish browser; English is checked below with the ES/EN switch.
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, colorScheme: vp.name === 'mobile' ? 'dark' : 'light', locale: 'es-PA', hasTouch: vp.name === 'mobile' });
  await page.context().route(/eventdetails\.html/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>EMSC</title>' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/seismicportal\.eu\/fdsnws/, (route) => {
    const feats = fdsn(route.request().url());
    return feats.length
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }) })
      : route.fulfill({ status: 204, body: '' });
  });
  const tileZooms = [];
  await page.route(/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/, (route) => {
    const z = /\/(\d+)\/\d+\/\d+(@2x)?\.png/.exec(route.request().url());
    if (z) tileZooms.push(Number(z[1]));
    return route.fulfill({ contentType: 'image/png', body: PNG });
  });
  if (vp.name === 'mobile') {
    // Load while hidden (like a background tab) and show it a moment later.
    // readyState 'interactive' comes before module scripts run.
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive') return;
        document.documentElement.style.display = 'none';
        setTimeout(() => { document.documentElement.style.display = ''; }, 1500);
      });
    });
  }
  await page.route(/earthquake\.usgs\.gov/, (route) => {
    const url = route.request().url();
    if (url.includes('cdi_zip.txt')) return route.fulfill({ contentType: 'text/plain', body: readFileSync(join(ROOT, 'tests/fixtures/usgs_cdi_zip.txt')) });
    if (url.includes('forecast.json')) return route.fulfill({ contentType: 'application/json', body: readFileSync(join(ROOT, 'tests/fixtures/usgs_forecast.json')) });
    return route.fulfill({ contentType: 'application/json', body: readFileSync(join(ROOT, 'tests/fixtures/usgs_event.json')) });
  });
  let socket;
  await page.routeWebSocket(/seismicportal\.eu\/standing_order/, (ws) => { socket = ws; });

  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#n-after').textContent !== '—', null, { timeout: 15000 });
  await page.waitForTimeout(500);
  check((await page.textContent('#n-after')) === '305', `${vp.name}: 305 aftershocks in the zone (got ${await page.textContent('#n-after')})`);
  check((await page.textContent('#main-mag')) === 'M7.7', `${vp.name}: mainshock M7.7`);
  check((await page.textContent('#big-mag')) === 'M6.6', `${vp.name}: largest aftershock M6.6`);
  check((await page.locator('#events tbody tr').count()) === 306, `${vp.name}: table lists 306 events`);
  check((await page.textContent('#live-text')) === 'En vivo', `${vp.name}: live status (got ${await page.textContent('#live-text')})`);
  await page.waitForTimeout(vp.name === 'mobile' ? 1500 : 0);
  check((await page.locator('#map .leaflet-interactive').count()) > 300, `${vp.name}: map markers drawn`);
  check(tileZooms.length > 0 && Math.max(...tileZooms) >= 6, `${vp.name}: map zoomed to the region (tile zoom ${Math.max(...tileZooms)})`);
  await page.waitForSelector('#forecast table', { timeout: 10000 });
  await page.waitForSelector('#chart-dyfi svg', { timeout: 10000 });
  for (const id of ['#chart-timeline', '#chart-windows', '#chart-cumulative', '#chart-bands', '#chart-intensity', '#chart-dyfi']) {
    check((await page.locator(`${id} svg`).count()) === 1, `${vp.name}: ${id} drawn`);
  }
  check((await page.locator('#forecast tbody tr').count()) === 3, `${vp.name}: forecast shows M5+, M6+, M7+`);
  check((await page.textContent('#forecast')).includes('94 %'), `${vp.name}: forecast week M5+ probability`);
  check((await page.textContent('#ref-reported')).includes('169 personas'), `${vp.name}: reported DYFI for Panama City (${await page.textContent('#ref-reported')})`);
  check((await page.textContent('#ref-badge-cap')) === 'reportado', `${vp.name}: badge uses the reported value`);
  check((await page.textContent('#n-after-sub')).includes('de M5+'), `${vp.name}: M5+/M6+ in the aftershock tile`);
  check((await page.locator('#events a[href*="eventdetails.html?unid="]').count()) === 306, `${vp.name}: every row links to EMSC`);
  check(/Sismo principal.*vie 9 oct.*lun 12 oct/.test(await page.textContent('#map-legend')), `${vp.name}: day legend on the map`);
  check((await page.locator('#legend-timeline span').count()) >= 5, `${vp.name}: day legend on the timeline`);
  check((await page.locator('#legend-intensity .sw').count()) >= 5, `${vp.name}: intensity legend`);
  // chart dots open the EMSC page: a click goes there, a tap pins a tooltip with the link
  await page.locator('#chart-timeline').scrollIntoViewIfNeeded();
  const mainDot = await page.locator('#chart-timeline circle.dot.main').boundingBox();
  const at = { x: mainDot.x + mainDot.width / 2, y: mainDot.y + mainDot.height / 2 };
  if (vp.name === 'mobile') {
    await page.touchscreen.tap(at.x, at.y);
    await page.waitForTimeout(200);
    const href = await page.locator('#chart-timeline .tip.pinned a').getAttribute('href').catch(() => '');
    check(/eventdetails\.html\?unid=20261009_0000264/.test(href), `${vp.name}: tapping a dot pins a link to its EMSC page (${href})`);
    await page.locator('h1').click();
    check((await page.locator('#chart-timeline .tip.pinned').count()) === 0, `${vp.name}: tapping elsewhere closes it`);
  } else {
    await page.mouse.move(at.x, at.y);
    check((await page.textContent('#chart-timeline .tip')).includes('EMSC'), `${vp.name}: tooltip says the dot opens EMSC`);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.mouse.click(at.x, at.y)]);
    await popup.waitForLoadState('domcontentloaded');
    check(/eventdetails\.html\?unid=20261009_0000264/.test(popup.url()), `${vp.name}: clicking a dot opens its EMSC page (${popup.url()})`);
    await popup.close();
    await page.locator('#chart-intensity').scrollIntoViewIfNeeded();
    const iDot = await page.locator('#chart-intensity circle.dot').last().boundingBox();
    const [p2] = await Promise.all([page.waitForEvent('popup'), page.mouse.click(iDot.x + iDot.width / 2, iDot.y + iDot.height / 2)]);
    check(p2.url().includes('eventdetails.html?unid='), `${vp.name}: intensity chart dots open EMSC too`);
    await p2.close();
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  const csv = readFileSync(await download.path(), 'utf8');
  check(csv.trim().split('\n').length === 307 && csv.includes('ficha_emsc'), `${vp.name}: CSV has 306 events + header`);
  if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: join(OUT, `${vp.name}.png`), fullPage: true }); }

  // playback
  await page.click('#map-play');
  await page.waitForTimeout(1200);
  const mid = await page.textContent('#map-time-label');
  check(!mid.startsWith('Ahora'), `${vp.name}: playback moves the time (${mid})`);
  await page.click('#map-play');
  if (OUT && vp.name === 'desktop') await page.locator('#map-card').screenshot({ path: join(OUT, 'map-playback.png') });

  // the week before the mainshock
  const dotsBefore = await page.locator('#chart-timeline circle.dot').count();
  const barsBefore = await page.locator('#chart-windows path.bar.s2').count();
  await page.click('[data-period="pre"]');
  await page.waitForTimeout(400);
  check((await page.locator('#chart-timeline circle.dot').count()) === dotsBefore + 3, `${vp.name}: timeline adds the week before`);
  check((await page.locator('#chart-windows path.bar.s2').count()) === barsBefore + 28, `${vp.name}: 6-hour bars add 28 windows before`);
  check((await page.textContent('#pre-note')).includes('3 sismos en la región, 2 de ellos'), `${vp.name}: week-before note (${await page.textContent('#pre-note')})`);
  check((await page.locator('#map .leaflet-pre-pane path').count()) === 3, `${vp.name}: week-before quakes drawn on the map`);
  await page.locator('#map-time').evaluate((n) => { n.value = '100'; n.dispatchEvent(new Event('input', { bubbles: true })); });
  check((await page.textContent('#map-time-label')).includes('antes del sismo principal'), `${vp.name}: slider goes before the mainshock`);
  if (OUT && vp.name === 'desktop') await page.screenshot({ path: join(OUT, 'pre-week.png'), fullPage: true });
  await page.click('[data-period="todo"]');
  await page.waitForTimeout(300);
  check((await page.locator('#chart-timeline circle.dot').count()) === dotsBefore, `${vp.name}: week before hidden again`);

  // period and magnitude filters
  const rowsAll = await page.locator('#events tbody tr').count();
  await page.click('[data-mag="5"]');
  await page.waitForTimeout(300);
  const mags = await page.locator('#events tbody tr td:nth-child(2)').allTextContents();
  check(mags.length > 5 && mags.length < 40 && mags.every((m) => Number(m) >= 5), `${vp.name}: M5+ filter on the table (${mags.length} rows)`);
  check((await page.locator('#chart-timeline circle.dot').count()) === mags.length, `${vp.name}: M5+ filter on the timeline`);
  check((await page.textContent('#view-note')).includes('M5+'), `${vp.name}: filter note (${await page.textContent('#view-note')})`);
  check(page.url().includes('mag=5'), `${vp.name}: filter kept in the address`);
  const [dlF] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  check(readFileSync(await dlF.path(), 'utf8').trim().split('\n').length === mags.length + 1, `${vp.name}: CSV follows the filter`);
  await page.click('[data-mag="0"]');
  await page.click('[data-period="24h"]');
  await page.waitForTimeout(300);
  const rows24 = await page.locator('#events tbody tr').count();
  check(rows24 > 0 && rows24 < rowsAll && (await page.locator('#chart-timeline circle.dot.main').count()) === 0, `${vp.name}: last 24 h (${rows24} of ${rowsAll})`);
  check(page.url().includes('periodo=24h'), `${vp.name}: period kept in the address`);
  await page.click('[data-period="6h"]');
  await page.waitForTimeout(300);
  check((await page.locator('#events tbody tr').count()) <= rows24, `${vp.name}: last 6 h`);
  await page.click('[data-period="todo"]');
  await page.waitForTimeout(300);
  check((await page.locator('#events tbody tr').count()) === rowsAll && !page.url().includes('periodo'), `${vp.name}: back to everything`);

  // a live event from the WebSocket
  const t = new Date(Date.now() - 60e3).toISOString();
  socket.send(JSON.stringify({
    action: 'create',
    data: { type: 'Feature', id: 'TEST_1', geometry: { type: 'Point', coordinates: [-80.6, 7.5, -10] },
      properties: { unid: 'TEST_1', time: t, lastupdate: t, lat: 7.5, lon: -80.6, depth: 10, mag: 4.9, magtype: 'm', auth: 'IGC', evtype: 'ke', flynn_region: 'PANAMA' } },
  }));
  await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(300);
  check((await page.textContent('#n-after')) === '306', `${vp.name}: live event counted`);
  check((await page.textContent('#last-sub')).startsWith('M4.9'), `${vp.name}: latest aftershock updated`);
  check((await page.textContent('#toast')).includes('M4.9'), `${vp.name}: toast shown`);

  // reference point
  await page.selectOption('#ref-select', 'chitre');
  await page.waitForTimeout(300);
  check((await page.textContent('#ref-name')) === 'Chitré', `${vp.name}: reference switches to Chitré`);
  if (OUT && vp.name === 'desktop') await page.locator('#ref-card').screenshot({ path: join(OUT, 'reference.png') });

  // English
  await page.click('[data-lang="en"]');
  await page.waitForTimeout(400);
  check((await page.getAttribute('html', 'lang')) === 'en', `${vp.name}: html lang switches to en`);
  check((await page.textContent('h1')) === 'The Panama earthquake and its aftershocks', `${vp.name}: English title`);
  check((await page.textContent('#live-text')) === 'Live', `${vp.name}: English live status`);
  check((await page.textContent('#takeaway')).includes('aftershocks have been recorded since the mainshock on Oct 9'), `${vp.name}: English takeaway (${await page.textContent('#takeaway')})`);
  check((await page.textContent('#n-after-sub')).includes('M2.5 or larger'), `${vp.name}: English tile`);
  check(/Mainshock.*Fri Oct 9.*Mon Oct 12/.test(await page.textContent('#map-legend')), `${vp.name}: English day legend`);
  check((await page.textContent('#forecast')).includes('94%') && (await page.textContent('#forecast')).includes('Next week'), `${vp.name}: English forecast`);
  check((await page.textContent('#events thead')).includes('Time (Panama)'), `${vp.name}: English table header`);
  check((await page.locator('#events tbody td', { hasText: / km [NSEW]{1,3} of / }).count()) > 100, `${vp.name}: English place names`);
  check((await page.textContent('#map')).includes('Panama City'), `${vp.name}: English map labels`);
  check((await page.textContent('#map-play')) === '▶ Play', `${vp.name}: English play button`);
  check((await page.textContent('#legend-intensity')).includes('moderate'), `${vp.name}: English intensity legend`);
  check((await page.getAttribute('#events-search', 'placeholder')).startsWith('Search'), `${vp.name}: English search placeholder`);
  const [dlEn] = await Promise.all([page.waitForEvent('download'), page.click('#csv')]);
  check(readFileSync(await dlEn.path(), 'utf8').includes('time_panama'), `${vp.name}: English CSV header`);
  if (OUT && vp.name === 'desktop') await page.screenshot({ path: join(OUT, 'english.png'), fullPage: true });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#n-after').textContent !== '—', null, { timeout: 15000 });
  check(page.url().includes('lang=en') && (await page.getAttribute('html', 'lang')) === 'en', `${vp.name}: English kept after reload`);
  check((await page.textContent('#ref-reported')).includes('169 people'), `${vp.name}: English DYFI text (${await page.textContent('#ref-reported')})`);
  await page.click('[data-lang="es"]');
  await page.waitForTimeout(300);
  check((await page.textContent('h1')) === 'Terremoto de Panamá y sus réplicas' && (await page.textContent('#map-play')) === '▶ Reproducir', `${vp.name}: back to Spanish`);
  check((await page.textContent('#ref-name')) === 'Ciudad de Panamá', `${vp.name}: reference name back in Spanish`);

  check(errors.length === 0, `${vp.name}: no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}
await browser.close();
server.close();
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
