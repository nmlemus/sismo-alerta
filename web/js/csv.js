// CSV export of the events table. Pure, so it can be unit tested without a browser.

import { emscLink } from './emsc.js';

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows: [{ ev, km, mmi }] as in the table; fmtLocal formats a Date in Panama time. */
export function buildCsv(rows, ref, fmtLocal) {
  const header = ['id', 'hora_utc', 'hora_panama', 'latitud', 'longitud', 'profundidad_km', 'magnitud', 'tipo_magnitud', 'agencia', 'lugar',
    `distancia_km_${ref.name}`, `intensidad_estimada_${ref.name}`, 'ficha_emsc'];
  const lines = [header.map(cell).join(',')];
  for (const r of [...rows].sort((a, b) => a.ev.t - b.ev.t)) {
    const e = r.ev;
    lines.push([e.id, e.t.toISOString(), fmtLocal(e.t), e.lat, e.lon, e.depth, e.mag, e.magType, e.agency, e.place,
      Math.round(r.km), r.mmi.toFixed(1), emscLink(e)].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
