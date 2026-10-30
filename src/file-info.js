/** The "File information" panel: container and stream details as reported by FFprobe. */
import { $, definitionItems, formatNumber } from './ui.js';

const NOT_REPORTED = 'Not reported';

const rate = (bitsPerSecond) =>
  bitsPerSecond > 0 ? `${formatNumber(bitsPerSecond / 1000)} kbps` : NOT_REPORTED;
const seconds = (value) =>
  value !== null && Number.isFinite(value) ? `${formatNumber(value, 3)} s` : NOT_REPORTED;

export function showFileInfo(metadata, file) {
  const container = metadata.container;
  const containerName = container.long_name
    ? `${container.long_name} (${container.name})`
    : container.name || NOT_REPORTED;
  $('file-summary').replaceChildren(
    ...definitionItems([
      ['File', file.name],
      ['Size', `${file.size.toLocaleString()} bytes (${formatNumber(file.size / 1e6)} MB)`],
      ['Container', containerName],
      ['Duration', metadata.duration > 0 ? seconds(metadata.duration) : NOT_REPORTED],
      ['Reported overall bitrate', rate(container.bit_rate)],
      ['Container start time', seconds(container.start_time)],
    ]),
  );
  $('file-streams').replaceChildren(...metadata.streams.map(streamSection));
  $('file-info').hidden = false;
}

export function clearFileInfo() {
  // A newly chosen file has not been analysed yet, so its details go back above the chart.
  document.querySelector('.results').prepend($('file-info'));
  $('file-info').open = true;
  $('file-info').hidden = true;
  $('file-summary').replaceChildren();
  $('file-streams').replaceChildren();
}

// Once analysis starts, the results take the top of the page and the file details move lower.
export function moveFileInfoBelowEstimate() {
  document.querySelector('.bandwidth-panel').after($('file-info'));
}

function streamSection(stream) {
  const section = document.createElement('section');
  const heading = document.createElement('h4');
  const details = document.createElement('dl');

  const tags =
    (stream.default ? ' · default' : '') + (stream.attached_picture ? ' · cover art' : '');
  heading.textContent = `Stream #${stream.index} · ${stream.type}${tags}`;

  const entries = [
    [
      'Codec',
      stream.codec_long_name ? `${stream.codec_long_name} (${stream.codec})` : stream.codec,
    ],
    ['Codec tag', stream.codec_tag || NOT_REPORTED],
    ['Profile', stream.profile || NOT_REPORTED],
    ['Reported bitrate', rate(stream.bit_rate)],
    ['Duration', seconds(stream.duration)],
  ];
  if (stream.type === 'video') {
    entries.push(
      [
        'Resolution',
        stream.width && stream.height ? `${stream.width} × ${stream.height}` : NOT_REPORTED,
      ],
      ['Average frame rate', stream.fps > 0 ? `${formatNumber(stream.fps, 3)} fps` : NOT_REPORTED],
    );
  }
  if (stream.type === 'audio') {
    const sampleRate = Number(stream.sample_rate);
    entries.push(
      ['Sample rate', sampleRate > 0 ? `${sampleRate.toLocaleString()} Hz` : NOT_REPORTED],
      ['Channels', stream.channels > 0 ? String(stream.channels) : NOT_REPORTED],
    );
  }
  details.replaceChildren(...definitionItems(entries));
  section.append(heading, details);
  return section;
}
