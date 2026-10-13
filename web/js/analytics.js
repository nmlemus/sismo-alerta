// Google Analytics 4, only when ANALYTICS.measurementId is set in config.js.
// No advertising features: Google signals and ad personalization are off, and
// GA4 does not store IP addresses. Events record what people use, never where
// they are (the "my location" coordinates never leave the browser).

import { ANALYTICS } from './config.js';

const id = (ANALYTICS.measurementId || '').trim();
export const analyticsOn = /^G-[A-Z0-9]+$/.test(id);

if (analyticsOn) {
  window.dataLayer = window.dataLayer || [];
  // eslint-disable-next-line prefer-rest-params
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id, { allow_google_signals: false, allow_ad_personalization_signals: false });
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(s);
}

/** Records a use of the page (e.g. track('filter', { kind: 'period', value: '24h' })). Does nothing without an id. */
export function track(name, params = {}) {
  if (analyticsOn) window.gtag('event', name, params);
}
