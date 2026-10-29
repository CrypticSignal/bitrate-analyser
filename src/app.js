/** Main page: choosing a file and stream, running the probe worker, and showing the result. */
import { canCompare, drawChart, hideTooltip } from './chart.js';
import { clearFileInfo, showFileInfo } from './file-info.js';
import { $, definitionItems, downloadFile, formatNumber, tableRow } from './ui.js';

const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TABLE_ROWS = 500;
const results = document.querySelector('.results');

let result = null; // The latest analysis result.
let fileMetadata = null; // Streams and format of the selected file.
let activeWorker = null;
let activeTimer = null;
let chartScrollFrame = null;

// ---------------------------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------------------------

function streamOptions(metadata) {
  const options = [new Option('Auto · first video, otherwise audio', 'auto')];
  const hasVideo =
    !metadata ||
    metadata.streams.some((stream) => stream.type === 'video' && !stream.attached_picture);
  if (hasVideo) options.push(new Option('Combined · default video + audio', 'combined'));
  for (const stream of metadata?.streams || []) {
    options.push(
      new Option(`#${stream.index} · ${stream.type} · ${stream.codec}`, String(stream.index)),
    );
  }
  return options;
}

function setStreamOptions(metadata, value) {
  $('stream').replaceChildren(...streamOptions(metadata));
  $('stream').value = value;
  updateMode();
}

/** Fills the combined-mode track pickers, keeping the current choices unless `reset` is set. */
function populatePairing(metadata, reset = false) {
  for (const type of ['video', 'audio']) {
    const select = $(type + '-track');
    const previous = reset ? 'default' : select.value;
    const tracks = (metadata?.streams || []).filter(
      (stream) => stream.type === type && !stream.attached_picture,
    );
    select.replaceChildren(
      new Option(`Default / first ${type}`, 'default'),
      ...tracks.map(
        (stream) => new Option(`#${stream.index} · ${stream.codec}`, String(stream.index)),
      ),
      ...(type === 'audio' ? [new Option('No audio', 'none')] : []),
    );
    const stillAvailable = [...select.options].some((option) => option.value === previous);
    select.value = stillAvailable ? previous : 'default';
  }
}

/** Enables the controls that make sense for the chosen stream and analysis mode. */
function updateMode() {
  const combined = $('stream').value === 'combined';
  $('pairing').hidden = !combined;
  // Combined analysis only works per second.
  $('mode').querySelector('[value=gop]').disabled = combined;
  if (combined) $('mode').value = 'seconds';

  const gop = $('mode').value === 'gop';
  $('partial').disabled = gop;
  $('partial-hint').textContent = gop
    ? 'GOP boundaries are determined by keyframe packet timestamps.'
    : 'Bitrate = packet bits in each fixed 1-second interval ÷ 1 second. By default, only full intervals within the stream’s packet timeline are included.';
}

function analysisRequest(file) {
  return {
    file,
    mode: $('mode').value,
    timestamp: document.querySelector('[name=timestamp]:checked').value,
    stream: $('stream').value,
    timeline: { start: fileMetadata?.container.start_time, duration: fileMetadata?.duration },
    includePartial: $('partial').checked,
    pairing: { video: $('video-track').value, audio: $('audio-track').value },
  };
}

// ---------------------------------------------------------------------------------------------
// Worker lifecycle and status
// ---------------------------------------------------------------------------------------------

/**
 * Starts a probe worker for `request`. Progress and errors are handled here; every other
 * message is passed to `onMessage`. Only the most recently started worker is listened to.
 */
function startWorker(request, { onMessage, errorMessage, timeoutMessage }) {
  const worker = new Worker(new URL('./probe-worker.js', import.meta.url), { type: 'module' });
  activeWorker = worker;
  worker.onmessage = ({ data }) => {
    if (activeWorker !== worker) return;
    if (data.type === 'progress') {
      showProgress(data);
      $('message').textContent = data.message;
    } else if (data.type === 'error') {
      fail(data.message);
    } else {
      onMessage(data);
    }
  };
  worker.onerror = () => {
    if (activeWorker === worker) fail(errorMessage);
  };
  worker.postMessage(request);
  activeTimer = setTimeout(() => fail(timeoutMessage), WORKER_TIMEOUT_MS);
}

/** Stops any running worker and resets the form controls. */
function finish() {
  if (activeWorker) activeWorker.terminate();
  activeWorker = null;
  clearTimeout(activeTimer);
  $('analyze').disabled = false;
  $('analyze').innerHTML = 'Analyze media <span>↗</span>';
  $('cancel').hidden = true;
  $('stream').disabled = false;
  $('analysis-progress').hidden = true;
}

function fail(message) {
  $('message').className = 'error';
  $('message').textContent = message;
  results.dataset.state = 'error';
  finish();
}

/** `state` is one of reading, ready, analysing, complete or error; tests wait on it. */
function setStatus(state, message) {
  $('message').className = '';
  $('message').textContent = message;
  results.dataset.state = state;
}

function showProgress({ message, percent }) {
  $('analysis-progress').hidden = false;
  $('progress-label').textContent = message;
  if (Number.isFinite(percent)) $('progress-bar').value = percent;
  else $('progress-bar').removeAttribute('value');
}

// ---------------------------------------------------------------------------------------------
// Choosing a file: reads its streams so the user can pick one
// ---------------------------------------------------------------------------------------------

function onFileChanged() {
  cancelChartScroll();
  if (activeWorker) fail('Source changed. Start a new analysis.');
  fileMetadata = null;
  $('analysis-progress').hidden = true;
  populatePairing(null, true);
  clearFileInfo();

  const file = $('file').files[0];
  $('file-name').textContent = file ? file.name : 'Drop a media file here';
  $('file-size').textContent = file
    ? `${formatNumber(file.size / 1024 / 1024, 1)} MB · ready to inspect`
    : 'or click to browse';
  setStreamOptions(null, 'auto');
  if (!file) return;

  $('analyze').disabled = true;
  $('stream').disabled = true;
  $('cancel').hidden = false;
  setStatus('reading', 'Reading stream information…');
  showProgress({ message: 'Reading stream information…' });
  try {
    startWorker(
      { file, metadataOnly: true },
      {
        onMessage: (data) => {
          if (data.type !== 'streams') return;
          fileMetadata = data.metadata;
          showFileInfo(data.metadata, file);
          populatePairing(data.metadata, true);
          setStreamOptions(data.metadata, 'auto');
          finish();
          setStatus('ready', 'Choose a stream, then analyze the media.');
        },
        errorMessage: 'Could not read streams. Check the media file and WASM assets.',
        timeoutMessage: 'Reading streams exceeded five minutes. Try a different file.',
      },
    );
  } catch (error) {
    fail(error.message);
  }
}

function onDropzoneEvent(event) {
  event.preventDefault();
  $('dropzone').classList.toggle('dragover', event.type === 'dragover');
  if (event.type === 'drop' && event.dataTransfer.files.length) {
    // Only the first dropped file is used.
    const transfer = new DataTransfer();
    transfer.items.add(event.dataTransfer.files[0]);
    $('file').files = transfer.files;
    onFileChanged();
  }
}

// ---------------------------------------------------------------------------------------------
// Running an analysis
// ---------------------------------------------------------------------------------------------

function onAnalyze(event) {
  event.preventDefault();
  cancelChartScroll();
  const file = $('file').files[0];
  if (!file) return;
  if (!('Worker' in window) || !('WebAssembly' in window)) {
    fail('This browser needs Web Workers and WebAssembly support.');
    return;
  }

  $('analyze').disabled = true;
  $('analyze').textContent = 'Analyzing locally…';
  $('cancel').hidden = false;
  showProgress({ message: 'Starting local analysis…' });
  setStatus('analysing', 'Starting local analysis…');
  const selection = $('stream').value;
  try {
    startWorker(analysisRequest(file), {
      onMessage: (data) => {
        if (data.type === 'metadata') {
          populatePairing(data.metadata);
          setStreamOptions(data.metadata, selection);
        } else if (data.type === 'result') {
          result = data.result;
          showResult(result);
          finish();
          showProgress({ percent: 100, message: 'Analysis complete · 100%' });
          scrollToChart(result);
        }
      },
      errorMessage:
        'The browser could not run FFprobe. Check that the WASM assets are served correctly, or try a smaller file or another browser.',
      timeoutMessage: 'Analysis exceeded five minutes. Try a shorter clip or a faster device.',
    });
  } catch (error) {
    fail(error.message);
  }
}

/** Scrolls to the chart once the result has been laid out. */
function scrollToChart(completedResult) {
  cancelChartScroll();
  // Wait two frames so result rendering and progress layout changes finish before measuring.
  chartScrollFrame = requestAnimationFrame(() => {
    chartScrollFrame = requestAnimationFrame(() => {
      chartScrollFrame = null;
      if (activeWorker || result !== completedResult) return;
      const chart = document.querySelector('.chart-panel');
      const immediate = window.matchMedia(
        '(max-width: 720px), (pointer: coarse), (prefers-reduced-motion: reduce)',
      ).matches;
      window.scrollTo({
        top: Math.max(0, window.scrollY + chart.getBoundingClientRect().top - 12),
        behavior: immediate ? 'instant' : 'smooth',
      });
    });
  });
}

function cancelChartScroll() {
  if (chartScrollFrame !== null) cancelAnimationFrame(chartScrollFrame);
  chartScrollFrame = null;
}

// ---------------------------------------------------------------------------------------------
// Showing a result
// ---------------------------------------------------------------------------------------------

function showResult(r) {
  results.dataset.state = 'complete';
  showMetrics(r);
  showDetails(r);
  setStreamOptions(r.metadata, r.selection || String(r.stream.index));
  $('message').className = '';
  $('message').textContent = partialSecondsMessage(r);
  showGopTable(r);

  for (const id of ['export-svg', 'export-json', 'export-csv']) $(id).disabled = false;
  $('compare').disabled = !canCompare(r);
  if ($('compare').disabled) $('compare').checked = false;
  redrawChart();
  // Lets the bandwidth panel offer this result as a source.
  window.dispatchEvent(new CustomEvent('bitrate-result', { detail: r }));
}

function showMetrics(r) {
  // Audio-only results are shown in kbps.
  const scale = r.stream.type === 'audio' ? 1000 : 1;
  const unit = scale === 1 ? 'Mbps' : 'kbps';
  showMetric('average', r.bitrate_mbps.mean * scale, unit);
  showMetric('peak', r.bitrate_mbps.max * scale, unit);
  showMetric('minimum', r.bitrate_mbps.min * scale, unit);
  showMetric(
    'whole-average',
    r.overall_bitrate_mbps === null ? null : r.overall_bitrate_mbps * scale,
    unit,
  );

  for (const [id, key] of [
    ['peak', 'max'],
    ['minimum', 'min'],
  ]) {
    const range = r.bitrate_ranges[key];
    const partial = range.partial ? ' (partial second)' : '';
    const ties = range.count > 1 ? ` · first of ${range.count.toLocaleString()} equal values` : '';
    $(id + '-note').textContent =
      `${formatNumber(range.start, 3)}–${formatNumber(range.end, 3)} s${partial}${ties}`;
  }
  const gop = r.mode === 'gop';
  $('chart-title').textContent = gop ? 'GOP bitrate over time' : 'Bitrate over time';
  $('average-note').textContent =
    `${gop ? 'Time-weighted across' : 'Across'} ${r.points.length.toLocaleString()} ${gop ? 'GOPs' : 'second buckets'}`;
}

function showMetric(id, value, unit) {
  $(id).replaceChildren(
    document.createTextNode(value === null ? 'Unavailable' : formatNumber(value, 3)),
    Object.assign(document.createElement('em'), { textContent: unit }),
  );
}

function showDetails(r) {
  $('detail-text').textContent =
    `${r.total_packets.toLocaleString()} valid packets · ${formatNumber(r.total_bytes / 1e6)} MB of stream data · ${r.rejected_packets} rejected packets.`;

  const tracks = (r.selected_streams || [r.stream])
    .map((stream) => `#${stream.index} · ${stream.type} / ${stream.codec}`)
    .join(' + ');
  const details = [
    ['Timestamp basis', r.timestamp],
    ['Selected streams', tracks],
    [
      'Observed timestamp range',
      `${formatNumber(r.first_timestamp, 3)} – ${formatNumber(r.last_timestamp, 3)} s`,
    ],
    [
      'Analysis range',
      `${formatNumber(r.analysis_range.start, 3)} – ${formatNumber(r.analysis_range.end, 3)} s`,
    ],
  ];
  if (r.engine) details.push(['Local engine', `FFprobe ${r.engine.ffprobe} · WASM`]);
  if (r.stream.fps) details.push(['Average frame rate', `${formatNumber(r.stream.fps, 3)} FPS`]);
  if (r.mode === 'seconds') details.push(['Seconds without packets', r.seconds_without_packets]);
  $('details').replaceChildren(...definitionItems(details));
}

/** Describes the partial seconds at the start and end of the timeline, if there are any. */
function partialSecondsMessage(r) {
  if (r.mode !== 'seconds' || !r.partial_seconds.length) return '';
  const count = r.partial_seconds.length;
  const shortTime = (value) =>
    value
      .toFixed(3)
      .replace(/\.000$/, '')
      .replace(/^-0$/, '0');
  const ranges = r.partial_seconds
    .map((second) => {
      const start = Math.max(second, r.first_timestamp);
      const end = Math.min(second + 1, r.end_timestamp);
      return `${shortTime(start)}-${shortTime(end)} s`;
    })
    .join(', ');
  const treatment = r.include_partial
    ? 'included as raw bits per one-second bucket'
    : 'excluded from the chart and statistics';
  const note = r.include_partial ? ' Edge buckets may be lower.' : '';
  return `${count} partial start/end interval${count === 1 ? '' : 's'} ${treatment}: ${ranges}.${note}`;
}

function showGopTable(r) {
  $('gop-panel').hidden = r.mode !== 'gop';
  if (!r.gop) return;
  const { count, duration_seconds: duration, packets } = r.gop;
  $('gop-summary').textContent =
    `${count} GOPs · duration ${formatNumber(duration.min, 3)}–${formatNumber(duration.max, 3)}s · average ${formatNumber(packets.mean, 1)} packets/GOP`;
  $('gop-body').replaceChildren(
    ...r.points
      .slice(0, MAX_TABLE_ROWS)
      .map((point, i) =>
        tableRow([
          i + 1,
          formatNumber(point.time, 3),
          formatNumber(point.duration, 3),
          point.packets,
          formatNumber(point.bitrate_mbps, 3),
        ]),
      ),
  );
  $('gop-note').textContent =
    r.points.length > MAX_TABLE_ROWS
      ? 'Showing the first 500 GOPs. Exports include all GOPs.'
      : 'Exports include all GOPs.';
}

function redrawChart() {
  if (!result) return;
  drawChart(result, { compare: $('compare').checked, filled: $('filled').checked });
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

function downloadResult(content, type, extension) {
  downloadFile(content, type, `${result.filename}.${result.mode}.${extension}`);
}

function exportCsv() {
  const data = $('compare').checked ? result.comparison_data || result : result;
  const comparisonColumns = data.comparison
    ? ['video_bytes', 'audio_bytes', 'video_bitrate_mbps', 'audio_bitrate_mbps']
    : [];
  const header = [
    'time_seconds',
    'duration_seconds',
    'bytes',
    'packets',
    'bitrate_mbps',
    ...comparisonColumns,
  ];
  const rows = data.points.map((point) => [
    point.time,
    point.duration,
    point.bytes,
    point.packets,
    point.bitrate_mbps,
    ...comparisonColumns.map((key) => point[key]),
  ]);
  const csv = [header, ...rows].map((row) => row.join(',')).join('\n');
  downloadResult(csv, 'text/csv', 'csv');
}

// ---------------------------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------------------------

$('file').addEventListener('change', onFileChanged);
for (const type of ['dragover', 'dragleave', 'drop']) {
  $('dropzone').addEventListener(type, onDropzoneEvent);
}
$('stream').addEventListener('change', updateMode);
$('mode').addEventListener('change', updateMode);
$('analysis-form').addEventListener('submit', onAnalyze);
$('cancel').addEventListener('click', () =>
  fail('Analysis canceled. Your file has not left your device.'),
);

$('filled').addEventListener('change', redrawChart);
$('compare').addEventListener('change', redrawChart);
window.addEventListener('resize', redrawChart);
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#chart')) hideTooltip();
});

$('export-json').addEventListener('click', () =>
  downloadResult(JSON.stringify(result, null, 2), 'application/json', 'json'),
);
$('export-csv').addEventListener('click', exportCsv);
$('export-svg').addEventListener('click', () =>
  downloadResult(
    new XMLSerializer().serializeToString($('chart').querySelector('svg')),
    'image/svg+xml',
    'svg',
  ),
);
