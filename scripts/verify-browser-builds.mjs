#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Run from the repository root. Requires Node 24+, a locally extracted SDK4.33.1,
// and the five pinned microbit-clang-wasm assets already downloaded by the browser.
// Usage: node scripts/verify-browser-builds.mjs --sdk /path/sdk-core --assets /path/gen --out /path/evidence [--example examples/platform-watchface] [--platform emery]
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const options = Object.create(null);
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1])
    throw new Error('Expected --option value');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!options.sdk || !options.assets || !options.out)
  throw new Error('--sdk, --assets and --out are required');
const repo = resolve(options.repo ?? '.'),
  sdk = resolve(options.sdk),
  assets = resolve(options.assets),
  out = resolve(options.out);
const moduleAt = (path) => import(pathToFileURL(join(repo, path)).href);
const { buildPebbleApp, normalizeMessageKeys } = await moduleAt(
  'public/compiler/portable-builder.mjs',
);
const { bundlePhone } = await moduleAt('public/compiler/pkjs-bundler.mjs');
const { loadLockedPackages } = await moduleAt('public/compiler/locked-packages.mjs');
const compiler = await moduleAt('public/compiler/vendor/bundle.js');
compiler.setAssetLoader(async (name) => new Uint8Array(await readFile(join(assets, name))));
async function readTree(root, prefix = '') {
  const files = Object.create(null);
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.name.startsWith('._') || ['.git', 'node_modules', 'build'].includes(e.name)) continue;
    const path = prefix + e.name;
    if (e.isDirectory()) Object.assign(files, await readTree(join(root, e.name), path + '/'));
    else if (e.isFile()) files[path] = new Uint8Array(await readFile(join(root, e.name)));
    else throw new Error('Only resolved regular source files supported: ' + path);
  }
  return files;
}
const sourceFiles = await readTree(join(repo, options.example ?? 'examples/platform-watchface'));
const decode = new TextDecoder();
const pkg = sourceFiles['package.json']
  ? JSON.parse(decode.decode(sourceFiles['package.json']))
  : {};
const info = pkg.pebble ?? JSON.parse(decode.decode(sourceFiles['appinfo.json']));
const platforms = options.platform ? [options.platform] : info.targetPlatforms;
if (!Array.isArray(platforms) || !platforms.length)
  throw new Error('Use --platform for metadata without targetPlatforms');
const sdkFiles = Object.create(null);
sdkFiles['manifest.json'] = new Uint8Array(await readFile(join(sdk, 'manifest.json')));
for (const platform of platforms) {
  Object.assign(
    sdkFiles,
    await readTree(join(sdk, 'pebble', platform, 'include'), 'pebble/' + platform + '/include/'),
  );
  const path = 'pebble/' + platform + '/lib/libpebble.a';
  sdkFiles[path] = new Uint8Array(await readFile(join(sdk, path)));
}
for (const path of [
  'pebble/common/pebble_app.ld.template',
  'pebble/common/include/_pkjs_shared_additions.js',
])
  sdkFiles[path] = new Uint8Array(await readFile(join(sdk, path)));
globalThis.self = globalThis;
const esbuild = await moduleAt('public/compiler/esbuild/browser.mjs');
await esbuild.initialize({
  wasmModule: await WebAssembly.compile(
    await readFile(join(repo, 'public/compiler/esbuild/esbuild.wasm')),
  ),
  worker: false,
});
const expanded = await loadLockedPackages({ sourceFiles });
const bundledJs = await bundlePhone({
  sourceFiles: expanded,
  esbuild,
  messageKeys: normalizeMessageKeys(info.messageKeys ?? info.appKeys ?? {}),
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(
  Object.entries(sourceFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, b]) => [path, sha(b)]),
);
const results = [];
try {
  for (const platform of platforms) {
    const result = await buildPebbleApp({
      sourceFiles,
      sdkFiles,
      session: compiler.createSession(),
      platform,
      bundledJs,
      timestamp: 1700000000,
    });
    const folder = join(out, platform);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'watchface.pbw'), result.pbw);
    await writeFile(join(folder, 'pebble-app.elf'), result.elf);
    if (result.workerElf) await writeFile(join(folder, 'pebble-worker.elf'), result.workerElf);
    for (const [path, bytes] of Object.entries(result.files)) {
      const target = join(folder, 'contents', path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const record = {
      platform,
      pbwBytes: result.pbw.length,
      load: result.metadata.loadSize,
      virtual: result.metadata.virtualSize,
      resourceNames: result.resources.entries.map((e) => e.name),
      workerBytes: result.workerMetadata?.binary.length ?? 0,
      sha256: sha(result.pbw),
    };
    results.push(record);
    console.log(JSON.stringify(record));
  }
} finally {
  esbuild.stop();
}
await writeFile(
  join(out, 'build-records.json'),
  JSON.stringify(
    {
      sdkVersion: JSON.parse(decode.decode(sdkFiles['manifest.json'])).version,
      timestamp: 1700000000,
      sourceHashes,
      results,
    },
    null,
    2,
  ) + '\n',
);
await writeFile(join(out, 'bundled.js'), bundledJs);
