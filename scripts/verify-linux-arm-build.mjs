// Optional Linux/Wasm ARM compiler reproduction. Downloads and licenses remain explicit.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runLinuxBuild } from '../src/app/linux-build-runtime.ts';
if (!process.env.PEBBLE_LINUX_IMAGE || !process.env.PEBBLE_LINUX_APKS)
  throw new Error('Set PEBBLE_LINUX_IMAGE and PEBBLE_LINUX_APKS. See tools/linux-build/README.md.');
const evidence = JSON.parse(
  await readFile(new URL('../docs/evidence/linux-build-gate.json', import.meta.url), 'utf8'),
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const image = new Uint8Array(await readFile(process.env.PEBBLE_LINUX_IMAGE));
assert.equal(hash(image), evidence.runtime.imageHash, 'Use the recorded reference image.');
const inputs = Object.create(null);
for (const pkg of evidence.packages) {
  const name = basename(new URL(pkg.url).pathname);
  const bytes = new Uint8Array(await readFile(resolve(process.env.PEBBLE_LINUX_APKS, name)));
  assert.equal(hash(bytes), pkg.sha256, 'Package hash mismatch: ' + name);
  inputs[name] = bytes;
}
const encode = (text) => new TextEncoder().encode(text);
const sourceFiles = {
  'install.py': encode(`import glob,tarfile
for path in glob.glob('/inputs/*.apk'):
 with tarfile.open(path,'r:gz',ignore_zeros=True) as archive:
  for member in archive:
   if not member.name.startswith(('usr/','lib/')) or member.isdir(): continue
   if 'arm-none-eabi' in member.name and member.name.rsplit('/',1)[-1] not in ['cc1','arm-none-eabi-gcc','arm-none-eabi-as','arm-none-eabi-readelf','as']: continue
   if '/share/' in member.name or '/include/' in member.name: continue
   archive.extract(member,path='/',filter='fully_trusted')
`),
  'generate.py': encode(
    "import pathlib\npathlib.Path('generated.c').write_text('int generated(void) { return 42; }\\n')\n",
  ),
};
const recipe = `version: 1
backend: linux-wasi
commands:
  - python3 install.py
  - python3 generate.py
  - arm-none-eabi-gcc -mcpu=cortex-m3 -mthumb -Os -c generated.c -o generated.o
  - arm-none-eabi-readelf -h generated.o
outputs: [generated.c, generated.o]
`;
const result = await runLinuxBuild({ image, inputs, sourceFiles, recipe, platform: 'emery' }, (s) =>
  process.stdout.write(s),
);
assert.equal(hash(result.artifacts['generated.o']), evidence.outputs['generated.o'].sha256);
const out = resolve(process.env.PEBBLE_TRACE_DIR ?? 'tmp/linux-arm-build');
await mkdir(out, { recursive: true });
for (const [name, bytes] of Object.entries(result.artifacts))
  await writeFile(resolve(out, name), bytes);
await writeFile(resolve(out, 'build-record.json'), JSON.stringify(result.record, null, 2) + '\n');
console.log('Actual Linux ARM GCC object matches the recorded reference.');
