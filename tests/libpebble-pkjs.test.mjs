import test from 'node:test';
import assert from 'node:assert/strict';
import { newVariant, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { quickJsPkjsHost } from '../src/app/libpebble-pkjs.ts';

const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, {}));

/** The proxy BrowserJsRunner generates for each interface. */
const proxy = (name, methods) => `
var ${name} = globalThis.${name} = {};
${JSON.stringify(methods)}.forEach(function (m) {
  ${name}[m] = function () {
    var r = JSON.parse(__nativeDispatch('${name}', m, JSON.stringify(Array.from(arguments))));
    if (r.x) (0, eval)(r.x);
    if ('e' in r) throw new Error(r.e);
    return r.v;
  };
});`;

test('app calls reach the dispatcher as JSON and results come back', () => {
  const calls = [];
  const engine = quickJsPkjsHost(quickjs).create('test', (object, method, args) => {
    calls.push([object, method, JSON.parse(args)]);
    if (method === 'sendAppMessageString')
      return JSON.stringify({ v: 7, x: 'globalThis.after = 1;' });
    if (method === 'fail') return JSON.stringify({ e: '_Pebble.fail: nope' });
    return JSON.stringify({ v: null });
  });
  assert.equal(
    engine.eval(proxy('_Pebble', ['sendAppMessageString', 'fail']), 'proxy.js'),
    '{"v":null}',
  );
  assert.equal(
    engine.eval('_Pebble.sendAppMessageString(JSON.stringify({ a: 1 })) + after', 'app.js'),
    '{"v":8}',
  );
  assert.deepEqual(calls[0], ['_Pebble', 'sendAppMessageString', ['{"a":1}']]);
  assert.match(
    JSON.parse(engine.eval('_Pebble.fail(1, "x", true)', 'app.js')).e,
    /_Pebble\.fail: nope/,
  );
  assert.deepEqual(calls[1][2], [1, 'x', true]);
  engine.destroy();
  assert.match(JSON.parse(engine.eval('1', 'late.js')).e, /stopped/);
});

test('exceptions, runaway code and promise jobs are reported, not hidden', () => {
  const logs = [];
  const engine = quickJsPkjsHost(quickjs, {
    limits: { evalMilliseconds: 50 },
    console: (label, level, text) => logs.push([label, level, text]),
  }).create('app', () => JSON.stringify({ v: null }));
  assert.match(JSON.parse(engine.eval('throw new TypeError("bad")', 'app.js')).e, /TypeError: bad/);
  assert.match(JSON.parse(engine.eval('while (true) {}', 'loop.js')).e, /interrupted/i);
  engine.eval(
    'Promise.resolve(2).then((v) => { globalThis.done = v; console.log("done", v); })',
    'p.js',
  );
  assert.equal(engine.eval('done', 'check.js'), '{"v":2}');
  assert.deepEqual(logs, [['app', 'log', 'done 2']]);
  // Runaway code inside a promise job is stopped by the same deadline; QuickJS turns it
  // into a rejection, which (like any unhandled rejection) it does not report.
  const began = Date.now();
  engine.eval('Promise.resolve().then(() => { while (true) {} })', 'j.js');
  assert.ok(Date.now() - began < 2000);
  engine.destroy();
});

test('each app gets its own engine', () => {
  const host = quickJsPkjsHost(quickjs);
  const a = host.create('a', () => '{"v":null}');
  const b = host.create('b', () => '{"v":null}');
  a.eval('globalThis.secret = 1', 'a.js');
  assert.equal(b.eval('typeof secret', 'b.js'), '{"v":"undefined"}');
  a.destroy();
  b.destroy();
});

test('the engine has the standard base64 methods upstream binary data uses', () => {
  const engine = quickJsPkjsHost(quickjs).create('base64', () => JSON.stringify({ v: null }));
  const run = (code) => JSON.parse(engine.eval(code, 'base64.js'));
  assert.deepEqual(
    run(`[
      Array.from(Uint8Array.fromBase64('AQL/')),
      Array.from(Uint8Array.fromBase64('4oKs\\n/w==')),
      Array.from(Uint8Array.fromBase64('-_8', { alphabet: 'base64url' })),
      Uint8Array.of(1, 2, 255).toBase64(),
      Uint8Array.of(0xe2, 0x82, 0xac, 0xff).toBase64(),
      Uint8Array.of(251, 255).toBase64({ alphabet: 'base64url', omitPadding: true }),
      new Uint8Array(0).toBase64(),
    ]`),
    {
      v: [[1, 2, 255], [0xe2, 0x82, 0xac, 0xff], [251, 255], 'AQL/', '4oKs/w==', '-_8', ''],
    },
  );
  assert.match(run(`Uint8Array.fromBase64('A')`).e, /SyntaxError: Invalid base64/);
  assert.match(run(`Uint8Array.fromBase64('AB*=')`).e, /SyntaxError: Invalid base64/);
  engine.destroy();
});
