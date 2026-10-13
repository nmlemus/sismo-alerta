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
