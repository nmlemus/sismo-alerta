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
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, colorScheme: vp.name === 'mobile' ? 'dark' : 'light' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/seismicportal\.eu\/fdsnws/, (route) => {
    const feats = fdsn(route.request().url());
    return feats.length
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }) })
      : route.fulfill({ status: 204, body: '' });
  });
  await page.route(/basemaps\.cartocdn\.com/, (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
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
  check((await page.locator('#map .leaflet-interactive').count()) > 300, `${vp.name}: map markers drawn`);
  for (const id of ['#chart-timeline', '#chart-windows', '#chart-bands', '#chart-intensity']) {
    check((await page.locator(`${id} svg`).count()) === 1, `${vp.name}: ${id} drawn`);
  }
  if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: join(OUT, `${vp.name}.png`), fullPage: true }); }

  // playback
  await page.click('#map-play');
  await page.waitForTimeout(1200);
  const mid = await page.textContent('#map-time-label');
  check(!mid.startsWith('Ahora'), `${vp.name}: playback moves the time (${mid})`);
  await page.click('#map-play');
  if (OUT && vp.name === 'desktop') await page.locator('#map-card').screenshot({ path: join(OUT, 'map-playback.png') });

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

  check(errors.length === 0, `${vp.name}: no page errors ${errors.length ? JSON.stringify(errors.slice(0, 3)) : ''}`);
  await page.close();
}
await browser.close();
server.close();
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
