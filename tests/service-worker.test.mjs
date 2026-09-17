import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const source = await readFile(new URL('../src/service-worker.js', import.meta.url), 'utf8');
const scope = 'https://example.test/emulator/';
const files = {
  'index.html': '<html>app</html>',
  'main-A.js': 'app shell',
  'watch-worker-A.js': 'watch worker',
  'manifest.webmanifest': '{}',
  'icons/icon-192.png': 'icon',
  'wasm/qemu-emery.wasm': 'hardware',
  'wasm/quickjs.wasm': 'phone JS',
  'phone-app/index.html': 'phone UI',
  'phone-app/runtime.wasm': 'phone Wasm',
  'phone-app/source.zip': 'phone source',
  'firmware/v1/LICENSE': 'license',
  ...Object.fromEntries(
    ['emery', 'flint', 'gabbro'].flatMap((name) => [
      [`examples/clock-${name}.pbw`, `clock ${name}`],
      [`firmware/v1/qemu_${name}_micro.bin.gz`, `micro ${name}`],
      [`firmware/v1/qemu_${name}_spi.bin.gz`, `spi ${name}`],
    ]),
  ),
};
class MemoryCache {
  entries = new Map();
  failPut;
  async match(url) {
    return this.entries.get(String(url))?.clone();
  }
  async put(url, response) {
    if (this.failPut?.(String(url))) throw new Error('Storage quota exceeded');
    this.entries.set(String(url), response.clone());
  }
  async delete(url) {
    return this.entries.delete(String(url));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}
class MemoryCaches {
  entries = new Map();
  async open(name) {
    if (!this.entries.has(name)) this.entries.set(name, new MemoryCache());
    return this.entries.get(name);
  }
  async keys() {
    return [...this.entries.keys()];
  }
  async delete(name) {
    return this.entries.delete(name);
  }
}
function worker({ version = 'one', content = files, caches = new MemoryCaches() } = {}) {
  const handlers = new Map();
  const inventory = Object.entries(content).map(([path, body]) => ({
    path,
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  }));
  const state = {
    requested: [],
    skipWaiting: 0,
    claimed: 0,
    caches,
    tabs: [{ url: scope, frameType: 'top-level' }],
    network: { ...content },
    beforeFetch: undefined,
  };
  const self = {
    registration: { scope },
    addEventListener: (name, handler) => handlers.set(name, handler),
    clients: {
      matchAll: async () => state.tabs,
      claim: async () => {
        state.claimed++;
      },
    },
    skipWaiting: async () => {
      state.skipWaiting++;
    },
  };
  vm.runInNewContext(
    source.replace(
      '/* BUILD_INVENTORY */',
      `const VERSION = ${JSON.stringify(version)}; const ASSETS = ${JSON.stringify(inventory)};`,
    ),
    {
      self,
      URL,
      Response,
      Headers,
      caches,
      crypto: webcrypto,
      Uint8Array,
      AbortController,
      fetch: async (url, options) => {
        const path = url.slice(scope.length);
        state.requested.push(path);
        assert.equal(options.cache, 'no-store');
        await state.beforeFetch?.(path, options);
        options.signal?.throwIfAborted();
        return new Response(state.network[path] ?? 'missing', {
          status: path in state.network ? 200 : 404,
        });
      },
    },
  );
  const emit = (type, event = {}) => {
    let completed;
    handlers.get(type)({
      ...event,
      waitUntil: (promise) => {
        completed = promise;
      },
    });
    return completed;
  };
  return Object.assign(state, {
    cache: () => caches.open(`pebble-offline:/emulator/:${version}`),
    install: () => emit('install'),
    activate: () => emit('activate'),
    message: async (type, data = {}, onProgress) => {
      const replies = [];
      await emit('message', {
        data: { type, id: 'request', ...data },
        source: { id: 'client' },
        ports: [
          {
            postMessage: (value) => {
              replies.push(structuredClone(value));
              if (value.progress !== undefined) onProgress?.(value.progress);
            },
            close() {},
          },
        ],
      });
      return replies.at(-1);
    },
    fetch: (url, method = 'GET') => {
      let response;
      handlers.get('fetch')({
        request: { url, method },
        respondWith: (promise) => {
          response = promise;
        },
      });
      return response;
    },
  });
}

test('install caches only the shell; scoped navigation works offline without intercepting remote apps', async () => {
  const w = worker();
  await w.install();
  assert.equal(w.skipWaiting, 0, 'Installing must never interrupt an existing session');
  assert.ok(w.requested.every((path) => !path.includes('/') || path.startsWith('icons/')));
  await w.activate();
  w.network = {};
  assert.equal(await (await w.fetch(scope + '?preview=1')).text(), files['index.html']);
  assert.equal(await (await w.fetch(scope + '#/example/clock')).text(), files['index.html']);
  assert.equal(w.fetch('https://github.com/watchface/settings.html'), undefined);
  assert.equal(w.fetch(scope + 'untrusted-upload.pbw'), undefined);
  assert.equal(w.fetch(scope + 'main-A.js', 'POST'), undefined);
  assert.equal((await w.fetch(scope + 'wasm/qemu-emery.wasm')).status, 503);
  const status = (await w.message('STATUS')).value;
  assert.equal(status.profiles.qemu_emery.ready, false);
});

test('selected offline watch includes firmware, phone and example; removal keeps shell and other sites', async () => {
  const w = worker();
  await w.install();
  const other = await w.caches.open('some-other-app');
  await other.put('https://example.test/private', new Response('keep'));
  const progress = [];
  const result = await w.message('CACHE_PROFILE', { profile: 'qemu_emery' }, (value) =>
    progress.push(value),
  );
  assert.equal(result.value.profiles.qemu_emery.ready, true);
  assert.equal(result.value.profiles.qemu_flint.ready, false);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  assert.ok(w.requested.includes('phone-app/runtime.wasm'));
  assert.ok(!w.requested.some((path) => /flint|gabbro/.test(path)));
  w.network = {};
  assert.equal(
    await (await w.fetch(scope + 'phone-app/index.html?session=private')).text(),
    'phone UI',
  );
  const cleared = await w.message('CLEAR_DOWNLOADS');
  assert.equal(cleared.value.profiles.qemu_emery.ready, false);
  assert.equal(await (await w.fetch(scope)).text(), files['index.html']);
  assert.equal(await (await other.match('https://example.test/private')).text(), 'keep');
  assert.ok(
    !(await (await w.cache()).keys()).some(({ url }) => url.includes('__offline_profile__')),
  );
});

test('canceling a download aborts the request and permits retry without reporting offline readiness', async () => {
  const w = worker();
  await w.install();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  w.beforeFetch = async (path, { signal }) => {
    if (path === 'phone-app/runtime.wasm') {
      started();
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    }
  };
  const pending = w.message('CACHE_PROFILE', { profile: 'qemu_emery' });
  await ready;
  assert.match((await w.message('CLEAR_DOWNLOADS')).error, /cancel/);
  await w.message('CANCEL_CACHE');
  assert.match((await pending).error, /canceled/);
  assert.equal((await w.message('STATUS')).value.profiles.qemu_emery.ready, false);
  w.beforeFetch = undefined;
  assert.equal(
    (await w.message('CACHE_PROFILE', { profile: 'qemu_emery' })).value.profiles.qemu_emery.ready,
    true,
  );
});

test('corrupt downloads and storage failures remain visible; online requests survive a full cache', async () => {
  const w = worker();
  await w.install();
  w.network['wasm/qemu-emery.wasm'] = 'corrupt';
  assert.match(
    (await w.message('CACHE_PROFILE', { profile: 'qemu_emery' })).error,
    /site has changed/,
  );
  assert.equal(await (await w.cache()).match(scope + 'wasm/qemu-emery.wasm'), undefined);
  w.network = { ...files };
  const cache = await w.cache();
  cache.failPut = (path) => path.includes('/wasm/');
  assert.match((await w.message('CACHE_PROFILE', { profile: 'qemu_emery' })).error, /quota/);
  assert.equal(await (await w.fetch(scope + 'wasm/qemu-emery.wasm')).text(), 'hardware');
  cache.failPut = undefined;
  assert.equal(
    (await w.message('CACHE_PROFILE', { profile: 'qemu_emery' })).value.profiles.qemu_emery.ready,
    true,
  );
});

test('updates preserve selected offline watches, verify replacements and leave the active version intact on failure', async () => {
  const old = worker();
  await old.install();
  await old.message('CACHE_PROFILE', { profile: 'qemu_emery' });
  const content = { ...files, 'index.html': 'new shell', 'phone-app/runtime.wasm': 'new phone' };
  const failed = worker({ version: 'two', content, caches: old.caches });
  failed.network['phone-app/runtime.wasm'] = 'wrong version';
  await assert.rejects(failed.install(), /site has changed/);
  assert.ok((await old.caches.keys()).includes('pebble-offline:/emulator/:one'));
  assert.ok(!(await old.caches.keys()).includes('pebble-offline:/emulator/:two'));
  assert.equal((await old.message('STATUS')).value.profiles.qemu_emery.ready, true);
  const next = worker({ version: 'two', content, caches: old.caches });
  await next.install();
  assert.deepEqual(next.requested.sort(), ['index.html', 'phone-app/runtime.wasm']);
  assert.equal(next.skipWaiting, 0);
  assert.equal((await next.message('STATUS')).value.profiles.qemu_emery.ready, true);
  await next.activate();
  assert.ok(!(await next.caches.keys()).includes('pebble-offline:/emulator/:one'));
});

test('an explicit update cannot replace another open watch session; the nested phone is not a separate tab', async () => {
  const w = worker();
  w.tabs.push({ url: scope + '#/example/clock', frameType: 'top-level' });
  assert.match((await w.message('APPLY_UPDATE')).error, /other emulator tabs/);
  assert.equal(w.skipWaiting, 0);
  w.tabs[1] = { url: scope + 'phone-app/index.html', frameType: 'nested' };
  assert.equal((await w.message('APPLY_UPDATE')).error, undefined);
  assert.equal(w.skipWaiting, 1);
  assert.match(
    (await w.message('CACHE_PROFILE', { profile: 'untrusted-board' })).error,
    /supported watch/,
  );
});
