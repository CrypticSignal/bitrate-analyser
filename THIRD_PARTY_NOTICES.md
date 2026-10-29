# Third-party software

The runtime uses @ffmpeg/core 0.12.10 (single-threaded FFmpeg/FFprobe WebAssembly). Its package declares GPL-2.0-or-later. It includes FFmpeg and other libraries with their own licenses.

- Upstream project, source and build instructions: https://github.com/ffmpegwasm/ffmpeg.wasm
- Package and exact version: https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10
- FFmpeg source and license: https://ffmpeg.org/legal.html

The npm lockfile records the precise downloaded archive and integrity. Distributors of compiled assets must comply with the included components' source and license obligations. The application source repository does not check in the compiled core.
