// d3 charts. Each draw function clears its container and redraws at its current width.
// Colors: series and MMI colors are CSS variables / the USGS ShakeMap scale; text uses ink tokens.

import { MMI_COLORS, ROMAN, describeMmi, mmiAww2014, mmiLabel, mmiLevel } from './intensity.js';
import { fmtInt, fmtMag, fmtRate, fmtTime, tickLabel, wall } from './format.js';
import { token } from './theme.js';
import { emscLink } from './emsc.js';
import { localName, t } from './i18n.js';
import { byHour, localHour } from './stats.js';

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
        if (Array.isArray(l)) { row.append('i').attr('class', 'sw').style('background', l[0]); row.append('span').text(l[1]); }
        else if (l && l.href) row.append('a').attr('href', l.href).attr('target', '_blank').attr('rel', 'noopener').text(l.text);
        else if (l && l.hint) row.attr('class', 'tip-hint').text(l.hint);
        else row.text(l);
      });
      tip.style('opacity', 1);
      const n = tip.node(), tw = n.offsetWidth, th = n.offsetHeight, W = el.clientWidth;
      let left = x + 12;
      if (left + tw > W) left = x - tw - 12;
      let top = y - th - 10;
      if (top < 0) top = y + 14;
      tip.style('left', `${Math.max(0, left)}px`).style('top', `${top}px`);
    },
    hide() { tip.style('opacity', 0).classed('pinned', false); },
    /** Keep it open and clickable (touch screens, where there is no hover). */
    pin() { tip.classed('pinned', true); },
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
  const every = [1, 2, 3, 6, 12, 24, 48, 168].find((h) => (span / h) * 64 <= plot) || 168;
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

/**
 * Tooltip for the point nearest the pointer. With linkOf, each point opens a page:
 * a mouse click goes straight there; a tap (no hover on touch screens) pins the
 * tooltip with the link inside it.
 */
function nearestHover(el, svg, pts, onShow, linkOf, { top = -Infinity } = {}) {
  const tip = tooltip(el);
  const ring = svg.append('circle').attr('class', 'hover-ring').attr('opacity', 0);
  const del = d3.Delaunay.from(pts.map((p) => [p.x, p.y]));
  const W = Number(svg.attr('width'));
  let pinned = false, pointerType = 'mouse';
  const nearest = (ev) => { const [px, py] = d3.pointer(ev); return pts[del.find(px, py)]; };
  const show = (p, withLink) => {
    ring.attr('cx', p.x).attr('cy', p.y).attr('r', p.r + 3).attr('opacity', 1);
    const s = el.clientWidth / W;
    const lines = onShow(p.d);
    if (linkOf) lines.push(withLink ? { href: linkOf(p.d), text: t('q.link') } : { hint: t('tip.click') });
    tip.show(lines, p.x * s, p.y * s);
  };
  const unpin = () => { pinned = false; tip.hide(); ring.attr('opacity', 0); };
  svg.on('pointerdown', (ev) => { pointerType = ev.pointerType || 'mouse'; })
    .on('pointermove', (ev) => {
      if (pinned || ev.pointerType === 'touch') return;
      if (d3.pointer(ev)[1] < top) { tip.hide(); ring.attr('opacity', 0); return; }
      show(nearest(ev), false);
    })
    .on('pointerleave', () => { if (!pinned) unpin(); });
  if (!linkOf) {
    // Without links, a tap just shows the tooltip.
    svg.on('click', (ev) => { if (pointerType === 'touch' && d3.pointer(ev)[1] >= top) show(nearest(ev), false); });
    return;
  }
  svg.style('cursor', 'pointer').on('click', (ev) => {
    if (d3.pointer(ev)[1] < top) return;
    const p = nearest(ev);
    if (pointerType !== 'touch') { window.open(linkOf(p.d), '_blank', 'noopener'); return; }
    pinned = true;
    show(p, true);
    tip.pin();
    ev.stopPropagation();
  });
  document.addEventListener('click', (ev) => { if (pinned && !el.contains(ev.target)) unpin(); });
}

/**
 * Every event, by time and magnitude: a stem and a dot per earthquake, colored by
 * local day; the mainshock in red. With showPre, the week before appears in gray
 * to the left of a line at the mainshock. With a period filter (`from`), the axis
 * covers that window up to now and only the events passed in are drawn.
 */
export function drawTimeline(el, { seq, main, pre, showPre, dayIndex, palette, preDays, from, now, mainIn = true, big }) {
  const { svg, W, H } = newSvg(el, 320);
  const before = showPre ? pre : [];
  const all = [...before, ...(mainIn ? [main] : []), ...seq];
  const m = { l: textWidth(svg, '8', 'tick') + 14, r: 12, t: 16, b: 30 };
  const x0 = from ? wall(from) : showPre ? d3.utcDay.offset(wall(main.t), -preDays) : d3.utcHour.offset(wall(main.t), -1);
  const x1 = from || !all.length ? wall(new Date(now)) : d3.utcHour.offset(wall(d3.max(all, (d) => d.t)), 1);
  const x = d3.scaleUtc([x0, x1], [m.l, W - m.r]);
  const y = d3.scaleLinear([2.3, Math.max(8.1, main.mag + 0.4)], [H - m.b, m.t]);
  yAxis(svg, y, [3, 4, 5, 6, 7, 8], m.l, W - m.r);
  timeAxis(svg, x, H - m.b, W);
  if (showPre) {
    const xm = x(wall(main.t));
    svg.append('line').attr('class', 'ref').attr('x1', xm).attr('x2', xm).attr('y1', m.t).attr('y2', H - m.b);
    svg.append('text').attr('class', 'tick').attr('x', xm - 6).attr('y', m.t + 4).attr('text-anchor', 'end').text(t('tl.pre', preDays));
  }
  if (!all.length) {
    svg.append('text').attr('class', 'label').attr('x', (m.l + W - m.r) / 2).attr('y', (m.t + H - m.b) / 2).attr('text-anchor', 'middle').text(t('f.empty'));
    return;
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
  if (mainIn) {
    svg.append('text').attr('class', 'label strong').attr('x', x(wall(main.t)) + radiusFor(main.mag) + 6).attr('y', y(main.mag)).attr('dy', '0.32em')
      .text(t('tl.mainLbl', fmtMag(main.mag)));
  }
  // Label the largest aftershock of the whole sequence, only if it is on screen.
  if (big && seq.includes(big)) {
    svg.append('text').attr('class', 'label').attr('x', x(wall(big.t)) + radiusFor(big.mag) + 6).attr('y', y(big.mag)).attr('dy', '0.32em')
      .text(t('tl.bigLbl', fmtMag(big.mag)));
  }
  nearestHover(el, svg, all.map((d) => ({ d, x: x(wall(d.t)), y: y(d.mag), r: radiusFor(d.mag) })),
    (d) => [fmtTime(d.t), `M${fmtMag(d.mag)} (${d.magType}) · ${d.depth} km · ${d.agency}`, d.place + (d.t < main.t ? t('tip.beforeMain') : '')], emscLink);
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
  add('var(--main)', t('leg.main'));
  for (const d of palette.legend) add(d.color, d.label);
  if (showPre) add('var(--pre)', t('leg.preDays', preDays));
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
          ? t('win.before', Math.abs(w.start), Math.abs(w.start + 6))
          : t('win.after', w.start, w.start + 6, open);
        tip.show([
          when,
          [token('--series-1'), t('win.small', w.count - w.m4)],
          [token('--series-2'), t('win.m4', w.m4)],
          w.maxMag == null ? t('win.none') : t('win.max', fmtMag(w.maxMag)),
        ], px, py);
      })
      .on('pointerleave', () => tip.hide());
  });
  if (zeroIdx > 0) {
    const xz = x(windows[zeroIdx].label) - (x.step() * x.paddingInner()) / 2;
    svg.append('line').attr('class', 'ref').attr('x1', xz).attr('x2', xz).attr('y1', 10).attr('y2', H - 28);
    svg.append('text').attr('class', 'tick').attr('x', xz + 4).attr('y', 12).text(t('win.main'));
  }
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0));
}

/** Running total of aftershocks: all of them and M4+ (step lines). */
export function drawCumulative(el, { seq, main, now }) {
  const { svg, W, H } = newSvg(el, 250);
  const series = [
    { cls: 's1', label: t('cum.all'), pts: seq },
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
    tip.show([fmtTime(t), [token('--series-1'), t('cum.tipAll', fmtInt(vals[0]))], [token('--series-2'), t('win.m4', fmtInt(vals[1]))]], px * sc, 40);
  }).on('pointerleave', () => { tip.hide(); rule.attr('opacity', 0); });
}

/**
 * Frequency over time and what it is made of, as three panels on one time axis
 * (never two y-scales on one plot): earthquakes per hour (log scale, all and M4+),
 * mean magnitude, and mean estimated intensity at the reference point. Each point
 * covers the previous `windowH` hours.
 */
export function drawRate(el, { series, ref, main, now, windowH }) {
  const panels = [{ key: 'rate', h: 150 }, { key: 'mag', h: 90 }, { key: 'mmi', h: 90 }];
  const titleH = 22, gap = 16, axisH = 30;
  const total = panels.reduce((a, p) => a + titleH + p.h + gap, 0) - gap + axisH;
  const { svg, W, H } = newSvg(el, total);
  const last = series[series.length - 1];
  const rateLbl = (v) => `${fmtRate(v)}/h`;
  const ends = [[t('cum.all'), last ? rateLbl(last.rate) : ''], ['M4+', last ? rateLbl(last.rateM4) : '']];
  const endW = d3.max(ends, ([a, b]) => textWidth(svg, `${a} ${b}`, 'label strong')) + 18;
  const m = { l: textWidth(svg, 'VIII', 'tick') + 14, r: Math.max(endW, 44) };
  const x = d3.scaleUtc([wall(main.t), wall(new Date(now))], [m.l, W - m.r]);
  let top = 0;
  for (const p of panels) { p.y0 = top + titleH; p.y1 = p.y0 + p.h; top = p.y1 + gap; }
  const [P1, P2, P3] = panels;
  const title = (p, text) => svg.append('text').attr('class', 'tick strong').attr('x', m.l).attr('y', p.y0 - 8).text(text);
  const base = (p) => svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', p.y1).attr('y2', p.y1);
  const X = (d) => x(wall(d.t));

  // 1. earthquakes per hour, log scale
  const hi = Math.max(1, d3.max(series, (d) => d.rate) || 1) * 1.15;
  const y1 = d3.scaleLog([0.1, hi], [P1.y1, P1.y0]).clamp(true);
  yAxis(svg, y1, [0.1, 0.3, 1, 3, 10, 30, 100].filter((v) => v <= hi), m.l, W - m.r, (v) => String(v));
  title(P1, t('rate.p1'));
  base(P1);
  const lines1 = [
    { cls: 's1', get: (d) => d.rate, label: ends[0] },
    { cls: 's2', get: (d) => d.rateM4, label: ends[1] },
  ];
  for (const l of lines1) {
    svg.append('path').attr('class', `line ${l.cls}`)
      .attr('d', d3.line(X, (d) => y1(l.get(d))).defined((d) => l.get(d) > 0)(series));
  }
  // end labels: colored mark + ink text, nudged apart if they collide
  const labels = lines1.filter((l) => last && l.get(last) > 0).map((l) => ({ l, y: y1(l.get(last)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  for (const { l, y } of labels) {
    const gx = W - m.r + 6;
    svg.append('line').attr('class', `line ${l.cls}`).attr('x1', gx).attr('x2', gx + 8).attr('y1', y).attr('y2', y);
    svg.append('text').attr('class', 'label strong').attr('x', gx + 12).attr('y', y).attr('dy', '0.32em').text(`${l.label[0]} ${l.label[1]}`);
  }

  // 2. mean magnitude
  const mags = series.map((d) => d.meanMag).filter((v) => v != null);
  const y2 = d3.scaleLinear([Math.min(2.5, (d3.min(mags) ?? 3) - 0.2), Math.max(4, (d3.max(mags) ?? 4) + 0.2)], [P2.y1, P2.y0]).nice();
  yAxis(svg, y2, y2.ticks(3), m.l, W - m.r, (v) => v.toFixed(1));
  title(P2, t('rate.p2'));
  base(P2);
  svg.append('path').attr('class', 'line s1').attr('d', d3.line(X, (d) => y2(d.meanMag)).defined((d) => d.meanMag != null)(series));

  // 3. mean estimated intensity at the reference point
  const mmis = series.map((d) => d.meanMmi).filter((v) => v != null);
  const top3 = Math.max(4, Math.ceil((d3.max(mmis) ?? 3) + 0.5));
  const y3 = d3.scaleLinear([1, top3], [P3.y1, P3.y0]);
  yAxis(svg, y3, d3.range(1, top3 + 1), m.l, W - m.r, (v) => ROMAN[v]);
  title(P3, t('rate.p3', localName(ref)));
  svg.append('line').attr('class', 'ref').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y3(2.5)).attr('y2', y3(2.5));
  svg.append('text').attr('class', 'tick').attr('x', W - m.r).attr('y', y3(2.5) - 5).attr('text-anchor', 'end').text(t('int.indoors'));
  svg.append('path').attr('class', 'line s1').attr('d', d3.line(X, (d) => y3(d.meanMmi)).defined((d) => d.meanMmi != null)(series));
  timeAxis(svg, x, P3.y1, W);

  // crosshair + one tooltip for the three panels
  if (!series.length) return;
  const tip = tooltip(el);
  const rule = svg.append('line').attr('class', 'crosshair').attr('y1', P1.y0).attr('y2', P3.y1).attr('opacity', 0);
  const marks = [
    { y: (d) => (d.rate > 0 ? y1(d.rate) : null), c: '--series-1' },
    { y: (d) => (d.rateM4 > 0 ? y1(d.rateM4) : null), c: '--series-2' },
    { y: (d) => (d.meanMag != null ? y2(d.meanMag) : null), c: '--series-1' },
    { y: (d) => (d.meanMmi != null ? y3(d.meanMmi) : null), c: '--series-1' },
  ].map((k) => ({ ...k, dot: svg.append('circle').attr('class', 'hover-dot').attr('r', 4).attr('opacity', 0) }));
  const bis = d3.bisector((d) => X(d)).center;
  svg.on('pointermove', (ev) => {
    const [px, py] = d3.pointer(ev);
    if (px < m.l || px > W - m.r) return;
    const d = series[bis(series, px)];
    const cx = X(d);
    rule.attr('x1', cx).attr('x2', cx).attr('opacity', 1);
    for (const k of marks) {
      const cy = k.y(d);
      k.dot.attr('cx', cx).attr('cy', cy ?? 0).attr('fill', token(k.c)).attr('opacity', cy == null ? 0 : 1);
    }
    const sc = el.clientWidth / W;
    tip.show([
      fmtTime(d.t),
      t('rate.tipN', fmtInt(d.n), Math.round((d.t - d.from) / 3600e3) || windowH),
      [token('--series-1'), t('rate.tipAll', fmtRate(d.rate))],
      [token('--series-2'), t('rate.tipM4', fmtRate(d.rateM4))],
      t('rate.tipMag', d.meanMag == null ? '—' : d.meanMag.toFixed(1)),
      t('rate.tipMmi', localName(ref), d.meanMmi == null ? '—' : `${describeMmi(d.meanMmi)}, ${d.meanMmi.toFixed(1)}`),
    ], cx * sc, py * sc);
  }).on('pointerleave', () => { tip.hide(); rule.attr('opacity', 0); marks.forEach((k) => k.dot.attr('opacity', 0)); });
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
export function drawIntensity(el, { rows, ref, from, now }) {
  const { svg, W, H } = newSvg(el, 270);
  const m = { l: textWidth(svg, 'VIII', 'tick') + 14, r: 12, t: 14, b: 30 };
  const maxLv = Math.max(5, (d3.max(rows, (r) => mmiLevel(r.mmi)) || 0) + 1);
  const y = d3.scaleLinear([1, maxLv], [H - m.b, m.t]);
  const x = from || !rows.length
    ? d3.scaleUtc([wall(from || new Date(now - 24 * 3600e3)), wall(new Date(now))], [m.l, W - m.r])
    : d3.scaleUtc([d3.utcHour.offset(wall(d3.min(rows, (r) => r.ev.t)), -1), d3.utcHour.offset(wall(d3.max(rows, (r) => r.ev.t)), 1)], [m.l, W - m.r]);
  yAxis(svg, y, d3.range(1, maxLv + 1), m.l, W - m.r, (v) => ROMAN[v]);
  timeAxis(svg, x, H - m.b, W);
  svg.append('line').attr('class', 'ref').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(2.5)).attr('y2', y(2.5));
  svg.append('text').attr('class', 'tick').attr('x', W - m.r).attr('y', y(2.5) - 5).attr('text-anchor', 'end').text(t('int.indoors'));
  if (!rows.length) {
    svg.append('text').attr('class', 'label').attr('x', (m.l + W - m.r) / 2).attr('y', y(4)).attr('text-anchor', 'middle').text(t('f.empty'));
    return;
  }
  const sorted = [...rows].sort((a, b) => a.ev.mag - b.ev.mag);
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('class', 'dot mmi').attr('fill', (r) => MMI_COLORS[mmiLevel(r.mmi)])
    .attr('cx', (r) => x(wall(r.ev.t))).attr('cy', (r) => y(r.mmi)).attr('r', (r) => radiusFor(r.ev.mag));
  nearestHover(el, svg, rows.map((r) => ({ d: r, x: x(wall(r.ev.t)), y: y(r.mmi), r: radiusFor(r.ev.mag) })),
    (r) => [fmtTime(r.ev.t), t('int.tip', fmtMag(r.ev.mag), Math.round(r.km), localName(ref)), t('int.est', describeMmi(r.mmi)), r.ev.place], (r) => emscLink(r.ev));
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
  svg.append('text').attr('class', 'tick').attr('x', W - m.r).attr('y', H - 2).attr('text-anchor', 'end').text(t('dyfi.axis'));
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', H - m.b).attr('y2', H - m.b);
  const curve = d3.range(5, maxKm + 1, 5).map((km) => ({ km, mmi: mmiAww2014(main.mag, km) })).filter((p) => p.mmi >= 2 && p.mmi <= 9);
  svg.append('path').attr('class', 'model').attr('d', d3.line((p) => x(p.km), (p) => y(p.mmi))(curve));
  const last = curve[curve.length - 1];
  if (last) svg.append('text').attr('class', 'tick').attr('x', x(last.km) - 4).attr('y', y(last.mmi) + 14).attr('text-anchor', 'end').text(t('dyfi.model'));
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
    (d) => [`${d.name}, ${d.province}`, t('dyfi.tipRep', ROMAN[mmiLevel(d.cdi)], d.cdi.toFixed(1), fmtInt(d.n)),
      t('dyfi.tipModel', mmiAww2014(main.mag, d.hypoKm).toFixed(1), Math.round(d.hypoKm))]);
}

/** Legend for the Modified Mercalli scale (USGS ShakeMap colors). */
export function mmiLegend(el, from = 1, to = 8) {
  el.replaceChildren();
  for (let lv = from; lv <= to; lv++) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.className = 'sw';
    i.style.background = MMI_COLORS[lv];
    s.append(i, document.createTextNode(`${ROMAN[lv]} ${mmiLabel(lv)}`));
    el.append(s);
  }
}


/**
 * Depth section: every earthquake seen from the side, as if the ground were cut along
 * a line. axis 'we' puts west on the left (by longitude); 'sn' puts south on the left
 * (by latitude). Depth grows downward. Towns along that direction mark the axis.
 * The vertical scale is exaggerated (the zone is ~300 km long and ~40 km deep).
 */
export function drawDepth(el, { seq, main, pre, showPre, dayIndex, palette, mainIn = true, axis = 'we', places, box }) {
  const { svg, W, H } = newSvg(el, 300);
  const all = [...(showPre ? pre : []), ...(mainIn ? [main] : []), ...seq];
  const m = { l: textWidth(svg, '60 km', 'tick') + 14, r: 14, t: 26, b: 34 };
  if (!all.length) {
    svg.append('text').attr('class', 'label').attr('x', W / 2).attr('y', H / 2).attr('text-anchor', 'middle').text(t('f.empty'));
    return { fixed: 0, total: 0 };
  }
  const pos = axis === 'we' ? (d) => d.lon : (d) => d.lat;
  const vals = all.map(pos);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(0.05, (hi - lo) * 0.04);
  const x = d3.scaleLinear([lo - pad, hi + pad], [m.l, W - m.r]);
  // Scale to where most of them are; the few much deeper ones sit on the bottom edge
  // as hollow rings (their real depth is in the tooltip).
  const depths = all.map((d) => d.depth).sort((a, b) => a - b);
  const deep = depths[Math.min(depths.length - 1, Math.floor(depths.length * 0.95))] || 30;
  const maxDepth = Math.max(30, Math.ceil((deep + 8) / 10) * 10);
  const y = d3.scaleLinear([0, maxDepth], [m.t, H - m.b]);
  const step = maxDepth > 60 ? 20 : 10;
  const clipped = all.filter((d) => d.depth > maxDepth).length;
  yAxis(svg, y, Array.from({ length: Math.floor(maxDepth / step) + 1 }, (_, i) => i * step), m.l, W - m.r,
    (v) => (v === maxDepth && clipped ? `≥${v} km` : `${v} km`));
  // Towns along the axis, as reference marks on top (skip ones that would overlap).
  // only towns inside the area, so a section along the south coast isn't marked with Caribbean towns
  const inside = (p) => !box || (axis === 'we' ? p.lat >= box.minLat && p.lat <= box.maxLat : p.lon >= box.minLon && p.lon <= box.maxLon);
  const marks = (places || []).filter(inside).map((p) => ({ name: localName(p), v: axis === 'we' ? p.lon : p.lat }))
    .filter((p) => p.v >= x.domain()[0] && p.v <= x.domain()[1]).sort((a, b) => a.v - b.v);
  let lastRight = -Infinity;
  for (const p of marks) {
    const px = x(p.v), w = textWidth(svg, p.name, 'tick');
    if (px - w / 2 < lastRight + 8 || px - w / 2 < m.l - 4 || px + w / 2 > W) continue;
    lastRight = px + w / 2;
    svg.append('line').attr('class', 'grid').attr('x1', px).attr('x2', px).attr('y1', m.t - 4).attr('y2', H - m.b);
    svg.append('text').attr('class', 'tick').attr('x', px).attr('y', m.t - 10).attr('text-anchor', 'middle').text(p.name);
  }
  const ends = axis === 'we' ? [t('depth.west'), t('depth.east')] : [t('depth.south'), t('depth.north')];
  svg.append('text').attr('class', 'label strong').attr('x', m.l).attr('y', H - m.b + 22).text(`← ${ends[0]}`);
  svg.append('text').attr('class', 'label strong').attr('x', W - m.r).attr('y', H - m.b + 22).attr('text-anchor', 'end').text(`${ends[1]} →`);
  // Vertical exaggeration: km per pixel across vs. down.
  const kmPerDeg = axis === 'we' ? 111.32 * Math.cos((main.lat * Math.PI) / 180) : 110.6;
  const ex = (((x.domain()[1] - x.domain()[0]) * kmPerDeg) / (x.range()[1] - x.range()[0])) / (maxDepth / (H - m.b - m.t));
  if (ex > 1.5) svg.append('text').attr('class', 'tick').attr('x', (m.l + W - m.r) / 2).attr('y', H - m.b + 22).attr('text-anchor', 'middle').text(t('depth.exag', Math.round(ex)));
  const colorOf = (d) => (d === main ? token('--main') : d.t < main.t ? token('--pre') : palette.colorOf(dayIndex(d)));
  const sorted = [...all].sort((a, b) => b.mag - a.mag); // small ones on top
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('class', (d) => (d === main ? 'dot main' : d.depth > maxDepth ? 'dot clipped' : 'dot day'))
    .attr('cx', (d) => x(pos(d))).attr('cy', (d) => y(Math.min(d.depth, maxDepth))).attr('r', (d) => radiusFor(d.mag))
    .attr('fill', (d) => (d.depth > maxDepth && d !== main ? 'none' : colorOf(d)))
    .attr('stroke', (d) => (d.depth > maxDepth && d !== main ? colorOf(d) : null));
  if (mainIn) {
    svg.append('text').attr('class', 'label strong').attr('x', x(pos(main)) + radiusFor(main.mag) + 6).attr('y', y(Math.min(main.depth, maxDepth))).attr('dy', '0.32em')
      .text(t('tl.mainLbl', fmtMag(main.mag)));
  }
  nearestHover(el, svg, all.map((d) => ({ d, x: x(pos(d)), y: y(Math.min(d.depth, maxDepth)), r: radiusFor(d.mag) })),
    (d) => [fmtTime(d.t), t('depth.tip', fmtMag(d.mag), d.depth), d.place], emscLink);
  return { fixed: all.filter((d) => d.depth === 10).length, total: all.length, clipped, maxDepth };
}


/**
 * When in the day they happen: every earthquake by its local hour (Panama time) and
 * magnitude, colored by the intensity estimated at the reference point, with the
 * night (6 p.m.–6 a.m.) shaded. On top, how many happened in each hour (M4+ at the
 * bottom of each bar). Returns the counts, for the summary under the chart.
 */
export function drawHours(el, { rows, ref, main, mainIn = true }) {
  const { svg, W, H } = newSvg(el, 340);
  const evs = rows.map((r) => r.ev);
  const hb = byHour(evs);
  const histH = 72, gap = 22;
  const m = { l: 0, r: 12, t: 10, b: 30 };
  const yh = d3.scaleLinear([0, Math.max(1, d3.max(hb.hours, (b) => b.n))], [m.t + histH, m.t]).nice();
  const hticks = yh.ticks(2);
  m.l = Math.max(textWidth(svg, '8', 'tick'), textWidth(svg, fmtInt(d3.max(hticks)), 'tick')) + 14;
  const x = d3.scaleLinear([0, 24], [m.l, W - m.r]);
  const p0 = m.t + histH + gap, p1 = H - m.b;
  const top = Math.max(5.5, (d3.max(evs, (e) => e.mag) ?? 5) + 0.4);
  const y = d3.scaleLinear([2.3, top], [p1, p0]);

  // night bands, behind everything
  for (const [a, b] of [[0, 6], [18, 24]]) {
    svg.append('rect').attr('class', 'night').attr('x', x(a)).attr('width', x(b) - x(a)).attr('y', m.t).attr('height', p1 - m.t);
    svg.append('text').attr('class', 'tick').attr('x', x((a + b) / 2)).attr('y', p0 - 6).attr('text-anchor', 'middle').text(t('hours.night'));
  }
  yAxis(svg, yh, hticks, m.l, W - m.r, fmtInt);
  yAxis(svg, y, [3, 4, 5, 6, 7, 8].filter((v) => v <= top), m.l, W - m.r);
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yh(0)).attr('y2', yh(0));
  svg.append('line').attr('class', 'axis').attr('x1', m.l).attr('x2', W - m.r).attr('y1', p1).attr('y2', p1);
  const every = W < 480 ? 6 : 3;
  for (let h = 0; h <= 24; h += every) {
    svg.append('text').attr('class', `tick${h % 12 === 0 ? ' strong' : ''}`).attr('x', x(h)).attr('y', p1 + 18)
      .attr('text-anchor', h === 0 ? 'start' : h === 24 ? 'end' : 'middle').text(t('hours.tick', h));
  }

  // how many in each hour (M4+ at the bottom of the bar)
  const step = x(1) - x(0), bw = Math.max(2, step * 0.78);
  const tip = tooltip(el);
  for (const b of hb.hours) {
    const bx = x(b.h) + (step - bw) / 2;
    const yM4 = yh(b.m4), yAll = yh(b.n);
    const gapPx = b.m4 > 0 && b.n > b.m4 ? 1.5 : 0;
    svg.append('path').attr('class', 'bar s2').attr('d', barPath(bx, yM4, bw, yh(0) - yM4, b.n > b.m4 ? 0 : 3));
    svg.append('path').attr('class', 'bar s1').attr('d', barPath(bx, yAll, bw, yM4 - yAll - gapPx, 3));
    svg.append('rect').attr('x', x(b.h)).attr('width', step).attr('y', 0).attr('height', m.t + histH + 4).attr('fill', 'transparent')
      .on('pointermove click', (ev) => {
        const [px, py] = d3.pointer(ev, el);
        tip.show([t('hours.range', b.h), [token('--series-1'), t('hours.barAll', fmtInt(b.n))], [token('--series-2'), t('win.m4', fmtInt(b.m4))]], px, py);
      })
      .on('pointerleave', () => tip.hide());
  }

  if (!rows.length) {
    svg.append('text').attr('class', 'label').attr('x', (m.l + W - m.r) / 2).attr('y', (p0 + p1) / 2).attr('text-anchor', 'middle').text(t('f.empty'));
    return hb;
  }
  const isMain = (r) => r.ev === main;
  const R = (r) => (isMain(r) ? 6 : 3.5);
  const pts = rows.map((r) => ({ d: r, x: x(localHour(r.ev.t)), y: y(r.ev.mag), r: R(r) }));
  const sorted = [...pts].sort((a, b) => a.d.ev.mag - b.d.ev.mag); // the big ones on top
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('class', 'dot mmi').attr('fill', (p) => MMI_COLORS[mmiLevel(p.d.mmi)])
    .attr('cx', (p) => p.x).attr('cy', (p) => p.y).attr('r', (p) => p.r);
  if (mainIn && main) {
    const p = pts.find((q) => isMain(q.d));
    if (p) {
      const right = p.x < W * 0.7;
      svg.append('text').attr('class', 'label strong').attr('x', p.x + (right ? 1 : -1) * (p.r + 6)).attr('y', p.y).attr('dy', '0.32em')
        .attr('text-anchor', right ? 'start' : 'end').text(t('tl.mainLbl', fmtMag(main.mag)));
    }
  }
  nearestHover(el, svg, pts,
    (r) => [fmtTime(r.ev.t), t('int.tip', fmtMag(r.ev.mag), Math.round(r.km), localName(ref)), t('int.est', describeMmi(r.mmi)), r.ev.place],
    (r) => emscLink(r.ev), { top: p0 - gap / 2 });
  return hb;
}
