import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getQuickJS } from 'quickjs-emscripten';
const repo = process.env.PEBBLE_REPO ?? fileURLToPath(new URL('../', import.meta.url));
const { bundlePhone } = await import(
  pathToFileURL(process.env.PEBBLE_BUNDLER ?? resolve(repo, 'public/compiler/pkjs-bundler.mjs'))
);
const { loadLockedPackages } = await import(
  pathToFileURL(resolve(repo, 'public/compiler/locked-packages.mjs'))
);
const { VirtualPhone } = await import(
  pathToFileURL(process.env.PEBBLE_PHONE_RUNTIME ?? resolve(repo, 'src/app/virtual-phone.ts'))
);
const esbuild = await import(
  pathToFileURL(resolve(repo, 'node_modules/esbuild-wasm/esm/browser.js'))
);
globalThis.self = globalThis;
await esbuild.initialize({
  wasmModule: await WebAssembly.compile(
    await readFile(resolve(repo, 'node_modules/esbuild-wasm/esbuild.wasm')),
  ),
  worker: false,
});
const encoder = new TextEncoder();
const files = (entries) =>
  Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [
      name,
      encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)),
    ]),
  );
const module = await getQuickJS();
const phone = () =>
  new VirtualPhone(module, {
    appId: '00112233-4455-6677-8899-aabbccddeeff',
    messageKeys: { NAME: 10000 },
    watchInfo: {
      platform: 'emery',
      model: 'pebble_time_2_silver_gray',
      language: 'en_US',
      firmware: { major: 4, minor: 37, patch: 0, suffix: '' },
    },
  });

test('SDK app_package.json alias exposes modern and legacy project metadata', async () => {
  for (const name of ['package.json', 'appinfo.json']) {
    const source = await bundlePhone({
      sourceFiles: files({
        [name]: { version: '1.2.3' },
        'src/pkjs/index.js': `console.log(require('app_package.json').version);`,
      }),
      esbuild,
    });
    const vm = phone();
    try {
      vm.start(source);
      assert.deepEqual(
        vm
          .drainEvents()
          .filter((e) => e.type === 'log')
          .map((e) => e.text),
        ['1.2.3'],
      );
    } finally {
      vm.dispose();
    }
  }
});
test('SDK Pebble.on/off aliases work when methods are detached', () => {
  const vm = phone();
  try {
    vm.start(
      `var on=Pebble.on,off=Pebble.off;function gone(){console.log('BAD')}on('ready',gone);off('ready',gone);on('ready',()=>console.log('ready'));`,
    );
    assert.deepEqual(
      vm
        .drainEvents()
        .filter((e) => e.type === 'log')
        .map((e) => e.text),
      ['ready'],
    );
  } finally {
    vm.dispose();
  }
});

test(
  'real pinned Clay package bundles, opens configuration, persists returned settings and emits a pending AppMessage',
  { skip: !process.env.PEBBLE_CLAY_ARCHIVE },
  async () => {
    const archive = await readFile(process.env.PEBBLE_CLAY_ARCHIVE);
    const integrity =
      'sha512-/rXxmltdW8JyohDzXINdea+d2wnFJVNFiTXfuZsKpySURZSCFMMucX9sZPZvbHnEA4xFINM4iicyhBbvY4ALfw==';
    const tarball = 'https://registry.npmjs.org/pebble-clay/-/pebble-clay-1.0.4.tgz';
    const sourceFiles = files({
      'package.json': { dependencies: { 'pebble-clay': '1.0.4' } },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { 'pebble-clay': '1.0.4' } },
          'node_modules/pebble-clay': { version: '1.0.4', resolved: tarball, integrity },
        },
      },
      'src/pkjs/index.js': `var Clay=require('pebble-clay');new Clay([{type:'input',messageKey:'NAME',defaultValue:'Ada',label:'Name'}]);`,
    });
    const expanded = await loadLockedPackages({
      sourceFiles,
      request: async (url) => {
        assert.equal(url, tarball);
        return new Response(archive);
      },
    });
    const source = await bundlePhone({
      sourceFiles: expanded,
      esbuild,
      messageKeys: { NAME: 10000 },
    });
    const vm = phone();
    try {
      vm.setConnected(true);
      vm.start(source);
      assert.deepEqual(vm.drainEvents(), []);
      vm.showConfiguration();
      const configuration = vm.drainEvents().find((e) => e.type === 'configuration');
      assert.ok(configuration);
      assert.match(configuration.url, /^data:text\/html;charset=utf-8,/);
      assert.ok(configuration.url.length > 10000);
      const response = encodeURIComponent(
        JSON.stringify({ NAME: { value: 'Lin', type: 'string' } }),
      );
      assert.equal(vm.closeConfiguration(response, configuration.requestId), true);
      const events = vm.drainEvents(),
        out = events.find((e) => e.type === 'outbound');
      assert.deepEqual(out.payload, { 10000: 'Lin' });
      assert.equal(vm.getStorage()['clay-settings'], '{"NAME":"Lin"}');
      assert.equal(vm.acknowledgeAppMessage(out.transactionId, true), true);
      assert.equal(vm.acknowledgeAppMessage(out.transactionId, true), false);
    } finally {
      vm.dispose();
    }
  },
);
test.after(() => esbuild.stop());
