import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';
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

test('stale watch-generation ACK cannot settle an ID reused after reset', () => {
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
  app.handleQemuEvent({ type: 'connection', connected: true });
  phone.emit({
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
    phone.messages.some((m) => m.type === 'ack' && m.accepted),
    false,
  );
  app.handleQemuEvent({
    type: 'appmessage',
    generation: 2,
    message: { kind: 'ack', transactionId: current.transactionId },
  });
  assert.equal(
    phone.messages.some((m) => m.type === 'ack' && m.transactionId === 2 && m.accepted),
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
