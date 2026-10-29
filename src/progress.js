/** Timeline coverage estimates scan progress; it is not a time-remaining estimate. */
export function scanProgress(timeline = {}) {
  const { start, duration } = timeline;
  let furthest = null,
    percent = null;
  return (timestamp, packets) => {
    if (Number.isFinite(timestamp))
      furthest = furthest === null ? timestamp : Math.max(furthest, timestamp);
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0 && furthest !== null) {
      percent = Math.max(
        percent ?? 0,
        Math.min(99, Math.max(0, Math.floor(((furthest - start) / duration) * 100))),
      );
    }
    return {
      stage: 'scanning',
      percent,
      packets,
      message: `Scanning packets${percent === null ? '' : ` · about ${percent}%`} · ${packets.toLocaleString()} packets read`,
    };
  };
}
