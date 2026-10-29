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
