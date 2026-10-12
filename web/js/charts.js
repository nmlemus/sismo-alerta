// d3 charts. Each draw function clears its container and redraws at its current width.

import { MMI_COLORS, ROMAN, describeMmi, mmiLevel } from './intensity.js';
import { DAY_COLORS, MAIN_COLOR, fmtDay, fmtMag, fmtTime, tickLabel, wall } from './format.js';

const d3 = globalThis.d3;

export const radiusFor = (m) => 1.8 + Math.max(0, m - 2.5) * 1.5;

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
      lines.forEach((l, i) => tip.append('div').attr('class', i === 0 ? 'tip-h' : null).text(l));
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
  const step = W < 520 ? 12 : 6;
  const span = (x.domain()[1] - x.domain()[0]) / 3600e3;
  const every = span > 24 * 6 ? 24 : span > 24 * 3 ? 12 : step;
  for (const t of x.ticks(d3.utcHour.every(every))) {
    svg.append('text').attr('class', `tick${t.getUTCHours() === 0 ? ' strong' : ''}`)
      .attr('x', x(t)).attr('y', y0 + 18).attr('text-anchor', 'middle').text(tickLabel(t));
  }
  svg.append('line').attr('class', 'axis').attr('x1', x.range()[0]).attr('x2', x.range()[1]).attr('y1', y0).attr('y2', y0);
}

/** Every event: time vs magnitude. */
export function drawTimeline(el, { seq, main, dayIndex }) {
  const { svg, W, H } = newSvg(el, 300);
  const all = [main, ...seq];
  const m = { l: textWidth(svg, '8', 'tick') + 14, r: 12, t: 14, b: 30 };
  const x = d3.scaleUtc([d3.utcHour.offset(wall(main.t), -1), d3.utcHour.offset(wall(d3.max(all, (d) => d.t)), 1)], [m.l, W - m.r]);
  const y = d3.scaleLinear([2.3, Math.max(8.1, main.mag + 0.4)], [H - m.b, m.t]);
  yAxis(svg, y, [3, 4, 5, 6, 7, 8], m.l, W - m.r);
  timeAxis(svg, x, H - m.b, W);
  const color = (d) => (d === main ? MAIN_COLOR : DAY_COLORS[dayIndex(d) % DAY_COLORS.length]);
  const sorted = [...all].sort((a, b) => a.mag - b.mag);
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('cx', (d) => x(wall(d.t))).attr('cy', (d) => y(d.mag)).attr('r', (d) => radiusFor(d.mag))
    .attr('fill', color).attr('fill-opacity', (d) => (d === main ? 0.9 : 0.55)).attr('stroke', color);
  svg.append('text').attr('class', 'label strong').attr('x', x(wall(main.t)) + radiusFor(main.mag) + 6).attr('y', y(main.mag)).attr('dy', '0.32em')
    .text(`M${fmtMag(main.mag)} sismo principal`);
  const big = seq.length ? seq.reduce((a, b) => (b.mag > a.mag ? b : a)) : null;
  if (big) {
    svg.append('text').attr('class', 'label').attr('x', x(wall(big.t)) + radiusFor(big.mag) + 6).attr('y', y(big.mag)).attr('dy', '0.32em')
      .text(`M${fmtMag(big.mag)} mayor réplica`);
  }
  hover(el, svg, all, (d) => [x(wall(d.t)), y(d.mag)], (d) => [fmtTime(d.t), `M${fmtMag(d.mag)} (${d.magType}) · ${d.depth} km · ${d.agency}`, d.place], color, W);
}

function hover(el, svg, data, xy, lines, color, W) {
  if (!data.length) return;
  const tip = tooltip(el);
  const ring = svg.append('circle').attr('fill', 'none').attr('stroke-width', 2).attr('opacity', 0);
  const pts = data.map(xy);
  const del = d3.Delaunay.from(pts);
  svg.on('pointermove', (ev) => {
    const [px, py] = d3.pointer(ev);
    const i = del.find(px, py);
    const d = data[i];
    ring.attr('cx', pts[i][0]).attr('cy', pts[i][1]).attr('r', radiusFor(d.mag) + 3).attr('stroke', color(d)).attr('opacity', 1);
    const s = el.clientWidth / W;
    tip.show(lines(d), pts[i][0] * s, pts[i][1] * s);
  }).on('pointerleave', () => { tip.hide(); ring.attr('opacity', 0); });
}

/** Aftershocks per 6-hour window, with the M4+ part highlighted. */
export function drawWindows(el, { windows }) {
  const { svg, W, H } = newSvg(el, 250);
  const max = Math.max(1, d3.max(windows, (w) => w.count));
  const y = d3.scaleLinear([0, max], [H - 28, 20]).nice();
  const ticks = y.ticks(4);
  const m = { l: textWidth(svg, String(d3.max(ticks)), 'tick') + 12, r: 4 };
  yAxis(svg, y, ticks, m.l, W - m.r);
  const x = d3.scaleBand(windows.map((w) => w.label), [m.l, W - m.r]).padding(0.2);
  const every = x.bandwidth() < 24 ? Math.ceil(24 / x.bandwidth()) : 1;
  const tip = tooltip(el);
  windows.forEach((w, i) => {
    const open = i === windows.length - 1;
    const g = svg.append('g').attr('opacity', open ? 0.55 : 1);
    g.append('rect').attr('x', x(w.label)).attr('width', x.bandwidth()).attr('y', y(w.count)).attr('height', y(0) - y(w.count)).attr('rx', 3).attr('class', 'bar-all');
    g.append('rect').attr('x', x(w.label)).attr('width', x.bandwidth()).attr('y', y(w.m4)).attr('height', y(0) - y(w.m4)).attr('rx', 3).attr('class', 'bar-m4');
    if (i % every === 0) svg.append('text').attr('class', 'tick').attr('x', x(w.label) + x.bandwidth() / 2).attr('y', H - 8).attr('text-anchor', 'middle').text(`${w.start}h`);
    svg.append('rect').attr('x', x(w.label) - (x.step() * x.paddingInner()) / 2).attr('width', x.step()).attr('y', 0).attr('height', H - 28).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px, py] = d3.pointer(ev, el);
        tip.show([`${w.start}–${w.start + 6} h después del sismo principal${open ? ' (en curso)' : ''}`, `${w.count} réplicas, ${w.m4} de M4 o más`, w.maxMag == null ? '' : `Mayor: M${fmtMag(w.maxMag)}`].filter(Boolean), px, py);
      })
      .on('pointerleave', () => tip.hide());
  });
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0));
}

/** Aftershock counts by magnitude band (horizontal bars). */
export function drawBands(el, { bands }) {
  const rowH = 32;
  const { svg, W } = newSvg(el, bands.length * rowH + 6);
  const lw = d3.max(bands, (b) => textWidth(svg, `M${b.label}`, 'tick'));
  const m = { l: lw + 12, r: 40 };
  const x = d3.scaleLinear([0, Math.max(1, d3.max(bands, (b) => b.count))], [m.l, W - m.r]);
  bands.forEach((b, i) => {
    const yy = i * rowH + 4;
    svg.append('text').attr('class', 'tick').attr('x', m.l - 8).attr('y', yy + 11).attr('dy', '0.32em').attr('text-anchor', 'end').text(`M${b.label}`);
    svg.append('rect').attr('class', 'bar-band').attr('x', m.l).attr('y', yy + 1).attr('height', 20).attr('rx', 4).attr('width', Math.max(b.count ? 3 : 0, x(b.count) - m.l));
    svg.append('text').attr('class', 'tick strong').attr('x', x(b.count) + 6).attr('y', yy + 11).attr('dy', '0.32em').text(b.count);
  });
}

/** Estimated intensity at the reference point for every event. */
export function drawIntensity(el, { rows, ref }) {
  const { svg, W, H } = newSvg(el, 280);
  const m = { l: textWidth(svg, 'VII', 'tick') + 14, r: 12, t: 14, b: 30 };
  const maxLv = Math.max(5, d3.max(rows, (r) => mmiLevel(r.mmi)) + 1);
  const y = d3.scaleLinear([1, maxLv], [H - m.b, m.t]);
  const x = d3.scaleUtc([d3.utcHour.offset(wall(d3.min(rows, (r) => r.ev.t)), -1), d3.utcHour.offset(wall(d3.max(rows, (r) => r.ev.t)), 1)], [m.l, W - m.r]);
  yAxis(svg, y, d3.range(1, maxLv + 1), m.l, W - m.r, (v) => ROMAN[v]);
  timeAxis(svg, x, H - m.b, W);
  svg.append('line').attr('class', 'ref').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(2.5)).attr('y2', y(2.5));
  svg.append('text').attr('class', 'tick').attr('x', W - m.r).attr('y', y(2.5) - 5).attr('text-anchor', 'end').text('se siente dentro de casa');
  const color = (r) => MMI_COLORS[mmiLevel(r.mmi)];
  const sorted = [...rows].sort((a, b) => a.ev.mag - b.ev.mag);
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('cx', (r) => x(wall(r.ev.t))).attr('cy', (r) => y(r.mmi)).attr('r', (r) => radiusFor(r.ev.mag))
    .attr('fill', color).attr('fill-opacity', 0.85).attr('class', 'mmi-dot');
  const tip = tooltip(el);
  const pts = rows.map((r) => [x(wall(r.ev.t)), y(r.mmi)]);
  const del = d3.Delaunay.from(pts);
  svg.on('pointermove', (ev) => {
    const [px, py] = d3.pointer(ev);
    const i = del.find(px, py);
    const r = rows[i];
    const s = el.clientWidth / W;
    tip.show([fmtTime(r.ev.t), `M${fmtMag(r.ev.mag)} a ${Math.round(r.km)} km de ${ref.name}`, `Intensidad estimada: ${describeMmi(r.mmi)}`, r.ev.place], pts[i][0] * s, pts[i][1] * s);
  }).on('pointerleave', () => tip.hide());
}

export function dayLegend(el, days) {
  el.replaceChildren();
  const add = (color, label, ring) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    if (ring) i.style.border = `2px solid ${color}`;
    else i.style.background = color;
    s.append(i, document.createTextNode(label));
    el.append(s);
  };
  add(MAIN_COLOR, 'Sismo principal');
  days.forEach((d, i) => add(DAY_COLORS[i % DAY_COLORS.length], d));
  return add;
}

export { fmtDay };
