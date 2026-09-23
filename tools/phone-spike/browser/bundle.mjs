// Builds the browser run: the application's QEMU and libpebble3 phone workers and the
// harness page (esbuild, as the application's own build does), the linked libpebble3
// library as one browser module, and the files they load.
// Usage: node bundle.mjs <library dist> <sqlite-wasm package dir> <firmware dir> <out>
import { build, stop } from 'esbuild-wasm';
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundleLibrary } from './library.mjs';

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

await bundleLibrary(dist, join(out, 'libpebble3'));
stop();

await cp(join(sqlite, 'dist'), join(out, 'sqlite'), { recursive: true });
await cp('public/wasm/quickjs.wasm', join(out, 'quickjs.wasm'));
await mkdir(join(out, 'wasm'), { recursive: true });
await cp('public/wasm/qemu-emery.wasm', join(out, 'wasm/qemu-emery.wasm'));
await cp(firmware, join(out, 'firmware'), { recursive: true });
await cp('public/examples/clock-emery.pbw', join(out, 'clock-emery.pbw'));
await cp('tools/phone-spike/browser/harness.html', join(out, 'harness.html'));
console.log('browser run built in', out);
