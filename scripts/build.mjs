import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/vendor/', import.meta.url), { recursive: true });
await cp(new URL('../src/', import.meta.url), new URL('../dist/', import.meta.url), {
  recursive: true,
});
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp(
    new URL('../node_modules/@ffmpeg/core/dist/esm/' + name, import.meta.url),
    new URL('../dist/vendor/' + name, import.meta.url),
  );
}
await cp(
  new URL('../THIRD_PARTY_NOTICES.md', import.meta.url),
  new URL('../dist/THIRD_PARTY_NOTICES.md', import.meta.url),
);
console.log('Built client-only app in dist/');
