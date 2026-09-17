import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { FIRMWARE_PROFILES, profileDisplay, isFirmwareProfile } from '../src/app/watch-profiles.ts';
const repo = process.env.PEBBLE_REPO ?? fileURLToPath(new URL('../', import.meta.url));
const { default: ts } = await import(
  pathToFileURL(resolve(repo, 'node_modules/typescript/lib/typescript.js'))
);
const sourcePath = process.env.PEBBLE_APP_SOURCE ?? resolve(repo, 'src/app/app.ts');
let AppMessageRouter;
try {
  ({ AppMessageRouter } = await import(
    pathToFileURL(
      process.env.PEBBLE_ROUTER_SOURCE ?? resolve(repo, 'src/app/app-message-router.ts'),
    )
  ));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const source = ts.createSourceFile(
  sourcePath,
  await readFile(sourcePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
// Execute the actual App methods against fake Worker ports and signals. This
// isolates message ownership/routing; it does not pretend to render Angular.
const transformed = ts.transform(source, [
  (context) => (node) => {
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isDecorator(node)) return undefined;
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isMetaProperty(node.expression) &&
        node.name.text === 'url'
      )
        return ts.factory.createStringLiteral(pathToFileURL(sourcePath).href);
      return ts.visitEachChild(node, visit, context);
    }
    return ts.visitNode(node, visit);
  },
]);
const js = ts.transpileModule(ts.createPrinter().printFile(transformed.transformed[0]), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
transformed.dispose();
const signal = (initial) => {
  let value = initial;
  const result = () => value;
  result.set = (next) => (value = next);
  result.update = (fn) => (value = fn(value));
  return result;
};
class Port {
  messages = [];
  terminated = false;
  onmessage;
  onerror;
  constructor() {}
  postMessage(message) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data) {
    this.onmessage?.({ data });
  }
}
function makeApp() {
  const values = new Map(),
    exports = {};
  const context = vm.createContext({
    exports,
    signal,
    AppMessageRouter,
    FIRMWARE_PROFILES,
    profileDisplay,
    isFirmwareProfile,
    Worker: Port,
    URL,
    TextEncoder,
    Date,
    console,
    setTimeout,
    clearTimeout,
    document: { baseURI: pathToFileURL(resolve(repo, 'public/')).href },
    sessionStorage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
  });
  vm.runInContext(js, context, { filename: sourcePath });
  const app = new exports.App();
  app.qemuWorker = new Port();
  app.worker = new Port();
  app.profile.set('qemu_emery');
  app.ready.set(true);
  app.watchReady.set(true);
  app.handleQemuEvent({ type: 'session', generation: 1 });
  app.linked.set(true);
  app.phoneScript.set('console.log("example")');
  return app;
}

test('switching to the diagnostic profile cannot leave an installation running invisibly', () => {
  const app = makeApp();
  app.installing.set(true);
  app.diagnostic();
  assert.equal(
    app.profile(),
    'qemu_emery',
    'Diagnostic switch should be rejected until install completes or is explicitly canceled',
  );
});

test('a queued preview installs once after firmware boot; cancel removes the queued launch', () => {
  const app = makeApp();
  app.pendingPreview = { bytes: new Uint8Array([1]), name: 'Clock.pbw' };
  app.watchReady.set(false);
  app.handleQemuEvent({ type: 'firmware-ready' });
  app.handleQemuEvent({ type: 'firmware-ready' });
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'install').length, 1);
  app.pendingPreview = { bytes: new Uint8Array([2]), name: 'Canceled.pbw' };
  app.cancelPreview();
  app.handleQemuEvent({ type: 'firmware-ready' });
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'install').length, 1);
});

test('phone clock barriers keep acknowledgments without scheduling UI clock redraws', () => {
  const app = makeApp();
  app.virtualSeconds.set(42);
  for (let sequence = 1; sequence <= 100; sequence++)
    app.handleQemuEvent({
      type: 'clock',
      generation: 1,
      sequence,
      virtualUs: sequence * 10000,
      epochMs: sequence * 10,
    });
  assert.equal(app.virtualSeconds(), 42);
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'phone-clock-ack').length, 100);
  assert.equal(app.watchEpochMs, 1000);
});

test('an ACK for the previous phone instance cannot acknowledge the replacement phone', () => {
  const app = makeApp();
  app.startPhone();
  const oldPhone = app.phoneWorker;
  oldPhone.emit({
    type: 'event',
    event: {
      type: 'outbound',
      transactionId: 1,
      appId: '00112233-4455-6677-8899-aabbccddeeff',
      payload: { 0: 'old' },
    },
  });
  const oldPacket = app.qemuWorker.messages.find((m) => m.type === 'appmessage');
  assert.ok(oldPacket);
  app.startPhone();
  const newPhone = app.phoneWorker;
  newPhone.emit({
    type: 'event',
    event: {
      type: 'outbound',
      transactionId: 1,
      appId: '00112233-4455-6677-8899-aabbccddeeff',
      payload: { 0: 'new' },
    },
  });
  app.handleQemuEvent({
    type: 'appmessage',
    generation: 1,
    message: { kind: 'ack', transactionId: oldPacket.transactionId },
  });
  assert.equal(
    newPhone.messages.some((m) => m.type === 'ack' && m.accepted === true),
    false,
    'Stale ACK was delivered to a different QuickJS instance',
  );
});

test('stopping the phone blocks queued outbound events immediately', () => {
  const app = makeApp();
  app.startPhone();
  const phone = app.phoneWorker;
  app.stopPhone();
  const before = app.qemuWorker.messages.length;
  phone.emit({
    type: 'event',
    event: {
      type: 'outbound',
      transactionId: 1,
      appId: '00112233-4455-6677-8899-aabbccddeeff',
      payload: { 0: 'stale' },
    },
  });
  assert.equal(app.qemuWorker.messages.length, before);
});

test('watch reset stops its phone and stale ACKs cannot settle the replacement phone', () => {
  const app = makeApp();
  app.startPhone();
  const phone = app.phoneWorker;
  phone.emit({
    type: 'event',
    event: {
      type: 'outbound',
      transactionId: 1,
      appId: '00112233-4455-6677-8899-aabbccddeeff',
      payload: { 0: 'old' },
    },
  });
  app.handleQemuEvent({ type: 'session', generation: 2 });
  assert.ok(phone.messages.some((m) => m.type === 'stop'));
  assert.equal(app.phoneAccepting, false);
  app.handleQemuEvent({ type: 'connection', connected: true });
  app.startPhone();
  const replacement = app.phoneWorker;
  assert.notEqual(replacement, phone);
  replacement.emit({
    type: 'event',
    event: {
      type: 'outbound',
      transactionId: 2,
      appId: '00112233-4455-6677-8899-aabbccddeeff',
      payload: { 0: 'new' },
    },
  });
  const current = app.qemuWorker.messages.filter((m) => m.type === 'appmessage').at(-1);
  app.handleQemuEvent({
    type: 'appmessage',
    generation: 1,
    message: { kind: 'ack', transactionId: current.transactionId },
  });
  assert.equal(
    replacement.messages.some((m) => m.type === 'ack' && m.accepted),
    false,
  );
  app.handleQemuEvent({
    type: 'appmessage',
    generation: 2,
    message: { kind: 'ack', transactionId: current.transactionId },
  });
  assert.equal(
    replacement.messages.some((m) => m.type === 'ack' && m.transactionId === 2 && m.accepted),
    true,
  );
});

test('phone inbox result from an earlier watch generation cannot ACK the new watch', () => {
  const app = makeApp();
  app.startPhone();
  const phone = app.phoneWorker;
  const before = app.qemuWorker.messages.length;
  phone.emit({ type: 'inbound-result', transportGeneration: 0, transactionId: 9, accepted: true });
  assert.equal(app.qemuWorker.messages.length, before);
});

test('events from a terminated phone worker cannot route new packets', () => {
  const app = makeApp();
  app.startPhone();
  const oldPhone = app.phoneWorker;
  app.startPhone();
  const before = app.qemuWorker.messages.length;
  oldPhone.emit({
    type: 'event',
    event: {
      type: 'outbound',
      transactionId: 1,
      appId: '00112233-4455-6677-8899-aabbccddeeff',
      payload: { 0: 'stale' },
    },
  });
  assert.equal(
    app.qemuWorker.messages.length,
    before,
    'Late event from a replaced worker was forwarded',
  );
});

test('UI profile follows accepted firmware and retains the old profile on rejected load', () => {
  const app = makeApp();
  app.handleQemuEvent({ type: 'error', message: 'invalid Flint firmware' });
  assert.equal(app.profile(), 'qemu_emery');
  app.handleQemuEvent({ type: 'firmware-loaded', profile: 'qemu_flint' });
  assert.equal(app.profile(), 'qemu_flint');
  assert.equal(app.display().width, 144);
  assert.equal(app.defaultWatchInfo(), null);
});

test('phone fixtures and explicit context are valid JSON; default context uses known model codes', () => {
  const app = makeApp();
  assert.equal(JSON.parse(app.phoneFixtures)[0].response.status, 200);
  app.firmwareName.set('qemu_emery_v4.37.0_micro_flash.bin');
  assert.equal(app.defaultWatchInfo().model, 'pebble_time_2_silver_gray');
  assert.equal(app.defaultWatchInfo().firmware.major, 4);
});
