import { parseHls, parseDash, analyzeSegments } from './segments.js';
const $ = (id) => document.getElementById(id);
const fmt = (value) =>
  Number(value.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
let files = [],
  representations = [],
  segmentResult = null,
  generation = 0;
function error(message) {
  $('segment-status').textContent = message;
  $('segment-output').hidden = true;
  $('segment-export').disabled = true;
  segmentResult = null;
}
async function loadManifest() {
  const version = ++generation;
  error('Reading manifest…');
  $('segment-representation').replaceChildren();
  try {
    const file = files.find(
      (f) => (f.webkitRelativePath || f.name) === $('segment-manifest').value,
    );
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) throw new Error('Manifest exceeds the 5 MiB limit.');
    const text = await file.text();
    if (version !== generation) return;
    representations = /\.m3u8$/i.test(file.name) ? parseHls(text) : parseDash(text);
    $('segment-representation').replaceChildren(
      ...representations.map((r, i) => new Option(r.label, String(i))),
    );
    calculate();
  } catch (e) {
    if (version === generation) error(e.message);
  }
}
function calculate() {
  try {
    const representation = representations[Number($('segment-representation').value)];
    if (!representation) return;
    segmentResult = analyzeSegments(representation, files, $('segment-manifest').value);
    const r = segmentResult;
    $('segment-summary').textContent =
      `${r.points.length} segments · ${fmt(r.duration_seconds)} s · ${fmt(r.average_mbps)} Mbps average · ${fmt(r.peak_mbps)} Mbps peak · ${r.initialization_bytes.toLocaleString()} initialization bytes (separate)`;
    $('segment-rows').replaceChildren(
      ...r.points.slice(0, 500).map((p) => {
        const row = document.createElement('tr');
        for (const value of [
          p.segment,
          p.path,
          fmt(p.duration),
          p.bytes.toLocaleString(),
          fmt(p.bitrate_mbps),
        ])
          row.append(Object.assign(document.createElement('td'), { textContent: value }));
        return row;
      }),
    );
    $('segment-status').textContent =
      r.points.length > 500
        ? 'Showing the first 500 segments. CSV includes all segments.'
        : 'All segments shown.';
    window.dispatchEvent(new CustomEvent('segment-result', { detail: r }));
    $('segment-output').hidden = false;
    $('segment-export').disabled = false;
  } catch (e) {
    error(e.message);
  }
}
for (const id of ['segment-files', 'segment-folder'])
  $(id).addEventListener('change', () => {
    ++generation;
    files = [...$(id).files];
    representations = [];
    error('Select a manifest.');
    $('segment-manifest').replaceChildren();
    $('segment-representation').replaceChildren();
    if (files.length > 100100) {
      error('Select a package with at most 100,100 files.');
      return;
    }
    const manifests = files.filter((f) => /\.(m3u8|mpd)$/i.test(f.name));
    $('segment-manifest').replaceChildren(
      ...manifests.map(
        (f) => new Option(f.webkitRelativePath || f.name, f.webkitRelativePath || f.name),
      ),
    );
    if (!manifests.length) {
      error(
        'Include an HLS media playlist (.m3u8) or static DASH manifest (.mpd) with its segment files.',
      );
      return;
    }
    void loadManifest();
  });
$('segment-manifest').addEventListener('change', () => void loadManifest());
$('segment-representation').addEventListener('change', calculate);
$('segment-export').addEventListener('click', () => {
  if (!segmentResult) return;
  const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
  const csv =
    'segment,path,time_seconds,duration_seconds,bytes,bitrate_mbps\n' +
    segmentResult.points
      .map((p) => [p.segment, quote(p.path), p.time, p.duration, p.bytes, p.bitrate_mbps].join(','))
      .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    a = document.createElement('a');
  a.href = url;
  a.download = 'segment-bitrates.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
