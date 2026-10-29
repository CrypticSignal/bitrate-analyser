import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHls, analyzeSegments } from '../src/segments.js';
test('segment rates use actual packaged file sizes and weighted durations', () => {
  const [r] = parseHls('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.ts\n#EXTINF:1,\nb.ts');
  const result = analyzeSegments(
    r,
    [
      { name: 'init.mp4', size: 10 },
      { name: 'a.ts', size: 250000 },
      { name: 'b.ts', size: 250000 },
    ],
    'media.m3u8',
  );
  assert.deepEqual(
    result.points.map((p) => p.bitrate_mbps),
    [1, 2],
  );
  assert.equal(result.average_mbps, 4 / 3);
  assert.equal(result.peak_mbps, 2);
  assert.equal(result.initialization_bytes, 10);
});
test('HLS ranges support implicit offsets and validate file bounds', () => {
  const [r] = parseHls(
    '#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:10@5\na.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:20\na.mp4',
  );
  assert.deepEqual(
    r.segments.map((p) => p.range),
    [
      { offset: 5, length: 10 },
      { offset: 15, length: 20 },
    ],
  );
  assert.equal(analyzeSegments(r, [{ name: 'a.mp4', size: 35 }], 'a.m3u8').total_bytes, 30);
  assert.throws(() => analyzeSegments(r, [{ name: 'a.mp4', size: 34 }], 'a.m3u8'), /Byte range/);
});
test('missing media, remote media, invalid playlists and ambiguous files fail clearly', () => {
  assert.throws(() => parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nx.m3u8'), /master/);
  assert.throws(() => parseHls('#EXTM3U\n#EXTINF:0,\nx.ts'), /duration/);
  assert.throws(() => parseHls('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:5\nx.ts'), /preceding/);
  const [r] = parseHls('#EXTM3U\n#EXTINF:1,\nx.ts');
  assert.throws(() => analyzeSegments(r, [], 'x.m3u8'), /Missing local/);
  assert.throws(
    () =>
      analyzeSegments(
        r,
        [
          { name: 'x.ts', size: 1 },
          { name: 'x.ts', size: 1 },
        ],
        'x.m3u8',
      ),
    /Duplicate/,
  );
  r.segments[0].uri = 'https://example.com/x.ts';
  assert.throws(() => analyzeSegments(r, [], 'x.m3u8'), /Remote/);
});
test('folder paths are resolved relative to the selected manifest', () => {
  const [r] = parseHls('#EXTM3U\n#EXTINF:1,\n../chunks/a.ts');
  const result = analyzeSegments(
    r,
    [{ name: 'a.ts', webkitRelativePath: 'package/chunks/a.ts', size: 125000 }],
    'package/video/media.m3u8',
  );
  assert.equal(result.average_mbps, 1);
});
