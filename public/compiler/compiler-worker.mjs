// SPDX-License-Identifier: Apache-2.0
import { bundlePhone } from './pkjs-bundler.mjs';
import { loadLockedPackages } from './locked-packages.mjs';
import { buildPebbleApp, normalizeMessageKeys, readProjectMetadata } from './portable-builder.mjs';
const VERSION = '21.11.0-alpha.1';
const BASE = `https://unpkg.com/microbit-clang-wasm@${VERSION}/gen/`;
const ASSETS = {
  'llvm.core.wasm': {
    size: 63386658,
    sha256: '21ae6e9371064766efadd978ddc81cb9573669072583b7d9f4fc49c1c810b7ec',
  },
  'llvm.core2.wasm': {
    size: 37626,
    sha256: '960c326eb9b5db7aedbc169540421587a2d3f3ff987e93d6ad5b4da43430ffd4',
  },
  'llvm.core3.wasm': {
    size: 5458,
    sha256: '63680c043192abac4700bbda6a78e4c19b139fa086b1e872d1c6915d37a428a8',
  },
  'llvm.core4.wasm': {
    size: 787,
    sha256: 'f544dc9cc46f88a0f22d1b839a4fb0853dce2d6e231d880bd19754c59a5a234d',
  },
  'llvm-resources.tar': {
    size: 34723840,
    sha256: 'fc2ef6bae7758f381e894670f0fa07bf3b7fff4e4b326d91f650aa4490c469af',
  },
};
const total = Object.values(ASSETS).reduce((n, a) => n + a.size, 0);
let compilerPromise = null,
  bundlerPromise = null,
  active = null;
async function getBundler() {
  bundlerPromise ??= import('./esbuild/browser.mjs')
    .then(async (esbuild) => {
      await esbuild.initialize({
        wasmURL: new URL('./esbuild/esbuild.wasm', import.meta.url).href,
        worker: false,
      });
      return esbuild;
    })
    .catch((error) => {
      bundlerPromise = null;
      throw error;
    });
  return bundlerPromise;
}
const post = (id, message, transfer = []) => self.postMessage({ id, ...message }, transfer);
async function cachedAsset(name, job) {
  const asset = ASSETS[name];
  if (!asset) throw new Error('Unknown compiler asset ' + name);
  const url = BASE + name;
  const cache =
    typeof caches === 'undefined'
      ? null
      : await caches.open('pebble-browser-compiler-' + VERSION).catch(() => null);
  const cached = cache ? await cache.match(url) : null;
  const response = cached || (await fetch(url, { mode: 'cors', signal: job.controller.signal }));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Compiler asset has no response body: ' + name);
  const chunks = [];
  let loaded = 0;
  try {
    while (true) {
      job.controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.length;
      if (loaded > asset.size) throw new Error('Compiler asset too large: ' + name);
      chunks.push(value);
      job.sizes[name] = loaded;
      post(job.id, {
        type: 'progress',
        asset: name,
        loaded: Object.values(job.sizes).reduce((a, b) => a + b, 0),
        total,
      });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (cached && cache) await cache.delete(url).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  job.controller.signal.throwIfAborted();
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (bytes.length !== asset.size) throw new Error('Compiler asset size mismatch: ' + name);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (hash !== asset.sha256) {
    if (cache) await cache.delete(url);
    throw new Error('Compiler asset integrity mismatch: ' + name);
  }
  if (!cached && cache)
    await cache
      .put(
        url,
        new Response(bytes, {
          headers: {
            'Content-Type': name.endsWith('.wasm')
              ? 'application/wasm'
              : 'application/octet-stream',
          },
        }),
      )
      .catch(() => {});
  post(job.id, {
    type: 'progress',
    asset: name,
    loaded: Object.values(job.sizes).reduce((a, b) => a + b, 0),
    total,
    cached: Boolean(cached),
  });
  return bytes;
}
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') {
    active?.controller.abort();
    return;
  }
  if (data.type !== 'build') return;
  if (active) {
    post(data.id, { type: 'error', message: 'A build is already running' });
    return;
  }
  const job = { id: data.id, controller: new AbortController(), sizes: {} };
  active = job;
  try {
    const log = (message) => post(job.id, { type: 'log', message });
    const files = data.sourceFiles;
    const { projectInfo } = readProjectMetadata(files);
    const jsPaths = Object.keys(files).filter((p) =>
      /^src\/(?:pkjs|js|common)\/.*\.(?:[cm]?js|json)$/.test(p),
    );
    let bundledJs;
    // Parse every companion through the bundler. Lexical regex checks miss valid
    // import/export/require syntax and silently omit simple legacy companions.
    if (jsPaths.length) {
      const esbuild = await getBundler();
      job.controller.signal.throwIfAborted();
      const expanded = await loadLockedPackages({
        sourceFiles: files,
        signal: job.controller.signal,
        log,
      });
      const messageKeys = normalizeMessageKeys(
        projectInfo.messageKeys ?? projectInfo.appKeys ?? {},
      );
      bundledJs = await bundlePhone({ sourceFiles: expanded, esbuild, messageKeys, log });
    }
    job.controller.signal.throwIfAborted();
    post(job.id, { type: 'log', message: 'Loading ARM compiler ' + VERSION });
    compilerPromise ??= import('./vendor/bundle.js').catch((error) => {
      compilerPromise = null;
      throw error;
    });
    const compiler = await compilerPromise;
    job.controller.signal.throwIfAborted();
    compiler.setAssetLoader((name) => cachedAsset(name, job));
    const session = compiler.createSession();
    const result = await buildPebbleApp({
      sourceFiles: data.sourceFiles,
      sdkFiles: data.sdkFiles,
      platform: data.platform ?? 'emery',
      bundledJs,
      projectRoot: data.projectRoot || '',
      timestamp: data.timestamp ?? Math.floor(Date.now() / 1000),
      session,
      log: (message) => post(job.id, { type: 'log', message }),
    });
    job.controller.signal.throwIfAborted();
    post(
      job.id,
      {
        type: 'done',
        pbw: result.pbw,
        elf: result.elf,
        manifest: result.manifest,
        appinfo: result.appinfo,
        metadata: {
          loadSize: result.metadata.loadSize,
          virtualSize: result.metadata.virtualSize,
          entry: result.metadata.entry,
          relocations: result.metadata.relocations,
        },
      },
      [result.pbw.buffer, result.elf.buffer],
    );
  } catch (error) {
    post(job.id, { type: 'error', message: error?.message || String(error) });
  } finally {
    job.controller.abort();
    active = null;
  }
};
