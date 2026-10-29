/** The "Bandwidth planning estimate" panel. Sources come from media and segment results. */
import { estimateBandwidth } from './bandwidth.js';
import { $, downloadFile } from './ui.js';

// Measured rates to choose from, keyed by <option> value: { label, value }.
const sources = new Map();
let estimate = null;

const formatMbps = (value) => value.toFixed(3).replace(/\.000$/, '');

function render() {
  try {
    estimate = calculateEstimate();
    $('bandwidth-value').textContent = `${formatMbps(estimate.estimate_mbps)} Mbps`;
    $('bandwidth-detail').textContent =
      `${estimate.source}: ${formatMbps(estimate.base_mbps)} Mbps` +
      ` × ${formatMbps(1 + estimate.overhead_percent / 100)} (overhead)` +
      ` × ${formatMbps(1 + estimate.headroom_percent / 100)} (headroom).`;
    $('bandwidth-export').disabled = false;
  } catch (error) {
    estimate = null;
    $('bandwidth-value').textContent = '—';
    $('bandwidth-detail').textContent = error.message;
    $('bandwidth-export').disabled = true;
  }
}

function calculateEstimate() {
  const source = sources.get($('bandwidth-source').value);
  if (!source) throw new Error('Analyze media or local segments to calculate an estimate.');
  const overhead = $('overhead').value.trim();
  const headroom = $('headroom').value.trim();
  if (!overhead || !headroom) throw new Error('Enter both overhead and headroom percentages.');
  return {
    source: source.label,
    ...estimateBandwidth(source.value, Number(overhead), Number(headroom)),
  };
}

/** Adds or replaces sources ([key, label, value] entries) and selects `preferred`. */
function updateSources(entries, preferred) {
  for (const [key, label, value] of entries) sources.set(key, { label, value });
  $('bandwidth-source').replaceChildren(
    ...[...sources].map(([key, source]) => new Option(source.label, key)),
  );
  $('bandwidth-source').value = preferred;
  render();
}

window.addEventListener('bitrate-result', ({ detail: result }) =>
  updateSources(
    [
      ['media-peak', 'Selected media: peak displayed interval', result.bitrate_mbps.max],
      ['media-average', 'Selected media: overall average', result.overall_bitrate_mbps],
    ],
    'media-peak',
  ),
);
window.addEventListener('segment-result', ({ detail: result }) =>
  updateSources(
    [
      ['segment-peak', 'Local segments: peak segment', result.peak_mbps],
      ['segment-average', 'Local segments: duration-weighted average', result.average_mbps],
    ],
    'segment-peak',
  ),
);
for (const id of ['bandwidth-source', 'overhead', 'headroom']) {
  $(id).addEventListener('input', render);
}
$('bandwidth-export').addEventListener('click', () => {
  if (!estimate) return;
  downloadFile(JSON.stringify(estimate, null, 2), 'application/json', 'bandwidth-estimate.json');
});

render();
