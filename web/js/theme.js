// Colors come from CSS custom properties (css/app.css), so light and dark mode
// each use their own validated steps. Read them at draw time.

import { DAY_SLOTS } from './config.js';
import { t } from './i18n.js';

const root = () => getComputedStyle(document.documentElement);
export const token = (name) => root().getPropertyValue(name).trim();

/** One color per local day of the sequence. If there are more days than slots,
 * the earliest ones share the first slot and the legend says "hasta …" ("through …"). */
export function dayPalette(days) {
  const slots = Array.from({ length: DAY_SLOTS }, (_, i) => token(`--day-${i + 1}`));
  const extra = Math.max(0, days.length - DAY_SLOTS);
  const slotOf = (i) => Math.max(0, i - extra);
  const legend = [];
  if (extra > 0) legend.push({ color: slots[0], label: t('leg.until', days[extra]) });
  for (let i = extra > 0 ? extra + 1 : 0; i < days.length; i++) legend.push({ color: slots[slotOf(i)], label: days[i] });
  return { colorOf: (dayIdx) => slots[slotOf(dayIdx)], legend };
}

export function onThemeChange(fn) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => { if (themeMode() === 'auto') fn(); });
  document.addEventListener('themechange', fn);
}

/** 'auto' (follow the system), 'light' or 'dark'. */
export const themeMode = () => document.documentElement.dataset.theme || 'auto';

export function setTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else delete root.dataset.theme;
  try { if (mode === 'auto') localStorage.removeItem('sismo-theme'); else localStorage.setItem('sismo-theme', mode); } catch { /* storage off */ }
  document.dispatchEvent(new Event('themechange'));
}
