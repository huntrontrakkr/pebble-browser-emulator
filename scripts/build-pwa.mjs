// Build an exact, same-origin asset inventory; never cache imported apps or remote responses.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve('dist/client');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assets = [];
async function walk(directory = '') {
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = directory + item.name;
    if (item.isDirectory()) await walk(path + '/');
    else if (path !== 'sw.js' && !path.endsWith('.map')) {
      const bytes = await readFile(resolve(root, path));
      assets.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
}
await walk();
const paths = new Set(assets.map((asset) => asset.path));
for (const required of [
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'wasm/emulator.wasm',
  'wasm/qemu-emery.wasm',
  'wasm/quickjs.wasm',
  'phone-app/index.html',
  'phone-app/pebble-phone.js',
  'phone-app/source.zip',
])
  if (!paths.has(required))
    throw new Error(
      `PWA asset missing: ${required}. Run npm run build to include both Wasm runtimes.`,
    );
for (const platform of ['emery', 'flint', 'gabbro']) {
  if (
    !paths.has(`examples/clock-${platform}.pbw`) ||
    !assets.some(
      (asset) =>
        asset.path.includes(`/qemu_${platform}_`) && asset.path.endsWith('_micro_flash.bin.gz'),
    ) ||
    !assets.some(
      (asset) =>
        asset.path.includes(`/qemu_${platform}_`) && asset.path.endsWith('_spi_flash.bin.gz'),
    )
  )
    throw new Error(`Offline example or firmware missing for ${platform}.`);
}
assets.sort((a, b) => a.path.localeCompare(b.path));
const source = await readFile('src/service-worker.js', 'utf8');
const version = digest(JSON.stringify(assets) + source).slice(0, 20);
await writeFile(
  resolve(root, 'sw.js'),
  source.replace(
    '/* BUILD_INVENTORY */',
    `const VERSION = ${JSON.stringify(version)};\nconst ASSETS = ${JSON.stringify(assets)};`,
  ),
);
console.log(`PWA asset inventory: ${assets.length} files, version ${version}`);
