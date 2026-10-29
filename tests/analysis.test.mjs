import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, parsePacket, normalizeMetadata, playbackStreams } from '../src/analysis.js';
test('exactly three seconds retains all three full intervals', () => {
  const r = analyze(
    Array.from({ length: 75 }, (_, i) => ({ time: i / 25, size: 1000, duration: 0.04 })),
  );
  assert.deepEqual(
    r.points.map((p) => p.time),
    [0, 1, 2],
  );
  assert.ok(Math.abs(r.bitrate_mbps.mean - 0.2) < 1e-12);
  assert.deepEqual(r.partial_seconds, []);
});
test('negative timestamps use floor and gaps are explicit', () => {
  const r = analyze(
    [
      { time: -0.04, size: 100 },
      { time: 2.1, size: 200 },
    ],
    { includePartial: true },
  );
  assert.deepEqual(
    r.points.map((p) => p.time),
    [-1, 0, 1, 2],
  );
  assert.equal(r.seconds_without_packets, 2);
});
test('partial seconds are opt-in; missing packets are not invented', () => {
  assert.throws(() => analyze([{ time: 0, size: 100 }]), /No full one-second intervals/);
  assert.equal(analyze([{ time: 0, size: 100 }], { includePartial: true }).points[0].bytes, 100);
});
test('GOP boundary and final variable duration produce known rates', () => {
  const r = analyze(
    [
      { time: 0, size: 100, duration: 0.1, keyframe: true },
      { time: 0.1, size: 200, duration: 0.2 },
      { time: 0.3, size: 300, duration: 0.1, keyframe: true },
      { time: 0.4, size: 400, duration: 0.3 },
    ],
    { mode: 'gop' },
  );
  assert.equal(r.gop.count, 2);
  assert.ok(Math.abs(r.points[1].duration - 0.4) < 1e-12);
  assert.ok(Math.abs(r.points[1].bitrate_mbps - 0.014) < 1e-12);
});
test('invalid timestamps, sparse streams and audio GOP errors remain actionable', () => {
  assert.throws(() => analyze([{ time: NaN, size: 100 }]), /No valid/);
  assert.throws(() => analyze([{ time: 0, size: 100 }], { mode: 'gop', video: false }), /video/);
});
test('compact packet parsing handles DTS, N/A, flags and side-data lines', () => {
  assert.deepEqual(
    parsePacket('stream_index=0|dts_time=-0.04|duration_time=0.04|size=1200|flags=K__', 'dts'),
    { time: -0.04, size: 1200, duration: 0.04, keyframe: true },
  );
  assert.equal(parsePacket('pts_time=N/A|size=12', 'pts'), false);
  assert.equal(parsePacket('side_data_type=Skip Samples', 'pts'), null);
});
test('stream metadata tolerates unknown frame rates and preserves indices', () => {
  const r = normalizeMetadata({
    streams: [{ index: 2, codec_type: 'audio', codec_name: 'aac', avg_frame_rate: '0/0' }],
  });
  assert.equal(r.streams[0].fps, 0);
  assert.equal(r.streams[0].index, 2);
});

test('low frame rate needs no packet-coverage heuristic', () => {
  const r = analyze([
    { time: 0, size: 100, duration: 0.5 },
    { time: 0.5, size: 200, duration: 0.5 },
  ]);
  assert.equal(r.points.length, 1);
  assert.equal(r.points[0].bytes, 300);
});
test('fractional edges are excluded; empty full intervals contribute zero', () => {
  const data = [
    { time: 0.2, size: 100, duration: 0.2 },
    { time: 2.2, size: 200, duration: 0.2 },
  ];
  const full = analyze(data);
  assert.deepEqual(
    full.points.map((p) => p.time),
    [1],
  );
  assert.equal(full.bitrate_mbps.mean, 0);
  assert.deepEqual(full.partial_seconds, [0, 2]);
  const all = analyze(data, { includePartial: true });
  assert.deepEqual(
    all.points.map((p) => p.time),
    [0, 1, 2],
  );
  assert.equal(all.points[0].bitrate_mbps, 0.0008);
  assert.equal(all.points[0].duration, 1);
});
test('unknown final duration is conservative and excessive timestamp gaps are bounded', () => {
  assert.equal(
    analyze([
      { time: 0, size: 100 },
      { time: 1, size: 100 },
    ]).points.length,
    1,
  );
  assert.throws(
    () =>
      analyze([
        { time: 0, size: 1 },
        { time: 3000000, size: 1 },
      ]),
    /interval limit/,
  );
});

test('GOP average is total bits divided by duration, excluding pre-keyframe bytes', () => {
  const r = analyze(
    [
      { time: -1, size: 9000, duration: 1 },
      { time: 0, size: 1000, duration: 1, keyframe: true },
      { time: 1, size: 1000, duration: 3, keyframe: true },
    ],
    { mode: 'gop' },
  );
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].bitrate_mbps, 0.008);
  assert.equal(r.points[1].bitrate_mbps, 0.008 / 3);
  assert.equal(r.bitrate_mbps.mean, 0.004); // 2000 bytes * 8 / 4 seconds / 1e6
  assert.equal(r.bitrate_mbps.max, 0.008);
  assert.equal(r.bitrate_mbps.min, 0.008 / 3);
});
test('final GOP uses the latest packet end, not just the latest timestamp', () => {
  const r = analyze(
    [
      { time: 0, size: 100, duration: 2, keyframe: true },
      { time: 1, size: 100, duration: 0.25 },
    ],
    { mode: 'gop' },
  );
  assert.equal(r.points[0].duration, 2);
  assert.equal(r.bitrate_mbps.mean, 0.0008);
});
test('unknown or invalid GOP durations never produce NaN rates', () => {
  for (const duration of [undefined, NaN, Infinity, -1]) {
    assert.throws(
      () => analyze([{ time: 0, size: 100, duration, keyframe: true }], { mode: 'gop' }),
      /No measurable GOPs/,
    );
    const r = analyze(
      [
        { time: 0, size: 100, duration: 1, keyframe: true },
        { time: 1, size: 200, duration, keyframe: true },
      ],
      { mode: 'gop' },
    );
    assert.equal(r.points.length, 1);
    assert.equal(r.bitrate_mbps.mean, 0.0008);
  }
});
test('negative packet durations use a valid frame rate fallback', () => {
  assert.equal(parsePacket('pts_time=0|duration_time=-1|size=100', 'pts', 25).duration, 0.04);
});
test('decimal units and fixed-bucket averages conserve analyzed bytes', () => {
  const r = analyze([
    { time: 0, size: 125000, duration: 1 },
    { time: 1, size: 375000, duration: 1 },
  ]);
  assert.deepEqual(
    r.points.map((p) => p.bitrate_mbps),
    [1, 3],
  );
  assert.equal(r.bitrate_mbps.mean, 2);
  assert.equal((r.bitrate_mbps.mean * 1e6 * 2) / 8, r.total_bytes);
});

test('playback tracks prefer defaults, exclude cover art, and fall back by file order', () => {
  const { streams } = normalizeMetadata({
    streams: [
      { index: 0, codec_type: 'video', disposition: { attached_pic: 1, default: 1 } },
      { index: 1, codec_type: 'video' },
      { index: 2, codec_type: 'video', disposition: { default: 1 } },
      { index: 3, codec_type: 'audio', disposition: { default: '0' } },
      { index: 4, codec_type: 'audio', disposition: { default: '1' } },
    ],
  });
  assert.deepEqual(
    playbackStreams(streams).map((s) => s.index),
    [2, 4],
  );
  assert.deepEqual(
    playbackStreams(streams.map((s) => ({ ...s, default: false }))).map((s) => s.index),
    [1, 3],
  );
  assert.deepEqual(
    playbackStreams(streams.filter((s) => s.type === 'video')).map((s) => s.index),
    [2],
  );
  assert.throws(
    () => playbackStreams(streams.filter((s) => s.type === 'audio')),
    /requires a video/,
  );
});
test('combined buckets sum simultaneous packets and preserve track offsets', () => {
  const r = analyze([
    { time: 0, size: 125000, duration: 1 },
    { time: 1, size: 125000, duration: 1 },
    { time: 0.5, size: 12500, duration: 0.5 },
    { time: 1, size: 25000, duration: 1 },
  ]);
  assert.deepEqual(
    r.points.map((p) => p.bytes),
    [137500, 150000],
  );
  assert.deepEqual(
    r.points.map((p) => p.bitrate_mbps),
    [1.1, 1.2],
  );
  assert.equal(r.total_bytes, 287500);
});

test('reported metadata preserves rates and distinguishes missing values from zero', () => {
  const r = normalizeMetadata({
    format: {
      format_name: 'mov,mp4',
      format_long_name: 'QuickTime / MOV',
      duration: '3.2',
      bit_rate: '123456',
      start_time: '0',
    },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        codec_long_name: 'H.264',
        codec_tag_string: 'avc1',
        profile: 'High',
        duration: '3.2',
        bit_rate: '100000',
      },
      { index: 1, codec_type: 'audio', duration: 'N/A', bit_rate: 'N/A' },
    ],
  });
  assert.equal(r.container.name, 'mov,mp4');
  assert.equal(r.container.bit_rate, 123456);
  assert.equal(r.container.start_time, 0);
  assert.equal(r.streams[0].bit_rate, 100000);
  assert.equal(r.streams[0].duration, 3.2);
  assert.equal(r.streams[0].codec_tag, 'avc1');
  assert.equal(r.streams[1].bit_rate, null);
  assert.equal(r.streams[1].duration, null);
  const missing = normalizeMetadata({ streams: [{ codec_type: 'audio' }] });
  assert.equal(missing.container.bit_rate, null);
  assert.equal(missing.container.start_time, null);
});

test('partial range bounds include packet duration at the actual timeline end', () => {
  const r = analyze([
    { time: 0.125, size: 100, duration: 0.5 },
    { time: 167.8, size: 200, duration: 0.067 },
  ]);
  assert.equal(r.first_timestamp, 0.125);
  assert.ok(Math.abs(r.end_timestamp - 167.867) < 1e-9);
  assert.deepEqual(r.partial_seconds, [0, 167]);
  const earlier = analyze([
    { time: 0, size: 100, duration: 2.75 },
    { time: 1, size: 100, duration: 0.1 },
  ]);
  assert.equal(earlier.end_timestamp, 2.75);
});

test('whole-stream average includes partial bytes independently of chart intervals', () => {
  const data = [
    { time: 0, size: 125000, duration: 1 },
    { time: 1, size: 250000, duration: 0.5 },
  ];
  for (const includePartial of [false, true]) {
    const r = analyze(data, { includePartial });
    assert.equal(r.duration_seconds, 1.5);
    assert.equal(r.overall_bitrate_mbps, 2);
    assert.equal(r.bitrate_mbps.mean, includePartial ? 1.5 : 1);
  }
  assert.equal(
    analyze([{ time: 0, size: 1 }], { includePartial: true }).overall_bitrate_mbps,
    null,
  );
});

test('combined selection supports explicit tracks, no audio, and rejects invalid tracks', () => {
  const streams = [
    { index: 0, type: 'video' },
    { index: 1, type: 'audio' },
    { index: 2, type: 'audio', default: true },
    { index: 3, type: 'video', attached_picture: true },
  ];
  assert.deepEqual(
    playbackStreams(streams, { video: '0', audio: '1' }).map((s) => s.index),
    [0, 1],
  );
  assert.deepEqual(
    playbackStreams(streams, { audio: 'none' }).map((s) => s.index),
    [0],
  );
  assert.throws(() => playbackStreams(streams, { audio: '9' }), /not available/);
  assert.throws(() => playbackStreams(streams, { video: '3' }), /not available/);
});

test('comparison components share buckets, preserve offsets and sum to combined', () => {
  const r = analyze(
    [
      { time: -0.1, size: 100, duration: 0.1, media_type: 'audio' },
      { time: 0, size: 1000, duration: 1, media_type: 'video' },
      { time: 0.5, size: 250, duration: 0.5, media_type: 'audio' },
      { time: 2, size: 500, duration: 0.5, media_type: 'video' },
    ],
    { compare: true, includePartial: true },
  );
  assert.equal(r.comparison, true);
  assert.equal(r.points[2].bytes, 0);
  for (const p of r.points) {
    assert.equal(p.video_bytes + p.audio_bytes, p.bytes);
    assert.ok(Math.abs(p.video_bitrate_mbps + p.audio_bitrate_mbps - p.bitrate_mbps) < 1e-12);
  }
  assert.equal(r.points[0].video_bytes, 0);
  assert.equal(r.points[1].audio_bytes, 250);
});

test('analysis range follows included intervals and clips partial buckets to real bounds', () => {
  const packets = [
    { time: -0.067, size: 100, duration: 0.067 },
    { time: 0, size: 100, duration: 1 },
    { time: 201.265, size: 100, duration: 0.04 },
  ];
  assert.deepEqual(analyze(packets).analysis_range, { start: 0, end: 201 });
  const partial = analyze(packets, { includePartial: true });
  assert.equal(partial.analysis_range.start, -0.067);
  assert.ok(Math.abs(partial.analysis_range.end - 201.305) < 1e-9);
  const gop = analyze(
    [
      { time: -1, size: 100, duration: 1 },
      { time: 0, size: 100, duration: 1, keyframe: true },
    ],
    { mode: 'gop' },
  );
  assert.deepEqual(gop.analysis_range, { start: 0, end: 1 });
});

test('extreme bitrate ranges locate first tied interval and actual partial bounds', () => {
  const r = analyze(
    [
      { time: -0.1, size: 100, duration: 0.1 },
      { time: 0, size: 1000, duration: 1 },
      { time: 1, size: 1000, duration: 1 },
      { time: 2, size: 200, duration: 0.25 },
    ],
    { includePartial: true },
  );
  assert.deepEqual(r.bitrate_ranges.max, { start: 0, end: 1, count: 2, partial: false });
  assert.deepEqual(r.bitrate_ranges.min, { start: -0.1, end: 0, count: 1, partial: true });
  const gop = analyze(
    [
      { time: 0, size: 100, duration: 1, keyframe: true },
      { time: 1, size: 900, duration: 3, keyframe: true },
    ],
    { mode: 'gop' },
  );
  assert.deepEqual(gop.bitrate_ranges.max, { start: 1, end: 4, count: 1, partial: false });
  assert.deepEqual(gop.bitrate_ranges.min, { start: 0, end: 1, count: 1, partial: false });
});
