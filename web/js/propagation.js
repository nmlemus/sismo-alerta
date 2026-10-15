// Simulation of how an earthquake's waves spread: the P wave (faster, the first jolt)
// and the S wave (the one that shakes most), drawn as rings from the epicenter. The S
// ring takes the color of the intensity the model expects where it is, and fades out
// where people would no longer feel it. Then the estimated intensity zones stay on the
// map. A model with constant speeds and perfect circles: it shows how shaking travels,
// it is not a measurement.

import { MMI_COLORS, ROMAN, VP_KM_S, VS_KM_S, describeMmi, epicentralKm, estimateMmi, hypocentralKm, mmiAww2014, mmiLevel } from './intensity.js';
import { fmtSeconds } from './hero.js';
import { t } from './i18n.js';

const L = globalThis.L;
export const FELT_MMI = 2; // intensity II: the weakest anyone feels
// Levels are rounded (II covers 1.5–2.5), so the wave stops where II ends: same edge as the zones.
const FELT_EDGE = FELT_MMI - 0.5;
const MAX_KM = 1500;

/** Epicentral radius (km) of a wave front t seconds after the quake at speed v. */
export function frontKm(ev, v, tSec) {
  const r = v * tSec;
  return r <= ev.depth ? 0 : Math.sqrt(r * r - ev.depth * ev.depth);
}

/** Seconds for a wave at speed v to reach an epicentral distance (km). */
export const arrivalSec = (ev, km, v) => hypocentralKm(km, ev.depth) / v;

/** Intensity the model expects at an epicentral distance (no site adjustment). */
export const mmiAtKm = (ev, km) => Math.min(10, Math.max(1, mmiAww2014(ev.mag, hypocentralKm(km, ev.depth))));

/** Farthest epicentral distance (km) where the expected intensity is still >= mmi. */
export function reachKm(ev, mmi) {
  if (mmiAtKm(ev, 0) < mmi) return 0;
  let lo = 0, hi = MAX_KM;
  if (mmiAtKm(ev, hi) >= mmi) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mmiAtKm(ev, mid) >= mmi) lo = mid; else hi = mid;
  }
  return lo;
}

/** Estimated intensity zones: one ring per level, from the outermost felt one in. */
export function zones(ev) {
  const top = mmiLevel(mmiAtKm(ev, 0));
  const out = [];
  for (let level = FELT_MMI; level <= top; level++) {
    const km = reachKm(ev, level - 0.5); // levels are rounded: level n starts at n - 0.5
    if (km > 0.5) out.push({ level, km });
  }
  return out;
}

/** Seconds of simulated time per real second, so the whole thing takes ~10 s at most. */
export const fastSpeed = (fadeKm, ev) => Math.max(1, arrivalSec(ev, fadeKm, VS_KM_S) / 10);

export class Propagation {
  /**
   * map: the Leaflet map; panel: nodes of the control panel;
   * places(): [{ name, lat, lon, siteAdjust, you? }] towns to mark as the wave reaches them.
   */
  constructor(map, panel, places) {
    Object.assign(this, { map, panel, places });
    map.createPane('waves').style.zIndex = 430; // over the plates, under the earthquakes
    this.layer = L.layerGroup().addTo(map);
    this.speedMode = 'fast';
    panel.replay.addEventListener('click', () => this.ev && this.play(this.ev));
    panel.close.addEventListener('click', () => this.stop(true));
    panel.speedBtns.forEach((b) => b.addEventListener('click', () => {
      this.speedMode = b.dataset.speed;
      panel.speedBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (this.ev) this.play(this.ev);
    }));
  }

  get reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

  play(ev) {
    this.stop(false);
    this.ev = ev;
    const fadeKm = reachKm(ev, FELT_EDGE);
    this.fadeKm = fadeKm;
    this.fadeSec = arrivalSec(ev, fadeKm, VS_KM_S);
    this.speed = this.speedMode === 'real' ? 1 : fastSpeed(fadeKm, ev);
    const towns = this.places().map((p) => {
      const km = epicentralKm(ev.lat, ev.lon, p.lat, p.lon);
      return { ...p, km, s: arrivalSec(ev, km, VS_KM_S), mmi: estimateMmi(ev, p.lat, p.lon, p.siteAdjust || 0), hit: false };
    }).sort((a, b) => a.s - b.s);
    this.towns = towns;

    const { panel } = this;
    panel.box.hidden = false;
    panel.title.textContent = t('wave.title', ev.mag.toFixed(1), ev.place);
    panel.speedBtns.forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.speed === this.speedMode)); });
    panel.legend.replaceChildren();
    this.map.getContainer().classList.add('simulating');

    // Frame the whole felt area (a little more for tiny ones, so there is context).
    const km = Math.max(fadeKm, 15) * 1.15;
    const dLat = km / 111.32, dLon = km / (111.32 * Math.cos((ev.lat * Math.PI) / 180));
    const bounds = L.latLngBounds([ev.lat - dLat, ev.lon - dLon], [ev.lat + dLat, ev.lon + dLon]);
    if (this.reduced) this.map.fitBounds(bounds, { maxZoom: 11 });
    else this.map.flyToBounds(bounds, { duration: 0.6, maxZoom: 11 });

    this.epi = L.circleMarker([ev.lat, ev.lon], { pane: 'waves', radius: 5, color: '#000', weight: 1, fillColor: MMI_COLORS[mmiLevel(mmiAtKm(ev, 0))], fillOpacity: 1, interactive: false }).addTo(this.layer);
    if (this.reduced) { this.finish(); return; }
    this.p = L.circle([ev.lat, ev.lon], { pane: 'waves', radius: 1, color: 'currentColor', className: 'wave-p', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(this.layer);
    this.sHalo = L.circle([ev.lat, ev.lon], { pane: 'waves', radius: 1, className: 'wave-halo', weight: 6, opacity: 0.35, fill: false, interactive: false }).addTo(this.layer);
    this.s = L.circle([ev.lat, ev.lon], { pane: 'waves', radius: 1, weight: 3.5, fillOpacity: 0.12, interactive: false }).addTo(this.layer);
    // Start once the map has flown there.
    this.startAt = null;
    const step = (now) => {
      if (this.startAt == null) this.startAt = now + 650;
      const sim = Math.max(0, ((now - this.startAt) / 1000) * this.speed);
      this.frame(sim);
      if (sim < this.fadeSec) this.raf = requestAnimationFrame(step);
      else this.finish();
    };
    this.raf = requestAnimationFrame(step);
  }

  frame(sim) {
    const { ev } = this;
    const sKm = frontKm(ev, VS_KM_S, sim);
    const pKm = Math.min(frontKm(ev, VP_KM_S, sim), MAX_KM);
    const mmi = mmiAtKm(ev, sKm);
    const color = MMI_COLORS[mmiLevel(mmi)];
    this.p.setRadius(Math.max(1, pKm * 1000));
    this.s.setRadius(Math.max(1, sKm * 1000));
    this.sHalo.setRadius(Math.max(1, sKm * 1000));
    // The S front fades as the expected shaking drops toward "not felt".
    const fade = Math.max(0.15, Math.min(1, (mmi - FELT_EDGE) / 2));
    this.s.setStyle({ color, fillColor: color, opacity: fade, fillOpacity: 0.12 * fade });
    for (const town of this.towns) if (!town.hit && town.s <= sim && sKm <= this.fadeKm) this.hitTown(town);
    this.panel.clock.textContent = t('wave.clock', fmtSeconds(Math.max(sim, 0.5)), Math.round(sKm), describeMmi(mmi), this.speed > 1 ? t('wave.speedNote', Math.round(this.speed)) : t('wave.realNote'));
  }

  hitTown(town) {
    town.hit = true;
    const label = `${town.name} · ${fmtSeconds(town.s)} · ${ROMAN[mmiLevel(town.mmi)]}`;
    const icon = L.divIcon({ className: `wave-hit${town.you ? ' you' : ''}`, html: `<span style="--c:${MMI_COLORS[mmiLevel(town.mmi)]}">${label.replace(/[<&]/g, '')}</span>`, iconSize: null });
    L.marker([town.lat, town.lon], { pane: 'labels', icon, interactive: false, keyboard: false }).addTo(this.layer);
  }

  finish() {
    cancelAnimationFrame(this.raf);
    const { ev } = this;
    for (const l of [this.p, this.s, this.sHalo]) if (l) this.layer.removeLayer(l);
    for (const town of this.towns) if (!town.hit && town.km <= this.fadeKm) this.hitTown(town);
    // Estimated intensity zones, outermost first so the inner ones sit on top.
    const list = zones(ev);
    for (const z of [...list].reverse()) {
      L.circle([ev.lat, ev.lon], { pane: 'waves', radius: z.km * 1000, color: MMI_COLORS[z.level], weight: 1, opacity: 0.9, fillColor: MMI_COLORS[z.level], fillOpacity: 0.22, interactive: false }).addTo(this.layer);
    }
    this.epi?.bringToFront();
    this.panel.clock.textContent = this.fadeKm > 0
      ? t('wave.done', Math.round(this.fadeKm), fmtSeconds(this.fadeSec))
      : t('wave.notFelt');
    this.panel.legend.replaceChildren(...list.map((z) => {
      const s = document.createElement('span');
      const i = document.createElement('i');
      i.className = 'sw';
      i.style.background = MMI_COLORS[z.level];
      s.append(i, `${ROMAN[z.level]} ${t('wave.upTo', Math.round(z.km))}`);
      return s;
    }));
  }

  stop(hidePanel) {
    cancelAnimationFrame(this.raf);
    this.layer.clearLayers();
    this.p = this.s = this.sHalo = this.epi = null;
    if (hidePanel) {
      this.ev = null;
      this.panel.box.hidden = true;
      this.map.getContainer().classList.remove('simulating');
    }
  }
}
