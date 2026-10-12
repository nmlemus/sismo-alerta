// Dates are shown in Panama time (UTC−5, no daylight saving). Charts work on
// "wall-clock" dates: the Panama local time stored in a Date's UTC fields,
// so d3's UTC scales and formats show local hours directly.
// Every formatter reads the current language when called.

import { lang, t } from './i18n.js';

const d3 = globalThis.d3;
const OFFSET_MS = 5 * 3600e3;

const NAMES = {
  es: {
    days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
    shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    shortMonths: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
    periods: ['a. m.', 'p. m.'],
    dateTime: '%A, %e de %B de %Y, %X', date: '%d/%m/%Y', time: '%H:%M:%S',
  },
  en: {
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    shortDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    periods: ['AM', 'PM'],
    dateTime: '%a %b %e %X %Y', date: '%m/%d/%Y', time: '%H:%M:%S',
  },
};
const LOCALES = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, d3.timeFormatLocale(v)]));
const PATTERNS = {
  es: { time: '%-d %b, %-I:%M %p' },
  en: { time: '%b %-d, %-I:%M %p' },
};
const fmt = (spec) => LOCALES[lang()].utcFormat(spec);
const names = () => NAMES[lang()];

export const wall = (d) => new Date(d.getTime() - OFFSET_MS);
export const fmtTime = (d) => fmt(PATTERNS[lang()].time)(wall(d));
export const fmtClock = (d) => fmt('%-I:%M:%S %p')(wall(d));
/** "vie 9 oct" / "Fri Oct 9": the local day, also used to group events by day. */
export function fmtDay(d) {
  const w = wall(d), n = names();
  const day = n.shortDays[w.getUTCDay()], mon = n.shortMonths[w.getUTCMonth()];
  return lang() === 'en' ? `${day} ${mon} ${w.getUTCDate()}` : `${day} ${w.getUTCDate()} ${mon}`;
}
export const fmtMag = d3.format('.1f');
export const fmtInt = d3.format(',');
export const fmtRate = (v) => (v >= 10 ? d3.format('.0f')(v) : d3.format('.1f')(v));

/** "3 h" / "2 días": how long, without "ago". */
export function duration(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return t('dur.days', Math.floor(s / 86400));
}

export function ago(d, now = new Date()) {
  return (now - d) < 60e3 ? t('ago.now') : t('ago', duration(now - d));
}

/** Tick label for a wall-clock date: the day at midnight, else the hour. */
export const tickLabel = (d) => (d.getUTCHours() === 0 ? `${names().shortDays[d.getUTCDay()]} ${d.getUTCDate()}` : fmt('%-I %p')(d));

export const fmtPct = (p) => {
  const sp = lang() === 'en' ? '' : ' ';
  return p >= 0.995 ? `>99${sp}%` : p < 0.01 ? `<1${sp}%` : `${Math.round(p * 100)}${sp}%`;
};
