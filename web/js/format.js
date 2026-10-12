// Dates are shown in Panama time (UTC−5, no daylight saving). Charts work on
// "wall-clock" dates: the Panama local time stored in a Date's UTC fields,
// so d3's UTC scales and formats show local hours directly.

const d3 = globalThis.d3;
const OFFSET_MS = 5 * 3600e3;

export const wall = (d) => new Date(d.getTime() - OFFSET_MS);
export const fmtTime = (d) => d3.utcFormat('%-d %b, %-I:%M %p')(wall(d));
export const fmtClock = (d) => d3.utcFormat('%-I:%M:%S %p')(wall(d));
export const fmtDay = (d) => DAY_NAMES[wall(d).getUTCDay()] + ' ' + wall(d).getUTCDate() + ' ' + MONTHS[wall(d).getUTCMonth()];
export const fmtMag = d3.format('.1f');
export const fmtInt = d3.format(',');
export const fmtRate = (v) => (v >= 10 ? d3.format('.0f')(v) : d3.format('.1f')(v));

const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

d3.timeFormatDefaultLocale({
  dateTime: '%A, %e de %B de %Y, %X', date: '%d/%m/%Y', time: '%H:%M:%S', periods: ['a. m.', 'p. m.'],
  days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  shortDays: DAY_NAMES,
  months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  shortMonths: MONTHS,
});

export function ago(d, now = new Date()) {
  const s = Math.max(0, (now - d) / 1000);
  if (s < 60) return 'hace segundos';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  const days = Math.floor(s / 86400);
  return `hace ${days} día${days === 1 ? '' : 's'}`;
}

/** Tick label for a wall-clock date: the day at midnight, else the hour. */
export const tickLabel = (d) => (d.getUTCHours() === 0 ? fmtDayWall(d) : d3.utcFormat('%-I %p')(d));
const fmtDayWall = (d) => `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()}`;

export const fmtPct = (p) => (p >= 0.995 ? '>99 %' : p < 0.01 ? '<1 %' : `${Math.round(p * 100)} %`);
