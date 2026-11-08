/** Interval geometry shared by the analysis and the chart. */

/** An interval's start and end, clipped to the packet timeline. */
export function intervalBounds(point, timeline) {
  return {
    start: Math.max(point.time, timeline.first_timestamp),
    end: Math.min(point.time + point.duration, timeline.end_timestamp),
  };
}

/** The last point starting at or before `time`, found by binary search; points are sorted. */
export function intervalAtTime(points, time) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return points[Math.max(0, low - 1)];
}

/**
 * SVG path data drawing one horizontal segment per interval. The segments are not joined,
 * so the chart does not imply instant jumps between interval rates.
 */
export function intervalPath(points, key, timeline, x, y) {
  return points
    .map((point) => {
      const { start, end } = intervalBounds(point, timeline);
      return `M${x(start)},${y(point[key])} H${x(end)}`;
    })
    .join(' ');
}

// Candidate spacings between time-axis labels, in seconds.
const TIME_STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/**
 * Time-axis labels at round times between `start` and `end` (seconds), at most about `count`
 * of them. Returns [{ time, label }]. Times of a minute or more are written as m:ss or h:mm:ss.
 */
export function timeAxis(start, end, count = 5) {
  const span = end - start;
  const step =
    TIME_STEPS.find((candidate) => span / candidate <= count) ??
    Math.ceil(span / count / 3600) * 3600;
  // Each tick is a whole multiple of the step; the tolerance keeps float error from losing one.
  const tolerance = step * 1e-6;
  const times = [];
  for (let k = Math.ceil((start - tolerance) / step); k * step <= end + tolerance; k++) {
    times.push(k * step);
  }
  let decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  // A span too short for two round labels gets its exact start and end instead.
  if (times.length < 2) {
    times.splice(0, times.length, start, end);
    decimals = 3;
  }

  const largest = Math.max(Math.abs(start), Math.abs(end));
  return times.map((time) => ({
    time,
    label:
      largest >= 60
        ? clockTime(time, decimals, largest >= 3600)
        : `${time.toFixed(decimals).replace(/^-(0\.?0*)$/, '$1')}s`,
  }));
}

/** Formats seconds as m:ss, or h:mm:ss when `hours` is set, with `decimals` second decimals. */
export function clockTime(seconds, decimals = 0, hours = false) {
  const factor = 10 ** decimals;
  // Round once up front so, for example, 59.96 s becomes 1:00.0 rather than 0:60.0.
  const total = Math.round(Math.abs(seconds) * factor) / factor;
  const sign = seconds < 0 && total > 0 ? '-' : '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0');
  return hours ? `${sign}${h}:${String(m).padStart(2, '0')}:${s}` : `${sign}${h * 60 + m}:${s}`;
}
