# Bitrate Plotter WASM

Entirely client-side bitrate and GOP analysis. A separate repository, refactored from [Bitrate Plotter](https://github.com/CrypticSignal/bitrate-plotter) and the Python web app at commit `d8b67282ab50c385eb7364f39c9c787b81ab70e7`.

The browser runs real FFprobe compiled to WebAssembly. It reads packet timestamps, byte sizes, durations, flags and stream metadata; JavaScript calculates the statistics and renders the chart. Media never leaves the device. There is no Python/API backend, upload endpoint, external CDN, analytics, or remote font dependency.

## Run

Requires Node 20+ for installation/build only:

```bash
npm ci
npm run build
npm run serve
```

Open http://localhost:8001. `npm run serve` uses Python's static HTTP server for convenience; any static server works. Python is not part of the app. Don't open `index.html` directly with `file://`: browser module workers need HTTP(S).

Deploy the contents of `dist/` to a static host. Serve `.js` as JavaScript and `.wasm` as `application/wasm`. Keep `index.html`, workers, and `vendor/` on the same origin. The single-threaded core does not need SharedArrayBuffer or COOP/COEP headers. It must support module workers and WebAssembly. The uncompressed core WASM asset is about 31 MiB; choose a host whose per-file limit permits it.

Once built, the app only requests its own static assets. It can run without an Internet connection from a local static server. A fresh hosted visit still needs to download the app and engine; this is not an installable/offline-cached PWA.

## Features

- Local file picker and drag/drop; no uploads.
- Video/audio stream selection, including audio tracks inside video containers.
- PTS and DTS timestamps, with negative timestamps supported.
- Fixed one-second bitrate intervals with optional partial start/end intervals.
- Video GOP boundaries, duration, byte size, packet count and bitrate statistics.
- Interactive chart, filled/unfilled area, kbps for audio and Mbps for video.
- JSON, CSV, and SVG downloads generated in the browser.
- Cancellable analysis, bounded packet count, timeout, errors, and mobile layout.

After the first scan the stream selector lists all audio/video tracks. The default selects the first non-cover-art video stream, falling back to audio. Each scan reads all streams so the complete selector remains available. Statistics and exports describe the selected stream.

## What “all client-side” does and does not guarantee

The application's features can run locally because they need packet demuxing and metadata, not a native video player or a Python service. They do not depend on the browser being able to play the codec. This is feature parity with the server web app, not a guarantee that every format/codec in every native FFmpeg build is compiled into this WASM build.

The engine is pinned to `@ffmpeg/core` **0.12.10**, which reports FFprobe **5.1.4**. Native FFprobe used for comparison was **7.1.5**. Different FFmpeg versions can packetize PCM audio differently: the tested short WAV has the same total bytes and bucket bitrate, but different packet counts. Version-dependent packet boundaries can also affect edge-bucket coverage. JSON exports record the WASM FFprobe version. A different engine build may be needed for unusual formats; there is no server fallback.

Input uses **WORKERFS** and `FileReaderSync` in a dedicated Web Worker. The input is mounted read-only and read in slices, rather than copying the entire media file into MEMFS. Packet records and results still consume memory. There is a **two million scanned packet limit**, including all streams, and a **five minute wall-clock timeout**. Cancel terminates the worker immediately. A fresh worker/core is created for each scan and destroyed afterwards, releasing the mounted file and WASM memory. This avoids reuse of FFprobe's global CLI state.

There is no arbitrary 1 GB upload limit, because there are no uploads. Large-file reliability still depends on the browser's memory budget, WASM's 32-bit addressing, demuxer seeks, file duration, and packet count. Multi-gigabyte inputs and Safari/Firefox are not validated here. Chromium desktop and mobile-width layouts were tested.

### Calculation behavior

Packets are assigned to fixed `[second, second + 1)` intervals using `floor(timestamp)`. The timeline starts at the earliest selected-stream packet timestamp and ends at the latest packet timestamp plus its duration, in the selected PTS/DTS basis. Missing video packet durations fall back to average frame rate; otherwise an unknown final duration is treated conservatively as zero. Floating-point boundary noise within 0.1 microseconds is tolerated.

By default, only intervals fully inside those bounds are included. There is no packet-coverage threshold: low-frame-rate and sparse intervals remain valid. Full intervals with no packets contribute zero bitrate. **Include partial seconds** also retains partial start/end intervals. All interval values are raw packet bits divided by exactly one second; partial intervals are not extrapolated. The mean is an arithmetic mean of displayed intervals, including empty ones. Packet bytes are assigned by their timestamp, not spread across the packet duration.

GOPs start at keyframe packet timestamps in sorted PTS/DTS order. Packets before the first keyframe are excluded from GOP statistics. The next keyframe defines the end; the final GOP uses its final packet's duration, falling back to average frame rate. This is packet-based GOP analysis, not a decoder-level frame dependency graph. Reordered video may produce different PTS and DTS boundaries.

SVG charts preserve extrema during display downsampling; JSON/CSV include every result interval. The GOP table displays the first 500 rows. Exports store decimal Mbps regardless of the chart display unit.

### FFprobe wrapper compatibility

The pinned core exposes `ffprobe`, `_ffprobe`, `FS.filesystems.WORKERFS`, and the required packet fields. Its JavaScript `ffprobe()` wrapper discards the C return value and reports `ret=-1` even on success. This app calls the exported `_ffprobe` entrypoint once per disposable worker and checks its actual return code. It does not ignore errors or interpret every `-1` as success. Regression tests exercise valid and invalid inputs in real WASM.

## Verification

```bash
npm test
npx playwright install chromium
npm run build
npm run test:browser
```

Browser integration tests also require native `ffmpeg`/`ffprobe` to generate fixtures and compare results. To use an installed Chromium:

```bash
TEST_BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:browser
```

The tests cover:

- Ten deterministic calculation/parsing tests, including negative timestamps, partial/sparse seconds and variable final GOP duration.
- Ten real WASM/native comparisons: H.264/AAC MP4 in PTS, DTS, GOP/PTS, GOP/DTS and embedded-audio modes; MP3; FLAC; VP9/Matroska GOPs; H.264/MPEG-TS DTS; short WAV partial buckets.
- Exact packet/byte counts and interval values for the compressed-media cases. WAV compares bytes and bucket rates because packetization differs between engine versions.
- Invalid media, audio GOP rejection, short-clip errors, stream switching in both directions, cancellation, exports, chart interaction and mobile overflow.
- All observed browser requests must be same-origin GETs: no media uploads or external requests.

`src/probe-worker.js` owns FFprobe/WASM and file reads. `src/analysis.js` is pure calculation code. `src/app.js` handles the UI. `scripts/build.mjs` copies source and the pinned engine to `dist/`. Build products and `node_modules` are ignored in Git. The Python web app and CLI repositories are unchanged.

## Third-party software

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The core package declares GPL-2.0-or-later and includes FFmpeg and other components; observe their license/source obligations when distributing compiled assets.

## Hosted version

GitHub Pages publishes `dist/` after the verification workflow passes on `main`: https://crypticsignal.github.io/bitrate-plotter-wasm/ . Repository Settings → Pages must use **GitHub Actions** as the build source.
