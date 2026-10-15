// Settings for the page. Change SEQUENCE to follow a different earthquake.

export const SEQUENCE = {
  title: 'Terremoto M7.7 de Panamá y sus réplicas',
  // The mainshock is the largest event inside `zone` from `start` on.
  start: '2026-10-09T17:50:00Z',
  // Aftershock zone: every count and chart uses only events inside this box.
  zone: { minLat: 6.5, maxLat: 8.2, minLon: -82.3, maxLon: -79.5 },
  // Wider area drawn on the map (events outside the zone appear grey).
  region: { minLat: 5.0, maxLat: 10.0, minLon: -84.0, maxLon: -77.0 },
  minMag: 2.5,
  // Days before the mainshock that can be shown (off by default; the views start at the mainshock).
  preDays: 7,
  // USGS id of the mainshock: "Did You Feel It?" reports and the official aftershock forecast.
  usgsEventId: 'us6000u18k',
};

export const EMSC = {
  fdsn: 'https://www.seismicportal.eu/fdsnws/event/1/query',
  ws: 'wss://www.seismicportal.eu/standing_order/websocket',
  pageSize: 300, // EMSC returns at most 300 events per request
  pollSeconds: 120, // safety net in case the live connection drops
  // An event counts only if it is confirmed: a solution from one of these agencies,
  // two or more agencies, or a solution reviewed by an analyst. A lone automatic
  // solution from another agency stays "unconfirmed" (shown, never counted).
  trustedAuthors: ['IGC'], // Instituto de Geociencias, Universidad de Panamá (national network)
};

// Reference points for "how strong would it feel here". siteAdjust is added to the
// intensity model: +0.6 matches what Panama City reported to USGS "Did You Feel It?"
// for the 2026-10-09 mainshock; Chitré and Santiago matched the model without it.
export const REFERENCES = [
  { id: 'panama', name: 'Ciudad de Panamá', en: 'Panama City', lat: 8.983, lon: -79.52, siteAdjust: 0.6 },
  { id: 'santiago', name: 'Santiago', lat: 8.1, lon: -80.983, siteAdjust: 0 },
  { id: 'chitre', name: 'Chitré', lat: 7.961, lon: -80.429, siteAdjust: 0 },
  { id: 'lastablas', name: 'Las Tablas', lat: 7.765, lon: -80.275, siteAdjust: 0 },
  { id: 'david', name: 'David', lat: 8.427, lon: -82.431, siteAdjust: 0 },
  { id: 'colon', name: 'Colón', lat: 9.359, lon: -79.901, siteAdjust: 0.6 },
];

// Towns used to name each epicenter (approximate coordinates). label: drawn on the map;
// en: English name, where it differs.
export const PLACES = [
  { name: 'Ciudad de Panamá', en: 'Panama City', lat: 8.983, lon: -79.52, label: true },
  { name: 'Colón', lat: 9.359, lon: -79.901, label: true },
  { name: 'La Chorrera', lat: 8.88, lon: -79.783 },
  { name: 'Penonomé', lat: 8.519, lon: -80.357, label: true },
  { name: 'Aguadulce', lat: 8.241, lon: -80.544 },
  { name: 'Santiago', lat: 8.1, lon: -80.983, label: true },
  { name: 'Chitré', lat: 7.961, lon: -80.429, label: true },
  { name: 'Las Tablas', lat: 7.765, lon: -80.275, label: true },
  { name: 'Macaracas', lat: 7.731, lon: -80.553 },
  { name: 'Tonosí', lat: 7.404, lon: -80.442, label: true },
  { name: 'Pedasí', lat: 7.531, lon: -80.026, label: true },
  { name: 'Mariato', lat: 7.717, lon: -80.967 },
  { name: 'Montijo', lat: 7.994, lon: -81.059 },
  { name: 'Soná', lat: 8.008, lon: -81.319, label: true },
  { name: 'Santa Catalina', lat: 7.632, lon: -81.256 },
  { name: 'isla Coiba', en: 'Coiba Island', lat: 7.45, lon: -81.77, label: true },
  { name: 'David', lat: 8.427, lon: -82.431, label: true },
  { name: 'Puerto Armuelles', lat: 8.283, lon: -82.867 },
  { name: 'Bocas del Toro', lat: 9.34, lon: -82.242 },
  { name: 'La Palma', lat: 8.409, lon: -78.145 },
];

// Map views as [[south, west], [north, east]].
export const VIEWS = {
  zone: [[6.7, -82.45], [8.35, -79.35]],
  country: [[7.0, -83.1], [9.7, -77.15]],
};

// Map tiles. With no key the map uses OpenStreetMap's own tiles, which are fine for
// light use. For heavier public use, request a free CARTO key at
// https://carto.com/basemaps/apikey (non-commercial: 5M tiles/month) and paste it here.
export const TILES = { cartoKey: '' };

// Satellite view: Sentinel-2 cloudless by EOX (free with attribution for non-commercial use,
// CC BY-NC-SA 4.0). Empty: no satellite option.
export const SATELLITE = {
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg',
  attribution: '<a href="https://s2maps.eu" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (Copernicus Sentinel data 2020)',
  maxNativeZoom: 14,
};

// Plate boundaries drawn on the map (data/plates.json, cut to the region from PB2002).
// Labels go where each plate is, roughly.
export const PLATES = {
  file: 'data/plates.json',
  attribution: 'Placas: Bird (2003), PB2002; datos de Hugo Ahlenius, Nordpil',
  labels: [
    { id: 'CO', lat: 6.2, lon: -86.2 },
    { id: 'NZ', lat: 4.2, lon: -80.6 },
    { id: 'CA', lat: 11.3, lon: -80.4 },
    { id: 'PM', lat: 9.15, lon: -81.55 },
    { id: 'ND', lat: 6.6, lon: -75.6 },
  ],
};

// Feed written by the IGC monitor (infra/deploy-monitor.sh prints it), e.g.
// 'https://storage.googleapis.com/<bucket>/igc/'. Empty: the page uses EMSC only.
export const IGC_FEED = { base: 'https://storage.googleapis.com/sismo-alerta-235ca-sismo-feed/igc/', pollSeconds: 60 };

// Public Telegram channel the IGC monitor posts to (without @). Empty: no link on the page.
export const TELEGRAM = { channel: 'sismos_panama_live' };

// Optional sound alarm on the page (the visitor turns it on): new earthquakes from this magnitude.
export const ALARM = { minMag: 4.0 };

// Visit statistics (countries, cities, where people come from). Paste the Google
// Analytics 4 measurement ID ("G-…") of the Firebase project here; empty = off.
export const ANALYTICS = { measurementId: 'G-VJL4JJSVCB' };

// Events this recent (relative to the moment shown) get a ring on the map.
export const RECENT_HOURS = 6;
// Day colors available before older days are grouped (validated categorical slots).
export const DAY_SLOTS = 7;
export const PLAY_SECONDS = 24; // how long the full playback takes
