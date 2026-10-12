// Leaflet map of the sequence with a time slider and playback. Aftershocks are
// colored by local day, the mainshock in red, the week before in gray; a dark ring
// marks the last RECENT_HOURS before the moment shown. With the week before turned
// on, the slider also covers the days before the mainshock (negative time).

import { PLACES, PLAY_SECONDS, RECENT_HOURS, SEQUENCE, TILES, VIEWS } from './config.js';
import { fmtInt, fmtMag, fmtTime } from './format.js';
import { radiusFor } from './charts.js';
import { dayPalette, token } from './theme.js';
import { emscLink } from './emsc.js';

const L = globalThis.L;
const H = 3600e3;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function quakeCard(ev, note, withLink) {
  const box = el('div', 'qtip');
  box.append(el('div', 'tip-h', fmtTime(ev.t)));
  box.append(el('div', null, `M${fmtMag(ev.mag)} (${ev.magType}) · ${ev.depth} km de profundidad`));
  box.append(el('div', null, ev.place));
  box.append(el('div', 'muted', `Localizado por ${ev.agency}${note ? ` · ${note}` : ''}`));
  if (withLink) {
    const a = el('a', null, 'Ver ficha en EMSC ↗');
    a.href = emscLink(ev);
    a.target = '_blank';
    a.rel = 'noopener';
    box.append(a);
  }
  return box;
}

const NOTES = { main: 'sismo principal', other: 'fuera de la zona de réplicas', pre: 'antes del sismo principal', seq: '' };

export class QuakeMap {
  constructor({ mapEl, playBtn, slider, ticks, timeLabel, viewBtns, legendEl, zone }) {
    Object.assign(this, { mapEl, playBtn, slider, ticks, timeLabel, viewBtns, legendEl, zone });
    this.t = null; // ms since the mainshock shown on the map (negative = before); null = follow "now"
    this.markers = new Map(); // id -> { marker, ev, kind, shown, key }
    this.playing = false;
    this.showPre = false;
  }

  init() {
    const map = L.map(this.mapEl, { zoomSnap: 0.25, scrollWheelZoom: false, attributionControl: true });
    this.map = map;
    // Fit the view once the container has a size (it may load hidden, e.g. in a
    // background tab), and keep Leaflet's idea of the size current afterwards.
    const fit = () => {
      if (!this.mapEl.clientWidth || !this.mapEl.clientHeight) return;
      map.invalidateSize();
      if (!this.fitted) { map.fitBounds(VIEWS.zone); this.fitted = true; }
    };
    new ResizeObserver(fit).observe(this.mapEl);
    fit();
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());

    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const key = (TILES.cartoKey || '').trim();
    L.tileLayer(key
      ? `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`
      : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: key ? `${osm} &copy; <a href="https://carto.com/attributions">CARTO</a>` : osm,
    }).addTo(map);

    map.createPane('quakes').style.zIndex = 450;
    map.createPane('pre').style.zIndex = 455; // the week before stays above the aftershocks
    map.createPane('labels').style.zIndex = 460;
    const z = this.zone;
    this.zoneRect = L.rectangle([[z.minLat, z.minLon], [z.maxLat, z.maxLon]], {
      weight: 1, dashArray: '4 4', fill: false, interactive: false,
    }).addTo(map);
    this.otherLayer = L.layerGroup().addTo(map);
    this.quakeLayer = L.layerGroup().addTo(map);
    this.fxLayer = L.layerGroup().addTo(map);
    for (const p of PLACES.filter((x) => x.label)) {
      L.marker([p.lat, p.lon], {
        pane: 'labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'place', html: el('span', null, p.name), iconSize: null }),
      }).addTo(map);
    }

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.slider.addEventListener('input', () => {
      this.stop();
      const v = Number(this.slider.value) / 1000;
      this.t = v >= 0.999 ? null : this.tMin + v * (this.T - this.tMin);
      this.render();
    });
    this.viewBtns.forEach((b) => b.addEventListener('click', () => {
      this.viewBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (!this.fitted) return;
      map.flyToBounds(VIEWS[b.dataset.view], { duration: 0.6 });
    }));
  }

  get tMin() { return this.showPre ? -SEQUENCE.preDays * 24 * H : 0; }

  /** Rebuild markers for new data. */
  setData({ main, seq, others, pre, dayIndex, days, ref, now, showPre }) {
    this.main = main;
    this.now = now;
    this.T = Math.max(1, now - main.t.getTime());
    this.dayIndex = dayIndex;
    this.days = days;
    this.palette = dayPalette(days);
    if (showPre !== this.showPre) {
      this.showPre = showPre;
      if (!showPre && this.t != null && this.t < 0) this.t = 0;
      if (this.fitted) {
        const z = this.zone;
        const bounds = L.latLngBounds([[z.minLat, z.minLon], [z.maxLat, z.maxLon]]);
        if (showPre) pre.forEach((e) => bounds.extend([e.lat, e.lon]));
        this.viewBtns.forEach((x) => x.setAttribute('aria-pressed', String(!showPre && x.dataset.view === 'zone')));
        this.map.flyToBounds(showPre ? bounds : VIEWS.zone, { duration: 0.6, padding: [20, 20] });
      }
    }
    // Tick on the slider where the mainshock is.
    const zeroAt = Math.round((-this.tMin / (this.T - this.tMin)) * 1000);
    this.ticks.replaceChildren(...(this.showPre ? [Object.assign(document.createElement('option'), { value: String(zeroAt), label: 'Sismo principal' })] : []));
    const all = [
      { ev: main, kind: 'main' },
      ...seq.map((ev) => ({ ev, kind: 'seq' })),
      ...others.map((ev) => ({ ev, kind: 'other' })),
      ...pre.map((ev) => ({ ev, kind: 'pre' })),
    ];
    const seen = new Set();
    // Big ones first so small markers stay on top and clickable.
    for (const { ev, kind } of all.sort((a, b) => b.ev.mag - a.ev.mag)) {
      seen.add(ev.id);
      const prev = this.markers.get(ev.id);
      const sig = `${ev.lat},${ev.lon},${ev.mag},${kind},${ev.place}`;
      if (prev && prev.sig === sig) { prev.ev = ev; continue; }
      if (prev) this.layerOf(prev.kind).removeLayer(prev.marker);
      const radius = kind === 'pre' ? Math.max(6, radiusFor(ev.mag) + 2) : radiusFor(ev.mag) + (kind === 'main' ? 2 : 0);
      const marker = L.circleMarker([ev.lat, ev.lon], { pane: kind === 'pre' ? 'pre' : 'quakes', radius, weight: 1 });
      marker.bindPopup(() => quakeCard(ev, NOTES[kind], true));
      if (kind === 'main') marker.bindTooltip(`M${fmtMag(ev.mag)}`, { permanent: true, direction: 'right', className: 'main-label', offset: [8, 0] });
      else marker.bindTooltip(() => quakeCard(ev, NOTES[kind], false), { direction: 'top', offset: [0, -4] });
      this.markers.set(ev.id, { marker, ev, kind, sig, shown: false, key: '' });
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        this.layerOf(m.kind).removeLayer(m.marker);
        this.markers.delete(id);
      }
    }
    this.setRef(ref);
    this.legend();
    this.render();
  }

  layerOf(kind) { return kind === 'other' || kind === 'pre' ? this.otherLayer : this.quakeLayer; }

  setRef(ref) {
    if (this.refMarker) this.map.removeLayer(this.refMarker);
    this.refMarker = L.marker([ref.lat, ref.lon], {
      pane: 'labels', keyboard: false, title: `Punto de referencia: ${ref.name}`,
      icon: L.divIcon({ className: 'refpin', html: el('span', null, '◆'), iconSize: [16, 16] }),
    }).addTo(this.map);
  }

  /** Re-read theme colors (light/dark switch) and restyle everything. */
  restyle() {
    for (const m of this.markers.values()) m.key = '';
    if (this.days) this.palette = dayPalette(this.days);
    this.legend();
    this.render();
  }

  colorOf(m) {
    if (m.kind === 'main') return token('--main');
    if (m.kind === 'pre') return token('--pre');
    if (m.kind === 'other') return token('--muted');
    return this.palette.colorOf(this.dayIndex(m.ev));
  }

  /** Show events up to the moment shown; ring the ones from the last RECENT_HOURS. */
  render() {
    if (!this.main) return;
    const t0 = this.main.t.getTime();
    const tNow = this.t == null ? this.now : t0 + this.t;
    const recentFrom = tNow - RECENT_HOURS * H;
    const ink = token('--ink'), surface = token('--surface');
    this.zoneRect.setStyle({ color: token('--muted') });
    let n = 0, nPre = 0;
    for (const m of this.markers.values()) {
      const time = m.ev.t.getTime();
      const visible = time <= tNow && (m.kind !== 'pre' || this.showPre);
      if (visible !== m.shown) {
        if (visible) this.layerOf(m.kind).addLayer(m.marker); else this.layerOf(m.kind).removeLayer(m.marker);
        m.shown = visible;
      }
      if (!visible) continue;
      if (m.kind === 'seq') n++;
      if (m.kind === 'pre') nPre++;
      const recent = m.kind !== 'other' && time > recentFrom;
      const c = this.colorOf(m);
      const key = `${recent}|${c}|${ink}`;
      if (key === m.key) continue;
      m.key = key;
      if (m.kind === 'other') {
        m.marker.setStyle({ color: c, weight: 1.2, fillColor: c, fillOpacity: 0.15 });
      } else if (m.kind === 'pre') {
        m.marker.setStyle({ color: recent ? ink : surface, weight: 2, fillColor: c, fillOpacity: 0.95 });
      } else {
        m.marker.setStyle({ color: recent ? ink : surface, weight: recent ? 2 : 1, fillColor: c, fillOpacity: 0.85 });
      }
    }
    const before = this.t != null && this.t < 0;
    const when = this.t == null ? `Ahora (${fmtTime(new Date(tNow))})` : fmtTime(new Date(tNow));
    const count = before
      ? `${(-this.t / (24 * H)).toFixed(1)} días antes del sismo principal · ${fmtInt(nPre)} sismo${nPre === 1 ? '' : 's'} en la región hasta ese momento`
      : `${fmtInt(n)} réplica${n === 1 ? '' : 's'} hasta ese momento`;
    this.timeLabel.textContent = `${when} · ${count}`;
    this.slider.value = String(this.t == null ? 1000 : Math.round(((this.t - this.tMin) / (this.T - this.tMin)) * 1000));
  }

  togglePlay() {
    if (this.playing) { this.stop(); return; }
    // Playback starts at the mainshock unless the slider was moved into the week before.
    if (this.t == null || this.t >= this.T) this.t = 0;
    this.playing = true;
    this.playBtn.textContent = '❚❚ Pausa';
    let last = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      this.t += ((now - last) / 1000) * (this.T / PLAY_SECONDS);
      last = now;
      if (this.t >= this.T) { this.t = null; this.stop(); this.render(); return; }
      this.render();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.playBtn.textContent = '▶ Reproducir';
  }

  /** A pulsing ring around a newly published event. */
  flash(ev) {
    const ring = L.circleMarker([ev.lat, ev.lon], {
      pane: 'quakes', radius: radiusFor(ev.mag) + 4, color: token('--main'), weight: 2, fill: false, interactive: false, className: 'pulse',
    }).addTo(this.fxLayer);
    setTimeout(() => this.fxLayer.removeLayer(ring), 60000);
  }

  legend() {
    const box = this.legendEl;
    box.replaceChildren();
    const add = (style, label) => {
      const s = el('span');
      const i = el('i');
      Object.assign(i.style, style);
      s.append(i, document.createTextNode(label));
      box.append(s);
    };
    add({ background: 'var(--main)' }, 'Sismo principal');
    for (const d of this.palette?.legend || []) add({ background: d.color }, d.label);
    if (this.showPre) add({ background: 'var(--pre)' }, `${SEQUENCE.preDays} días antes`);
    add({ background: 'transparent', border: '2px solid var(--ink)' }, `Últimas ${RECENT_HOURS} h del momento mostrado`);
    add({ border: '1.5px solid var(--muted)', background: 'transparent' }, 'Fuera de la zona de réplicas (recuadro)');
    add({ background: 'var(--link)', borderRadius: '2px', transform: 'rotate(45deg) scale(.8)' }, 'Punto de referencia');
  }
}
