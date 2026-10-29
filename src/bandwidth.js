/** Planning assumptions, not a measurement of protocol overhead or buffer behavior. */
export function estimateBandwidth(baseMbps, overheadPercent = 5, headroomPercent = 20) {
  if (!Number.isFinite(baseMbps) || baseMbps < 0)
    throw new Error('No measured bitrate is available for this source.');
  for (const n of [overheadPercent, headroomPercent])
    if (!Number.isFinite(n) || n < 0 || n > 1000)
      throw new Error('Overhead and headroom must be between 0% and 1000%.');
  const withOverhead = baseMbps * (1 + overheadPercent / 100);
  return {
    base_mbps: baseMbps,
    overhead_percent: overheadPercent,
    headroom_percent: headroomPercent,
    with_overhead_mbps: withOverhead,
    estimate_mbps: withOverhead * (1 + headroomPercent / 100),
  };
}
