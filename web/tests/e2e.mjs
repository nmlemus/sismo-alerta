// End-to-end smoke test: serves web/, fakes EMSC (catalog + WebSocket) with the
// 2026-10-09 fixture and checks the page loads, counts, plays back and takes a
// live event. Run: node web/tests/e2e.mjs [screenshot-dir]
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { toQuakeML } from './quakeml.mjs';

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

// An unconfirmed event: one automatic UNA solution, like the false M4.0 of Oct 13.
fixture.features.push(preEvent('FAKE_UNA', '2026-10-11T12:00:00.0Z', 7.5, -80.8, 4.0));
fixture.features.at(-1).properties.auth = 'UNA';
const LONE = new Set(['FAKE_UNA', 'TEST_UNA']);

/** EMSC FDSN mock: QuakeML with all origins, as the page asks for. */
function emscRoute(route) {
  const feats = fdsn(route.request().url());
  return feats.length
    ? route.fulfill({ contentType: 'application/xml', body: toQuakeML(feats, { lone: LONE }) })
    : route.fulfill({ status: 204, body: '' });
}

function fdsn(url) {
  const q = new URL(url).searchParams;
  if (q.get('eventid')) return [...fixture.features, ...liveFeatures].filter((f) => f.properties.unid === q.get('eventid'));
  const start = new Date(`${q.get('start')}Z`).getTime();
  const after = q.get('updatedafter') ? new Date(`${q.get('updatedafter')}Z`).getTime() : null;
  let feats = fixture.features.filter((f) => new Date(f.properties.time).getTime() >= start);
  if (after) feats = feats.filter((f) => new Date(f.properties.lastupdate).getTime() > after);
  feats.sort((a, b) => new Date(a.properties.time) - new Date(b.properties.time));
  return feats.slice(0, Number(q.get('limit') || 300));
}

// The browser's clock is fixed to a moment covered by the fixture, so periods like
// "last 24 h" don't depend on the day the test runs.
const NOW = new Date('2026-10-12T22:00:00Z');
const liveFeatures = []; // sent over the fake WebSocket; also answerable by eventid
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const browser = await chromium.launch();
for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  // Spanish browser; English is checked below with the ES/EN switch.
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, colorScheme: vp.name === 'mobile' ? 'dark' : 'light', locale: 'es-PA', hasTouch: vp.name === 'mobile' });
  await page.clock.setFixedTime(NOW);
  await page.context().route(/eventdetails\.html/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>EMSC</title>' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/seismicportal\.eu\/fdsnws/, (route) => {
    return emscRoute(route);
  });
  await page.route(/sismo-alerta-235ca-sismo-feed/, (route) => route.fulfill({ contentType: 'application/json', body: '{"events":[]}' }));
  // Google Analytics is on in the real config: answer it locally so tests never send hits
  await page.route(/googletagmanager\.com|google-analytics\.com/, (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  const tileZooms = [];
  const satTiles = [];
  await page.route(/tiles\.maps\.eox\.at/, (route) => { satTiles.push(route.request().url()); return route.fulfill({ contentType: 'image/png', body: PNG }); });
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
  check(/^\d+(\.\d)?$/.test(await page.textContent('#freq')) && (await page.textContent('#freq-sub')).includes('primeras 6 h'), `${vp.name}: current frequency tile (${await page.textContent('#freq')})`);
  check((await page.textContent('#big-mag')) === 'M6.6', `${vp.name}: largest aftershock M6.6`);
  check((await page.textContent('#unconfirmed-note summary')).startsWith('1 sismo sin confirmar'), `${vp.name}: the lone automatic UNA event is listed as unconfirmed, not counted`);
  check((await page.textContent('#n-out')) === '49' && (await page.textContent('#n-out-sub')).includes('el mayor, M'), `${vp.name}: 49 other earthquakes in Panama outside the zone (${await page.textContent('#n-out')}: ${await page.textContent('#n-out-sub')})`);
  check((await page.locator('#events tbody tr').count()) === 355, `${vp.name}: table lists all 355 earthquakes in Panama (${await page.locator('#events tbody tr').count()})`);
  check(/^(Réplica del M7\.7|Fuera de la zona de réplicas)$/.test(await page.textContent('#hero-tag')), `${vp.name}: hero says whether it is an aftershock (${await page.textContent('#hero-tag')})`);
  check((await page.getAttribute('[data-view="country"]', 'aria-pressed')) === 'true', `${vp.name}: map opens on all of Panama`);
  check(/Zona de réplicas \(recuadro punteado\)/.test(await page.textContent('#map-legend')), `${vp.name}: map legend explains the dotted aftershock zone`);
  check((await page.textContent('#takeaway')).includes('Fuera de la zona de réplicas hubo 49 sismos más'), `${vp.name}: takeaway mentions the others`);
  check((await page.textContent('#live-text')) === 'En vivo', `${vp.name}: live status (got ${await page.textContent('#live-text')})`);
  await page.waitForTimeout(vp.name === 'mobile' ? 1500 : 0);
  check((await page.locator('#map .leaflet-interactive').count()) > 300, `${vp.name}: map markers drawn`);
  check(tileZooms.length > 0 && Math.max(...tileZooms) >= 6, `${vp.name}: map zoomed to the region (tile zoom ${Math.max(...tileZooms)})`);
  await page.waitForSelector('#forecast table', { timeout: 10000 });
  await page.waitForSelector('#chart-dyfi svg', { timeout: 10000 });
  for (const id of ['#chart-timeline', '#chart-rate', '#chart-windows', '#chart-cumulative', '#chart-bands', '#chart-intensity', '#chart-dyfi']) {
    check((await page.locator(`${id} svg`).count()) === 1, `${vp.name}: ${id} drawn`);
  }
  check((await page.locator('#forecast tbody tr').count()) === 3, `${vp.name}: forecast shows M5+, M6+, M7+`);
  check((await page.textContent('#forecast')).includes('94 %'), `${vp.name}: forecast week M5+ probability`);
  check((await page.textContent('#ref-reported')).includes('169 personas'), `${vp.name}: reported DYFI for Panama City (${await page.textContent('#ref-reported')})`);
  check((await page.textContent('#ref-badge-cap')) === 'reportado', `${vp.name}: badge uses the reported value`);
  check((await page.textContent('#n-after-sub')).includes('de M5+'), `${vp.name}: M5+/M6+ in the aftershock tile`);
  check((await page.locator('#events a[href*="eventdetails.html?unid="]').count()) === 355, `${vp.name}: every row links to EMSC`);
  check(/Sismo principal.*vie 9 oct.*lun 12 oct/.test(await page.textContent('#map-legend')), `${vp.name}: day legend on the map`);
  check((await page.locator('#legend-timeline span').count()) >= 5, `${vp.name}: day legend on the timeline`);
  check((await page.locator('#legend-intensity .sw').count()) >= 5, `${vp.name}: intensity legend`);
  // latest earthquake up top
  check(await page.isVisible('#hero'), `${vp.name}: hero shown`);
  check((await page.locator('#hero-arrivals li').count()) === 6, `${vp.name}: arrival times for the 6 towns`);
  check(/^\d+ s$|min/.test(await page.textContent('#hero-arrivals li .arr-val')), `${vp.name}: arrival time format (${await page.textContent('#hero-arrivals li .arr-val')})`);
  check((await page.textContent('#hero-energy')).includes('TNT'), `${vp.name}: energy in TNT (${await page.textContent('#hero-energy')})`);
  check((await page.textContent('#hero-felt')).includes('Ciudad de Panamá'), `${vp.name}: estimated intensity in Panama City`);
  check((await page.getAttribute('#hero-wa', 'href')).startsWith('https://wa.me/?text=Sismo%20M'), `${vp.name}: WhatsApp share link`);
  check((await page.getAttribute('#tg-cta', 'href')) === 'https://t.me/sismos_panama_live', `${vp.name}: Telegram channel link`);
  check((await page.locator('#map path.latest-ring').count()) === 1, `${vp.name}: latest earthquake rings on the map`);
  check(/EMSC: en vivo/.test(await page.textContent('#sources')) && /USGS: al día/.test(await page.textContent('#sources')), `${vp.name}: sources strip (${await page.textContent('#sources')})`);
  // time of day
  check((await page.locator('#chart-hours circle.dot').count()) === 355, `${vp.name}: hours chart draws every event (${await page.locator('#chart-hours circle.dot').count()})`);
  check((await page.locator('#chart-hours path.bar').count()) === 48 && /noche/.test(await page.textContent('#chart-hours')), `${vp.name}: hours chart has 24 bars and night bands`);
  check(/La noche \(6 p\.m\. a 6 a\.m\.\) es la mitad del día: en ella ocurrió el \d+ %/.test(await page.textContent('#hours-sum')), `${vp.name}: hours summary (${await page.textContent('#hours-sum')})`);
  // depth section
  check((await page.locator('#chart-depth circle.dot').count()) === 355, `${vp.name}: depth section draws every event (${await page.locator('#chart-depth circle.dot').count()})`);
  check(/oeste/.test(await page.textContent('#chart-depth')), `${vp.name}: depth section labelled west to east`);
  await page.click('[data-depth-axis="sn"]');
  await page.waitForTimeout(300);
  check(/norte/.test(await page.textContent('#chart-depth')) && (await page.locator('#chart-depth circle.dot').count()) === 355, `${vp.name}: depth section south to north`);
  await page.click('[data-depth-axis="we"]');
  // plate boundaries (on by default) and satellite
  await page.waitForSelector('#map .leaflet-plates-pane path', { timeout: 4000 }).catch(() => {});
  check((await page.locator('#map .leaflet-plates-pane path').count()) >= 10, `${vp.name}: plate boundaries drawn (${await page.locator('#map .leaflet-plates-pane path').count()})`);
  check(/Subducción/.test(await page.textContent('#map-legend')) && /Microplaca de Panamá|Placa de Cocos/.test(await page.textContent('#map')), `${vp.name}: plate legend and labels`);
  await page.click('#map-plates');
  await page.waitForTimeout(200);
  check((await page.locator('#map .leaflet-plates-pane path').count()) === 0 && !/Subducción/.test(await page.textContent('#map-legend')), `${vp.name}: plates can be turned off`);
  await page.click('#map-plates');
  await page.click('[data-base="satellite"]');
  await page.waitForTimeout(500);
  check((await page.getAttribute('#map', 'data-base')) === 'satellite' && satTiles.length > 0, `${vp.name}: satellite view loads its tiles (${satTiles.length})`);
  await page.click('[data-base="streets"]');
  // theme
  await page.click('[data-theme-btn="dark"]');
  await page.waitForTimeout(200);
  if (OUT) {
    for (const id of ['hero', 'tiles', 'map-card', 'depth-card', 'hours-card', 'seq-head', 'rate-card']) await page.locator(`#${id}`).screenshot({ path: join(OUT, `${vp.name}-dark-${id}.png`) });
  }
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor === 'rgb(13, 13, 13)'), `${vp.name}: dark theme on demand`);
  await page.click('[data-theme-btn="light"]');
  await page.waitForTimeout(200);
  if (OUT) {
    for (const id of ['hero', 'tiles', 'map-card', 'hours-card', 'rate-card']) await page.locator(`#${id}`).screenshot({ path: join(OUT, `${vp.name}-light-${id}.png`) });
    await page.screenshot({ path: join(OUT, `${vp.name}-light-full.png`), fullPage: true });
  }
  check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(249, 249, 247)'), `${vp.name}: light theme on demand`);
  await page.click('[data-theme-btn="auto"]');
  check(await page.evaluate(() => !document.documentElement.dataset.theme), `${vp.name}: back to the system theme`);
  // sound alarm
  await page.click('#alarm');
  check((await page.getAttribute('#alarm', 'aria-pressed')) === 'true' && (await page.textContent('#alarm')) === 'Alarma sonora activada', `${vp.name}: sound alarm turns on`);
  await page.click('#hero-map');
  await page.waitForSelector('#map .leaflet-popup', { timeout: 4000 }).catch(() => {});
  check((await page.locator('#map .leaflet-popup').count()) === 1, `${vp.name}: "show on the map" opens its card on the map`);
  // wave simulation from the map card: animates, then can be closed
  await page.locator('#map .leaflet-popup .wave-btn').click();
  await page.waitForTimeout(1800);
  if (OUT && vp.name === 'desktop') { await page.waitForTimeout(1500); await page.locator('#map').screenshot({ path: join(OUT, 'waves-mid.png') }); }
  check(await page.isVisible('#wave-panel') && (await page.textContent('#wave-title')).includes('M3.5'), `${vp.name}: simulation starts from the map card (${await page.textContent('#wave-title')})`);
  check(/después del sismo: la onda S va a \d+ km/.test(await page.textContent('#wave-clock')), `${vp.name}: the S wave front moves (${await page.textContent('#wave-clock')})`);
  check((await page.locator('#map .leaflet-waves-pane path').count()) >= 3, `${vp.name}: P and S rings drawn`);
  check(await page.evaluate(() => document.querySelector('#map').classList.contains('simulating')), `${vp.name}: other earthquakes dimmed meanwhile`);
  await page.click('#wave-close');
  check(await page.isHidden('#wave-panel') && (await page.locator('#map .leaflet-waves-pane path').count()) === 0, `${vp.name}: closing the simulation clears it`);
  // with reduced motion: straight to the result (zones, where it stopped being felt)
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.click('#hero-wave');
  await page.waitForTimeout(300);
  check(/dejó de sentirse a unos \d+ km/.test(await page.textContent('#wave-clock')) && (await page.locator('#wave-legend .sw').count()) >= 2, `${vp.name}: reduced motion shows the zones right away (${await page.textContent('#wave-clock')})`);
  check((await page.locator('#map .leaflet-waves-pane path').count()) >= 3, `${vp.name}: intensity zones drawn`);
  if (OUT && vp.name === 'desktop') await page.locator('#map-card').screenshot({ path: join(OUT, 'waves-final.png') });
  await page.click('#wave-close');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('Escape');
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 8.0, longitude: -80.9 });
  await page.click('#hero-locate');
  await page.waitForSelector('#hero-arrivals li.you', { timeout: 4000 }).catch(() => {});
  check((await page.locator('#hero-arrivals li.you').count()) === 1 && (await page.textContent('#hero-felt')).includes('tu ubicación'), `${vp.name}: "my location" adds your row and intensity (${await page.textContent('#hero-felt')})`);
  check(await page.isHidden('#hero-locate'), `${vp.name}: location button hides once located`);
  await page.selectOption('#ref-select', 'panama');
  await page.waitForTimeout(300);
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
  check(csv.trim().split('\n').length === 356 && csv.includes('ficha_emsc'), `${vp.name}: CSV has 355 events + header`);
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

  // aftershocks only: the 49 earthquakes outside the zone leave the table and go gray on the map
  await page.click('[data-scope="replicas"]');
  await page.waitForTimeout(400);
  check((await page.textContent('#n-after')) === '305', `${vp.name}: aftershock count does not change (${await page.textContent('#n-after')})`);
  check((await page.locator('#events tbody tr').count()) === 306 && page.url().includes('ver=replicas'), `${vp.name}: aftershocks only in the table and the address`);
  check((await page.textContent('#area-note')).startsWith('Solo réplicas') && /Fuera de la zona de réplicas/.test(await page.textContent('#map-legend')), `${vp.name}: note and map legend for aftershocks only`);
  check((await page.getAttribute('[data-view="zone"]', 'aria-pressed')) === 'true', `${vp.name}: map goes to the aftershock zone`);
  if (OUT) { await page.waitForTimeout(900); await page.locator('#map-card').screenshot({ path: join(OUT, `${vp.name}-replicas-map-card.png`) }); }
  await page.click('[data-scope="todos"]');
  await page.waitForTimeout(400);
  check((await page.locator('#events tbody tr').count()) === 355 && !page.url().includes('ver='), `${vp.name}: back to all earthquakes`);

  // a live event from the WebSocket
  const t = new Date(NOW.getTime() - 60e3).toISOString();
  socket.send(JSON.stringify({
    action: 'create',
    data: { type: 'Feature', id: 'TEST_1', geometry: { type: 'Point', coordinates: [-80.6, 7.5, -10] },
      properties: { unid: 'TEST_1', time: t, lastupdate: t, lat: 7.5, lon: -80.6, depth: 10, mag: 4.9, magtype: 'm', auth: 'IGC', evtype: 'ke', flynn_region: 'PANAMA' } },
  }));
  await page.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(300);
  check((await page.textContent('#n-after')) === '306', `${vp.name}: live event counted`);
  check((await page.textContent('#hero-tag')) === 'Réplica del M7.7', `${vp.name}: the live quake is tagged as an aftershock`);
  check((await page.textContent('#hero-mag')) === '4.9' && await page.isVisible('#hero-new'), `${vp.name}: hero shows the live quake as new`);
  check(await page.evaluate(() => document.querySelector('#hero').classList.contains('arrived')), `${vp.name}: hero lights up when it arrives`);
  check((await page.locator('#map path.pulse').count()) >= 1, `${vp.name}: ripple on the map`);
  check((await page.textContent('#toast')).includes('M4.9'), `${vp.name}: toast shown`);
  // EMSC deletes it: it goes away
  socket.send(JSON.stringify({ action: 'delete', data: { type: 'Feature', id: 'TEST_1', properties: { unid: 'TEST_1' } } }));
  await page.waitForTimeout(400);
  check((await page.textContent('#n-after')) === '305', `${vp.name}: event deleted by EMSC is removed (${await page.textContent('#n-after')})`);
  check((await page.textContent('#excluded-note')).includes('Geociencias'), `${vp.name}: excluded false events listed in the footer`);
  // a live event with only an automatic UNA solution: checked, not counted, no toast
  const tu = new Date(NOW.getTime() - 30e3).toISOString();
  const una = { type: 'Feature', id: 'TEST_UNA', geometry: { type: 'Point', coordinates: [-79.36, 8.97, -20] },
    properties: { unid: 'TEST_UNA', time: tu, lastupdate: tu, lat: 8.97, lon: -79.36, depth: 20, mag: 4.7, magtype: 'm', auth: 'UNA', evtype: 'ke', flynn_region: 'PANAMA' } };
  liveFeatures.push(una);
  socket.send(JSON.stringify({ action: 'create', data: una }));
  await page.waitForTimeout(800);
  check((await page.textContent('#n-out')) === '49' && (await page.locator('#events tbody tr').count()) === 355, `${vp.name}: unconfirmed live event not counted (${await page.textContent('#n-out')})`);
  check((await page.textContent('#unconfirmed-note summary')).startsWith('2 sismos sin confirmar'), `${vp.name}: and listed as unconfirmed`);
  check(!(await page.textContent('#toast')).includes('M4.7'), `${vp.name}: and no toast for it`);
  check((await page.locator('#map path[stroke-dasharray="3 3"]').count()) >= 1, `${vp.name}: unconfirmed drawn hollow and dashed on the map`);

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
// Analytics on (fake id): the production CSP must let gtag load, and filters send events.
// The same page checks the false-event list with one real aftershock listed in it.
const EXCLUDE = fixture.features.find((f) => f.properties.time > '2026-10-09T18:00' && f.properties.lat < 8 && f.properties.lon < -80).properties.unid;
{
  const page = await browser.newPage({ locale: 'es-PA' });
  await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  let gtagLoaded = false;
  await page.route(/js\/config\.js$/, async (route) => {
    const body = readFileSync(join(ROOT, 'js/config.js'), 'utf8').replace(/measurementId: '[^']*'/, "measurementId: 'G-TEST1234'");
    await route.fulfill({ contentType: 'text/javascript', body, headers: { 'content-security-policy': CSP } });
  });
  await page.route(/data\/excluded\.json/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [{ id: EXCLUDE, es: 'prueba', en: 'test' }] }) }));
  await page.route(/googletagmanager\.com\/gtag\/js/, (route) => { gtagLoaded = true; return route.fulfill({ contentType: 'text/javascript', body: '/* gtag stub */' }); });
  await page.route(/seismicportal\.eu\/fdsnws/, (route) => {
    return emscRoute(route);
  });
  await page.route(/sismo-alerta-235ca-sismo-feed/, (route) => route.fulfill({ contentType: 'application/json', body: '{"events":[]}' }));
  await page.route(/tile\.openstreetmap\.org|earthquake\.usgs\.gov/, (route) => route.abort());
  await page.routeWebSocket(/seismicportal\.eu/, () => {});
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#n-after').textContent !== '—', null, { timeout: 15000 });
  check((await page.textContent('#n-after')) === '304', `exclusions: a listed event is left out of the counts (${await page.textContent('#n-after')})`);
  check((await page.locator(`#events a[href$="${EXCLUDE}"]`).count()) === 0, 'exclusions: and out of the table');
  await page.click('[data-mag="4"]');
  const events = await page.evaluate(() => window.dataLayer.map((a) => [...a]).filter((a) => a[0] === 'event').map((a) => `${a[1]}:${a[2].kind}=${a[2].value}`));
  check(gtagLoaded, 'analytics: gtag script requested');
  check(events.includes('filter:magnitude=4'), `analytics: filter event recorded (${events})`);
  check(await page.isVisible('#analytics-note'), 'analytics: privacy note shown in the footer');
  check(!errors.some((e) => /Content Security Policy|gtag/i.test(e)), `analytics: no CSP errors ${JSON.stringify(errors.filter((e) => /Content Security Policy|gtag/i.test(e)).slice(0, 2))}`);
  await page.close();
}
// IGC monitor feed on: dedupe with EMSC, IGC-only quakes counted, IGC confirms a UNA-only
// event, and a quake in the next 6-hour poll is announced.
{
  const page = await browser.newPage({ locale: 'es-PA' });
  await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/js\/config\.js$/, async (route) => {
    const body = readFileSync(join(ROOT, 'js/config.js'), 'utf8')
      .replace(/IGC_FEED = \{[^}]*\}/, "IGC_FEED = { base: 'https://storage.googleapis.com/test-bucket/igc/', pollSeconds: 2 }");
    await route.fulfill({ contentType: 'text/javascript', body, headers: { 'content-security-policy': CSP } });
  });
  const dupOf = fixture.features.find((f) => f.properties.auth === 'IGC' && f.properties.time > '2026-10-10').properties;
  const ev = (id, time, lat, lon, mag) => ({ id, time, lat, lon, depth: 10, mag, reviewed: false, url: `https://sismosgeociencias.up.ac.pa/ultimosismo.html?id=${id}` });
  const week = [
    ev('igc-dup', new Date(new Date(dupOf.time).getTime() + 10e3).toISOString(), dupOf.lat + 0.05, dupOf.lon, dupOf.mag),
    ev('igc-new', new Date(NOW.getTime() - 90e3).toISOString(), 7.6, -80.9, 4.3),
    ev('igc-conf', '2026-10-11T12:00:20Z', 7.52, -80.8, 4.0), // confirms FAKE_UNA
  ];
  let recent = [week[1]];
  const status = { checked: NOW.toISOString(), igc: { last_ok: '2026-10-12T21:00:00Z', down_since: '2026-10-12T21:30:00Z', reason: 'la página dice: «Estamos en mantenimiento»' },
    x: { on: true, last_ok: new Date(NOW.getTime() - 60e3).toISOString(), user: 'igcpanamaup' } };
  await page.route(/storage\.googleapis\.com\/test-bucket\/igc\//, (route) => {
    const isRecent = route.request().url().includes('recent.json');
    const body = isRecent ? { events: recent, status } : { events: week };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/seismicportal\.eu\/fdsnws/, emscRoute);
  await page.route(/googletagmanager\.com|google-analytics\.com/, (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(/tile\.openstreetmap\.org|earthquake\.usgs\.gov/, (route) => route.abort());
  await page.routeWebSocket(/seismicportal\.eu/, () => {});
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#n-after').textContent !== '—', null, { timeout: 15000 });
  await page.waitForTimeout(600);
  check((await page.textContent('#n-after')) === '307', `igc: +1 IGC-only quake and +1 confirmed by IGC, the duplicate not counted (${await page.textContent('#n-after')})`);
  check(await page.isHidden('#unconfirmed-note'), 'igc: the UNA-only event is confirmed by IGC');
  check((await page.locator('#events a', { hasText: 'IGC ↗' }).count()) === 1, 'igc: IGC-only quake links to the IGC page');
  await page.waitForTimeout(2500); // first recent.json poll brings the sources' status
  const srcText = await page.textContent('#sources');
  check(/IGC, lista web: sin respuesta desde las 4:30/.test(srcText) && /IGC en X: al día/.test(srcText), `igc: sources strip shows IGC's list down and X up (${srcText})`);
  check((await page.getAttribute('#sources li[data-kind=bad]', 'title')).includes('mantenimiento'), 'igc: the reason is in the tooltip');
  recent = [week[1], ev('igc-live', new Date(NOW.getTime() - 30e3).toISOString(), 7.65, -81.0, 4.4)];
  await page.waitForSelector('#toast:not([hidden])', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
  check((await page.textContent('#n-after')) === '308' && (await page.textContent('#toast')).includes('M4.4'), `igc: a new quake in the 6-hour poll is counted and announced (${await page.textContent('#n-after')})`);
  const real = errors.filter((e) => !e.includes('Failed to load resource')); // tiles and USGS are blocked on purpose here
  check(real.length === 0, `igc: no page errors ${JSON.stringify(real.slice(0, 2))}`);
  await page.close();
}
await browser.close();
server.close();
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
