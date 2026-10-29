# Bitrate Analyser

Client-side bitrate, GOP, and streaming bandwidth analysis using FFprobe WebAssembly. Media stays on your device; there are no uploads, API backend, or external asset requests.

**[Open the app](https://crypticsignal.github.io/bitrate-analyser/)** · Based on [Bitrate Plotter](https://github.com/CrypticSignal/bitrate-plotter).

## Run locally

Requires Node 20+ and Python 3 for the convenience server:

```bash
npm ci
npm run build
npm run serve
```

Open http://localhost:8001. Any static HTTP(S) server can serve `dist/`; opening files directly with `file://` does not support module workers.

## Analyze media

Selecting a file loads container and audio/video track information before analysis, with Auto selected. Reported codecs, bitrates, durations, and other properties are separate from calculated packet rates; missing metadata displays as **Not reported**.

- **Auto:** first non-cover-art video stream, otherwise first audio stream.
- **Individual stream:** select any listed audio/video track.
- **Combined:** choose one video and one audio track, or no audio. Defaults prefer tracks marked as default, then the first of each type; player language preferences may differ.
- **Timestamps:** DTS by default; PTS is optional. Negative timestamps are supported.
- **Comparison:** after per-second analysis of a file with video and audio, overlay video, audio, and total bitrate without rescanning. An individual selection is paired with its default counterpart; Combined mode uses your chosen pair. Cards still describe the selected analysis; comparison uses a shared combined timeline. The checkbox is unavailable for GOP analysis or when both track types are not available.

Successful analysis scrolls to the graph; the four bitrate cards and Analysis details follow it. Mobile uses an immediate scroll, while desktop uses smooth scrolling unless reduced motion is preferred.

Progress shows engine loading, stream discovery, packet scanning, and calculation stages. Scan percentages estimate timestamp coverage using the metadata probe; missing duration gives an indeterminate bar with packet counts. Updates are throttled, require no extra scan, and reach 100% only after successful analysis.

Charts show independent horizontal segments spanning each bitrate interval, without vertical connectors, with dots marking interval ends: the value for 53–54 s is marked at 54 s. Hovering or tapping highlights the entire interval and shows its range and bitrate in a floating tooltip beside the pointer or touch position. A tapped tooltip stays visible until you tap elsewhere. Partial edges show their actual timeline bounds; their rates still use a one-second divisor. Filled areas are enabled by default and can be turned off. Long charts preserve sampled extrema; hovering uses the full interval data. JSON retains the selected analysis and available comparison data; CSV follows the displayed chart, including comparison components; SVG exports the displayed chart. GOP tables show up to 500 rows. Rates use decimal Mbps in exports, with kbps displayed for individual audio analysis and Mbps for comparison overlays. Displayed values use three decimal places, omitting decimals for whole numbers.

### Calculation rules

| Result | Calculation |
| --- | --- |
| One-second bitrate | Packet bytes × 8 ÷ 1 second, assigned using `floor(timestamp)` |
| Overall average | All valid selected packet bits ÷ full selected packet timeline |
| Chart average | Mean of displayed one-second rates, or duration-weighted GOP rates |
| GOP bitrate | GOP packet bits ÷ GOP duration |

The packet timeline runs from the earliest selected timestamp to the latest packet end. Missing video durations fall back to average frame rate; other unknown durations count as zero. A zero-length timeline has no overall average.

**Analysis details** distinguishes the observed packet timestamp range from the **Analysis range** included in chart statistics. For example, excluding partial seconds can reduce an observed `-0.067–201.265 s` range to `0–201 s`. With partial seconds included, the range uses actual packet timeline bounds, including packet durations. Overall average always uses the full selected packet timeline.

Only full one-second intervals are included by default; excluded partial ranges are listed. **Include partial seconds** retains edge buckets but still divides their bits by one second. Empty full intervals contribute zero. Bytes are assigned by timestamp, not spread across packet duration.

GOP analysis requires an individual video stream. Keyframes define boundaries in the selected timestamp order; packets before the first keyframe are excluded. The final GOP ends at its latest packet end. These are packet-based groups, not decoded frame dependencies; PTS and DTS can produce different boundaries.

## Analyze HLS / DASH segments

Expand **HLS / DASH segment analysis** (collapsed by default), then select a local package folder or a manifest and its segment files together. Folder selection preserves nested paths. This reads manifest text and file sizes only—no WASM, packet scan, or remote downloads.

| Format | Supported |
| --- | --- |
| HLS | Media playlists with EXTINF durations, initialization maps, and byte ranges |
| DASH | Static, single-period MPDs with SegmentList or SegmentTemplate/SegmentTimeline, numbered/time templates, BaseURL, and byte ranges |

Master HLS playlists, low-latency part/delta playlists, live or multi-period DASH, and SegmentBase are unsupported. Limits: 5 MiB per manifest and 100,000 segments across representations. Missing files and invalid ranges produce errors.

Segment bitrate is packaged file/range bits ÷ declared playback duration. The average is duration-weighted; initialization bytes are reported separately. Analyze separate audio/video representations individually and account for both. Tables show up to 500 segments; CSV includes all of them.

## Estimate bandwidth

Expand **Bandwidth planning estimate** (collapsed by default). Choose a media peak/overall average or a segment peak/average, then adjust overhead and headroom:

```text
Estimated Mbps = measured Mbps × (1 + overhead / 100) × (1 + headroom / 100)
```

The initial 5% overhead and 20% headroom are editable assumptions. Packet rates omit container/transport overhead; segment rates already include packaging. Estimates update without rescanning and export as JSON with their assumptions. They do not guarantee delivery under buffering, short bursts, or segment download deadlines.

## Test

Browser tests require native `ffmpeg`/`ffprobe` and Chromium:

```bash
npm test
npx playwright install --with-deps chromium
npm run build
npm run test:browser
```

To use an installed browser, set `TEST_BROWSER_EXECUTABLE=/usr/bin/chromium`. Tests cover calculation rules, real WASM/native comparisons, local manifests, bandwidth estimates, stream selection, overlays, exports, cancellation, mobile layout, and same-origin-only requests. PCM packet counts can differ between FFprobe versions.

## Deployment and limits

Pushes to `main` run verification, then deploy `dist/` to GitHub Pages. Repository Settings → Pages must use **GitHub Actions**. Other static hosts must serve JavaScript and `application/wasm` with same-origin workers/assets. COOP/COEP headers are unnecessary; the WASM asset is about 31 MiB.

The pinned engine is `@ffmpeg/core@0.12.10` (FFprobe 5.1.4). Files are read in slices through WORKERFS in a disposable worker; packet records still consume memory. Analysis is limited to two million scanned packets across all streams, two million timestamp intervals, and five minutes. Cancel terminates the worker.

Codec support depends on the WASM build. Multi-gigabyte inputs and Safari/Firefox have not been validated; Chromium desktop/mobile layouts are tested. A fresh visit needs the app assets; this is not an offline-cached PWA.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and distribution obligations, including GPL-2.0-or-later components.
