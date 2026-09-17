import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { parseBuildRecipe, recipeScript } from '../src/app/build-recipe.ts';
import { boundBuildMemory } from '../src/app/wasm-memory-limit.ts';
import { runLinuxBuild, limitFilesystem, BUILD_LIMITS } from '../src/app/linux-build-runtime.ts';
import { WASI, File, OpenFile } from '@bjorn3/browser_wasi_shim';
const encoder = new TextEncoder();
test('build recipes preserve literal shell input and reject ambiguous or unsupported YAML', () => {
  const r = parseBuildRecipe(
    'version: 1\nbackend: linux-wasi\nworkdir: sub\ncommands: ["python3 generate.py"]\noutputs: [build/app.pbw]\nenv:\n  EXAMPLE: "$(example)"\n',
  );
  assert.match(recipeScript(r, 'emery'), /export EXAMPLE='\$\(example\)'/);
  for (const extra of [
    'version: 2',
    'unknown: true',
    'workdir: ../outside',
    'outputs: ["../outside"]',
    'commands: []',
    'timeoutSeconds: 0',
    'env: []',
  ])
    assert.throws(() =>
      parseBuildRecipe(
        'version: 1\nbackend: linux-wasi\ncommands: [make]\noutputs: [app.pbw]\n' + extra,
      ),
    );
});
test('memory ceilings are encoded into the build module before instantiation', async () => {
  const source = Uint8Array.of(
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    5,
    3,
    1,
    0,
    1,
    7,
    10,
    1,
    6,
    109,
    101,
    109,
    111,
    114,
    121,
    2,
    0,
  );
  const bounded = boundBuildMemory(source, 2);
  const { instance } = await WebAssembly.instantiate(bounded);
  assert.equal(instance.exports.memory.grow(1), 1);
  assert.throws(() => instance.exports.memory.grow(1), RangeError);
  assert.throws(() => boundBuildMemory(source, 0));
});
test('untrusted build file allocation fails before allocating beyond quota', () => {
  const file = new File([1, 2, 3]),
    fd = new OpenFile(file),
    wasi = new WASI([], [], [fd], { debug: false });
  limitFilesystem(wasi, 3, 1);
  assert.equal(fd.fd_allocate(0n, 2n ** 60n), 51);
  assert.equal(file.data.length, 3);
  assert.equal(fd.fd_filestat_set_size(BigInt(BUILD_LIMITS.filesystemBytes) + 1n), 51);
  assert.equal(fd.fd_pwrite(Uint8Array.of(9), 2n).ret, 0);
  assert.deepEqual([...file.data], [1, 2, 9]);
  file.readonly = true;
  assert.equal(fd.fd_allocate(0n, 100n), 8);
  assert.equal(file.data.length, 3);
});
test(
  'actual Linux/Wasm runs custom Python and returns a generated artifact',
  { skip: !process.env.PEBBLE_LINUX_IMAGE, timeout: 180000 },
  async () => {
    const result = await runLinuxBuild(
      {
        image: new Uint8Array(await readFile(process.env.PEBBLE_LINUX_IMAGE)),
        platform: 'emery',
        recipe:
          'version: 1\nbackend: linux-wasi\ncommands: ["python3 generate.py"]\noutputs: [generated.c]\n',
        sourceFiles: {
          'generate.py': encoder.encode(
            'import pathlib\npathlib.Path("generated.c").write_text("int answer(void) { return 42; }\\n")',
          ),
        },
      },
      () => {},
    );
    assert.equal(
      new TextDecoder().decode(result.artifacts['generated.c']),
      'int answer(void) { return 42; }\n',
    );
    assert.equal(result.record.exitCode, 0);
    assert.notEqual(result.record.imageHash, result.record.boundedHash);
  },
);
test(
  'a build Worker can be terminated during an untrusted infinite Wasm loop',
  { timeout: 10000 },
  async () => {
    // Minimal Wasm: memory and _start exports, an endless branch loop.
    const image = Uint8Array.of(
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      4,
      1,
      96,
      0,
      0,
      3,
      2,
      1,
      0,
      5,
      3,
      1,
      0,
      1,
      7,
      19,
      2,
      6,
      109,
      101,
      109,
      111,
      114,
      121,
      2,
      0,
      6,
      95,
      115,
      116,
      97,
      114,
      116,
      0,
      0,
      10,
      9,
      1,
      7,
      0,
      3,
      64,
      12,
      0,
      11,
      11,
    );
    const worker = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source: resolve('src/app/linux-build.worker.ts') },
    });
    try {
      const started = new Promise((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (m) => {
          if (m.type === 'harness-ready')
            worker.postMessage({
              type: 'build',
              id: 1,
              image,
              platform: 'emery',
              recipe: 'version: 1\nbackend: linux-wasi\ncommands: ["true"]\noutputs: [result]\n',
              sourceFiles: {},
            });
          if (m.type === 'log') resolve();
          if (m.type === 'error') reject(new Error(m.message));
        });
      });
      await started;
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(await worker.terminate());
    } finally {
      await worker.terminate();
    }
  },
);
