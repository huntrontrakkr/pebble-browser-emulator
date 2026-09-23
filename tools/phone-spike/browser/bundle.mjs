// Builds the browser run: the application's QEMU and libpebble3 phone workers and the
// harness page (esbuild, as the application's own build does), the linked libpebble3
// library as one browser module, and the files they load.
// Usage: node bundle.mjs <library dist> <sqlite-wasm package dir> <firmware dir> <out>
import { build, stop } from 'esbuild-wasm';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stubMissingModules } from '../load.mjs';

const [dist, sqlite, firmware, out] = process.argv.slice(2).map((p) => resolve(p));
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    'qemu.worker': 'src/app/qemu.worker.ts',
    'libpebble.worker': 'src/app/libpebble.worker.ts',
    harness: 'tools/phone-spike/browser/harness.mjs',
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});

// The library imports npm modules by name, which a browser cannot resolve, so it is
// bundled with them. `ws` is Node's WebSocket; in a browser ktor uses the page's own,
// so it stands in as an empty module. skiko stands in as functions that throw.
await stubMissingModules(dist);
const entry = [];
for (const name of await readdir(dist)) {
  if (!name.endsWith('.mjs') || name.includes('.import-object') || name.includes('js-builtins'))
    continue;
  if ((await readFile(join(dist, name), 'utf8')).includes('phoneStart')) entry.push(name);
}
if (entry.length !== 1) throw new Error(`expected one entry module in ${dist}: ${entry}`);
const wsStub = join(out, 'ws-stub.mjs');
await writeFile(wsStub, 'export default {};\n');
await build({
  entryPoints: { libpebble3: join(dist, entry[0]) },
  outdir: join(out, 'libpebble3'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  alias: { ws: wsStub },
  logLevel: 'warning',
});
for (const name of await readdir(dist))
  if (name.endsWith('.wasm')) await cp(join(dist, name), join(out, 'libpebble3', name));
stop();

await cp(join(sqlite, 'dist'), join(out, 'sqlite'), { recursive: true });
await cp('public/wasm/quickjs.wasm', join(out, 'quickjs.wasm'));
await mkdir(join(out, 'wasm'), { recursive: true });
await cp('public/wasm/qemu-emery.wasm', join(out, 'wasm/qemu-emery.wasm'));
await cp(firmware, join(out, 'firmware'), { recursive: true });
await cp('public/examples/clock-emery.pbw', join(out, 'clock-emery.pbw'));
await cp('tools/phone-spike/browser/harness.html', join(out, 'harness.html'));
console.log('browser run built in', out);
