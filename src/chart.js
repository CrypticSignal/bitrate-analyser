/** Draws the bitrate chart as an inline SVG, with a hover / tap tooltip. */
import { intervalAtTime, intervalBounds, intervalPath } from './chart-intervals.js';
import { $, formatNumber } from './ui.js';

const HEIGHT = 350;
const LEFT = 55;
const TOP = 22;
const BOTTOM = 300;
// Lines are thinned to roughly this many groups of points so large files stay fast to draw.
const MAX_GROUPS = 900;

const SELECTED_SERIES = [
  { key: 'bitrate_mbps', id: 'selected', label: 'Selected stream', color: '#baf28a' },
];
const COMPARISON_SERIES = [
  { key: 'bitrate_mbps', id: 'combined', label: 'Combined', color: '#baf28a' },
  { key: 'video_bitrate_mbps', id: 'video', label: 'Video', color: '#7dcfff' },
  { key: 'audio_bitrate_mbps', id: 'audio', label: 'Audio', color: '#f6b970' },
];

export function canCompare(result) {
  return !!(result.comparison || result.comparison_data);
}

/**
 * Draws `result` into #chart. With `compare`, draws the video, audio and combined comparison
 * instead of the selected stream. With `filled`, shades the area under the main line.
 */
export function drawChart(result, { compare, filled }) {
  compare = compare && canCompare(result);
  const chartData = compare ? result.comparison_data || result : result;
  const points = chartData.points;
  // Audio-only results are shown in kbps.
  const scale = !compare && result.stream.type === 'audio' ? 1000 : 1;
  const unit = scale === 1 ? 'Mbps' : 'kbps';

  updateLabels(result, compare, points, unit);

  const width = Math.max(320, $('chart').clientWidth - 16);
  const right = width - 15;
  const start = intervalBounds(points[0], chartData).start;
  const end = Math.max(start + 1e-6, intervalBounds(points.at(-1), chartData).end);
  const max = Math.max(chartData.bitrate_mbps.max * scale * 1.12, 0.001);
  const x = (time) => LEFT + ((time - start) / (end - start)) * (right - LEFT);
  const y = (bitrate) => BOTTOM - ((bitrate * scale) / max) * (BOTTOM - TOP);

  const lines = (compare ? COMPARISON_SERIES : SELECTED_SERIES).map((series) => ({
    ...series,
    sampled: samplePoints(points, series.key),
  }));
  const main = lines[0];

  const fill = filled
    ? main.sampled
        .map((point) => {
          const bounds = intervalBounds(point, chartData);
          return `<path data-interval-fill d="M${x(bounds.start)},${BOTTOM} V${y(point[main.key])} H${x(bounds.end)} V${BOTTOM} Z" fill="#baf28a" opacity=".12"/>`;
        })
        .join('')
    : '';
  const paths = lines
    .map((line) => {
      const d = intervalPath(
        line.sampled,
        line.key,
        chartData,
        (time) => x(time).toFixed(2),
        (bitrate) => y(bitrate).toFixed(2),
      );
      return `<path data-series="${line.id}" d="${d}" fill="none" stroke="${line.color}" stroke-width="2" stroke-linejoin="round"><title>${line.label}</title></path>`;
    })
    .join('');
  // A dot at the end of each interval.
  const markers = lines
    .flatMap((line) =>
      line.sampled.map((point) => {
        const cx = x(intervalBounds(point, chartData).end).toFixed(2);
        const cy = y(point[line.key]).toFixed(2);
        return `<circle data-interval-start="${point.time}" cx="${cx}" cy="${cy}" r="2" fill="${line.color}"/>`;
      }),
    )
    .join('');

  const label = `${compare ? 'Video, audio and combined bitrate' : 'Bitrate'} over time in ${unit}`;
  $('chart').innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${label}">` +
    `<rect width="${width}" height="${HEIGHT}" fill="#142022"/>` +
    `<g font-family="system-ui,sans-serif" font-size="12" fill="#91a69c">${axes(right, start, end, max, x)}<text x="${LEFT}" y="13">${unit}</text></g>` +
    `<rect id="interval-highlight" y="${TOP}" height="${BOTTOM - TOP}" fill="#baf28a" opacity=".22" visibility="hidden"/>` +
    `${fill}${paths}${markers}</svg>` +
    `<div id="tooltip" role="tooltip" hidden><strong id="tooltip-range"></strong><div id="tooltip-rates"></div></div>`;

  const svg = $('chart').querySelector('svg');
  const showTooltip = (event) => {
    // Use the hovered dot if there is one, otherwise the interval under the pointer.
    const marker = event.target.closest('[data-interval-start]');
    let time;
    if (marker) {
      time = Number(marker.dataset.intervalStart);
    } else {
      const svgPoint = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        svg.getScreenCTM().inverse(),
      );
      time = start + ((svgPoint.x - LEFT) / (right - LEFT)) * (end - start);
    }
    const point = intervalAtTime(points, time);
    const bounds = intervalBounds(point, chartData);

    const highlight = $('interval-highlight');
    highlight.setAttribute('x', x(bounds.start));
    highlight.setAttribute('width', Math.max(0, x(bounds.end) - x(bounds.start)));
    highlight.setAttribute('visibility', 'visible');

    const partial = point.complete === false ? ' (partial second)' : '';
    $('tooltip-range').textContent =
      `${formatNumber(bounds.start, 3)}–${formatNumber(bounds.end, 3)} s${partial}`;
    $('tooltip-rates').textContent = compare
      ? `V ${formatNumber(point.video_bitrate_mbps, 3)} · A ${formatNumber(point.audio_bitrate_mbps, 3)} · Σ ${formatNumber(point.bitrate_mbps, 3)} Mbps`
      : `${formatNumber(point.bitrate_mbps * scale, 3)} ${unit}`;
    positionTooltip(event);
  };
  svg.addEventListener('pointermove', showTooltip);
  svg.addEventListener('pointerdown', showTooltip);
  // A finger has no hover state, so keep a tapped interval visible after the touch ends.
  svg.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') hideTooltip();
  });
  svg.addEventListener('pointercancel', hideTooltip);
}

export function hideTooltip() {
  $('interval-highlight')?.setAttribute('visibility', 'hidden');
  if ($('tooltip')) $('tooltip').hidden = true;
  for (const id of ['tooltip-range', 'tooltip-rates']) {
    if ($(id)) $(id).textContent = '';
  }
}

/** Sets the legend, caption and comparison note that describe the chart. */
function updateLabels(result, compare, points, unit) {
  const streamType = result.stream.type === 'combined' ? 'Video + audio' : result.stream.type;
  $('legend').textContent = compare ? 'Video + audio comparison · Mbps' : `${streamType} · ${unit}`;

  const partialNote = result.include_partial
    ? ' · partial-second rates still use a 1 s divisor'
    : '';
  const compareNote = compare ? ' · combined comparison timeline' : '';
  $('chart-caption').textContent =
    `${result.timestamp} timestamps · ${points.length.toLocaleString()} intervals · ` +
    `horizontal segments span intervals; dots mark interval ends${partialNote}${compareNote}`;

  $('comparison-key').hidden = !compare;
  $('compare-note').textContent = comparisonNote(result, compare);
}

function comparisonNote(result, compare) {
  if (compare) {
    const tracks = (result.comparison_data || result).selected_streams || [];
    const names = tracks.map((track) => `#${track.index} ${track.type} (${track.codec})`);
    return `Comparing ${names.join(' + ')}. Cards and analysis details describe the selected stream(s); the overlay uses the combined timeline.`;
  }
  if (canCompare(result)) {
    return 'Compare the selected track with its default video/audio counterpart; no additional scan is needed.';
  }
  if (result.mode === 'gop') return 'Comparison requires per-second analysis.';
  return result.comparison_unavailable || 'Comparison requires both a video and an audio track.';
}

/** Horizontal grid lines with bitrate labels, and time labels along the bottom. */
function axes(right, start, end, max, x) {
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const lineY = TOP + ((BOTTOM - TOP) * i) / 4;
    const bitrate = max * (1 - i / 4);
    svg += `<line x1="${LEFT}" y1="${lineY}" x2="${right}" y2="${lineY}" stroke="#2b3c3b"/>`;
    svg += `<text x="${LEFT - 13}" y="${lineY + 4}" text-anchor="end">${formatNumber(bitrate, 3)}</text>`;
    const time = start + ((end - start) * i) / 4;
    svg += `<text x="${x(time)}" y="${BOTTOM + 26}" text-anchor="middle">${formatNumber(time, 1)}s</text>`;
  }
  return svg;
}

/**
 * Thins points for drawing. Each group keeps its first, last, lowest and highest point, so peaks
 * survive. Each line is sampled separately, so small audio peaks are not lost behind video.
 */
function samplePoints(points, key) {
  const sampled = [];
  const groupSize = Math.max(1, Math.ceil(points.length / MAX_GROUPS));
  for (let i = 0; i < points.length; i += groupSize) {
    const group = points.slice(i, i + groupSize);
    const lowest = group.reduce((a, b) => (a[key] < b[key] ? a : b));
    const highest = group.reduce((a, b) => (a[key] > b[key] ? a : b));
    const kept = new Set([group[0], lowest, highest, group.at(-1)]);
    sampled.push(...[...kept].sort((a, b) => a.time - b.time));
  }
  return sampled;
}

/** Places the tooltip near the pointer, flipping sides to stay inside the chart. */
function positionTooltip(event) {
  const tooltip = $('tooltip');
  const area = $('chart').getBoundingClientRect();
  tooltip.hidden = false;
  const pointerX = event.clientX - area.left;
  const pointerY = event.clientY - area.top;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const preferredX =
    pointerX + 14 + width <= area.width - 8 ? pointerX + 14 : pointerX - width - 14;
  const preferredY = pointerY - height - 18 >= 8 ? pointerY - height - 18 : pointerY + 18;
  tooltip.style.left = `${Math.max(8, Math.min(area.width - width - 8, preferredX))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(area.height - height - 8, preferredY))}px`;
}
