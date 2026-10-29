/**
 * Returns a function that turns scan updates into progress messages. The percentage is how
 * much of the media timeline has been scanned so far; it is not a time-remaining estimate.
 */
export function scanProgress(timeline = {}) {
  const { start, duration } = timeline;
  const canEstimate = Number.isFinite(start) && Number.isFinite(duration) && duration > 0;
  let furthest = null;
  let percent = null;

  return (timestamp, packets) => {
    if (Number.isFinite(timestamp)) {
      furthest = furthest === null ? timestamp : Math.max(furthest, timestamp);
    }
    if (canEstimate && furthest !== null) {
      const covered = Math.floor(((furthest - start) / duration) * 100);
      // Never move backwards, and stay below 100% until the scan has actually finished.
      percent = Math.max(percent ?? 0, Math.min(99, Math.max(0, covered)));
    }
    const percentText = percent === null ? '' : ` · about ${percent}%`;
    return {
      stage: 'scanning',
      percent,
      packets,
      message: `Scanning packets${percentText} · ${packets.toLocaleString()} packets read`,
    };
  };
}
