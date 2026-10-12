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
};

export const EMSC = {
  fdsn: 'https://www.seismicportal.eu/fdsnws/event/1/query',
  ws: 'wss://www.seismicportal.eu/standing_order/websocket',
  pageSize: 300, // EMSC returns at most 300 events per request
  pollSeconds: 120, // safety net in case the live connection drops
};

// Reference points for "how strong would it feel here". siteAdjust is added to the
// intensity model: +0.6 matches what Panama City reported to USGS "Did You Feel It?"
// for the 2026-10-09 mainshock; Chitré and Santiago matched the model without it.
export const REFERENCES = [
  { id: 'panama', name: 'Ciudad de Panamá', lat: 8.983, lon: -79.52, siteAdjust: 0.6 },
  { id: 'santiago', name: 'Santiago', lat: 8.1, lon: -80.983, siteAdjust: 0 },
  { id: 'chitre', name: 'Chitré', lat: 7.961, lon: -80.429, siteAdjust: 0 },
  { id: 'lastablas', name: 'Las Tablas', lat: 7.765, lon: -80.275, siteAdjust: 0 },
  { id: 'david', name: 'David', lat: 8.427, lon: -82.431, siteAdjust: 0 },
  { id: 'colon', name: 'Colón', lat: 9.359, lon: -79.901, siteAdjust: 0.6 },
];

// Towns used to name each epicenter (approximate coordinates). label: drawn on the map.
export const PLACES = [
  { name: 'Ciudad de Panamá', lat: 8.983, lon: -79.52, label: true },
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
  { name: 'isla Coiba', lat: 7.45, lon: -81.77, label: true },
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

export const RECENT_HOURS = 6; // events this recent get a ring on the map
export const PLAY_SECONDS = 24; // how long the full playback takes
