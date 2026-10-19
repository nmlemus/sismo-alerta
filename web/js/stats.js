// Frequency of earthquakes over time. Pure, so it can be unit tested.

const H = 3600e3;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Index of the first event after time t (ms) in a list sorted by time. */
function after(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t.getTime() <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * How often earthquakes arrive, estimated from the last `k` of them rather than from a
 * fixed time window: at time t, the last k events (at or before t) and the time since
 * the one before them give rate = k / hours. Early on, when they come every few
 * minutes, that covers minutes; days later it covers many hours. So one new event
 * moves the curve by about 1/k instead of making a spike, and a quiet spell lowers it
 * smoothly (the hours keep growing until the next one). The same for M4+ with `kM4`,
 * and the mean magnitude and estimated intensity (mmiOf) of the last k events.
 * Evaluated every `stepH` hours from `start` to `end` (ms), plus at `end`.
 */
export function eventRateSeries(events, { start, end, stepH = 1, k = 20, kM4 = 10, mmiOf = null, minN = 3 }) {
  const ev = events.filter((e) => e.t.getTime() > start).sort((a, b) => a.t - b.t);
  const m4 = ev.filter((e) => e.mag >= 4);
  const times = [];
  for (let t = start + stepH * H; t < end; t += stepH * H) times.push(t);
  if (end > start) times.push(end);
  const rate = (list, kk, t) => {
    const j = after(list, t); // events list[0..j-1] happened by t
    if (j < minN) return { rate: 0, n: j, from: start, win: [] };
    const i = Math.max(0, j - kk);
    const from = i > 0 ? list[i - 1].t.getTime() : start;
    return { rate: (j - i) / Math.max((t - from) / H, 1 / 60), n: j - i, from, win: list.slice(i, j) };
  };
  return times.map((t) => {
    const all = rate(ev, k, t);
    const big = rate(m4, kM4, t);
    const enough = all.win.length >= minN;
    return {
      t: new Date(t),
      from: new Date(all.from),
      n: all.n,
      rate: all.rate,
      rateM4: big.rate,
      meanMag: enough ? mean(all.win.map((e) => e.mag)) : null,
      meanMmi: enough && mmiOf ? mean(all.win.map(mmiOf)) : null,
    };
  });
}

/**
 * Omori–Utsu law, how aftershocks usually die down: rate(t) = K / (t + c)^p per hour,
 * t in hours after the mainshock. Fitted by maximum likelihood to the aftershock times
 * from tMin hours on (the first hour misses many small ones) up to T. Returns
 * { K, p, c, rate(t) } or null with too few aftershocks.
 */
export function omoriFit(hours, { tMin = 1, T }) {
  const ts = hours.filter((x) => x >= tMin && x <= T);
  const N = ts.length;
  if (N < 20 || T <= tMin) return null;
  let best = null;
  for (let pi = 0; pi <= 70; pi++) {
    const p = 0.5 + pi * 0.02;
    for (const c of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10]) {
      const I = Math.abs(p - 1) < 1e-9 ? Math.log((T + c) / (tMin + c)) : ((T + c) ** (1 - p) - (tMin + c) ** (1 - p)) / (1 - p);
      const K = N / I;
      let sl = 0;
      for (const x of ts) sl += Math.log(x + c);
      const ll = N * Math.log(K) - p * sl - N;
      if (!best || ll > best.ll) best = { K, p, c, ll };
    }
  }
  const { K, p, c } = best;
  return { K, p, c, rate: (t) => K / (t + c) ** p };
}

const PANAMA_OFFSET_H = -5; // Panama has no daylight saving time

/** Local hour of the day (0–24, with minutes as a fraction) in Panama. */
export const localHour = (t) => {
  const d = new Date(t.getTime() + PANAMA_OFFSET_H * H);
  return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
};

/** Night: 6 p.m. to 6 a.m., when there is less traffic and machinery shaking the ground. */
export const isNight = (hour) => hour >= 18 || hour < 6;

/**
 * Earthquakes by hour of the day (Panama time): count and M4+ count for each of the
 * 24 hours, and how many of them happened at night.
 */
export function byHour(events) {
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: 0, m4: 0 }));
  const night = { n: 0, m4: 0 };
  for (const e of events) {
    const hr = localHour(e.t);
    const b = hours[Math.floor(hr) % 24];
    b.n++;
    if (e.mag >= 4) b.m4++;
    if (isNight(hr)) { night.n++; if (e.mag >= 4) night.m4++; }
  }
  return { hours, night, n: events.length, m4: events.filter((e) => e.mag >= 4).length };
}
