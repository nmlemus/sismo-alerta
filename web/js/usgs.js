// USGS products for the mainshock: "Did You Feel It?" reports by town and the
// official aftershock forecast (OAF). Both come from the event's detail feed.

const DETAIL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/** Parses one CSV line with quoted fields. */
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** DYFI cdi_zip.txt -> towns in Panama: { name, province, cdi, n, hypoKm, lat, lon }. */
export function parseDyfi(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = splitCsv(line);
    const [name, province, country] = f[0].split('::');
    if (country !== 'Panama') continue;
    const row = { name, province, cdi: Number(f[1]), n: Number(f[2]), hypoKm: Number(f[3]), lat: Number(f[4]), lon: Number(f[5]), suspect: f[6] === '1' };
    if (Number.isFinite(row.cdi) && Number.isFinite(row.lat) && !row.suspect) rows.push(row);
  }
  return rows;
}

/** OAF forecast.json -> { created, next, windows: [{label, end, bins: {5: {p, min, max, median}}}], aboveMain }. */
export function parseForecast(f) {
  const LABELS = { '1 Day': 'Próximo día', '1 Week': 'Próxima semana', '1 Month': 'Próximo mes', '1 Year': 'Próximo año' };
  const windows = (f.forecast || []).map((w) => ({
    key: w.label,
    label: LABELS[w.label] || w.label,
    start: new Date(w.timeStart),
    end: new Date(w.timeEnd),
    aboveMain: w.aboveMainshockMag ? { mag: w.aboveMainshockMag.magnitude, p: w.aboveMainshockMag.probability } : null,
    bins: Object.fromEntries((w.bins || []).map((b) => [b.magnitude, { p: b.probability, min: b.p95minimum, max: b.p95maximum, median: b.median }])),
  }));
  return { created: new Date(f.creationTime), next: f.nextForecastTime ? new Date(f.nextForecastTime) : null, windows, model: f.model?.name || '' };
}

export async function fetchUsgs(eventId, fetchImpl = fetch) {
  const r = await fetchImpl(`${DETAIL}?eventid=${encodeURIComponent(eventId)}&format=geojson`);
  if (!r.ok) throw new Error(`USGS respondió ${r.status}`);
  const ev = await r.json();
  const p = ev.properties.products || {};
  const out = { url: ev.properties.url, dyfi: null, dyfiCount: null, forecast: null };
  const dyfi = p.dyfi?.[0];
  const oaf = p.oaf?.[0];
  const jobs = [];
  if (dyfi?.contents?.['cdi_zip.txt']) {
    out.dyfiCount = Number(dyfi.properties?.['num-responses']) || null;
    jobs.push(fetchImpl(dyfi.contents['cdi_zip.txt'].url).then((x) => x.text()).then((t) => { out.dyfi = parseDyfi(t); }));
  }
  if (oaf?.contents?.['forecast.json']) {
    jobs.push(fetchImpl(oaf.contents['forecast.json'].url).then((x) => x.json()).then((j) => { out.forecast = parseForecast(j); }));
  }
  await Promise.allSettled(jobs);
  return out;
}
