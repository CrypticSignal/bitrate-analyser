/**
 * Runs FFprobe (WebAssembly) on one file and posts messages back to the page:
 *   progress  – { stage, percent, message, packets? }
 *   streams   – file metadata only (when metadataOnly is set)
 *   metadata  – metadata and the resolved stream selection, before calculating
 *   result    – the finished analysis
 *   error     – { message, packetsKept }
 * A metadataOnly worker closes after replying. Otherwise the worker scans the file once and keeps
 * its packets, so later requests for the same file (another stream, timestamp basis or setting)
 * are answered without scanning again. Each worker runs FFprobe only once, so a new file needs a
 * new worker.
 */
import createFFmpegCore from './vendor/ffmpeg-core.js';
import {
  analyze,
  normalizeMetadata,
  packetRecord,
  parseCompactFields,
  playbackStreams,
  timedPacket,
} from './analysis.js';
import { scanProgress } from './progress.js';

const ENGINE = '@ffmpeg/core@0.12.10';
const MAX_PACKETS = 2_000_000;
const PROGRESS_INTERVAL_MS = 150;

const PACKET_ENTRIES = 'packet=stream_index,pts_time,dts_time,duration_time,size,flags';
const METADATA_ENTRIES = [
  'stream=index,codec_name,codec_long_name,codec_tag_string,profile,codec_type,bit_rate,duration,width,height,avg_frame_rate,sample_rate,channels',
  'stream_disposition=attached_pic,default',
  'format=format_name,format_long_name,duration,bit_rate,start_time',
  'program_version=version',
].join(':');

// The finished scan of this worker's file: { metadata, packetsByStream, version, packetCount }.
let scan = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.metadataOnly) {
      const probe = await runProbe(data, true);
      self.postMessage({
        type: 'streams',
        metadata: probe.metadata,
        scanned_packets: probe.packetCount,
      });
      self.close();
      return;
    }

    if (scan) {
      postProgress('calculating', 'Recalculating from the earlier scan…');
    } else {
      scan = await runProbe(data, false);
      self.postMessage({
        type: 'progress',
        stage: 'calculating',
        percent: null,
        packets: scan.packetCount,
        message: `Calculating bitrate statistics · ${scan.packetCount.toLocaleString()} packets read`,
      });
    }
    self.postMessage({ type: 'result', result: analyzeSelection(data, scan) });
  } catch (error) {
    // Once the file has been scanned, the worker stays usable for other settings.
    self.postMessage({
      type: 'error',
      message: error.message || String(error),
      packetsKept: scan !== null,
    });
    if (!scan) self.close();
  }
};

function postProgress(stage, message) {
  self.postMessage({ type: 'progress', stage, percent: null, message });
}

/** Loads the engine, runs FFprobe once on the file and returns what it reported. */
async function runProbe(request, metadataOnly) {
  const { file } = request;
  if (!file?.size) throw new Error('Choose a nonempty media file.');
  postProgress('loading', 'Loading FFprobe WebAssembly…');
  const core = await loadCore();
  const path = mountFile(core, file);
  try {
    const output = collectOutput(core, request);
    postProgress(
      metadataOnly ? 'reading' : 'scanning',
      metadataOnly ? 'Reading stream information…' : 'Inspecting packets on your device…',
    );
    runFFprobe(core, probeArgs(path, metadataOnly), output);

    const metadata = normalizeMetadata({ streams: output.streams, format: output.format });
    dropUnusedPackets(output.packetsByStream, metadata.streams);
    return {
      metadata,
      packetsByStream: output.packetsByStream,
      version: output.version,
      packetCount: output.packetCount,
    };
  } finally {
    try {
      core.FS.unmount('/input');
    } catch {}
  }
}

/**
 * Frees packets of streams that can never be analysed, such as subtitles. FFprobe reports the
 * stream types after the packets, so they cannot be skipped during the scan.
 */
function dropUnusedPackets(packetsByStream, streams) {
  for (const index of packetsByStream.keys()) {
    if (!streams.some((stream) => stream.index === index)) packetsByStream.delete(index);
  }
}

async function loadCore() {
  const wasmURL = new URL('./vendor/ffmpeg-core.wasm', import.meta.url).href;
  // ffmpeg-core reads the .wasm location from the hash of mainScriptUrlOrBlob.
  const core = await createFFmpegCore({
    mainScriptUrlOrBlob: import.meta.url + '#' + btoa(JSON.stringify({ wasmURL })),
  });
  if (typeof core._ffprobe !== 'function' || !core.FS.filesystems.WORKERFS) {
    throw new Error('The loaded WASM build needs FFprobe and WORKERFS support.');
  }
  return core;
}

/** Mounts the file read-only and returns its path inside the WASM file system. */
function mountFile(core, file) {
  // WORKERFS reads slices of the browser File on demand, so the file is never copied into memory.
  core.FS.mkdir('/input');
  // Keep the extension: FFprobe uses it as a hint for some formats.
  const extension = (file.name.match(/\.[a-z0-9]{1,12}$/i) || [''])[0];
  const name = 'media' + extension;
  core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name, data: file }] }, '/input');
  return '/input/' + name;
}

function probeArgs(path, metadataOnly) {
  const args = ['./ffprobe', '-v', 'error', '-protocol_whitelist', 'file', '-threads', '1'];
  if (!metadataOnly) args.push('-show_packets');
  const entries = metadataOnly ? METADATA_ENTRIES : PACKET_ENTRIES + ':' + METADATA_ENTRIES;
  args.push(
    '-show_streams',
    '-show_format',
    '-show_program_version',
    '-show_entries',
    entries,
    '-of',
    'compact=p=1',
    path,
  );
  return args;
}

function runFFprobe(core, args, output) {
  // core 0.12.10's JS ffprobe() wrapper discards the C return value and returns its untouched
  // ret=-1. Call the exported C entry point instead so failures are detected. This worker
  // invokes it once and is then closed.
  const code = core._ffprobe(args.length, core.stringsToPtr(args));
  if (code !== 0) {
    throw new Error(
      output.errors.trim() ||
        'FFprobe could not read this media. The format may not be included in this WASM build.',
    );
  }
}

/** Collects FFprobe's compact output line by line as it runs. */
function collectOutput(core, { timeline = {} }) {
  const output = {
    streams: [],
    format: {},
    version: 'unknown',
    packetsByStream: new Map(),
    packetCount: 0,
    errors: '',
  };
  const reportProgress = progressReporter(timeline);

  core.setLogger(({ type, message }) => {
    if (type !== 'stdout') {
      // Keep only the end of stderr for the error message.
      output.errors = (output.errors + '\n' + message).slice(-3000);
      return;
    }
    const [kind, ...parts] = message.trim().split(/(?<!\\)\|/);
    const fields = parseCompactFields(parts);
    if (kind === 'packet') {
      output.packetCount++;
      if (output.packetCount > MAX_PACKETS) {
        throw new Error('This file exceeds the two million packet limit. Choose a shorter clip.');
      }
      addPacket(output, fields);
      reportProgress(fields, output.packetCount);
    } else if (kind === 'stream') {
      output.streams.push({
        ...fields,
        index: Number(fields.index),
        disposition: {
          attached_pic: Number(fields['disposition:attached_pic']),
          default: Number(fields['disposition:default']),
        },
      });
    } else if (kind === 'format') {
      output.format = fields;
    } else if (kind === 'program_version') {
      output.version = fields.version || 'unknown';
    }
  });
  return output;
}

/** Stores a packet with both of its timestamps; which one is used is decided per analysis. */
function addPacket(output, fields) {
  const packet = packetRecord(fields);
  if (packet === null) return;
  const index = Number(fields.stream_index);
  if (!output.packetsByStream.has(index)) output.packetsByStream.set(index, []);
  output.packetsByStream.get(index).push(packet);
}

/** Returns a function that posts scan progress, at most every PROGRESS_INTERVAL_MS. */
function progressReporter(timeline) {
  const estimate = scanProgress(timeline);
  let furthest = null;
  let lastPostedAt = 0;

  return (fields, packetCount) => {
    // Progress follows DTS when available: it tracks demux order even when B-frames reorder PTS.
    const rawTime =
      fields.dts_time && fields.dts_time !== 'N/A' ? fields.dts_time : fields.pts_time;
    const time = rawTime === undefined || rawTime === 'N/A' ? NaN : Number(rawTime);
    if (Number.isFinite(time)) furthest = furthest === null ? time : Math.max(furthest, time);

    // Reading the clock for every packet is wasteful, so only check every 256 packets.
    if (packetCount !== 1 && packetCount % 256 !== 0) return;
    const now = performance.now();
    if (packetCount === 1 || now - lastPostedAt >= PROGRESS_INTERVAL_MS) {
      self.postMessage({ type: 'progress', ...estimate(furthest, packetCount) });
      lastPostedAt = now;
    }
  };
}

/** Resolves the requested stream(s) and analyses their packets from the scan. */
function analyzeSelection(request, scan) {
  const { file, mode, timestamp, stream, includePartial, pairing = {} } = request;
  const { metadata, packetsByStream } = scan;
  const combined = stream === 'combined';
  if (combined && mode === 'gop') {
    throw new Error(
      'Combined video + audio bitrate uses one-second intervals. Select a single video stream for GOP analysis.',
    );
  }
  const selectedStreams = combined
    ? playbackStreams(metadata.streams, pairing)
    : [findStream(metadata.streams, stream)];
  if (!selectedStreams[0]) throw new Error('Stream index not found in this file.');
  const selected = combined
    ? {
        index: 'combined',
        type: 'combined',
        codec: selectedStreams.map((track) => track.codec).join(' + '),
        fps: 0,
      }
    : selectedStreams[0];
  self.postMessage({ type: 'metadata', metadata, stream: selected });

  const { packets, rejected } = packetsForTracks(selectedStreams, packetsByStream, timestamp);
  const result = analyze(packets, {
    mode,
    includePartial,
    video: selected.type === 'video',
    compare: combined && selectedStreams.length === 2,
  });
  if (!combined && mode === 'seconds' && hasVideoAndAudio(metadata.streams)) {
    addComparison(result, metadata.streams, selectedStreams, packetsByStream, request);
  }

  return Object.assign(result, {
    selected_streams: selectedStreams,
    selection: stream,
    pairing: combined ? pairing : null,
    filename: file.name,
    file_bytes: file.size,
    timestamp: timestamp.toUpperCase(),
    engine: { core: ENGINE, ffprobe: scan.version },
    metadata,
    stream: selected,
    rejected_packets: rejected,
  });
}

/** 'auto' means the first video stream (ignoring cover art), otherwise the first audio stream. */
function findStream(streams, selection) {
  if (selection !== 'auto') return streams.find((stream) => String(stream.index) === selection);
  return (
    streams.find((stream) => stream.type === 'video' && !stream.attached_picture) ||
    streams.find((stream) => stream.type === 'audio') ||
    streams[0]
  );
}

function hasVideoAndAudio(streams) {
  return (
    streams.some((stream) => stream.type === 'video' && !stream.attached_picture) &&
    streams.some((stream) => stream.type === 'audio')
  );
}

/**
 * Adds a video + audio comparison for a single-stream analysis. Every track was already read
 * during the scan, so this needs no second pass. The selected stream is paired with the default
 * track of the other type.
 */
function addComparison(result, streams, selectedStreams, packetsByStream, request) {
  const tracks = playbackStreams(streams).map(
    (track) => selectedStreams.find((s) => s.type === track.type && !s.attached_picture) || track,
  );
  try {
    const { packets } = packetsForTracks(tracks, packetsByStream, request.timestamp);
    result.comparison_data = analyze(packets, {
      mode: 'seconds',
      includePartial: request.includePartial,
      compare: true,
    });
    result.comparison_data.selected_streams = tracks;
  } catch (error) {
    result.comparison_unavailable = error.message;
  }
}

/**
 * The tracks' packets timed by `timestamp`, on their shared timeline (tracks are never re-aligned
 * to zero). Packets without a usable time or size are counted as rejected instead.
 */
function packetsForTracks(tracks, packetsByStream, timestamp) {
  const packets = [];
  let rejected = 0;
  for (const track of tracks) {
    // A video packet without a duration lasts one frame at the average frame rate.
    const fps = track.type === 'video' ? track.fps : 0;
    for (const record of packetsByStream.get(track.index) || []) {
      const packet = timedPacket(record, timestamp, fps);
      if (!packet) {
        rejected++;
        continue;
      }
      packet.media_type = track.type;
      packets.push(packet);
    }
  }
  return { packets, rejected };
}
