/** The "HLS / DASH segment analysis" panel. */
import { analyzeSegments, localPath, parseDash, parseHls } from './segments.js';
import { $, downloadFile, tableRow } from './ui.js';

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
// The segment limit, plus room for manifests and initialization files.
const MAX_FILES = 100_100;
const MAX_TABLE_ROWS = 500;

let files = [];
let representations = [];
let segmentResult = null;
// Increases whenever the selection changes, so a slow manifest read can tell it is stale.
let generation = 0;

const formatNumber = (value) =>
  Number(value.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });

function showError(message) {
  $('segment-status').textContent = message;
  $('segment-output').hidden = true;
  $('segment-export').disabled = true;
  segmentResult = null;
}

function onFilesSelected(event) {
  ++generation;
  files = [...event.target.files];
  representations = [];
  showError('Select a manifest.');
  $('segment-manifest').replaceChildren();
  $('segment-representation').replaceChildren();
  if (files.length > MAX_FILES) {
    showError('Select a package with at most 100,100 files.');
    return;
  }
  const manifests = files.filter((file) => /\.(m3u8|mpd)$/i.test(file.name));
  $('segment-manifest').replaceChildren(
    ...manifests.map((file) => new Option(localPath(file), localPath(file))),
  );
  if (!manifests.length) {
    showError(
      'Include an HLS media playlist (.m3u8) or static DASH manifest (.mpd) with its segment files.',
    );
    return;
  }
  void loadManifest();
}

async function loadManifest() {
  const version = ++generation;
  showError('Reading manifest…');
  $('segment-representation').replaceChildren();
  try {
    const file = files.find((f) => localPath(f) === $('segment-manifest').value);
    if (!file) return;
    if (file.size > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the 5 MiB limit.');
    const text = await file.text();
    if (version !== generation) return;
    representations = /\.m3u8$/i.test(file.name) ? parseHls(text) : parseDash(text);
    $('segment-representation').replaceChildren(
      ...representations.map((representation, i) => new Option(representation.label, String(i))),
    );
    calculate();
  } catch (error) {
    if (version === generation) showError(error.message);
  }
}

function calculate() {
  try {
    const representation = representations[Number($('segment-representation').value)];
    if (!representation) return;
    segmentResult = analyzeSegments(representation, files, $('segment-manifest').value);
    showResult(segmentResult);
    // Lets the bandwidth panel offer this result as a source.
    window.dispatchEvent(new CustomEvent('segment-result', { detail: segmentResult }));
    $('segment-output').hidden = false;
    $('segment-export').disabled = false;
  } catch (error) {
    showError(error.message);
  }
}

function showResult(r) {
  $('segment-summary').textContent =
    `${r.points.length} segments · ${formatNumber(r.duration_seconds)} s · ` +
    `${formatNumber(r.average_mbps)} Mbps average · ${formatNumber(r.peak_mbps)} Mbps peak · ` +
    `${r.initialization_bytes.toLocaleString()} initialization bytes (separate)`;
  $('segment-rows').replaceChildren(
    ...r.points
      .slice(0, MAX_TABLE_ROWS)
      .map((point) =>
        tableRow([
          point.segment,
          point.path,
          formatNumber(point.duration),
          point.bytes.toLocaleString(),
          formatNumber(point.bitrate_mbps),
        ]),
      ),
  );
  $('segment-status').textContent =
    r.points.length > MAX_TABLE_ROWS
      ? 'Showing the first 500 segments. CSV includes all segments.'
      : 'All segments shown.';
}

function exportCsv() {
  if (!segmentResult) return;
  // Paths can contain commas or quotes.
  const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
  const header = 'segment,path,time_seconds,duration_seconds,bytes,bitrate_mbps';
  const rows = segmentResult.points.map((point) =>
    [
      point.segment,
      quote(point.path),
      point.time,
      point.duration,
      point.bytes,
      point.bitrate_mbps,
    ].join(','),
  );
  downloadFile([header, ...rows].join('\n'), 'text/csv', 'segment-bitrates.csv');
}

$('segment-files').addEventListener('change', onFilesSelected);
$('segment-folder').addEventListener('change', onFilesSelected);
$('segment-manifest').addEventListener('change', () => void loadManifest());
$('segment-representation').addEventListener('change', calculate);
$('segment-export').addEventListener('click', exportCsv);
