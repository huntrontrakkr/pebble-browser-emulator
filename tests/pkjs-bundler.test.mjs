import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { getQuickJS } from 'quickjs-emscripten';
import { bundlePhone } from '../public/compiler/pkjs-bundler.mjs';
import {
  loadLockedPackages,
  unpackPackage,
  verifyIntegrity,
} from '../public/compiler/locked-packages.mjs';
// The same browser API and Wasm binary shipped to visitors; no native esbuild process.
import * as esbuild from '../node_modules/esbuild-wasm/esm/browser.js';
const enc = new TextEncoder();
globalThis.self = globalThis;
await esbuild.initialize({
  wasmModule: await WebAssembly.compile(
    await readFile(new URL('../node_modules/esbuild-wasm/esbuild.wasm', import.meta.url)),
  ),
  worker: false,
});
const files = (input) =>
  Object.fromEntries(
    Object.entries(input).map(([path, text]) => [
      path,
      enc.encode(typeof text === 'string' ? text : JSON.stringify(text)),
    ]),
  );
function tarPackage(entries) {
  const output = [];
  for (const [name, source] of Object.entries(entries)) {
    const data = enc.encode(source),
      header = new Uint8Array(512);
    header.set(enc.encode('package/' + name));
    header.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
    header[156] = 48;
    header.fill(32, 148, 156);
    const sum = header.reduce((n, b) => n + b, 0);
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    output.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  output.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(output));
}
test('browser Wasm bundles local CommonJS, ESM, JSON and message keys; result executes inside QuickJS', async () => {
  const sourceFiles = files({
    'src/pkjs/index.js':
      "const cfg = require('../common/settings.json'); import { value } from './value.js'; globalThis.answer = value + cfg.delta + require('message_keys').RESULT;",
    'src/pkjs/value.js': 'export const value = 40;',
    'src/common/settings.json': { delta: 1 },
  });
  const source = await bundlePhone({ sourceFiles, esbuild, messageKeys: { RESULT: 1 } });
  const runtime = (await getQuickJS()).newContext();
  try {
    const result = runtime.evalCode(source + '\nanswer');
    assert.equal(result.error, undefined);
    assert.equal(runtime.dump(result.value), 42);
    result.value.dispose();
  } finally {
    runtime.dispose();
  }
});
test('bundle rejects module escape, host builtins, and unresolved dynamic modules', async () => {
  for (const source of [
    "require('../../../../outside')",
    "require('node:fs')",
    "require('missing')",
    'const path = Date.now(); require(path)',
  ])
    await assert.rejects(
      bundlePhone({ sourceFiles: files({ 'src/pkjs/index.js': source }), esbuild }),
      /escapes|unavailable|not found|Dynamic module/,
    );
});
test('locked packages verify tar integrity and resolve dependency module without running npm scripts', async () => {
  const bytes = tarPackage({
    'package.json': JSON.stringify({
      name: 'number-fixture',
      version: '1.2.3',
      main: 'lib/main.js',
      scripts: { install: 'DO NOT EXECUTE' },
    }),
    'lib/main.js': 'module.exports = 42;',
  });
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const sourceFiles = files({
    'package.json': { dependencies: { 'number-fixture': '^1.2.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { 'number-fixture': '^1.2.0' } },
        'node_modules/number-fixture': {
          version: '1.2.3',
          resolved: 'https://registry.npmjs.org/number-fixture/-/number-fixture-1.2.3.tgz',
          integrity,
        },
      },
    },
    'src/pkjs/index.js': "globalThis.answer = require('number-fixture');",
  });
  const expanded = await loadLockedPackages({
    sourceFiles,
    request: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return new Response(bytes);
    },
  });
  assert.match(await bundlePhone({ sourceFiles: expanded, esbuild }), /42/);
  await assert.rejects(verifyIntegrity(bytes.slice(1), integrity), /integrity mismatch/);
  await assert.rejects(verifyIntegrity(bytes, 'sha1-old'), /needs SHA/);
  const unsafe = tarPackage({ '../escape': 'x', 'package.json': '{}' });
  await assert.rejects(unpackPackage(unsafe), /Unsafe|escapes/);
});
test('dependencies require matching locked registry entries', async () => {
  await assert.rejects(
    loadLockedPackages({ sourceFiles: files({ 'package.json': { dependencies: { a: '*' } } }) }),
    /package-lock/,
  );
  const root = { dependencies: { a: '1' } };
  for (const url of [
    'https://example.com/a.tgz',
    'https://user:pass@registry.npmjs.org/a.tgz',
    'file:///tmp/a.tgz',
  ])
    await assert.rejects(
      loadLockedPackages({
        sourceFiles: files({
          'package.json': root,
          'package-lock.json': {
            lockfileVersion: 3,
            packages: { '': root, 'node_modules/a': { version: '1', resolved: url } },
          },
        }),
      }),
      /immutable/,
    );
});
test.after(() => esbuild.stop());
