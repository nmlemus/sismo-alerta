// Leaflet map of the sequence with a time slider and playback.

import { PLACES, PLAY_SECONDS, RECENT_HOURS, TILES, VIEWS } from './config.js';
import { DAY_COLORS, MAIN_COLOR, OTHER_COLOR, fmtInt, fmtMag, fmtTime } from './format.js';
import { radiusFor } from './charts.js';

const L = globalThis.L;
const H = 3600e3;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function quakeTooltip(ev, note) {
  const box = el('div', 'qtip');
  box.append(el('div', 'tip-h', fmtTime(ev.t)));
  box.append(el('div', null, `M${fmtMag(ev.mag)} (${ev.magType}) · ${ev.depth} km de profundidad`));
  box.append(el('div', null, ev.place));
  box.append(el('div', 'muted', `Localizado por ${ev.agency}${note ? ` · ${note}` : ''}`));
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
    L.rectangle([[z.minLat, z.minLon], [z.maxLat, z.maxLon]], {
      color: '#6b7280', weight: 1, dashArray: '4 4', fill: false, interactive: false,
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
  setData({ main, seq, others, dayIndex, days, ref, now }) {
    this.main = main;
    this.dayIndex = dayIndex;
    this.now = now;
    this.T = Math.max(1, now - main.t.getTime());
    const all = [
      { ev: main, kind: 'main' },
      ...seq.map((ev) => ({ ev, kind: 'seq' })),
      ...others.map((ev) => ({ ev, kind: 'other' })),
    ];
    const seen = new Set();
    // Big ones first so small markers stay clickable on top.
    for (const { ev, kind } of all.sort((a, b) => b.ev.mag - a.ev.mag)) {
      seen.add(ev.id);
      const prev = this.markers.get(ev.id);
      const sig = `${ev.lat},${ev.lon},${ev.mag},${kind},${ev.place}`;
      if (prev && prev.sig === sig) { prev.ev = ev; continue; }
      if (prev) (prev.kind === 'other' ? this.otherLayer : this.quakeLayer).removeLayer(prev.marker);
      const marker = L.circleMarker([ev.lat, ev.lon], { pane: 'quakes', radius: radiusFor(ev.mag), weight: 1 });
      marker.bindTooltip(() => quakeTooltip(ev, kind === 'other' ? 'fuera de la zona de réplicas' : kind === 'main' ? 'sismo principal' : ''), { direction: 'top', offset: [0, -4] });
      this.markers.set(ev.id, { marker, ev, kind, sig, shown: false, key: '' });
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        (m.kind === 'other' ? this.otherLayer : this.quakeLayer).removeLayer(m.marker);
        this.markers.delete(id);
      }
    }
    this.setRef(ref);
    this.legend(days);
    this.render();
  }

  setRef(ref) {
    if (this.refMarker) this.map.removeLayer(this.refMarker);
    this.refMarker = L.marker([ref.lat, ref.lon], {
      pane: 'labels', keyboard: false, title: `Referencia: ${ref.name}`,
      icon: L.divIcon({ className: 'refpin', html: el('span', null, '◆'), iconSize: [16, 16] }),
    }).addTo(this.map);
  }

  colorOf(m) {
    if (m.kind === 'main') return MAIN_COLOR;
    if (m.kind === 'other') return OTHER_COLOR;
    return DAY_COLORS[this.dayIndex(m.ev) % DAY_COLORS.length];
  }

  /** Show events up to the current time; ring the ones from the last RECENT_HOURS. */
  render() {
    if (!this.main) return;
    const t0 = this.main.t.getTime();
    const tNow = this.t == null ? this.now : t0 + this.t;
    const recentFrom = tNow - RECENT_HOURS * H;
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#111';
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
      const recent = m.kind !== 'other' && time > recentFrom;
      const key = `${recent}|${fg}`;
      if (key !== m.key) {
        const c = this.colorOf(m);
        m.marker.setStyle({
          color: recent ? fg : c, weight: recent ? 1.6 : 1, fillColor: c,
          fillOpacity: m.kind === 'other' ? 0.35 : recent || m.kind === 'main' ? 0.85 : 0.5,
          opacity: m.kind === 'other' ? 0.6 : 1,
        });
        m.key = key;
      }
    }
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
      pane: 'quakes', radius: radiusFor(ev.mag) + 4, color: MAIN_COLOR, weight: 2, fill: false, interactive: false, className: 'pulse',
    }).addTo(this.fxLayer);
    setTimeout(() => this.fxLayer.removeLayer(ring), 60000);
  }

  legend(days) {
    const box = this.legendEl;
    box.replaceChildren();
    const add = (style, label) => {
      const s = el('span');
      const i = el('i');
      Object.assign(i.style, style);
      s.append(i, document.createTextNode(label));
      box.append(s);
    };
    add({ background: MAIN_COLOR }, 'Sismo principal');
    days.forEach((d, i) => add({ background: DAY_COLORS[i % DAY_COLORS.length] }, d));
    add({ border: '2px solid var(--fg)' }, `Últimas ${RECENT_HOURS} h del momento mostrado`);
    add({ background: OTHER_COLOR }, 'Fuera de la zona de réplicas (recuadro)');
    add({ background: 'var(--accent)', borderRadius: '2px', transform: 'rotate(45deg) scale(.8)' }, 'Punto de referencia');
  }
}
