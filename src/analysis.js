/** Pure packet calculations: no DOM, no WASM. */
import { intervalBounds } from './chart-intervals.js';

const MAX_INTERVALS = 2_000_000;
// Tolerance for floating-point timestamps that land fractionally either side of a whole second.
const EPSILON = 1e-7;

export function summarize(values) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return { min, mean: sum / values.length, max };
}

/**
 * Calculates bitrate per one-second interval (mode 'seconds') or per GOP (mode 'gop').
 * Each packet is { time, size, duration, keyframe, media_type }, with times in seconds.
 */
export function analyze(
  input,
  { mode = 'seconds', includePartial = false, video = true, compare = false } = {},
) {
  const packets = validPackets(input);
  if (!packets.length) {
    throw new Error('No valid packet timestamps found. Try a different stream or timestamp type.');
  }
  const timeline = {
    first_timestamp: packets[0].time,
    end_timestamp: timelineEnd(packets),
  };

  let intervals;
  if (mode === 'gop') {
    if (!video) throw new Error('GOP analysis requires a video stream.');
    intervals = { points: gopPoints(packets), partialSeconds: [], secondsWithoutPackets: 0 };
  } else {
    intervals = secondPoints(packets, timeline, { includePartial, compare });
  }
  const { points } = intervals;

  const totalBytes = sumSizes(packets);
  const durationSeconds = timeline.end_timestamp - timeline.first_timestamp;
  const result = {
    mode,
    points,
    bitrate_mbps: summarize(points.map((point) => point.bitrate_mbps)),
    total_packets: packets.length,
    total_bytes: totalBytes,
    first_timestamp: timeline.first_timestamp,
    last_timestamp: packets.at(-1).time,
    end_timestamp: timeline.end_timestamp,
    comparison: compare && mode === 'seconds',
    partial_seconds: intervals.partialSeconds,
    include_partial: includePartial,
    seconds_without_packets: intervals.secondsWithoutPackets,
    analysis_range: {
      start: intervalBounds(points[0], timeline).start,
      end: intervalBounds(points.at(-1), timeline).end,
    },
    duration_seconds: durationSeconds,
    overall_bitrate_mbps: durationSeconds > 0 ? (totalBytes * 8) / durationSeconds / 1e6 : null,
  };

  if (mode === 'gop') {
    // Total bits over total time: a plain mean of GOP rates would over-weight short GOPs.
    const gopBytes = points.reduce((sum, point) => sum + point.bytes, 0);
    const gopSeconds = points.reduce((sum, point) => sum + point.duration, 0);
    result.bitrate_mbps.mean = (gopBytes * 8) / gopSeconds / 1e6;
    result.gop = {
      count: points.length,
      duration_seconds: summarize(points.map((point) => point.duration)),
      packets: summarize(points.map((point) => point.packets)),
      size_megabits: summarize(points.map((point) => (point.bytes * 8) / 1e6)),
    };
  }

  result.bitrate_ranges = {
    min: extremeRange(points, result.bitrate_mbps.min, timeline),
    max: extremeRange(points, result.bitrate_mbps.max, timeline),
  };
  return result;
}

/** Drops packets without a usable time or size and sorts the rest by time. */
function validPackets(input) {
  return input
    .filter((packet) => Number.isFinite(packet.time) && Number.isFinite(packet.size))
    .filter((packet) => packet.size >= 0)
    .map((packet) => ({ ...packet, duration: Math.max(0, finiteNumber(packet.duration)) }))
    .sort((a, b) => a.time - b.time);
}

/** The latest packet end. It can be later than the last packet's timestamp. */
function timelineEnd(packets) {
  let end = packets[0].time;
  for (const packet of packets) end = Math.max(end, packet.time + packet.duration);
  return end;
}

function sumSizes(packets) {
  return packets.reduce((sum, packet) => sum + packet.size, 0);
}

/** One point per group of pictures; each GOP starts at a keyframe. */
function gopPoints(packets) {
  const groups = [];
  for (const packet of packets) {
    if (packet.keyframe) groups.push([]);
    // Packets before the first keyframe belong to no GOP.
    if (groups.length) groups.at(-1).push(packet);
  }

  const points = [];
  groups.forEach((group, i) => {
    const start = group[0].time;
    const nextGroup = groups[i + 1];
    const end = nextGroup ? nextGroup[0].time : timelineEnd(group);
    const duration = end - start;
    if (duration <= 0) return;
    const bytes = sumSizes(group);
    points.push({
      time: start,
      duration,
      bytes,
      packets: group.length,
      bitrate_mbps: (bytes * 8) / duration / 1e6,
    });
  });
  if (!points.length) {
    throw new Error('No measurable GOPs found. The stream needs keyframes and packet durations.');
  }
  return points;
}

/**
 * One point per whole second of the packet timeline. Seconds only partly covered by the
 * timeline (at the start and end) are left out unless includePartial is set.
 */
function secondPoints(packets, timeline, { includePartial, compare }) {
  const packetsBySecond = new Map();
  for (const packet of packets) {
    const second = Math.floor(packet.time);
    if (!packetsBySecond.has(second)) packetsBySecond.set(second, []);
    packetsBySecond.get(second).push(packet);
  }

  // Bounds come from the selected timestamps and packet durations rather than the container
  // duration, which may describe a different stream or timestamp basis.
  const start = timeline.first_timestamp;
  const end = timeline.end_timestamp;
  const firstSecond = Math.floor(start);
  const stopSecond = Math.max(
    firstSecond + 1,
    Math.floor(packets.at(-1).time) + 1,
    Math.ceil(end - EPSILON),
  );
  if (stopSecond - firstSecond > MAX_INTERVALS) {
    throw new Error('The timestamp range exceeds the two million interval limit.');
  }

  const points = [];
  const partialSeconds = [];
  let secondsWithoutPackets = 0;
  for (let second = firstSecond; second < stopSecond; second++) {
    const group = packetsBySecond.get(second) || [];
    const complete = second >= start - EPSILON && second + 1 <= end + EPSILON;
    if (!complete) partialSeconds.push(second);
    if (!complete && !includePartial) continue;

    const bytes = sumSizes(group);
    const point = {
      time: second,
      duration: 1,
      bytes,
      packets: group.length,
      bitrate_mbps: (bytes * 8) / 1e6,
      complete,
    };
    if (compare) Object.assign(point, videoAudioSplit(group));
    points.push(point);
    if (!group.length) secondsWithoutPackets++;
  }
  if (!points.length) {
    throw new Error('No full one-second intervals found. Enable partial seconds for short clips.');
  }
  return { points, partialSeconds, secondsWithoutPackets };
}

function videoAudioSplit(packets) {
  let videoBytes = 0;
  let audioBytes = 0;
  for (const packet of packets) {
    if (packet.media_type === 'video') videoBytes += packet.size;
    else if (packet.media_type === 'audio') audioBytes += packet.size;
    else throw new Error('Comparison packets must identify video or audio.');
  }
  return {
    video_bytes: videoBytes,
    audio_bytes: audioBytes,
    video_bitrate_mbps: (videoBytes * 8) / 1e6,
    audio_bitrate_mbps: (audioBytes * 8) / 1e6,
  };
}

/** Where the minimum or maximum bitrate first occurs, and how many intervals share it. */
function extremeRange(points, bitrate, timeline) {
  const matches = points.filter((point) => point.bitrate_mbps === bitrate);
  const first = matches[0];
  return {
    ...intervalBounds(first, timeline),
    count: matches.length,
    partial: first.complete === false,
  };
}

/** Converts an FFprobe value to a number, treating '', 'N/A' and non-numbers as missing. */
export function finiteNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '' || value === 'N/A') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveOrNull(value) {
  const number = finiteNumber(value);
  return number > 0 ? number : null;
}

function numberOrNull(value) {
  return value === undefined ? null : finiteNumber(value);
}

/** Parses a frame rate such as '30000/1001'; unknown rates become 0. */
function parseFrameRate(value) {
  const [numerator, denominator] = String(value || '0/1')
    .split('/')
    .map(Number);
  const rate = numerator / denominator;
  return Number.isFinite(rate) ? rate : 0;
}

/** Converts raw FFprobe stream and format entries into the app's metadata shape. */
export function normalizeMetadata(data) {
  const streams = (data.streams || [])
    .filter((stream) => ['audio', 'video'].includes(stream.codec_type))
    .map((stream) => ({
      index: stream.index,
      type: stream.codec_type,
      attached_picture: !!Number(stream.disposition?.attached_pic),
      default: !!Number(stream.disposition?.default),
      codec: stream.codec_name || 'unknown',
      codec_long_name: stream.codec_long_name || null,
      codec_tag: stream.codec_tag_string || null,
      profile: stream.profile || null,
      bit_rate: positiveOrNull(stream.bit_rate),
      duration: finiteNumber(stream.duration, NaN) >= 0 ? finiteNumber(stream.duration) : null,
      fps: parseFrameRate(stream.avg_frame_rate),
      width: numberOrNull(stream.width),
      height: numberOrNull(stream.height),
      sample_rate: stream.sample_rate ?? null,
      channels: numberOrNull(stream.channels),
    }));
  if (!streams.length) {
    throw new Error(
      'No audio or video streams found. This format may not be included in the WASM build.',
    );
  }
  const format = data.format || {};
  return {
    duration: finiteNumber(format.duration),
    container: {
      name: format.format_name || null,
      long_name: format.format_long_name || null,
      bit_rate: positiveOrNull(format.bit_rate),
      start_time: finiteNumber(format.start_time, null),
    },
    streams,
  };
}

/** Turns 'key=value' strings from FFprobe's compact output into an object. */
export function parseCompactFields(parts) {
  const fields = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    fields[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return fields;
}

/**
 * Parses one compact packet line. Returns null for lines that are not packets (compact output
 * can put side data on its own line) and false for packets without a usable time or size.
 */
export function parsePacket(line, timestamp, fps = 0) {
  return packetFromFields(parseCompactFields(line.trim().split('|')), timestamp, fps);
}

export function packetFromFields(fields, timestamp, fps = 0) {
  if (!('size' in fields)) return null;
  const time = finiteNumber(fields[`${timestamp}_time`], NaN);
  const size = finiteNumber(fields.size, -1);
  if (!Number.isFinite(time) || size < 0) return false;
  const frameDuration = Number.isFinite(fps) && fps > 0 ? 1 / fps : 0;
  return {
    time,
    size,
    duration: Math.max(0, finiteNumber(fields.duration_time)) || frameDuration,
    keyframe: (fields.flags || '').includes('K'),
  };
}

/** Chooses one playable video track and one audio track; player language preferences may differ. */
export function playbackStreams(streams, { video = 'default', audio = 'default' } = {}) {
  const videoTrack = chooseTrack(streams, 'video', video);
  if (!videoTrack) {
    throw new Error('Combined bitrate requires a video stream. Select an audio stream instead.');
  }
  return [videoTrack, chooseTrack(streams, 'audio', audio)].filter(Boolean);
}

function chooseTrack(streams, type, choice) {
  const candidates = streams.filter((stream) => stream.type === type && !stream.attached_picture);
  if (type === 'audio' && choice === 'none') return undefined;
  if (choice === 'default') return candidates.find((stream) => stream.default) || candidates[0];
  const track = candidates.find((stream) => String(stream.index) === String(choice));
  if (!track) throw new Error(`Selected ${type} track is not available.`);
  return track;
}
