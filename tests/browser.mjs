/**
 * Browser integration tests. Serves the built app (dist/) to Chromium, drives the UI, and checks
 * WASM results against native FFprobe. Needs ffmpeg, ffprobe and Chromium; run `npm run build`
 * first.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { analyze, normalizeMetadata } from '../src/analysis.js';

const TIMEOUT_MS = 60000;
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

// ---------------------------------------------------------------------------------------------
// Test media, generated with native ffmpeg
// ---------------------------------------------------------------------------------------------

const temp = await mkdtemp(join(tmpdir(), 'bitrate-wasm-tests-'));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function makeMedia(name, args) {
  const path = join(temp, name);
  run('ffmpeg', ['-v', 'error', ...args, path]);
  return path;
}

const testPattern = ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25'];
const sine = ['-f', 'lavfi', '-i', 'sine=sample_rate=48000'];
// 3.2 s of H.264 with B-frames plus AAC audio.
const video = makeMedia('bframes.mp4', [
  ...testPattern,
  ...sine,
  ...['-t', '3.2', '-c:v', 'libx264', '-g', '25', '-bf', '2', '-c:a', 'aac'],
]);
// Two copies of the audio track; the second is marked as the default.
const multi = makeMedia('multi.mp4', [
  ...['-i', video, '-map', '0:v:0', '-map', '0:a:0', '-map', '0:a:0', '-c', 'copy'],
  ...['-disposition:a:0', '0', '-disposition:a:1', 'default'],
]);
const audio = makeMedia('audio.mp3', [...sine, '-t', '3.2', '-c:a', 'libmp3lame']);
const flac = makeMedia('audio.flac', [...sine, '-t', '3.2']);
const mkv = makeMedia('video.mkv', [...testPattern, '-t', '3.2', '-c:v', 'libvpx-vp9', '-g', '25']);
const ts = makeMedia('video.ts', [
  ...testPattern,
  ...['-t', '3.2', '-c:v', 'libx264', '-g', '25', '-f', 'mpegts'],
]);
const short = makeMedia('short.wav', [...sine, '-t', '0.2']);
const bad = join(temp, 'invalid.mp4');
await writeFile(bad, 'not a media file');

// ---------------------------------------------------------------------------------------------
// Static server for dist/, recording every request the page makes
// ---------------------------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.html': 'text/html',
};
const requests = [];
const pageErrors = [];

const server = createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://local').pathname;
    const path = resolve('dist', '.' + (name === '/' ? '/index.html' : name));
    if (!path.startsWith(resolve('dist') + '/')) {
      response.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(path)] || 'text/plain',
      'Cache-Control': 'max-age=3600',
    });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

function watchPage(page) {
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  page.on('pageerror', (error) => pageErrors.push(error.message));
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Runs the probe worker directly in the page and returns its result (or streams) message. */
async function analyzeInBrowser(page, path, options = {}) {
  const bytes = await readFile(path);
  return page.evaluate(
    ({ bytes, name, options }) =>
      new Promise((resolve, reject) => {
        const progress = [];
        const worker = new Worker('./probe-worker.js', { type: 'module' });
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error('WASM test timeout'));
        }, 60000);
        const finish = () => {
          clearTimeout(timer);
          worker.terminate();
        };
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') {
            progress.push(data);
          } else if (data.type === 'streams') {
            finish();
            resolve(data);
          } else if (data.type === 'result') {
            finish();
            resolve({ ...data.result, test_progress: progress });
          } else if (data.type === 'error') {
            finish();
            reject(new Error(data.message));
          }
        };
        worker.onerror = (error) => {
          finish();
          reject(new Error(error.message));
        };
        const file = new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name);
        worker.postMessage({
          file,
          mode: 'seconds',
          timestamp: 'pts',
          stream: 'auto',
          includePartial: false,
          ...options,
        });
      }),
    { bytes: bytes.toString('base64'), name: path.split('/').at(-1), options },
  );
}

/**
 * The expected result, from native FFprobe JSON. Stream selection is re-implemented here rather
 * than shared with the app, so that the two are checked against each other.
 */
function analyzeNatively(path, options = {}) {
  const data = JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-show_packets',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path,
    ]),
  );
  const streams = normalizeMetadata(data).streams;
  const playable = (type) => streams.filter((s) => s.type === type && !s.attached_picture);

  let tracks;
  if (options.stream === 'combined') {
    tracks = ['video', 'audio']
      .map((type) => playable(type).find((s) => s.default) || playable(type)[0])
      .filter(Boolean);
  } else if (options.stream && options.stream !== 'auto') {
    tracks = [streams.find((s) => String(s.index) === options.stream)];
  } else {
    tracks = [playable('video')[0] || streams.find((s) => s.type === 'audio')];
  }

  const packets = data.packets
    .filter((packet) => tracks.some((track) => packet.stream_index === track.index))
    .map((packet) => {
      const track = tracks.find((t) => t.index === packet.stream_index);
      return {
        time: Number(packet[`${options.timestamp || 'pts'}_time`]),
        size: Number(packet.size),
        duration: Number(packet.duration_time) || (track.fps > 0 ? 1 / track.fps : 0),
        keyframe: packet.flags?.includes('K'),
      };
    });
  return analyze(packets, {
    mode: options.mode || 'seconds',
    includePartial: options.includePartial || false,
    video: tracks[0].type === 'video',
  });
}

const waitForState = (page, state) =>
  page.locator(`.results[data-state="${state}"]`).waitFor({ timeout: TIMEOUT_MS });

async function analyzeInUi(page) {
  await page.locator('#analyze').click();
  await waitForState(page, 'complete');
}

async function chooseFile(page, path) {
  await page.locator('#file').setInputFiles(path);
  await waitForState(page, 'ready');
}

async function download(page, buttonId) {
  const pending = page.waitForEvent('download');
  await page.locator('#' + buttonId).click();
  return pending;
}

async function assertNoHorizontalScroll(page) {
  await page.setViewportSize(PHONE);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize(DESKTOP);
}

/** Checks the number of chart lines, and that each is made of flat segments only. */
async function assertChartLines(page, count) {
  const lines = page.locator('#chart path[data-series]');
  assert.equal(await lines.count(), count);
  for (const line of await lines.all()) assert.doesNotMatch(await line.getAttribute('d'), /[VL]/);
}

/** Screen coordinates of a point late in the 1–2 s interval of the 3 s test chart. */
function chartPointLateInSecondInterval(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#chart svg');
    const width = svg.viewBox.baseVal.width;
    const point = new DOMPoint(55 + (1.9 / 3) * (width - 15 - 55), 150).matrixTransform(
      svg.getScreenCTM(),
    );
    return { x: point.x, y: point.y };
  });
}

// ---------------------------------------------------------------------------------------------
// Tests. They share one page and run in order; later steps rely on earlier state.
// ---------------------------------------------------------------------------------------------

async function testInitialLayout(page) {
  assert.ok(
    await page.evaluate(() => {
      const chartTop = document.querySelector('.chart-panel').getBoundingClientRect().top;
      const settingsTop = document.querySelector('aside').getBoundingClientRect().top;
      return Math.abs(chartTop - settingsTop) < 1;
    }),
    'Chart aligns with source panel',
  );
}

// DASH parsing uses the browser's XML parser, so it is tested here; expected rates are worked out by hand.
async function testDashParsing(page) {
  await page.evaluate(async () => {
    const { parseDash, analyzeSegments } = await import('./segments.js');
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const head =
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT3S"><Period><AdaptationSet contentType="video">';
    const tail = '</AdaptationSet></Period></MPD>';

    const template =
      head +
      '<SegmentTemplate timescale="10" duration="20" media="seg$Number%03d$.m4s" initialization="init.mp4"/><Representation id="v" bandwidth="1000000"/>' +
      tail;
    const [representation] = parseDash(template);
    check(
      representation.segments[0].uri === 'seg001.m4s' && representation.segments[1].duration === 1,
      'DASH template duration / padding',
    );
    const files = [
      { name: 'seg001.m4s', size: 250000 },
      { name: 'seg002.m4s', size: 250000 },
      { name: 'init.mp4', size: 10 },
    ];
    const result = analyzeSegments(representation, files, 'main.mpd');
    check(
      result.average_mbps === 4 / 3 && result.peak_mbps === 2 && result.initialization_bytes === 10,
      'DASH packaged segment rates',
    );

    const timeline =
      head +
      '<Representation id="v"><SegmentTemplate timescale="1" media="$Time$.m4s"><SegmentTimeline><S t="0" d="1" r="-1"/></SegmentTimeline></SegmentTemplate></Representation>' +
      tail;
    check(parseDash(timeline)[0].segments.length === 3, 'DASH bounded negative repeat');

    const list =
      head +
      '<BaseURL>chunks/</BaseURL><Representation id="v"><SegmentList duration="3"><SegmentURL media="all.mp4" mediaRange="5-14"/></SegmentList></Representation>' +
      tail;
    const listed = parseDash(list)[0];
    check(
      listed.segments[0].uri === 'chunks/all.mp4' && listed.segments[0].range.length === 10,
      'DASH list / BaseURL / byte ranges',
    );

    for (const xml of [
      '<MPD><Period/><Period/></MPD>',
      '<MPD type="dynamic"><Period/></MPD>',
      '<broken>',
    ]) {
      let failed = false;
      try {
        parseDash(xml);
      } catch {
        failed = true;
      }
      check(failed, 'Unsupported MPD must fail');
    }
  });
}

async function testSegmentAndBandwidthPanels(page) {
  // Both panels start collapsed.
  assert.equal(await page.locator('.bandwidth-panel').evaluate((panel) => panel.open), false);
  assert.equal(await page.locator('.segment-panel').evaluate((panel) => panel.open), false);
  assert.equal(await page.locator('#overhead').isVisible(), false);
  assert.equal(await page.locator('#segment-files').isVisible(), false);
  await page.locator('#bandwidth-title').click();
  await page.locator('#segment-title').click();
  assert.equal(await page.locator('#overhead').isVisible(), true);

  await page.locator('#segment-files').setInputFiles([
    {
      name: 'media.m3u8',
      mimeType: 'application/vnd.apple.mpegurl',
      buffer: Buffer.from('#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:1,\nb.ts'),
    },
    { name: 'a.ts', mimeType: 'video/mp2t', buffer: Buffer.alloc(250000) },
    { name: 'b.ts', mimeType: 'video/mp2t', buffer: Buffer.alloc(250000) },
  ]);
  await page.locator('#segment-output').waitFor({ state: 'visible' });
  assert.match(
    await page.locator('#segment-summary').innerText(),
    /1\.333 Mbps average · 2 Mbps peak/,
  );
  assert.equal(await page.locator('#segment-rows tr').count(), 2);

  // The segment peak (2 Mbps) becomes the bandwidth source: 2 × 1.05 × 1.2 = 2.52.
  assert.equal(await page.locator('#bandwidth-value').innerText(), '2.520 Mbps');
  await page.locator('#overhead').fill('10');
  await page.locator('#headroom').fill('50');
  assert.equal(await page.locator('#bandwidth-value').innerText(), '3.300 Mbps');
  await page.locator('#bandwidth-source').selectOption('segment-average');
  assert.equal(await page.locator('#bandwidth-value').innerText(), '2.200 Mbps');
  await page.locator('#overhead').fill('-1');
  assert.equal(await page.locator('#bandwidth-export').isDisabled(), true);
  await page.locator('#overhead').fill('5');
  await page.locator('#headroom').fill('20');

  const segmentCsv = await download(page, 'segment-export');
  assert.equal(segmentCsv.suggestedFilename(), 'segment-bitrates.csv');
}

async function testMetadataProbe(page) {
  const probe = await analyzeInBrowser(page, multi, { metadataOnly: true });
  assert.equal(probe.scanned_packets, 0, 'File information probe must not scan packets');
  assert.equal(probe.metadata.streams.length, 3);
}

async function testNativeParity(page) {
  const cases = [
    [video, {}],
    [video, { timestamp: 'dts', timeline: { start: 0, duration: 3.2 } }],
    [video, { stream: 'combined', timestamp: 'dts' }],
    [multi, { stream: 'combined', timestamp: 'dts', includePartial: true }],
    [video, { mode: 'gop' }],
    [video, { mode: 'gop', timestamp: 'dts' }],
    [video, { stream: '1' }],
    [audio, {}],
    [flac, {}],
    [mkv, { mode: 'gop' }],
    [ts, { timestamp: 'dts' }],
    [short, { includePartial: true }],
  ];
  for (const [path, options] of cases) {
    const actual = await analyzeInBrowser(page, path, options);
    const expected = analyzeNatively(path, options);
    // PCM packet counts can differ between FFprobe versions, so the WAV file only compares bytes.
    const totals = path === short ? ['total_bytes'] : ['total_packets', 'total_bytes'];
    for (const key of totals) assert.equal(actual[key], expected[key], `${path} ${key}`);

    assert.equal(actual.points.length, expected.points.length, `${path} interval count`);
    const pointKeys =
      path === short
        ? ['time', 'duration', 'bytes', 'bitrate_mbps']
        : ['time', 'duration', 'bytes', 'packets', 'bitrate_mbps'];
    actual.points.forEach((point, i) => {
      for (const key of pointKeys) {
        assert.ok(
          Math.abs(point[key] - expected.points[i][key]) < 1e-5,
          `${path} interval ${i} ${key}: ${point[key]} vs ${expected.points[i][key]}`,
        );
      }
    });

    if (options.stream === 'combined') {
      assert.deepEqual(
        actual.selected_streams.map((s) => s.index),
        path === multi ? [0, 2] : [0, 1],
      );
      assert.equal(actual.stream.index, 'combined');
      for (const point of actual.points) {
        assert.equal(point.video_bytes + point.audio_bytes, point.bytes);
        assert.ok(
          Math.abs(point.video_bitrate_mbps + point.audio_bitrate_mbps - point.bitrate_mbps) <
            1e-12,
        );
      }
    }
    if (actual.comparison_data) {
      const paired = analyzeNatively(path, { ...options, stream: 'combined' });
      assert.deepEqual(
        actual.comparison_data.points.map((p) => p.bytes),
        paired.points.map((p) => p.bytes),
      );
      assert.ok(actual.comparison_data.points.some((p) => p.audio_bytes > 0 && p.video_bytes > 0));
    }

    const progress = actual.test_progress;
    assert.ok(progress.some((p) => p.stage === 'loading'));
    assert.ok(progress.some((p) => p.stage === 'scanning' && p.packets > 0));
    assert.ok(progress.some((p) => p.stage === 'calculating'));
    if (options.timeline) {
      assert.ok(
        progress.some(
          (p) => p.stage === 'scanning' && Number.isFinite(p.percent) && p.percent < 100,
        ),
      );
    }
    console.log('Native parity:', path.split('/').at(-1), JSON.stringify(options));
  }
}

async function testWorkerErrors(page) {
  await assert.rejects(
    () => analyzeInBrowser(page, audio, { stream: 'combined' }),
    /requires a video/,
  );
  await assert.rejects(
    () => analyzeInBrowser(page, video, { stream: 'combined', mode: 'gop' }),
    /one-second intervals/,
  );
  await assert.rejects(() => analyzeInBrowser(page, bad), /Invalid|invalid|media|input/i);
  await assert.rejects(() => analyzeInBrowser(page, short), /partial seconds/);
  await assert.rejects(() => analyzeInBrowser(page, audio, { mode: 'gop' }), /video/);
}

async function testCancelAndUnreadableFile(page) {
  await page.locator('#file').setInputFiles(video);
  await page.locator('#cancel').click();
  assert.equal(await page.locator('#stream').isEnabled(), true);
  assert.equal(await page.locator('#analysis-progress').isVisible(), false);

  await page.locator('#file').setInputFiles(bad);
  await waitForState(page, 'error');
  assert.equal(await page.locator('#stream').isEnabled(), true);
  assert.equal(await page.locator('#analysis-progress').isVisible(), false);
  assert.match(await page.locator('#message').innerText(), /Invalid|invalid|media|input/i);
}

async function testFileInformation(page) {
  // Replacing an in-flight probe must not allow stale stream metadata through.
  await page.locator('#file').setInputFiles(audio);
  await chooseFile(page, multi);
  assert.equal(await page.locator('#stream option').count(), 5);
  assert.equal(await page.locator('#file-info').isVisible(), true);
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('#file-info').getBoundingClientRect().bottom <=
        document.querySelector('.chart-panel').getBoundingClientRect().top,
    ),
    'File information sits above chart',
  );

  // The panel collapses and expands.
  await page.locator('#file-info-title').click();
  assert.equal(await page.locator('#file-summary').isVisible(), false);
  assert.equal(await page.locator('#file-info-title').isVisible(), true);
  await page.locator('#file-info-title').click();
  assert.equal(await page.locator('#file-summary').isVisible(), true);

  const reported = JSON.parse(
    run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', multi]),
  );
  const summary = await page.locator('#file-summary').innerText();
  assert.ok(summary.includes(reported.format.format_name));
  assert.match(summary, /3\.200 s/);
  const reportedKbps = (Number(reported.format.bit_rate) / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
  assert.ok(summary.includes(reportedKbps + ' kbps'));
  assert.equal(await page.locator('#file-streams section').count(), 3);
  const streams = await page.locator('#file-streams').innerText();
  assert.match(streams, /avc1/);
  assert.match(streams, /160 × 90/);
  assert.match(streams, /48,000 Hz/);
  await assertNoHorizontalScroll(page);

  await analyzeInUi(page);
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('.bandwidth-panel').getBoundingClientRect().bottom <=
        document.querySelector('#file-info').getBoundingClientRect().top,
    ),
    'File information moves below bandwidth estimate after analysis',
  );
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('#message').getBoundingClientRect().bottom <=
        document.querySelector('.chart-panel').getBoundingClientRect().top,
    ),
    'Status message sits above chart',
  );
  await chooseFile(page, audio);
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('#file-info').getBoundingClientRect().bottom <=
        document.querySelector('.chart-panel').getBoundingClientRect().top,
    ),
    'A newly chosen file shows its information above chart again',
  );
  await chooseFile(page, multi);
}

async function testStreamSelection(page) {
  assert.equal(await page.locator('#stream').inputValue(), 'auto');
  await page.locator('#stream').selectOption('combined');
  assert.equal(await page.locator('#pairing').isVisible(), true);
  await page.locator('#audio-track').selectOption('1');
  await analyzeInUi(page);
  assert.match(await page.locator('#details').innerText(), /#0.*video.*#1.*audio/);
  assert.equal(await page.locator('#audio-track').inputValue(), '1');

  await page.locator('#stream').selectOption('2');
  await analyzeInUi(page);
  assert.match(await page.locator('#details').innerText(), /#2.*audio/);

  await chooseFile(page, audio);
  assert.equal(await page.locator('#stream option').count(), 2);
  assert.equal(await page.locator('#file-streams section').count(), 1);
  assert.match(await page.locator('#file-summary').innerText(), /audio.mp3/);
  assert.equal(await page.locator('#stream').inputValue(), 'auto');
}

async function testAutoAnalysisAndChart(page) {
  await chooseFile(page, video);
  assert.equal(await page.locator('#stream option').count(), 4);
  assert.equal(await page.locator('#stream').inputValue(), 'auto');
  await analyzeInUi(page);
  assert.equal(await page.locator('#stream option').count(), 4);
  assert.equal(await page.locator('#stream').inputValue(), 'auto');
  assert.equal(await page.locator('[name=timestamp]:checked').inputValue(), 'dts');
  assert.equal(await page.locator('#progress-bar').evaluate((bar) => bar.value), 100);
  assert.equal(await page.locator('#progress-label').innerText(), 'Analysis complete · 100%');

  // Comparison must work after the default Auto analysis, without another Analyze.
  const selectedAverage = await page.locator('#whole-average').innerText();
  await page.locator('#compare').check();
  await assertChartLines(page, 3);
  assert.match(await page.locator('#compare-note').innerText(), /#0 video.*#1 audio/);
  assert.equal(await page.locator('#whole-average').innerText(), selectedAverage);
  await page.locator('#compare').uncheck();
  assert.equal(await page.locator('#chart path[data-series]').count(), 1);

  assert.equal(await page.locator('#filled').isChecked(), true);
  assert.ok((await page.locator('#chart path[data-interval-fill]').count()) > 0);
  await page.locator('#filled').uncheck();
  assert.equal(await page.locator('#chart path[data-interval-fill]').count(), 0);
  await page.locator('#filled').check();
  const intervalLine = await page.locator('#chart path[data-series]').getAttribute('d');
  assert.match(intervalLine, /H.*M.*H/);
  assert.doesNotMatch(intervalLine, /[VL]/);
}

async function testTooltip(page) {
  // Late in the 1–2 second interval, hover must not jump to the 2–3 bucket.
  const point = await chartPointLateInSecondInterval(page);
  await page.evaluate(({ x, y }) => {
    const svg = document.querySelector('#chart svg');
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
  }, point);
  assert.equal(await page.locator('#tooltip-range').textContent(), '1–2 s');
  assert.equal(await page.locator('#interval-highlight').getAttribute('visibility'), 'visible');
  assert.equal(await page.locator('#cursor').count(), 0);
  assert.equal(await page.locator('#tooltip').isVisible(), true);
  assert.equal(await page.locator('#chart svg #tooltip').count(), 0);
  assert.ok(
    await page
      .locator('#interval-highlight')
      .evaluate((rect) => Number(rect.getAttribute('width')) > 0),
  );

  // Hovering an interval's end dot selects that interval, even though the dot sits at its end.
  const endMarker = page.locator('#chart circle[data-interval-start="0"]');
  assert.ok(await endMarker.evaluate((circle) => Number(circle.getAttribute('cx')) > 55));
  await endMarker.dispatchEvent('pointermove', { clientX: 0, clientY: 0 });
  assert.equal(await page.locator('#tooltip-range').textContent(), '0–1 s');
  await endMarker.hover();
  assert.equal(await page.locator('#tooltip-range').textContent(), '0–1 s');
}

async function testCardsAndDetails(page) {
  for (const id of ['peak-note', 'minimum-note']) {
    assert.match(await page.locator('#' + id).innerText(), /\d+(?:\.\d{3})?–\d+(?:\.\d{3})? s/);
  }
  const rangeEntry = page.locator('#details dt').filter({ hasText: 'Analysis range' });
  assert.equal(await rangeEntry.locator('xpath=following-sibling::dd[1]').innerText(), '0 – 3 s');
  for (const id of ['whole-average', 'average', 'peak', 'minimum']) {
    assert.match(await page.locator('#' + id).innerText(), /\d+(?:\.\d{3})?(?:Mbps|kbps|sec)$/);
  }
  assert.match(
    await page.locator('#message').innerText(),
    /excluded from the chart and statistics: -0\.080-0 s, 3-3\.120 s\./,
  );
}

async function testCombinedComparison(page) {
  await page.locator('#stream').selectOption('combined');
  assert.equal(
    await page.locator('#mode option[value=gop]').evaluate((option) => option.disabled),
    true,
  );
  await analyzeInUi(page);
  assert.equal(await page.locator('#stream').inputValue(), 'combined');
  assert.match(await page.locator('#details').innerText(), /#0.*video.*#1.*audio/);
  assert.equal(await page.locator('#legend').innerText(), 'Video + audio · Mbps');

  await page.locator('#compare').check();
  await assertChartLines(page, 3);
  assert.equal(await page.locator('#comparison-key').isVisible(), true);
  await page.locator('#chart svg').hover();
  assert.match(await page.locator('#tooltip').textContent(), /V .* A .* Σ /);

  const csv = await download(page, 'export-csv');
  assert.match(
    await readFile(await csv.path(), 'utf8'),
    /video_bytes,audio_bytes,video_bitrate_mbps,audio_bitrate_mbps/,
  );
  const svg = await download(page, 'export-svg');
  assert.match(await readFile(await svg.path(), 'utf8'), /data-series="audio"/);
  await assertNoHorizontalScroll(page);
}

async function testSingleTrackComparison(page) {
  await page.locator('#stream').selectOption('1');
  await analyzeInUi(page);
  assert.equal(await page.locator('#stream option').count(), 4);
  assert.equal(await page.locator('#compare').isEnabled(), true);
  await page.locator('#compare').check();
  await assertChartLines(page, 3);
  await page.locator('#compare').uncheck();
  assert.equal(await page.locator('#chart path[data-series]').count(), 1);
}

async function testGopAndExports(page) {
  await page.locator('#stream').selectOption('0');
  await page.locator('#mode').selectOption('gop');
  await analyzeInUi(page);
  assert.ok((await page.locator('#gop-body tr').count()) > 0);
  assert.equal(await page.locator('#compare').isDisabled(), true);
  await page.locator('#filled').check();
  await page.locator('#chart svg').hover();
  for (const extension of ['json', 'csv', 'svg']) {
    const file = await download(page, 'export-' + extension);
    assert.ok(file.suggestedFilename().endsWith('.' + extension));
  }
  await page.setViewportSize(PHONE);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  }
}

async function testScrollAndCancel(page) {
  // A finished analysis scrolls the chart into view.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await analyzeInUi(page);
  await page.waitForFunction(() => {
    const rect = document.querySelector('.chart-panel').getBoundingClientRect();
    return rect.top >= -1 && rect.top < 50;
  });
  await page.locator('#analyze').click();
  await page.locator('#cancel').click();
  assert.equal(await page.locator('#analyze').isEnabled(), true);
}

/** Mobile browser emulation, with normal motion and first-analysis layout changes. */
async function testMobile(browser) {
  const context = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const mobile = await context.newPage();
  watchPage(mobile);
  await mobile.goto(origin);
  await chooseFile(mobile, video);
  for (const motion of ['no-preference', 'reduce']) {
    await mobile.emulateMedia({ reducedMotion: motion });
    await analyzeInUi(mobile);
    await mobile.waitForFunction(
      () => {
        const rect = document.querySelector('.chart-panel').getBoundingClientRect();
        return scrollY > 0 && rect.top >= -1 && rect.top < 50;
      },
      {},
      { timeout: 5000 },
    );
  }

  // A tap shows the tooltip inside the screen, and it stays after the finger lifts.
  const point = await chartPointLateInSecondInterval(mobile);
  await mobile.touchscreen.tap(point.x, point.y);
  assert.equal(await mobile.locator('#tooltip-range').textContent(), '1–2 s');
  assert.ok(
    await mobile.locator('#tooltip').evaluate((tooltip) => {
      const rect = tooltip.getBoundingClientRect();
      return (
        rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      );
    }),
  );
  await mobile.locator('#chart svg').dispatchEvent('pointerleave', { pointerType: 'touch' });
  assert.equal(await mobile.locator('#tooltip-range').textContent(), '1–2 s');
  // Tapping elsewhere hides it.
  await mobile.locator('#file-info-title').tap();
  assert.equal(await mobile.locator('#tooltip-range').textContent(), '');
  await context.close();
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.TEST_BROWSER_EXECUTABLE }
      : {}),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: DESKTOP });
  watchPage(page);
  await page.goto(origin);

  await testInitialLayout(page);
  await testDashParsing(page);
  await testSegmentAndBandwidthPanels(page);
  await testMetadataProbe(page);
  await testNativeParity(page);
  await testWorkerErrors(page);
  await testCancelAndUnreadableFile(page);
  await testFileInformation(page);
  await testStreamSelection(page);
  await testAutoAnalysisAndChart(page);
  await testTooltip(page);
  await testCardsAndDetails(page);
  await testCombinedComparison(page);
  await testSingleTrackComparison(page);
  await testGopAndExports(page);
  await testScrollAndCancel(page);
  await testMobile(browser);

  assert.deepEqual(pageErrors, []);
  assert.ok(
    requests.every((request) => request.method === 'GET' && request.url.startsWith(origin + '/')),
    'No uploads or external requests',
  );
  console.log('Browser UI, cancellation, exports, mobile layout, and no-upload checks passed.');
} finally {
  if (browser) await browser.close();
  server.close();
  await rm(temp, { recursive: true, force: true });
}
