// Ground-motion helpers. Same model as backend/app/intensity.py and
// app/lib/core/intensity.dart — keep the three in sync.
//
// Intensity: Atkinson, Worden & Wald (2014) intensity prediction equation,
// hypocentral-distance form.

import { localName, t } from './i18n.js';

export const EARTH_RADIUS_KM = 6371.0;
export const VP_KM_S = 6.0;
export const VS_KM_S = 3.5;

export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
/** Shaking label for an intensity level, in the current language. */
export const mmiLabel = (level) => t('mmi')[level];

// USGS ShakeMap colors by intensity level.
export const MMI_COLORS = ['#ffffff', '#dfe6fe', '#bfccff', '#a0e6ff', '#80ffff', '#7aff93', '#ffff00', '#ffc800', '#ff9100', '#ff0000', '#c80000'];

const rad = (d) => (d * Math.PI) / 180;

export function epicentralKm(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const x = Math.sin(dl) * Math.cos(p2);
  const y = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

export const hypocentralKm = (epiKm, depthKm) => Math.hypot(epiKm, Math.max(0, depthKm));

export function mmiAww2014(mag, rhypKm) {
  const r = Math.sqrt(rhypKm * rhypKm + 14 * 14);
  const lr = Math.log10(r);
  const b = Math.max(0, Math.log10(r / 50));
  return 0.309 + 1.864 * mag - 1.672 * lr - 0.00219 * r + 1.77 * b - 0.383 * mag * lr;
}

/** Intensity expected at (lat, lon) from an event, clipped to [1, 10]. */
export function estimateMmi(ev, lat, lon, siteAdjust = 0) {
  const rhyp = hypocentralKm(epicentralKm(ev.lat, ev.lon, lat, lon), ev.depth);
  return Math.min(10, Math.max(1, mmiAww2014(ev.mag, rhyp) + siteAdjust));
}

export const mmiLevel = (mmi) => Math.min(10, Math.max(1, Math.floor(mmi + 0.5)));
export const describeMmi = (mmi) => `${ROMAN[mmiLevel(mmi)]} (${mmiLabel(mmiLevel(mmi))})`;

/** "16 km al SE de Mariato" / "16 km SE of Mariato" relative to the nearest place in the list. */
export function placeName(lat, lon, places, fallback = '') {
  let best = null, bestKm = Infinity;
  for (const p of places) {
    const d = epicentralKm(p.lat, p.lon, lat, lon);
    if (d < bestKm) { bestKm = d; best = p; }
  }
  if (!best || (bestKm > 90 && fallback)) return fallback;
  if (bestKm < 3) return t('place.near', localName(best));
  const dir = t('dirs')[Math.floor((bearingDeg(best.lat, best.lon, lat, lon) + 11.25) / 22.5) % 16];
  return t('place.from', Math.round(bestKm), dir, localName(best));
}
