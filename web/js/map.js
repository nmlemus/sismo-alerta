// Leaflet map of the sequence with a time slider and playback. Epicenters are
// colored by age relative to the moment shown (USGS convention: last hour, day,
// week, older), on a one-hue ramp validated for light and dark mode.

import { AGE_CLASSES, PLACES, PLAY_SECONDS, TILES, VIEWS } from './config.js';
import { fmtInt, fmtMag, fmtTime } from './format.js';
import { radiusFor } from './charts.js';
import { ageColors, token } from './theme.js';
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

export class QuakeMap {
  constructor({ mapEl, playBtn, slider, timeLabel, viewBtns, legendEl, zone }) {
    Object.assign(this, { mapEl, playBtn, slider, timeLabel, viewBtns, legendEl, zone });
    this.t = null; // ms since the mainshock shown on the map; null = follow "now"
    this.markers = new Map(); // id -> { marker, ev, kind, shown, key }
    this.playing = false;
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
      this.t = v >= 0.999 ? null : v * this.T;
      this.render();
    });
    this.viewBtns.forEach((b) => b.addEventListener('click', () => {
      this.viewBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (!this.fitted) return;
      map.flyToBounds(VIEWS[b.dataset.view], { duration: 0.6 });
    }));
  }

  /** Rebuild markers for new data. */
  setData({ main, seq, others, ref, now }) {
    this.main = main;
    this.now = now;
    this.T = Math.max(1, now - main.t.getTime());
    const all = [
      { ev: main, kind: 'main' },
      ...seq.map((ev) => ({ ev, kind: 'seq' })),
      ...others.map((ev) => ({ ev, kind: 'other' })),
    ];
    const seen = new Set();
    // Big ones first so small markers stay on top and clickable.
    for (const { ev, kind } of all.sort((a, b) => b.ev.mag - a.ev.mag)) {
      seen.add(ev.id);
      const prev = this.markers.get(ev.id);
      const sig = `${ev.lat},${ev.lon},${ev.mag},${kind},${ev.place}`;
      if (prev && prev.sig === sig) { prev.ev = ev; continue; }
      if (prev) (prev.kind === 'other' ? this.otherLayer : this.quakeLayer).removeLayer(prev.marker);
      const note = kind === 'other' ? 'fuera de la zona de réplicas' : kind === 'main' ? 'sismo principal' : '';
      const marker = L.circleMarker([ev.lat, ev.lon], { pane: 'quakes', radius: radiusFor(ev.mag) + (kind === 'main' ? 2 : 0), weight: 1 });
      marker.bindTooltip(() => quakeCard(ev, note, false), { direction: 'top', offset: [0, -4] });
      marker.bindPopup(() => quakeCard(ev, note, true));
      if (kind === 'main') marker.bindTooltip(`M${fmtMag(ev.mag)}`, { permanent: true, direction: 'right', className: 'main-label', offset: [8, 0] });
      this.markers.set(ev.id, { marker, ev, kind, sig, shown: false, key: '' });
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        (m.kind === 'other' ? this.otherLayer : this.quakeLayer).removeLayer(m.marker);
        this.markers.delete(id);
      }
    }
    this.setRef(ref);
    this.legend();
    this.render();
  }

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
    this.legend();
    this.render();
  }

  /** Show events up to the current time, colored by their age at that time. */
  render() {
    if (!this.main) return;
    const t0 = this.main.t.getTime();
    const tNow = this.t == null ? this.now : t0 + this.t;
    const ages = ageColors();
    const ink = token('--ink'), surface = token('--surface'), muted = token('--muted');
    this.zoneRect.setStyle({ color: muted });
    let n = 0;
    for (const m of this.markers.values()) {
      const time = m.ev.t.getTime();
      const visible = time <= tNow;
      const layer = m.kind === 'other' ? this.otherLayer : this.quakeLayer;
      if (visible !== m.shown) {
        if (visible) layer.addLayer(m.marker); else layer.removeLayer(m.marker);
        m.shown = visible;
      }
      if (!visible) continue;
      if (m.kind === 'seq') n++;
      const ageH = (tNow - time) / H;
      const cls = AGE_CLASSES.findIndex((a) => ageH <= a.maxHours);
      const key = `${m.kind}|${cls}|${ink}|${ages[cls]}`;
      if (key === m.key) continue;
      m.key = key;
      if (m.kind === 'main') m.marker.setStyle({ color: surface, weight: 2, fillColor: ink, fillOpacity: 1 });
      else if (m.kind === 'other') m.marker.setStyle({ color: muted, weight: 1.2, fillColor: muted, fillOpacity: 0.12 });
      else m.marker.setStyle({ color: surface, weight: 1, fillColor: ages[cls], fillOpacity: 0.9 });
    }
    // Recent events on top.
    for (const m of this.markers.values()) if (m.shown && m.kind === 'seq' && (tNow - m.ev.t) / H <= 24) m.marker.bringToFront();
    const when = this.t == null ? `Ahora (${fmtTime(new Date(tNow))})` : fmtTime(new Date(tNow));
    this.timeLabel.textContent = `${when} · ${fmtInt(n)} réplica${n === 1 ? '' : 's'} hasta ese momento`;
    this.slider.value = String(this.t == null ? 1000 : Math.round((this.t / this.T) * 1000));
  }

  togglePlay() {
    if (this.playing) { this.stop(); return; }
    if (this.t == null) this.t = 0;
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
      pane: 'quakes', radius: radiusFor(ev.mag) + 4, color: token('--ink'), weight: 2, fill: false, interactive: false, className: 'pulse',
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
    const ages = ageColors();
    box.append(el('span', 'legend-title', 'Antigüedad respecto al momento mostrado:'));
    AGE_CLASSES.forEach((a, i) => add({ background: ages[i] }, a.label));
    add({ background: 'var(--ink)' }, 'Sismo principal');
    add({ border: '1.5px solid var(--muted)', background: 'transparent' }, 'Fuera de la zona de réplicas (recuadro)');
    add({ background: 'var(--link)', borderRadius: '2px', transform: 'rotate(45deg) scale(.8)' }, 'Punto de referencia');
  }
}
