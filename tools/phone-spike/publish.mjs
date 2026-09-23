// Writes the application's copy of the upstream phone: public/libpebble3/, which
// Preview's Phone tab detects through its manifest. It is optional in a build of the
// site; without it, Preview reports the upstream phone as not included.
// Usage: node publish.mjs <library dist> <sqlite-wasm package dir> <upstream checkout> [out]
import { stop } from 'esbuild-wasm';
import { execFileSync } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundleLibrary } from './browser/library.mjs';

const [dist, sqlite, checkout, out = 'public/libpebble3'] = process.argv
  .slice(2)
  .map((p) => resolve(p));
const git = (...args) =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
const tag = git('describe', '--tags', '--exact-match');
const commit = git('rev-parse', 'HEAD');
const sqlitePackage = JSON.parse(await readFile(join(sqlite, 'package.json'), 'utf8'));
const catalog = await readFile(join(checkout, 'gradle/libs.versions.toml'), 'utf8');
const pinned = (name) => catalog.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))?.[1] ?? 'unknown';

await rm(out, { recursive: true, force: true });
await bundleLibrary(dist, out);
stop();
await cp(join(sqlite, 'dist'), join(out, 'sqlite'), { recursive: true });
await cp(join(checkout, 'LICENSE'), join(out, 'LICENSE-libpebble3.txt'));
await cp(join(sqlite, 'LICENSE'), join(out, 'LICENSE-sqlite-wasm.txt')).catch(() => {});
await writeFile(
  join(out, 'manifest.json'),
  JSON.stringify(
    {
      upstream: 'coredevices/mobileapp',
      tag,
      commit,
      bundle: 'libpebble3.js',
      sqlite: 'sqlite/index.mjs',
      sqliteVersion: sqlitePackage.version,
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  join(out, 'NOTICE.md'),
  `# Upstream phone app (experimental)

libpebble3 from [coredevices/mobileapp ${tag}](https://github.com/coredevices/mobileapp/tree/${commit})
(GPL-3.0, LICENSE-libpebble3.txt), compiled for the browser by tools/phone-spike from that
release's source. It includes, compiled from their released sources: Room ${pinned('room')} and
androidx.sqlite 2.6 (Apache-2.0), kmp-io 0.3.0 (Apache-2.0) and kotlinx-io ${pinned('kotlinx-io')}
(Apache-2.0), and the libraries upstream depends on, under their own licenses.

SQLite's official WebAssembly build, @sqlite.org/sqlite-wasm ${sqlitePackage.version}
(${sqlitePackage.license}; SQLite itself is in the public domain), is served beside it.
`,
);
console.log(`Published libpebble3 ${tag} (${commit.slice(0, 7)}) to ${out}`);
