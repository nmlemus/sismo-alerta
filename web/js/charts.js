// d3 charts. Each draw function clears its container and redraws at its current width.
// Colors: series and MMI colors are CSS variables / the USGS ShakeMap scale; text uses ink tokens.

import { LABEL_ES, MMI_COLORS, ROMAN, describeMmi, mmiAww2014, mmiLevel } from './intensity.js';
import { fmtInt, fmtMag, fmtTime, tickLabel, wall } from './format.js';
import { token } from './theme.js';

const d3 = globalThis.d3;

export const radiusFor = (m) => 2 + Math.max(0, m - 2.5) * 1.5;

function newSvg(el, H) {
  el.querySelectorAll('svg, .tip').forEach((n) => n.remove());
  const W = Math.max(260, el.clientWidth);
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`);
  return { svg, W, H };
}

function textWidth(svg, text, cls) {
  const t = svg.append('text').attr('class', cls || null).text(text);
  const w = t.node().getComputedTextLength();
  t.remove();
  return w;
}

export function tooltip(el) {
  const tip = d3.select(el).append('div').attr('class', 'tip').attr('role', 'status');
  return {
    show(lines, x, y) {
      tip.selectAll('*').remove();
      lines.forEach((l, i) => {
        const row = tip.append('div').attr('class', i === 0 ? 'tip-h' : null);
        if (Array.isArray(l)) { row.append('i').attr('class', 'sw').style('background', l[0]); row.append('span').text(l[1]); } else row.text(l);
      });
      tip.style('opacity', 1);
      const n = tip.node(), tw = n.offsetWidth, th = n.offsetHeight, W = el.clientWidth;
      let left = x + 12;
      if (left + tw > W) left = x - tw - 12;
      let top = y - th - 10;
      if (top < 0) top = y + 14;
      tip.style('left', `${Math.max(0, left)}px`).style('top', `${top}px`);
    },
    hide() { tip.style('opacity', 0); },
  };
}

function yAxis(svg, y, ticks, x0, x1, fmt = String) {
  const g = svg.append('g');
  for (const v of ticks) {
    g.append('line').attr('class', 'grid').attr('x1', x0).attr('x2', x1).attr('y1', y(v)).attr('y2', y(v));
    g.append('text').attr('class', 'tick').attr('x', x0 - 6).attr('y', y(v)).attr('dy', '0.32em').attr('text-anchor', 'end').text(fmt(v));
  }
}

function timeAxis(svg, x, y0, W) {
  // Smallest step (hours) that leaves ~64 px per label.
  const span = (x.domain()[1] - x.domain()[0]) / 3600e3;
  const plot = x.range()[1] - x.range()[0];
  const every = [6, 12, 24, 48, 168].find((h) => (span / h) * 64 <= plot) || 168;
  for (const t of x.ticks(d3.utcHour.every(every))) {
    svg.append('text').attr('class', `tick${t.getUTCHours() === 0 ? ' strong' : ''}`)
      .attr('x', x(t)).attr('y', y0 + 18).attr('text-anchor', 'middle').text(tickLabel(t));
  }
  svg.append('line').attr('class', 'axis').attr('x1', x.range()[0]).attr('x2', x.range()[1]).attr('y1', y0).attr('y2', y0);
}

/** Vertical bar with only its data end (top) rounded. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function nearestHover(el, svg, pts, onShow) {
  const tip = tooltip(el);
  const ring = svg.append('circle').attr('class', 'hover-ring').attr('opacity', 0);
  const del = d3.Delaunay.from(pts.map((p) => [p.x, p.y]));
  const W = Number(svg.attr('width'));
  svg.on('pointermove', (ev) => {
    const [px, py] = d3.pointer(ev);
    const p = pts[del.find(px, py)];
    ring.attr('cx', p.x).attr('cy', p.y).attr('r', p.r + 3).attr('opacity', 1);
    const s = el.clientWidth / W;
    tip.show(onShow(p.d), p.x * s, p.y * s);
  }).on('pointerleave', () => { tip.hide(); ring.attr('opacity', 0); });
}

/**
 * Every event, by time and magnitude: a stem and a dot per earthquake, colored by
 * local day; the mainshock in red. With showPre, the week before appears in gray
 * to the left of a line at the mainshock.
 */
export function drawTimeline(el, { seq, main, pre, showPre, dayIndex, palette, preDays }) {
  const { svg, W, H } = newSvg(el, 320);
  const before = showPre ? pre : [];
  const all = [...before, main, ...seq];
  const m = { l: textWidth(svg, '8', 'tick') + 14, r: 12, t: 16, b: 30 };
  const x0 = showPre ? d3.utcDay.offset(wall(main.t), -preDays) : d3.utcHour.offset(wall(main.t), -1);
  const x = d3.scaleUtc([x0, d3.utcHour.offset(wall(d3.max(all, (d) => d.t)), 1)], [m.l, W - m.r]);
  const y = d3.scaleLinear([2.3, Math.max(8.1, main.mag + 0.4)], [H - m.b, m.t]);
  yAxis(svg, y, [3, 4, 5, 6, 7, 8], m.l, W - m.r);
  timeAxis(svg, x, H - m.b, W);
  if (showPre) {
    const xm = x(wall(main.t));
    svg.append('line').attr('class', 'ref').attr('x1', xm).attr('x2', xm).attr('y1', m.t).attr('y2', H - m.b);
    svg.append('text').attr('class', 'tick').attr('x', xm - 6).attr('y', m.t + 4).attr('text-anchor', 'end').text(`← ${preDays} días antes del sismo principal`);
  }
  const colorOf = (d) => (d === main ? token('--main') : d.t < main.t ? token('--pre') : palette.colorOf(dayIndex(d)));
  const sorted = [...all].sort((a, b) => a.mag - b.mag);
  svg.append('g').selectAll('line').data(sorted).join('line').attr('class', 'stem')
    .attr('x1', (d) => x(wall(d.t))).attr('x2', (d) => x(wall(d.t))).attr('y1', H - m.b).attr('y2', (d) => y(d.mag))
    .attr('stroke', colorOf);
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('class', (d) => (d === main ? 'dot main' : 'dot day'))
    .attr('cx', (d) => x(wall(d.t))).attr('cy', (d) => y(d.mag)).attr('r', (d) => radiusFor(d.mag))
    .attr('fill', colorOf);
  svg.append('text').attr('class', 'label strong').attr('x', x(wall(main.t)) + radiusFor(main.mag) + 6).attr('y', y(main.mag)).attr('dy', '0.32em')
    .text(`M${fmtMag(main.mag)} sismo principal`);
  const big = seq.length ? seq.reduce((a, b) => (b.mag > a.mag ? b : a)) : null;
  if (big) {
    svg.append('text').attr('class', 'label').attr('x', x(wall(big.t)) + radiusFor(big.mag) + 6).attr('y', y(big.mag)).attr('dy', '0.32em')
      .text(`M${fmtMag(big.mag)} mayor réplica`);
  }
  nearestHover(el, svg, all.map((d) => ({ d, x: x(wall(d.t)), y: y(d.mag), r: radiusFor(d.mag) })),
    (d) => [fmtTime(d.t), `M${fmtMag(d.mag)} (${d.magType}) · ${d.depth} km · ${d.agency}`, d.place + (d.t < main.t ? ' · antes del sismo principal' : '')]);
}

/** Legend items shared by the timeline (and the same colors as the map). */
export function dayLegend(el, { palette, showPre, preDays }) {
  el.replaceChildren();
  const add = (color, label) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = color;
    s.append(i, document.createTextNode(label));
    el.append(s);
  };
  add('var(--main)', 'Sismo principal');
  for (const d of palette.legend) add(d.color, d.label);
  if (showPre) add('var(--pre)', `${preDays} días antes`);
}

/**
 * Aftershocks per 6-hour window, M4+ stacked under the smaller ones. Windows with a
 * negative start are the week before the mainshock (shown only when asked).
 */
export function drawWindows(el, { windows }) {
  const { svg, W, H } = newSvg(el, 250);
  const y = d3.scaleLinear([0, Math.max(1, d3.max(windows, (w) => w.count))], [H - 28, 16]).nice();
  const ticks = y.ticks(4);
  const m = { l: textWidth(svg, String(d3.max(ticks)), 'tick') + 12, r: 4 };
  yAxis(svg, y, ticks, m.l, W - m.r);
  const x = d3.scaleBand(windows.map((w) => w.label), [m.l, W - m.r]).padding(windows.length > 24 ? 0.15 : 0.25);
  const minLabelPx = 30;
  const every = Math.max(1, Math.ceil(minLabelPx / x.step()));
  const tip = tooltip(el);
  const zeroIdx = windows.findIndex((w) => w.start === 0);
  windows.forEach((w, i) => {
    const open = i === windows.length - 1;
    const g = svg.append('g').attr('class', open ? 'open' : null);
    const bx = x(w.label), bw = x.bandwidth();
    const yM4 = y(w.m4), yAll = y(w.count);
    const gap = w.m4 > 0 && w.count > w.m4 ? 2 : 0;
    g.append('path').attr('class', 'bar s2').attr('d', barPath(bx, yM4, bw, y(0) - yM4, w.count > w.m4 ? 0 : 4));
    g.append('path').attr('class', 'bar s1').attr('d', barPath(bx, yAll, bw, yM4 - yAll - gap));
    if ((i - Math.max(0, zeroIdx)) % every === 0) {
      const abs = Math.abs(w.start);
      const lbl = w.start === 0 ? '0' : `${w.start > 0 ? '' : '−'}${abs >= 48 && abs % 24 === 0 ? `${abs / 24}d` : `${abs}h`}`;
      svg.append('text').attr('class', `tick${w.start === 0 ? ' strong' : ''}`).attr('x', bx + bw / 2).attr('y', H - 8).attr('text-anchor', 'middle').text(lbl);
    }
    svg.append('rect').attr('x', bx - (x.step() * x.paddingInner()) / 2).attr('width', x.step()).attr('y', 0).attr('height', H - 28).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px, py] = d3.pointer(ev, el);
        const when = w.start < 0
          ? `${Math.abs(w.start)}–${Math.abs(w.start + 6)} h antes del sismo principal`
          : `${w.start}–${w.start + 6} h después del sismo principal${open ? ' (en curso)' : ''}`;
        tip.show([
          when,
          [token('--series-1'), `${w.count - w.m4} de M2.5–3.9`],
          [token('--series-2'), `${w.m4} de M4 o más`],
          w.maxMag == null ? 'Sin sismos' : `Mayor: M${fmtMag(w.maxMag)}`,
        ], px, py);
      })
      .on('pointerleave', () => tip.hide());
  });
  if (zeroIdx > 0) {
    const xz = x(windows[zeroIdx].label) - (x.step() * x.paddingInner()) / 2;
    svg.append('line').attr('class', 'ref').attr('x1', xz).attr('x2', xz).attr('y1', 10).attr('y2', H - 28);
    svg.append('text').attr('class', 'tick').attr('x', xz + 4).attr('y', 12).text('sismo principal');
  }
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0));
}

/** Running total of aftershocks: all of them and M4+ (step lines). */
export function drawCumulative(el, { seq, main, now }) {
  const { svg, W, H } = newSvg(el, 250);
  const series = [
    { cls: 's1', label: 'Todas', pts: seq },
    { cls: 's2', label: 'M4+', pts: seq.filter((e) => e.mag >= 4) },
  ].map((s) => ({ ...s, steps: [{ t: main.t, n: 0 }, ...s.pts.map((e, i) => ({ t: e.t, n: i + 1 })), { t: new Date(now), n: s.pts.length }] }));
  const maxN = Math.max(1, seq.length);
  const y = d3.scaleLinear([0, maxN], [H - 28, 16]).nice();
  const ticks = y.ticks(4);
  const endW = d3.max(series, (s) => textWidth(svg, `${s.label} ${fmtInt(s.pts.length)}`, 'label strong')) + 18;
  const m = { l: textWidth(svg, fmtInt(d3.max(ticks)), 'tick') + 12, r: endW };
  const x = d3.scaleUtc([wall(main.t), wall(new Date(now))], [m.l, W - m.r]);
  yAxis(svg, y, ticks, m.l, W - m.r, fmtInt);
  timeAxis(svg, x, H - 28, W);
  const line = d3.line((p) => x(wall(p.t)), (p) => y(p.n)).curve(d3.curveStepAfter);
  const ends = [];
  for (const s of series) {
    svg.append('path').attr('class', `line ${s.cls}`).attr('d', line(s.steps));
    ends.push({ s, y: y(s.pts.length) });
  }
  // End labels: colored mark + ink text, nudged apart if they collide.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) {
    const gx = W - m.r + 6;
    svg.append('line').attr('class', `line ${e.s.cls}`).attr('x1', gx).attr('x2', gx + 8).attr('y1', e.y).attr('y2', e.y);
    svg.append('text').attr('class', 'label strong').attr('x', gx + 12).attr('y', e.y).attr('dy', '0.32em').text(`${e.s.label} ${fmtInt(e.s.pts.length)}`);
  }
  // Crosshair + tooltip.
  const tip = tooltip(el);
  const rule = svg.append('line').attr('class', 'crosshair').attr('y1', 16).attr('y2', H - 28).attr('opacity', 0);
  const bis = d3.bisector((p) => p.t).right;
  svg.on('pointermove', (ev) => {
    const [px] = d3.pointer(ev);
    if (px < m.l || px > W - m.r) { tip.hide(); rule.attr('opacity', 0); return; }
    const tw = x.invert(px);
    const t = new Date(tw.getTime() + 5 * 3600e3);
    const vals = series.map((s) => s.steps[Math.max(0, bis(s.steps, t) - 1)].n);
    rule.attr('x1', px).attr('x2', px).attr('opacity', 1);
    const sc = el.clientWidth / W;
    tip.show([fmtTime(t), [token('--series-1'), `${fmtInt(vals[0])} réplicas en total`], [token('--series-2'), `${fmtInt(vals[1])} de M4 o más`]], px * sc, 40);
  }).on('pointerleave', () => { tip.hide(); rule.attr('opacity', 0); });
}

/** Aftershock counts by magnitude band (horizontal bars, one series). */
export function drawBands(el, { bands }) {
  const rowH = 30;
  const { svg, W } = newSvg(el, bands.length * rowH + 6);
  const lw = d3.max(bands, (b) => textWidth(svg, `M${b.label}`, 'tick'));
  const m = { l: lw + 12, r: 40 };
  const x = d3.scaleLinear([0, Math.max(1, d3.max(bands, (b) => b.count))], [m.l, W - m.r]);
  bands.forEach((b, i) => {
    const yy = i * rowH + 4;
    svg.append('text').attr('class', 'tick').attr('x', m.l - 8).attr('y', yy + 10).attr('dy', '0.32em').attr('text-anchor', 'end').text(`M${b.label}`);
    if (b.count) svg.append('rect').attr('class', 'bar s1').attr('x', m.l).attr('y', yy).attr('height', 20).attr('rx', 4).attr('width', Math.max(4, x(b.count) - m.l));
    svg.append('text').attr('class', 'tick strong').attr('x', x(b.count) + 6).attr('y', yy + 10).attr('dy', '0.32em').text(fmtInt(b.count));
  });
}

/** Estimated intensity at the reference point for every event (USGS ShakeMap colors). */
export function drawIntensity(el, { rows, ref }) {
  const { svg, W, H } = newSvg(el, 270);
  const m = { l: textWidth(svg, 'VIII', 'tick') + 14, r: 12, t: 14, b: 30 };
  const maxLv = Math.max(5, d3.max(rows, (r) => mmiLevel(r.mmi)) + 1);
  const y = d3.scaleLinear([1, maxLv], [H - m.b, m.t]);
  const x = d3.scaleUtc([d3.utcHour.offset(wall(d3.min(rows, (r) => r.ev.t)), -1), d3.utcHour.offset(wall(d3.max(rows, (r) => r.ev.t)), 1)], [m.l, W - m.r]);
  yAxis(svg, y, d3.range(1, maxLv + 1), m.l, W - m.r, (v) => ROMAN[v]);
  timeAxis(svg, x, H - m.b, W);
  svg.append('line').attr('class', 'ref').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(2.5)).attr('y2', y(2.5));
  svg.append('text').attr('class', 'tick').attr('x', W - m.r).attr('y', y(2.5) - 5).attr('text-anchor', 'end').text('desde aquí se siente dentro de casa');
  const sorted = [...rows].sort((a, b) => a.ev.mag - b.ev.mag);
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('class', 'dot mmi').attr('fill', (r) => MMI_COLORS[mmiLevel(r.mmi)])
    .attr('cx', (r) => x(wall(r.ev.t))).attr('cy', (r) => y(r.mmi)).attr('r', (r) => radiusFor(r.ev.mag));
  nearestHover(el, svg, rows.map((r) => ({ d: r, x: x(wall(r.ev.t)), y: y(r.mmi), r: radiusFor(r.ev.mag) })),
    (r) => [fmtTime(r.ev.t), `M${fmtMag(r.ev.mag)} a ${Math.round(r.km)} km de ${ref.name}`, `Intensidad estimada: ${describeMmi(r.mmi)}`, r.ev.place]);
}

/**
 * What people reported to USGS "Did You Feel It?" for the mainshock, town by town,
 * against the intensity model without local adjustment. The selected town is ringed.
 */
export function drawDyfi(el, { dyfi, main, refRow }) {
  const { svg, W, H } = newSvg(el, 280);
  const m = { l: textWidth(svg, 'VIII', 'tick') + 14, r: 14, t: 14, b: 34 };
  const maxKm = Math.max(50, d3.max(dyfi, (d) => d.hypoKm) + 10);
  const x = d3.scaleLinear([0, maxKm], [m.l, W - m.r]).nice();
  const y = d3.scaleLinear([2, 9], [H - m.b, m.t]);
  yAxis(svg, y, d3.range(2, 10), m.l, W - m.r, (v) => ROMAN[v]);
  for (const v of x.ticks(W < 480 ? 4 : 7)) svg.append('text').attr('class', 'tick').attr('x', x(v)).attr('y', H - m.b + 18).attr('text-anchor', 'middle').text(v);
  svg.append('text').attr('class', 'tick').attr('x', W - m.r).attr('y', H - 2).attr('text-anchor', 'end').text('distancia al hipocentro (km)');
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', H - m.b).attr('y2', H - m.b);
  const curve = d3.range(5, maxKm + 1, 5).map((km) => ({ km, mmi: mmiAww2014(main.mag, km) })).filter((p) => p.mmi >= 2 && p.mmi <= 9);
  svg.append('path').attr('class', 'model').attr('d', d3.line((p) => x(p.km), (p) => y(p.mmi))(curve));
  const last = curve[curve.length - 1];
  if (last) svg.append('text').attr('class', 'tick').attr('x', x(last.km) - 4).attr('y', y(last.mmi) + 14).attr('text-anchor', 'end').text('modelo');
  const r = d3.scaleSqrt([1, d3.max(dyfi, (d) => d.n)], [3, 12]);
  const sorted = [...dyfi].sort((a, b) => b.n - a.n);
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('class', 'dot mmi').attr('fill', (d) => MMI_COLORS[mmiLevel(d.cdi)])
    .attr('cx', (d) => x(d.hypoKm)).attr('cy', (d) => y(d.cdi)).attr('r', (d) => r(d.n));
  if (refRow) {
    svg.append('circle').attr('class', 'sel-ring').attr('cx', x(refRow.hypoKm)).attr('cy', y(refRow.cdi)).attr('r', r(refRow.n) + 4);
    const right = x(refRow.hypoKm) < W * 0.7;
    svg.append('text').attr('class', 'label strong').attr('x', x(refRow.hypoKm) + (right ? 1 : -1) * (r(refRow.n) + 8)).attr('y', y(refRow.cdi)).attr('dy', '0.32em')
      .attr('text-anchor', right ? 'start' : 'end').text(refRow.name);
  }
  nearestHover(el, svg, dyfi.map((d) => ({ d, x: x(d.hypoKm), y: y(d.cdi), r: r(d.n) })),
    (d) => [`${d.name}, ${d.province}`, `Reportado: ${ROMAN[mmiLevel(d.cdi)]} (${d.cdi.toFixed(1)}) · ${fmtInt(d.n)} reporte${d.n === 1 ? '' : 's'}`,
      `Modelo: ${mmiAww2014(main.mag, d.hypoKm).toFixed(1)} a ${Math.round(d.hypoKm)} km`]);
}

/** Legend for the Modified Mercalli scale (USGS ShakeMap colors). */
export function mmiLegend(el, from = 1, to = 8) {
  el.replaceChildren();
  for (let lv = from; lv <= to; lv++) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.className = 'sw';
    i.style.background = MMI_COLORS[lv];
    s.append(i, document.createTextNode(`${ROMAN[lv]} ${LABEL_ES[lv]}`));
    el.append(s);
  }
}

