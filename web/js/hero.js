// The latest earthquake, up top: what, where, when, how strong where you are, how long
// the shaking took to reach each town, and ways to share it. Pure helpers first
// (unit tested), then the renderer.

import { VS_KM_S, epicentralKm, hypocentralKm } from './intensity.js';
import { lang, t } from './i18n.js';

/** Seismic energy in tonnes of TNT (Gutenberg–Richter: log10 E[J] = 1.5 M + 4.8). */
export const energyTonnes = (mag) => 10 ** (1.5 * mag + 4.8) / 4.184e9;

/** "21 t", "480 kg", "15 mil t" / "15 thousand t": two significant figures at most. */
export function fmtEnergy(tonnes) {
  const en = lang() === 'en';
  const round2 = (v) => (v >= 100 ? Math.round(v / 10) * 10 : v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  const num = (v) => round2(v).toLocaleString(en ? 'en-US' : 'es-PA');
  if (tonnes < 1) return `${num(tonnes * 1000)} kg`;
  if (tonnes < 1e3) return `${num(tonnes)} t`;
  if (tonnes < 1e6) return en ? `${num(tonnes / 1e3)} thousand t` : `${num(tonnes / 1e3)} mil t`;
  return en ? `${num(tonnes / 1e6)} million t` : `${num(tonnes / 1e6)} millones de t`;
}

/** Seconds for the S wave (the one that shakes most) to reach each place, nearest first. */
export function arrivals(ev, places) {
  return places
    .map((p) => {
      const km = epicentralKm(ev.lat, ev.lon, p.lat, p.lon);
      return { ...p, km, s: hypocentralKm(km, ev.depth) / VS_KM_S };
    })
    .sort((a, b) => a.s - b.s);
}

/** "15 s", "1 min 2 s". */
export function fmtSeconds(s) {
  const r = Math.max(1, Math.round(s));
  if (r < 60) return `${r} s`;
  return r % 60 ? `${Math.floor(r / 60)} min ${r % 60} s` : `${r / 60} min`;
}

/** Link that opens WhatsApp with the text ready to send. */
export const whatsappLink = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** The page's address in the current language, without filters (for sharing). */
export function shareUrl(loc = globalThis.location) {
  const u = new URL(loc.pathname, loc.origin);
  if (lang() !== 'es') u.searchParams.set('lang', lang());
  return u.toString();
}

/** Restarts the "wave reaching each town" animation: bars grow at one constant speed,
 * so each town fills in at its own arrival time (scaled to about 2 seconds). */
export function playWave(list) {
  list.classList.remove('play');
  void list.offsetWidth; // restart the CSS animation
  list.classList.add('play');
}

/**
 * Renders the hero. `ev` is the latest earthquake; `refs` the towns for the arrival
 * times (with the visitor's location among them when known); `felt` the intensity at
 * the reference point: { mmi, color, roman, text }.
 */
export function renderHero(nodes, { ev, ago, time, place, felt, refs, you, sourceText, shareText }) {
  nodes.box.hidden = false;
  nodes.mag.textContent = ev.mag.toFixed(1);
  nodes.ago.textContent = ago;
  nodes.place.textContent = place;
  nodes.time.textContent = time;
  nodes.depth.textContent = t('hero.depthVal', Math.round(ev.depth));
  nodes.energy.textContent = t('hero.energyVal', fmtEnergy(energyTonnes(ev.mag)));
  nodes.src.textContent = sourceText;
  nodes.mmi.textContent = felt.roman;
  nodes.mmi.style.background = felt.color;
  nodes.felt.textContent = felt.text;
  nodes.locate.hidden = Boolean(you);
  nodes.wa.href = whatsappLink(shareText);

  const list = arrivals(ev, refs);
  const max = Math.max(...list.map((a) => a.s));
  const items = list.map((a) => {
    const li = document.createElement('li');
    if (a.you) li.className = 'you';
    const name = document.createElement('span');
    name.className = 'arr-name';
    name.textContent = a.name;
    const track = document.createElement('span');
    track.className = 'arr-track';
    const bar = document.createElement('span');
    bar.className = 'arr-bar';
    const share = a.s / max;
    bar.style.setProperty('--w', share.toFixed(3));
    bar.style.setProperty('--d', `${(share * 2).toFixed(2)}s`);
    track.append(bar);
    const val = document.createElement('span');
    val.className = 'arr-val';
    val.textContent = fmtSeconds(a.s);
    const km = document.createElement('span');
    km.className = 'arr-km';
    km.textContent = `${Math.round(a.km)} km`;
    li.append(name, track, val, km);
    return li;
  });
  nodes.arrivals.replaceChildren(...items);
}
