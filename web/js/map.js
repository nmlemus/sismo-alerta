// Leaflet map of Panama's earthquakes since the mainshock, with a time slider and
// playback. Earthquakes are colored by local day, the mainshock in red, the week before
// in gray; a dark ring marks the last RECENT_HOURS before the moment shown. The dotted
// box is the aftershock zone: what is outside is drawn the same way, and only its card
// says it is not an aftershock. With the week before turned
// on, the slider also covers the days before the mainshock (negative time).

import { PLACES, PLATES, PLAY_SECONDS, RECENT_HOURS, SATELLITE, SEQUENCE, TILES, VIEWS } from './config.js';
import { fmtInt, fmtMag, fmtTime } from './format.js';
import { radiusFor } from './charts.js';
import { dayPalette, token } from './theme.js';
import { emscLink } from './emsc.js';
import { localName, t } from './i18n.js';

const L = globalThis.L;
const H = 3600e3;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function quakeCard(ev, note, withLink, onWave) {
  const box = el('div', 'qtip');
  box.append(el('div', 'tip-h', fmtTime(ev.t)));
  box.append(el('div', null, t('q.depth', fmtMag(ev.mag), ev.magType, ev.depth)));
  box.append(el('div', null, ev.place));
  box.append(el('div', 'muted', `${t('q.by', ev.agency)}${note ? ` · ${note}` : ''}`));
  if (withLink) {
    const a = el('a', null, t(ev.source === 'igc' ? 'q.linkIgc' : 'q.link'));
    a.href = emscLink(ev);
    a.target = '_blank';
    a.rel = 'noopener';
    box.append(a);
  }
  if (onWave) {
    const b = el('button', 'btn wave-btn', t('wave.btn'));
    b.type = 'button';
    b.addEventListener('click', () => onWave(ev));
    box.append(b);
  }
  return box;
}

const note = (kind, ev) => (kind === 'seq' ? (ev && ev.aftershock === false ? t('note.out') : '') : t(`note.${kind}`));

// Remembered per visitor (best effort: storage may be off).
const pref = {
  get: (k, d) => { try { return localStorage.getItem(`sismo-${k}`) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`sismo-${k}`, v); } catch { /* not allowed */ } },
};
// Line style per kind of plate boundary.
const PLATE_STYLE = {
  subduction: { weight: 3, dashArray: null },
  convergent: { weight: 2.5, dashArray: null },
  transform: { weight: 2, dashArray: '8 5' },
  ridge: { weight: 2, dashArray: '2 5' },
  other: { weight: 1.5, dashArray: '2 4' },
};
const AUX = new Set(['other', 'pre', 'unconfirmed']); // drawn on the secondary layer

export class QuakeMap {
  constructor({ mapEl, playBtn, slider, ticks, timeLabel, viewBtns, legendEl, zone, view = 'zone' }) {
    Object.assign(this, { mapEl, playBtn, slider, ticks, timeLabel, viewBtns, legendEl, zone, view });
    this.scope = 'todos';
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
      if (!this.fitted) { map.fitBounds(VIEWS[this.view]); this.fitted = true; }
    };
    new ResizeObserver(fit).observe(this.mapEl);
    fit();
    map.on('focus', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());

    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    const key = (TILES.cartoKey || '').trim();
    this.bases = {
      streets: L.tileLayer(key
        ? `https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`
        : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, className: 'base-streets',
        attribution: key ? `${osm} &copy; <a href="https://carto.com/attributions">CARTO</a>` : osm,
      }),
    };
    if (SATELLITE?.url) {
      this.bases.satellite = L.tileLayer(SATELLITE.url, {
        maxZoom: 19, maxNativeZoom: SATELLITE.maxNativeZoom || 14, className: 'base-sat', attribution: SATELLITE.attribution,
      });
    }
    this.baseBtns = [...document.querySelectorAll('[data-base]')];
    this.baseBtns.forEach((b) => { b.hidden = !this.bases[b.dataset.base]; b.addEventListener('click', () => this.setBase(b.dataset.base)); });
    this.setBase(pref.get('base', 'streets'));

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
    map.createPane('plates').style.zIndex = 420; // under the earthquakes
    this.plateLayer = L.layerGroup();
    this.plateBtn = document.querySelector('#map-plates');
    this.plateBtn?.addEventListener('click', () => this.setPlates(this.plateBtn.getAttribute('aria-pressed') !== 'true'));
    this.setPlates(pref.get('plates', 'on') === 'on');
    this.placeLabels = PLACES.filter((x) => x.label).map((p) => ({
      p,
      marker: L.marker([p.lat, p.lon], { pane: 'labels', interactive: false, keyboard: false, icon: this.placeIcon(p) }).addTo(map),
    }));

    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.slider.addEventListener('input', () => {
      this.stop();
      const v = Number(this.slider.value) / 1000;
      this.t = v >= 0.999 ? null : this.tMin + v * (this.T - this.tMin);
      this.render();
    });
    this.viewBtns.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.view === this.view));
      b.addEventListener('click', () => this.showView(b.dataset.view));
    });
  }

  /** "Zona de réplicas" or "Todo Panamá". */
  showView(name) {
    this.view = name;
    this.viewBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === name)));
    if (this.fitted) this.map.flyToBounds(VIEWS[name], { duration: 0.6 });
  }

  /** Street map or satellite. */
  setBase(name) {
    if (!this.bases[name]) name = 'streets';
    for (const [k, layer] of Object.entries(this.bases)) {
      if (k === name) layer.addTo(this.map); else this.map.removeLayer(layer);
    }
    this.base = name;
    this.mapEl.dataset.base = name;
    this.baseBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === name)));
    pref.set('base', name);
  }

  /** Plate boundaries on or off (loaded the first time they're shown). */
  async setPlates(on) {
    this.plateBtn?.setAttribute('aria-pressed', String(on));
    pref.set('plates', on ? 'on' : 'off');
    this.platesOn = on;
    if (!on) { this.map.removeLayer(this.plateLayer); this.legend(); return; }
    this.plateLayer.addTo(this.map);
    if (!this.plateData) {
      try {
        const r = await fetch(PLATES.file);
        this.plateData = await r.json();
      } catch { this.plateData = { features: [] }; }
      this.map.attributionControl.addAttribution(PLATES.attribution);
    }
    this.drawPlates();
    this.legend();
  }

  drawPlates() {
    if (!this.plateData || !this.platesOn) return;
    const color = token('--plate');
    const names = t('plate');
    this.plateLayer.clearLayers();
    for (const f of this.plateData.features) {
      const kind = f.properties.kind || 'other';
      const [a, b] = f.properties.name.split(/[-/\\]/);
      const line = L.polyline(f.geometry.coordinates.map(([x, y]) => [y, x]), {
        pane: 'plates', color, opacity: 0.85, ...PLATE_STYLE[kind] || PLATE_STYLE.other, interactive: true,
      });
      line.bindTooltip(t('plate.tip', names[a] || a, names[b] || b, t('plate.kind')[kind]), { sticky: true });
      this.plateLayer.addLayer(line);
    }
    for (const l of PLATES.labels) {
      this.plateLayer.addLayer(L.marker([l.lat, l.lon], {
        pane: 'labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'plate-label', html: el('span', null, names[l.id] || l.id), iconSize: null }),
      }));
    }
  }

  placeIcon(p) { return L.divIcon({ className: 'place', html: el('span', null, localName(p)), iconSize: null }); }

  /** The area that counts (dotted box). fly: also move the map to it. */
  setArea(box, fly = false) {
    this.zone = box;
    this.zoneRect.setBounds([[box.minLat, box.minLon], [box.maxLat, box.maxLon]]);
    if (fly && this.fitted) this.map.flyToBounds(this.zoneRect.getBounds(), { duration: 0.6, padding: [20, 20] });
  }

  /** What the map shows now, as an area box clipped to `limit` (the region the page loads). */
  visibleBox(limit) {
    const b = this.map.getBounds();
    const r = (v) => Math.round(v * 100) / 100;
    return {
      minLat: r(Math.max(limit.minLat, b.getSouth())), maxLat: r(Math.min(limit.maxLat, b.getNorth())),
      minLon: r(Math.max(limit.minLon, b.getWest())), maxLon: r(Math.min(limit.maxLon, b.getEast())),
    };
  }

  /** Text that doesn't come with the data: town labels, legend, buttons. */
  relabel() {
    for (const { p, marker } of this.placeLabels || []) marker.setIcon(this.placeIcon(p));
    this.drawPlates();
    this.playBtn.textContent = t(this.playing ? 'map.pause' : 'map.play');
    if (this.main) { this.legend(); this.render(); }
  }

  /** Start of the slider, in ms from the mainshock: the week before, the mainshock, or the start of a period filter. */
  get tMin() { return this.showPre ? -SEQUENCE.preDays * 24 * H : Math.max(0, this.from == null ? 0 : this.from - this.main.t.getTime()); }

  /** Rebuild markers for new data. */
  setData({ main, seq, others, pre, unconfirmed = [], dayIndex, days, ref, now, showPre, from = null, scope = 'todos' }) {
    this.main = main;
    this.scope = scope;
    this.from = from;
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
        this.viewBtns.forEach((x) => x.setAttribute('aria-pressed', String(!showPre && x.dataset.view === this.view)));
        this.map.flyToBounds(showPre ? bounds : VIEWS[this.view], { duration: 0.6, padding: [20, 20] });
      }
    }
    if (this.t != null && (this.t < this.tMin || this.t > this.T)) this.t = null;
    // Tick on the slider where the mainshock is.
    const zeroAt = Math.round((-this.tMin / (this.T - this.tMin)) * 1000);
    this.ticks.replaceChildren(...(this.showPre ? [Object.assign(document.createElement('option'), { value: String(zeroAt), label: t('leg.main') })] : []));
    const all = [
      { ev: main, kind: 'main' },
      ...seq.map((ev) => ({ ev, kind: 'seq' })),
      ...others.map((ev) => ({ ev, kind: 'other' })),
      ...pre.map((ev) => ({ ev, kind: 'pre' })),
      ...unconfirmed.map((ev) => ({ ev, kind: 'unconfirmed' })),
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
      marker.bindPopup(() => quakeCard(this.markers.get(ev.id)?.ev || ev, note(kind, ev), true,
        kind === 'unconfirmed' || !this.onPropagate ? null : (e) => { this.map.closePopup(); this.onPropagate(e); }));
      if (kind === 'main') marker.bindTooltip(`M${fmtMag(ev.mag)}`, { permanent: true, direction: 'right', className: 'main-label', offset: [8, 0] });
      else marker.bindTooltip(() => quakeCard(this.markers.get(ev.id)?.ev || ev, note(kind, ev), false), { direction: 'top', offset: [0, -4] });
      this.markers.set(ev.id, { marker, ev, kind, sig, shown: false, key: '' });
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) {
        this.layerOf(m.kind).removeLayer(m.marker);
        this.markers.delete(id);
      }
    }
    this.hasUnconfirmed = unconfirmed.length > 0;
    this.setRef(ref);
    this.legend();
    this.render();
  }

  layerOf(kind) { return AUX.has(kind) ? this.otherLayer : this.quakeLayer; }

  setRef(ref) {
    if (this.refMarker) this.map.removeLayer(this.refMarker);
    this.refMarker = L.marker([ref.lat, ref.lon], {
      pane: 'labels', keyboard: false, title: t('map.refTitle', localName(ref)),
      icon: L.divIcon({ className: 'refpin', html: el('span', null, '◆'), iconSize: [16, 16] }),
    }).addTo(this.map);
  }

  /** Re-read theme colors (light/dark switch) and restyle everything. */
  restyle() {
    for (const m of this.markers.values()) m.key = '';
    if (this.days) this.palette = dayPalette(this.days);
    this.drawPlates();
    this.legend();
    this.render();
  }

  colorOf(m) {
    if (m.kind === 'main') return token('--main');
    if (m.kind === 'pre') return token('--pre');
    if (m.kind === 'other' || m.kind === 'unconfirmed') return token('--muted');
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
      if (m.kind === 'unconfirmed') {
        m.marker.setStyle({ color: ink, weight: 1.5, dashArray: '3 3', fillOpacity: 0 });
      } else if (m.kind === 'other') {
        m.marker.setStyle({ color: c, weight: 1.2, fillColor: c, fillOpacity: 0.15 });
      } else if (m.kind === 'pre') {
        m.marker.setStyle({ color: recent ? ink : surface, weight: 2, fillColor: c, fillOpacity: 0.95 });
      } else {
        m.marker.setStyle({ color: recent ? ink : surface, weight: recent ? 2 : 1, fillColor: c, fillOpacity: 0.85 });
      }
    }
    if (this.latestRing) {
      const show = this.latest.t.getTime() <= tNow;
      if (show && !this.fxLayer.hasLayer(this.latestRing)) this.fxLayer.addLayer(this.latestRing);
      if (!show && this.fxLayer.hasLayer(this.latestRing)) this.fxLayer.removeLayer(this.latestRing);
      this.latestRing.setStyle({ color: ink });
    }
    const before = this.t != null && this.t < 0;
    const when = this.t == null ? t('time.now', fmtTime(new Date(tNow))) : fmtTime(new Date(tNow));
    const count = before ? t('time.before', (-this.t / (24 * H)).toFixed(1), fmtInt(nPre))
      : t(this.scope === 'replicas' ? 'time.after' : 'time.afterAll', fmtInt(n));
    this.timeLabel.textContent = `${when} · ${count}`;
    this.slider.value = String(this.t == null ? 1000 : Math.round(((this.t - this.tMin) / (this.T - this.tMin)) * 1000));
  }

  togglePlay() {
    if (this.playing) { this.stop(); return; }
    // Playback starts at the mainshock unless the slider was moved into the week before.
    if (this.t == null || this.t >= this.T) this.t = Math.max(0, this.tMin);
    this.playing = true;
    this.playBtn.textContent = t('map.pause');
    let last = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      this.t += ((now - last) / 1000) * ((this.T - Math.max(0, this.tMin)) / PLAY_SECONDS);
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
    this.playBtn.textContent = t('map.play');
  }

  /** A slow ring that keeps beating around the latest earthquake. */
  setLatest(ev) {
    this.latest = ev;
    if (this.latestRing) this.fxLayer.removeLayer(this.latestRing);
    this.latestRing = L.circleMarker([ev.lat, ev.lon], {
      pane: 'quakes', radius: radiusFor(ev.mag) + 3, color: token('--ink'), weight: 2, fill: false, interactive: false, className: 'latest-ring',
    });
    this.render();
  }

  /** Centers the map on an earthquake and opens its card. */
  focus(ev) {
    this.stop();
    this.t = null;
    this.render();
    const m = this.markers.get(ev.id);
    const zoom = Math.max(this.map.getZoom(), 9);
    let opened = false;
    const open = () => { if (!opened && m?.shown) { opened = true; m.marker.openPopup(); } };
    this.map.once('moveend', open);
    // In case the flight is interrupted or never finishes: jump there, then open the card.
    setTimeout(() => {
      if (opened) return;
      this.map.stop();
      this.map.setView([ev.lat, ev.lon], zoom, { animate: false });
      open();
    }, 1500);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.map.setView([ev.lat, ev.lon], zoom);
    else this.map.flyTo([ev.lat, ev.lon], zoom, { duration: 0.8 });
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
    add({ background: 'var(--main)' }, t('leg.main'));
    for (const d of this.palette?.legend || []) add({ background: d.color }, d.label);
    if (this.showPre) add({ background: 'var(--pre)' }, t('leg.preDays', SEQUENCE.preDays));
    add({ background: 'transparent', border: '2px solid var(--ink)' }, t('leg.recent', RECENT_HOURS));
    if (this.scope === 'replicas') add({ border: '1.5px solid var(--muted)', background: 'transparent' }, t('leg.outside'));
    else add({ border: '1.5px dashed var(--muted)', background: 'transparent', borderRadius: '2px' }, t('leg.zone'));
    if (this.hasUnconfirmed) add({ border: '1.5px dashed var(--ink)', background: 'transparent' }, t('leg.unconf'));
    add({ background: 'var(--link)', borderRadius: '2px', transform: 'rotate(45deg) scale(.8)' }, t('leg.ref'));
    if (this.platesOn) {
      const kinds = new Set((this.plateData?.features || []).map((f) => f.properties.kind));
      for (const k of ['subduction', 'transform', 'ridge', 'convergent']) {
        if (!kinds.has(k)) continue;
        const s = el('span', 'plate-key');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '22'); svg.setAttribute('height', '8'); svg.setAttribute('aria-hidden', 'true');
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        Object.entries({ x1: 1, y1: 4, x2: 21, y2: 4, stroke: 'var(--plate)', 'stroke-width': PLATE_STYLE[k].weight }).forEach(([n, v]) => ln.setAttribute(n, v));
        if (PLATE_STYLE[k].dashArray) ln.setAttribute('stroke-dasharray', PLATE_STYLE[k].dashArray);
        svg.append(ln);
        s.append(svg, document.createTextNode(t(`leg.${k}`)));
        box.append(s);
      }
    }
  }
}
