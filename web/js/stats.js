// Frequency of earthquakes over time. Pure, so it can be unit tested.

const H = 3600e3;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Rolling-window frequency every `stepH` hours from `start` to `end` (ms):
 * earthquakes per hour in the previous `windowH` hours (shorter at the start, where
 * the window can't reach back past `start`), the same for M4+, and the mean
 * magnitude and mean estimated intensity (mmiOf) of the earthquakes in the window,
 * when there are at least `minN` of them.
 */
export function rateSeries(events, { start, end, windowH = 6, stepH = 1, mmiOf = null, minN = 3 }) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  const times = [];
  for (let t = start + stepH * H; t < end; t += stepH * H) times.push(t);
  if (end > start) times.push(end);
  return times.map((t) => {
    const from = Math.max(start, t - windowH * H);
    const hours = (t - from) / H;
    const w = ev.filter((e) => e.t.getTime() > from && e.t.getTime() <= t);
    const m4 = w.filter((e) => e.mag >= 4).length;
    const enough = w.length >= minN;
    return {
      t: new Date(t),
      from: new Date(from),
      n: w.length,
      m4,
      rate: w.length / hours,
      rateM4: m4 / hours,
      meanMag: enough ? mean(w.map((e) => e.mag)) : null,
      meanMmi: enough && mmiOf ? mean(w.map(mmiOf)) : null,
    };
  });
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
