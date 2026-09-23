import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { BufferedHistory } from '../src/app/buffered-history.ts';
import { FIRMWARE_PROFILES, profileDisplay, isFirmwareProfile } from '../src/app/watch-profiles.ts';
import {
  defaultDemoSettings,
  normalizeDemoSettings,
  DEMO_STORAGE_KEY,
} from '../src/app/demo-settings.ts';
import { watchModelSpec, modelSource } from '../src/app/watch-model-specs.ts';
import { boardDescriptor } from '../src/app/board-registry.ts';
import { screenPoint } from '../src/app/watch-gestures.ts';
import { buildStamp } from '../src/app/build-stamp.ts';
import { WEATHER_CONDITIONS } from '../src/app/weather-records.ts';
import { coordinateName, fetchForecast, weatherReading } from '../src/app/weather-source.ts';
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
/** Stands in for upstream-phone.ts; records what the App asks of it. */
class UpstreamPhone {
  calls = [];
  connectedValue = false;
  connected = () => this.connectedValue;
  busy = () => false;
  manifest = () => null;
  status = () => '';
  runningApp = () => '';
  detect() {}
  handleQemuMessage(data) {
    this.calls.push(['qemu', data.type]);
  }
  dispose() {}
  async configure() {
    this.calls.push(['configure']);
    return 'data:text/html,upstream';
  }
  async configurationClosed(response) {
    this.calls.push(['closed', response]);
  }
}
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
    savedFirmwares = [],
    exports = {};
  const context = vm.createContext({
    exports,
    signal,
    // Rendering hooks have nothing to render here; the log's scroll position
    // is checked in the browser, not by this harness.
    inject: () => undefined,
    Injector: class {},
    afterNextRender: () => {},
    AppMessageRouter,
    UpstreamPhone,
    BufferedHistory,
    MessageChannel,
    FIRMWARE_PROFILES,
    defaultDemoSettings,
    normalizeDemoSettings,
    DEMO_STORAGE_KEY,
    watchModelSpec,
    modelSource,
    profileDisplay,
    isFirmwareProfile,
    boardDescriptor,
    screenPoint,
    buildStamp,
    WEATHER_CONDITIONS,
    coordinateName,
    fetchForecast,
    weatherReading,
    saveFirmware: async (firmware) => {
      savedFirmwares.push(firmware);
    },
    Worker: Port,
    AbortController,
    URL,
    TextEncoder,
    Date,
    console,
    setTimeout,
    clearTimeout,
    document: { baseURI: pathToFileURL(resolve(repo, 'public/')).href },
    sessionStorage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    localStorage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
  });
  vm.runInContext(js, context, { filename: sourcePath });
  const app = new exports.App();
  app.savedFirmwares = savedFirmwares;
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

test('manual firmware is remembered only after acceptance; cached previews do not rewrite it', async () => {
  const app = makeApp();
  app.qemuReady = Promise.resolve();
  const firmware = {
    profile: 'qemu_emery',
    name: 'official-default',
    micro: new Uint8Array([1]),
    flash: new Uint8Array([2]),
  };
  await app.loadFirmware(firmware);
  assert.equal(app.savedFirmwares.length, 0, 'Unaccepted firmware must not replace the saved pair');
  app.handleQemuEvent({ type: 'firmware-loaded', profile: firmware.profile, name: firmware.name });
  assert.equal(app.savedFirmwares.length, 1);
  await app.loadFirmware(firmware, true);
  app.handleQemuEvent({ type: 'firmware-loaded', profile: firmware.profile, name: firmware.name });
  assert.equal(
    app.savedFirmwares.length,
    1,
    'Cached images should not incur another large IndexedDB write',
  );
});

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
  const watch = app.qemuWorker;
  app.cancelPreview();
  app.handleQemuEvent({ type: 'firmware-ready' });
  assert.equal(watch.messages.filter((m) => m.type === 'install').length, 1);
  assert.ok(watch.terminated);
  assert.equal(app.qemuWorker, undefined);
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
  app.handleQemuEvent({
    type: 'clock',
    generation: 1,
    direct: true,
    virtualUs: 1010000,
    epochMs: 1010,
  });
  assert.equal(app.watchEpochMs, 1010);
  assert.equal(
    app.qemuWorker.messages.filter((m) => m.type === 'phone-clock-ack').length,
    100,
    'Direct-clock telemetry must not release a barrier through the UI',
  );
  app.phoneAccepting = true;
  app.phoneWorker = new Port();
  app.handleQemuEvent({
    type: 'clock',
    generation: 1,
    direct: true,
    virtualUs: 1020000,
    epochMs: 1020,
  });
  assert.equal(app.phoneWorker.messages.length, 0, 'Telemetry must not advance the phone twice');
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

test('preview defaults apply once before installation, and stale setup ACKs cannot launch a canceled preview', () => {
  const app = makeApp();
  app.previewSession = true;
  app.pendingPreview = { bytes: new Uint8Array([1]), name: 'Clock.pbw' };
  app.handleQemuEvent({ type: 'firmware-ready' });
  app.handleQemuEvent({ type: 'firmware-ready' });
  const command = app.qemuWorker.messages.find((m) => m.type === 'demo-settings');
  assert.equal(command.settings.battery, 69);
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'demo-settings').length, 1);
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'install').length, 0);
  app.handleQemuEvent({
    type: 'demo-applied',
    generation: command.generation,
    revision: command.revision,
    notifications: 2,
    calendar: 2,
  });
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'install').length, 1);
  app.pendingPreview = { bytes: new Uint8Array([2]), name: 'Canceled.pbw' };
  const watch = app.qemuWorker;
  app.cancelPreview();
  app.handleQemuEvent({
    type: 'demo-applied',
    generation: command.generation,
    revision: command.revision,
    notifications: 2,
    calendar: 2,
  });
  assert.equal(watch.messages.filter((m) => m.type === 'install').length, 1);
  assert.ok(watch.terminated);
});

test('watch controls preserve chords, suppress key repeat, and release on focus loss', () => {
  const app = makeApp();
  app.loaded.set(true);
  const key = (name, repeat = false) => ({ key: name, repeat, preventDefault() {} });
  app.keyButton(key('ArrowUp'), 2, true);
  app.keyButton(key('ArrowDown'), 8, true);
  assert.equal(app.buttons, 10);
  const count = app.qemuWorker.messages.length;
  app.keyButton(key('ArrowUp', true), 2, true);
  assert.equal(app.qemuWorker.messages.length, count);
  app.pointerButtons.set(7, 2);
  app.releaseKeys();
  assert.equal(app.buttons, 2, 'Moving keyboard focus must not release a still-held pointer');
  app.releaseButtons();
  assert.equal(app.buttons, 0);
  assert.equal(app.pointerButtons.size, 0);
});

test('settings return belongs to its exact page, app and phone generation; replacement cancels ownership', () => {
  const app = makeApp();
  app.startPhone();
  const phone = app.phoneWorker;
  phone.emit({ type: 'status', status: 'Running', phoneGeneration: 7 });
  phone.emit({
    type: 'event',
    phoneGeneration: 7,
    event: { type: 'configuration', requestId: 1, url: 'data:text/html,settings' },
  });
  const first = app.configuration();
  app.returnConfiguration({ request: { ...first }, response: 'forged' });
  assert.equal(phone.messages.filter((m) => m.type === 'configurationClosed').length, 0);
  phone.emit({
    type: 'event',
    phoneGeneration: 7,
    event: { type: 'configuration', requestId: 2, url: 'data:text/html,new' },
  });
  app.returnConfiguration({ request: first, response: 'stale' });
  assert.equal(phone.messages.filter((m) => m.type === 'configurationClosed').length, 0);
  const current = app.configuration();
  app.returnConfiguration({ request: current, response: '{"value":"%25"}' });
  const result = phone.messages.find((m) => m.type === 'configurationClosed');
  assert.equal(result.requestId, 2);
  assert.equal(result.phoneGeneration, 7);
  assert.equal(result.response, '{"value":"%25"}');
  app.returnConfiguration({ request: current, response: 'duplicate' });
  assert.equal(phone.messages.filter((m) => m.type === 'configurationClosed').length, 1);
  app.stopPhone();
});

test('upstream phone settings return to the upstream phone only, exactly as the frame gives them', async () => {
  const app = makeApp();
  app.showPreview = () => {};
  app.startPhone();
  const phone = app.phoneWorker;
  await app.upstreamConfiguration();
  const view = app.configuration();
  assert.equal(view.url, 'data:text/html,upstream');
  app.returnConfiguration({ request: { ...view }, response: 'forged' });
  assert.deepEqual(
    app.upstreamPhone.calls.filter((c) => c[0] === 'closed'),
    [],
  );
  app.returnConfiguration({ request: view, response: '{"value":"%25"}' });
  assert.deepEqual(
    app.upstreamPhone.calls.filter((c) => c[0] === 'closed'),
    [['closed', '{"value":"%25"}']],
  );
  assert.equal(app.configuration(), null);
  assert.equal(phone.messages.filter((m) => m.type === 'configurationClosed').length, 0);
  app.stopPhone();
});

test('while the upstream phone holds the watch link, Preview does not install over it', () => {
  const app = makeApp();
  app.isFirmware = () => true;
  app.watchReady.set(true);
  app.upstreamPhone.connectedValue = true;
  app.installPackage({ bytes: new Uint8Array([1]), name: 'app.pbw' });
  assert.match(app.error(), /upstream phone is connected/);
  assert.equal(app.qemuWorker.messages.filter((m) => m.type === 'install').length, 0);
});

test('changing 3D profile resizes before redraw, retains the renderer and cancels stale loads', async () => {
  const app = makeApp();
  const loads = [],
    events = [];
  const model = {
    setActive() {},
    setTouchMode() {},
    finish() {},
    setSpec(spec) {
      events.push('spec:' + spec.profile);
    },
    dispose() {
      assert.fail('Switching should retain the renderer');
    },
    load(signal) {
      return new Promise((resolve) => loads.push({ signal, resolve }));
    },
  };
  app.model = model;
  app.modelProfile = 'qemu_flint';
  app.modelLoaded = true;
  app.redraw = () => events.push('draw:' + app.profile());
  app.profile.set('qemu_gabbro');
  const first = app.setDisplay('model');
  assert.equal(events[0], 'spec:qemu_gabbro');
  assert.equal(events[1], 'draw:qemu_gabbro');
  app.profile.set('qemu_emery');
  const second = app.setDisplay('model');
  assert.equal(loads[0].signal.aborted, true);
  loads[0].resolve();
  await first;
  assert.equal(app.modelLoaded, false);
  assert.equal(app.modelLoading, true);
  loads[1].resolve();
  await second;
  assert.equal(app.model, model);
  assert.equal(app.modelProfile, 'qemu_emery');
  assert.equal(app.modelLoaded, true);
  assert.equal(app.modelStatus(), '');
  await app.setDisplay('model');
  assert.equal(loads.length, 2, 'Already loaded geometry is not reloaded');
});

test('install progress watchdog survives a frozen virtual clock, resets on progress and clears on success', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = makeApp(),
    watch = app.qemuWorker;
  app.watchReady.set(true);
  app.installPackage({ bytes: new Uint8Array([1]), name: 'App.pbw' });
  t.mock.timers.tick(44000);
  assert.equal(watch.terminated, false);
  app.handleQemuEvent({ type: 'install-status', busy: true, message: 'app: 2000 / 4000 bytes' });
  t.mock.timers.tick(44000);
  assert.equal(watch.terminated, false);
  t.mock.timers.tick(1000);
  assert.equal(watch.terminated, true);
  assert.equal(app.installing(), false);
  assert.equal(app.previewBusy(), false);
  assert.equal(app.loaded(), false);
  assert.ok(app.restartRequired());
  assert.match(app.error(), /no installation progress/);
  const replacement = new Port();
  app.qemuWorker = replacement;
  app.watchReady.set(true);
  app.installPackage({ bytes: new Uint8Array([1]), name: 'Next.pbw' });
  app.handleQemuEvent({ type: 'install-status', busy: false, message: 'Launched' });
  t.mock.timers.tick(90000);
  assert.equal(replacement.terminated, false, 'The previous watchdog cannot kill the new app');
});
