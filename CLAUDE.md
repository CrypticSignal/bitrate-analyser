# Bitrate Analyser

Client-only bitrate, GOP and segment analyser built on FFprobe WebAssembly. Plain JavaScript ES modules in `src/`, no framework, no bundler beyond `scripts/build.mjs`.

## Priorities

Simplicity and maintainability come first. The owner, or another developer, should be able to read any file and change it with confidence.

- Prefer the simplest solution that works. Don't add abstractions, options or dependencies for hypothetical future needs.
- Write readable code: descriptive names, one statement per line, normal indentation and spacing. Don't compress code onto single lines.
- Keep functions small and focused. Keep pure calculations (`analysis.js`, `segments.js`, `bandwidth.js`, `chart-intervals.js`, `progress.js`) separate from DOM code so they stay unit-testable.
- Comment the *why* for non-obvious rules (timestamp handling, interval boundaries), not the *what*.
- When touching existing dense code, leave it easier to read than you found it, without changing behaviour.

## Commands

```bash
npm ci
npm test               # unit tests (node --test)
npm run build          # outputs dist/
npm run test:browser   # needs native ffmpeg/ffprobe and Chromium
npm run serve          # http://localhost:8001
```

Run `npm test` before committing; run the browser tests for UI or worker changes. Keep README.md in sync with user-visible behaviour.
