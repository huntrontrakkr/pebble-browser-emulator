import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getQuickJS } from 'quickjs-emscripten';
const repo = process.env.PEBBLE_REPO ?? fileURLToPath(new URL('../', import.meta.url));
const sourcePath =
  process.env.PEBBLE_COMPILER_WORKER ?? resolve(repo, 'public/compiler/compiler-worker.mjs');
const enc = new TextEncoder();
const files = (values) =>
  Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      enc.encode(typeof v === 'string' ? v : JSON.stringify(v)),
    ]),
  );
class Harness {
  messages = [];
  waiters = [];
  failure;
  constructor(source, options = {}) {
    this.worker = new Worker(new URL('./compiler-worker-test-bootstrap.mjs', import.meta.url), {
      workerData: { source, ...options },
    });
    this.worker.on('message', (m) => {
      this.messages.push(m);
      for (const waiter of [...this.waiters]) waiter();
    });
    this.worker.on('error', (e) => {
      this.failure = e;
      for (const waiter of [...this.waiters]) waiter();
    });
  }
  send(m) {
    this.worker.postMessage(m);
  }
  async wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Timeout: ' + JSON.stringify(this.messages.slice(-5)))),
        20000,
      );
      const finish = (e, value) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
        e ? reject(e) : resolve(value);
      };
      const check = () => {
        if (this.failure) {
          finish(this.failure);
          return;
        }
        const value = this.messages.find(predicate);
        if (value) finish(null, value);
      };
      this.waiters.push(check);
      check();
    });
  }
  async close() {
    await this.worker.terminate();
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'pebble-compiler-wiring-'));
  await mkdir(join(dir, 'esbuild'));
  await mkdir(join(dir, 'vendor'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'compiler-worker.mjs'), await readFile(sourcePath));
  for (const name of ['pkjs-bundler.mjs', 'locked-packages.mjs'])
    await symlink(resolve(repo, 'public/compiler', name), join(dir, name));
  await writeFile(
    join(dir, 'esbuild/browser.mjs'),
    `export * from ${JSON.stringify(pathToFileURL(resolve(repo, 'node_modules/esbuild-wasm/esm/browser.js')).href)};`,
  );
  await symlink(
    resolve(repo, 'node_modules/esbuild-wasm/esbuild.wasm'),
    join(dir, 'esbuild/esbuild.wasm'),
  );
  await writeFile(
    join(dir, 'vendor/bundle.js'),
    `let loader;export function setAssetLoader(fn){loader=fn}export function createSession(){return {asset:name=>loader(name)}}`,
  );
  await writeFile(
    join(dir, 'portable-builder.mjs'),
    `
 export {normalizeMessageKeys,readProjectMetadata} from ${JSON.stringify(pathToFileURL(process.env.PEBBLE_METADATA_BUILDER ?? resolve(repo, 'public/compiler/portable-builder.mjs')).href)};
 export async function buildPebbleApp({sourceFiles,bundledJs,session}){
  if(sourceFiles['gate']){postMessage({type:'harness-gate'});await globalThis.__testGate();}
  if(sourceFiles['asset'])await session.asset('llvm.core4.wasm');
  return {pbw:new TextEncoder().encode(bundledJs??'OMITTED'),elf:new Uint8Array(0),manifest:{},appinfo:{},metadata:{loadSize:0,virtualSize:0,entry:0,relocations:[]}};
 }`,
  );
  return dir;
}
async function evaluate(source) {
  const vm = (await getQuickJS()).newContext();
  try {
    const r = vm.evalCode(new TextDecoder().decode(source) + '\nanswer');
    if (r.error) {
      const error = vm.dump(r.error);
      r.error.dispose();
      throw new Error(JSON.stringify(error));
    }
    const result = vm.dump(r.value);
    r.value.dispose();
    return result;
  } finally {
    vm.dispose();
  }
}

test(
  'actual compiler Worker bundles plain legacy and compact ESM entries, keeps legacy keys, and reuses esbuild',
  { timeout: 60000 },
  async () => {
    const dir = await fixture(),
      h = new Harness(join(dir, 'compiler-worker.mjs'));
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.send({
        type: 'build',
        id: 1,
        sourceFiles: files({
          'appinfo.json': { appKeys: { ANSWER: 41 } },
          'src/js/app.js': `globalThis.answer=require('message_keys').ANSWER+1;`,
        }),
        sdkFiles: {},
      });
      let result = await h.wait((m) => m.id === 1 && (m.type === 'done' || m.type === 'error'));
      assert.equal(result.type, 'done', result.message);
      assert.equal(await evaluate(result.pbw), 42);
      h.send({
        type: 'build',
        id: 2,
        sourceFiles: files({
          'package.json': { pebble: {} },
          'src/pkjs/index.js': `const value=43;export{value};globalThis.answer=value;`,
        }),
        sdkFiles: {},
      });
      result = await h.wait((m) => m.id === 2 && (m.type === 'done' || m.type === 'error'));
      assert.equal(result.type, 'done', result.message);
      assert.equal(await evaluate(result.pbw), 43);
      h.send({
        type: 'build',
        id: 3,
        sourceFiles: files({ 'appinfo.json': {}, 'src/js/app.js': 'globalThis.answer=44;' }),
        sdkFiles: {},
      });
      result = await h.wait((m) => m.id === 3 && (m.type === 'done' || m.type === 'error'));
      assert.equal(result.type, 'done', result.message);
      assert.equal(await evaluate(result.pbw), 44);
      h.send({
        type: 'build',
        id: 4,
        sourceFiles: files({
          'package.json': { name: 'legacy-npm-project', dependencies: {} },
          'appinfo.json': { appKeys: { ANSWER: 45 } },
          'src/js/app.js': "globalThis.answer=require('message_keys').ANSWER;",
        }),
        sdkFiles: {},
      });
      result = await h.wait((m) => m.id === 4 && (m.type === 'done' || m.type === 'error'));
      assert.equal(result.type, 'done', result.message);
      assert.equal(await evaluate(result.pbw), 45);
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('compiler Worker rejects canceled build before posting done', { timeout: 30000 }, async () => {
  const dir = await fixture(),
    h = new Harness(join(dir, 'compiler-worker.mjs'));
  try {
    await h.wait((m) => m.type === 'harness-ready');
    h.send({
      type: 'build',
      id: 1,
      sourceFiles: files({ 'appinfo.json': {}, gate: 'yes' }),
      sdkFiles: {},
    });
    await h.wait((m) => m.type === 'harness-gate');
    h.send({ type: 'cancel' });
    h.send({ type: 'harness-release' });
    const result = await h.wait((m) => m.id === 1 && (m.type === 'done' || m.type === 'error'));
    assert.equal(result.type, 'error');
    assert.match(result.message, /abort/i);
    assert.equal(
      h.messages.some((m) => m.id === 1 && m.type === 'done'),
      false,
    );
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'cached compiler assets use bounded streams and discard oversized cache entries',
  { timeout: 30000 },
  async () => {
    const dir = await fixture(),
      h = new Harness(join(dir, 'compiler-worker.mjs'), { oversizedCache: true });
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.send({
        type: 'build',
        id: 1,
        sourceFiles: files({ 'appinfo.json': {}, asset: 'yes' }),
        sdkFiles: {},
      });
      const result = await h.wait((m) => m.id === 1 && (m.type === 'done' || m.type === 'error'));
      assert.equal(result.type, 'error');
      assert.match(result.message, /asset too large/);
      assert.ok(h.messages.some((m) => m.type === 'harness-cache-canceled'));
      assert.ok(h.messages.some((m) => m.type === 'harness-cache-deleted'));
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
