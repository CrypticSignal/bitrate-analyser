/**
 * Segment bitrates from local HLS / DASH packages. Reads manifest text and file sizes only:
 * no media decoding, network requests or WASM.
 */

const MAX_SEGMENTS = 100_000;
// Relative URLs are resolved against this placeholder origin. Anything that resolves to a
// different origin points outside the selected local files.
const LOCAL_ORIGIN = 'https://segments.invalid';
const LOCAL_BASE = LOCAL_ORIGIN + '/';

function positive(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('Missing or invalid segment duration / timescale.');
  }
  return number;
}

function checkSegmentCount(segments) {
  if (segments.length > MAX_SEGMENTS) throw new Error('Manifest exceeds 100,000 segments.');
}

/** The path used to match manifest entries to selected files. */
export function localPath(file) {
  return file.webkitRelativePath || file.name;
}

// ---------------------------------------------------------------------------------------------
// HLS
// ---------------------------------------------------------------------------------------------

export function parseHls(text) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist.');
  if (/#EXT-X-(STREAM-INF|I-FRAME-STREAM-INF|MEDIA):/.test(text)) {
    throw new Error('Choose an HLS media playlist, rather than the master playlist.');
  }
  if (/#EXT-X-(PART|SKIP):/.test(text)) {
    throw new Error(
      'Low-latency partial / delta playlists are not supported. Choose a complete media playlist.',
    );
  }

  const segments = [];
  const initialization = [];
  // Tags that describe the next segment URI line.
  let duration = null;
  let byteRange = null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration = positive(line.slice('#EXTINF:'.length).split(',')[0]);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = line.slice('#EXT-X-BYTERANGE:'.length);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      initialization.push(parseHlsMap(line.slice('#EXT-X-MAP:'.length)));
    } else if (!line.startsWith('#')) {
      if (duration === null) throw new Error('HLS segment is missing EXTINF duration.');
      const range = byteRange ? parseHlsByteRange(byteRange, line, segments.at(-1)) : undefined;
      segments.push({ uri: line, duration, range });
      checkSegmentCount(segments);
      duration = null;
      byteRange = null;
    }
  }
  if (duration !== null || !segments.length) throw new Error('No complete HLS segments found.');
  return [{ id: 'hls', label: 'HLS media playlist', segments, initialization }];
}

/** Parses an EXT-X-MAP attribute list, e.g. URI="init.mp4",BYTERANGE="720@0". */
function parseHlsMap(attributeList) {
  const attributes = {};
  for (const match of attributeList.matchAll(/([A-Z-]+)=(?:"([^"]*)"|([^,]*))/g)) {
    attributes[match[1]] = match[2] ?? match[3];
  }
  if (!attributes.URI) throw new Error('Missing HLS initialization URI.');
  if (!attributes.BYTERANGE) return { uri: attributes.URI, range: undefined };

  const [length, offset] = attributes.BYTERANGE.split('@').map(Number);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw new Error('Initialization byte range needs an explicit offset.');
  }
  return { uri: attributes.URI, range: { length, offset } };
}

/** Parses an EXT-X-BYTERANGE value: 'length@offset', or 'length' to continue the previous range. */
function parseHlsByteRange(value, uri, previousSegment) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw new Error('Invalid HLS byte range.');
  const length = positive(match[1]);

  let offset;
  if (match[2] !== undefined) {
    offset = Number(match[2]);
  } else if (previousSegment?.uri === uri && previousSegment.range) {
    offset = previousSegment.range.offset + previousSegment.range.length;
  } else {
    offset = NaN;
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Implicit HLS byte range has no preceding range for that file.');
  }
  return { length, offset };
}

// ---------------------------------------------------------------------------------------------
// DASH
// ---------------------------------------------------------------------------------------------

function children(node, name) {
  return [...node.children].filter((element) => element.localName === name);
}

function child(node, name) {
  return children(node, name)[0];
}

/** Parses a DASH byte range such as '0-999' (inclusive). */
function parseByteRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(value || '');
  if (!match || Number(match[2]) < Number(match[1])) throw new Error('Invalid segment byte range.');
  return { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 };
}

function optionalByteRange(node, attribute) {
  return node.hasAttribute(attribute) ? parseByteRange(node.getAttribute(attribute)) : undefined;
}

/** Parses an ISO 8601 duration such as 'PT1H2M3.5S' into seconds. */
function parseIsoDuration(value) {
  if (!value) return null;
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!match) throw new Error('Unsupported DASH presentation duration.');
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export function parseDash(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || mpd.localName !== 'MPD') {
    throw new Error('Invalid DASH MPD.');
  }
  if (mpd.getAttribute('type') === 'dynamic') {
    throw new Error('Choose a static DASH MPD; live manifests are not supported.');
  }
  const periods = children(mpd, 'Period');
  if (periods.length !== 1) throw new Error('DASH analysis currently requires a single Period.');
  const period = periods[0];
  const periodDuration =
    parseIsoDuration(period.getAttribute('duration')) ??
    parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));

  const results = [];
  let totalSegments = 0;
  for (const adaptation of children(period, 'AdaptationSet')) {
    for (const representation of children(adaptation, 'Representation')) {
      const hierarchy = [mpd, period, adaptation, representation];
      const { segments, initialization } = parseRepresentation(hierarchy, periodDuration);
      if (!segments.length) throw new Error('DASH representation has no segments.');
      totalSegments += segments.length;
      if (totalSegments > MAX_SEGMENTS) {
        throw new Error('Manifest exceeds 100,000 segments across representations.');
      }
      results.push({
        id: String(results.length),
        label: representationLabel(adaptation, representation, results.length),
        segments,
        initialization,
      });
    }
  }
  if (!results.length) throw new Error('No DASH representations found.');
  return results;
}

function representationLabel(adaptation, representation, index) {
  const type =
    adaptation.getAttribute('contentType') || adaptation.getAttribute('mimeType') || 'Track';
  const id = representation.getAttribute('id') || index;
  const bandwidth = representation.getAttribute('bandwidth') || '?';
  return `${type} · ${id} · ${bandwidth} bps declared`;
}

/**
 * Segment addressing can be declared at any level from MPD down to Representation, with
 * inner levels overriding outer ones. `hierarchy` lists the levels from outermost inwards.
 */
function parseRepresentation(hierarchy, periodDuration) {
  const representation = hierarchy.at(-1);
  const resolveUri = uriResolver(hierarchy);
  const lists = hierarchy.map((node) => child(node, 'SegmentList')).filter(Boolean);
  const templates = hierarchy.map((node) => child(node, 'SegmentTemplate')).filter(Boolean);
  const sources = lists.length ? lists : templates;
  if (!sources.length) {
    throw new Error('DASH SegmentBase is not supported. Use SegmentList or SegmentTemplate.');
  }

  const attributes = Object.assign(
    {},
    ...sources.map((node) =>
      Object.fromEntries([...node.attributes].map((a) => [a.name, a.value])),
    ),
  );
  const timescale = positive(attributes.timescale || 1);
  const offset = Number(attributes.presentationTimeOffset || 0);
  const timelineNode = sources
    .map((node) => child(node, 'SegmentTimeline'))
    .filter(Boolean)
    .at(-1);
  const timings = timelineNode
    ? expandTimeline(timelineNode, timescale, periodDuration, offset)
    : null;

  if (lists.length) {
    return segmentListSegments(lists, attributes, timings, timescale, resolveUri);
  }
  return segmentTemplateSegments(
    representation,
    attributes,
    timings,
    timescale,
    periodDuration,
    resolveUri,
  );
}

/** Returns a function that resolves a URI against the nested BaseURL elements. */
function uriResolver(hierarchy) {
  let base = LOCAL_BASE;
  for (const node of hierarchy) {
    const baseUrl = child(node, 'BaseURL');
    if (baseUrl) base = new URL(baseUrl.textContent.trim(), base).href;
  }
  return (uri) => new URL(uri, base).href.replace(LOCAL_BASE, '');
}

/** Expands a SegmentTimeline into { time, duration } rows. `time` is in timescale units. */
function expandTimeline(timelineNode, timescale, periodDuration, offset) {
  const entries = children(timelineNode, 'S');
  const rows = [];
  let time = 0;
  entries.forEach((entry, i) => {
    const ticks = positive(entry.getAttribute('d'));
    if (entry.hasAttribute('t')) time = Number(entry.getAttribute('t'));
    let repeat = Number(entry.getAttribute('r') || 0);
    // r="-1" repeats until the next entry's start time, or else the end of the period.
    if (repeat === -1) {
      const next = entries[i + 1];
      let end = NaN;
      if (next?.hasAttribute('t')) end = Number(next.getAttribute('t'));
      else if (periodDuration !== null) end = periodDuration * timescale + offset;
      if (!Number.isFinite(end)) throw new Error('An open DASH timeline needs a period duration.');
      repeat = Math.ceil((end - time) / ticks) - 1;
    }
    if (
      !Number.isSafeInteger(repeat) ||
      repeat < 0 ||
      !Number.isSafeInteger(time) ||
      rows.length + repeat + 1 > MAX_SEGMENTS
    ) {
      throw new Error('Invalid or excessive DASH timeline.');
    }
    for (let j = 0; j <= repeat; j++) {
      rows.push({ time, duration: ticks / timescale });
      time += ticks;
    }
  });
  return rows;
}

function segmentListSegments(lists, attributes, timings, timescale, resolveUri) {
  const urls = children(lists.at(-1), 'SegmentURL');
  if (!timings) {
    timings = urls.map((_, i) => {
      const ticks = positive(attributes.duration);
      return { time: i * ticks, duration: ticks / timescale };
    });
  }
  if (timings.length !== urls.length) {
    throw new Error('DASH SegmentList duration count does not match its URLs.');
  }
  const segments = urls.map((url, i) => ({
    uri: resolveUri(url.getAttribute('media') || ''),
    duration: timings[i].duration,
    range: optionalByteRange(url, 'mediaRange'),
  }));

  const initialization = [];
  const init = lists
    .map((node) => child(node, 'Initialization'))
    .filter(Boolean)
    .at(-1);
  if (init) {
    initialization.push({
      uri: resolveUri(init.getAttribute('sourceURL') || ''),
      range: optionalByteRange(init, 'range'),
    });
  }
  return { segments, initialization };
}

function segmentTemplateSegments(
  representation,
  attributes,
  timings,
  timescale,
  periodDuration,
  resolveUri,
) {
  if (!attributes.media) throw new Error('Missing DASH media template.');
  if (!timings) timings = fixedDurationTimings(attributes.duration, timescale, periodDuration);

  const startNumber = Number(attributes.startNumber || 1);
  const expand = (template, index, time) =>
    expandTemplate(template, {
      RepresentationID: representation.getAttribute('id'),
      Bandwidth: representation.getAttribute('bandwidth'),
      Number: startNumber + index,
      Time: time,
    });

  const segments = timings.map((timing, i) => ({
    uri: resolveUri(expand(attributes.media, i, timing.time)),
    duration: timing.duration,
  }));
  const initialization = attributes.initialization
    ? [{ uri: resolveUri(expand(attributes.initialization, 0, 0)) }]
    : [];
  return { segments, initialization };
}

/** Timings for a template with a fixed segment duration, covering the whole period. */
function fixedDurationTimings(durationTicks, timescale, periodDuration) {
  if (periodDuration === null) {
    throw new Error('DASH duration template needs a presentation duration.');
  }
  const segmentDuration = positive(durationTicks) / timescale;
  const count = Math.ceil(periodDuration / segmentDuration);
  if (count > MAX_SEGMENTS) throw new Error('Manifest exceeds 100,000 segments.');
  return Array.from({ length: count }, (_, i) => ({
    time: i * Number(durationTicks),
    // The last segment may be cut short by the end of the period.
    duration: Math.min(segmentDuration, periodDuration - i * segmentDuration),
  }));
}

/** Fills in a template such as 'seg-$Number%05d$.m4s'. '$$' is a literal '$'. */
function expandTemplate(template, values) {
  return template.replace(
    /\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
    (match, key, width) => {
      if (match === '$$') return '$';
      const value = values[key];
      if (value === null || value === undefined) {
        throw new Error('Missing DASH template attribute.');
      }
      if (width && Number(width) > 20) throw new Error('Excessive DASH template padding.');
      return String(value).padStart(Number(width) || 0, '0');
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Segment bitrates
// ---------------------------------------------------------------------------------------------

/** Matches a parsed representation's segments to the selected files and measures each one. */
export function analyzeSegments(representation, files, manifestPath) {
  const filesByPath = new Map();
  for (const file of files) {
    const path = localPath(file);
    if (filesByPath.has(path)) throw new Error(`Duplicate selected path: ${path}`);
    filesByPath.set(path, file);
  }
  const manifestUrl = new URL(manifestPath, LOCAL_BASE);
  const resolve = (entry) => resolveLocalFile(entry, filesByPath, manifestUrl);

  let time = 0;
  let totalBytes = 0;
  let peak = 0;
  const points = representation.segments.map((entry, i) => {
    const duration = positive(entry.duration);
    const { path, bytes } = resolve(entry);
    const bitrate = (bytes * 8) / duration / 1e6;
    const point = { segment: i + 1, path, time, duration, bytes, bitrate_mbps: bitrate };
    time += duration;
    totalBytes += bytes;
    peak = Math.max(peak, bitrate);
    return point;
  });

  // Several entries can name the same initialization bytes; count each range once.
  const initializationBytes = new Map();
  for (const entry of representation.initialization) {
    const { path, bytes } = resolve(entry);
    initializationBytes.set(`${path}:${entry.range?.offset ?? 0}:${bytes}`, bytes);
  }

  return {
    label: representation.label,
    points,
    total_bytes: totalBytes,
    duration_seconds: time,
    average_mbps: (totalBytes * 8) / time / 1e6,
    peak_mbps: peak,
    initialization_bytes: [...initializationBytes.values()].reduce((sum, bytes) => sum + bytes, 0),
  };
}

/** Finds the selected file for a manifest entry and returns its path and byte count. */
function resolveLocalFile(entry, filesByPath, manifestUrl) {
  const url = new URL(entry.uri, manifestUrl);
  if (url.origin !== LOCAL_ORIGIN) {
    throw new Error('Remote segment URLs are not fetched. Use a manifest with local paths.');
  }
  const path = decodeURIComponent(url.pathname.slice(1));
  const file = filesByPath.get(path);
  if (!file) {
    throw new Error(`Missing local segment: ${path}. Select the package folder to preserve paths.`);
  }
  if (!entry.range) return { path, bytes: file.size };

  const { offset, length } = entry.range;
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset + length > file.size
  ) {
    throw new Error(`Byte range exceeds file: ${path}`);
  }
  return { path, bytes: length };
}
