// Builds the static site in dist/: the app source, plus the FFmpeg WebAssembly core it loads.
import { cp, rm } from 'node:fs/promises';

const fromRoot = (path) => new URL('../' + path, import.meta.url);

await rm(fromRoot('dist/'), { recursive: true, force: true });
await cp(fromRoot('src/'), fromRoot('dist/'), { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp(fromRoot('node_modules/@ffmpeg/core/dist/esm/' + name), fromRoot('dist/vendor/' + name));
}
// The licence notices must ship with the WebAssembly build.
await cp(fromRoot('THIRD_PARTY_NOTICES.md'), fromRoot('dist/THIRD_PARTY_NOTICES.md'));
console.log('Built client-only app in dist/');
