import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// Lifecycle tests use repository assets. Official firmware tests are explicitly opt-in.
const repo = process.env.PEBBLE_REPO ?? fileURLToPath(new URL('../', import.meta.url));
const firmwareDir = process.env.PEBBLE_FIRMWARE_DIR;
const firmwareVersion = process.env.PEBBLE_FIRMWARE_VERSION ?? '4.37.0';
const microPath =
  process.env.PEBBLE_MICRO ??
  (firmwareDir && resolve(firmwareDir, `qemu_emery_v${firmwareVersion}_micro_flash.bin`));
const flashPath =
  process.env.PEBBLE_FLASH ??
  (firmwareDir && resolve(firmwareDir, `qemu_emery_v${firmwareVersion}_spi_flash.bin`));
const pbwPath = process.env.PEBBLE_PBW;
const wasmPath = process.env.PEBBLE_WASM ?? resolve(repo, 'public/wasm/qemu-emery.wasm');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Harness {
  messages = [];
  waiters = [];
  failure;
  constructor(source, options = {}) {
    if (source === 'src/app/qemu.worker.ts' && process.env.PEBBLE_WORKER)
      source = process.env.PEBBLE_WORKER;
    if (source === 'src/app/phone.worker.ts' && process.env.PEBBLE_PHONE_WORKER)
      source = process.env.PEBBLE_PHONE_WORKER;
    this.worker = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source: resolve(repo, source), ...options },
    });
    this.worker.on('message', (data) => {
      this.messages.push(data);
      if (
        process.env.PEBBLE_QA_VERBOSE &&
        (data.type === 'error' ||
          data.type === 'firmware-ready' ||
          data.type === 'installed' ||
          data.type === 'install-status' ||
          (data.type === 'state' && data.state.instructions % 10000000 === 0))
      )
        console.log(JSON.stringify(summarize(data)));
      for (const waiter of [...this.waiters]) waiter.check();
    });
    this.worker.on('error', (e) => {
      this.failure = e;
      for (const waiter of [...this.waiters]) waiter.check();
    });
  }
  send(message) {
    this.worker.postMessage(message);
  }
  mark() {
    return this.messages.length;
  }
  async wait(predicate, { after = 0, timeout = 30000, allowErrors = false } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        check: () => {
          if (this.failure) {
            done();
            reject(this.failure);
            return;
          }
          const recent = this.messages.slice(after),
            item = recent.find(predicate),
            error = recent.find((m) => m.type === 'error' || m.type === 'harness-unhandled');
          if (item) {
            done();
            resolve(item);
          } else if (error && !allowErrors) {
            done();
            reject(new Error(error.message));
          }
        },
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            'Worker message timeout; recent: ' +
              JSON.stringify(this.messages.slice(-6).map(summarize)),
          ),
        );
      }, timeout);
      const done = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((x) => x !== waiter);
      };
      this.waiters.push(waiter);
      waiter.check();
    });
  }
  async close() {
    await this.worker.terminate();
  }
  errors(after = 0) {
    return this.messages
      .slice(after)
      .filter((m) => m.type === 'error' || m.type === 'harness-unhandled');
  }
  async saveTrace(name) {
    if (!process.env.PEBBLE_TRACE_DIR) return;
    await writeFile(
      resolve(process.env.PEBBLE_TRACE_DIR, name + '.json'),
      JSON.stringify(this.messages.map(summarize), null, 2),
    );
    await writeFile(
      resolve(process.env.PEBBLE_TRACE_DIR, name + '-uart.bin'),
      Buffer.concat(this.messages.filter((m) => m.type === 'serial').map((m) => m.bytes)),
    );
  }
}
function summarize(message) {
  if (message.type === 'state')
    return {
      type: message.type,
      running: message.state.running,
      loaded: message.state.loaded,
      ready: message.firmwareReady,
      linked: message.linked,
      installing: message.installing,
      instructions: message.state.instructions,
      fault: message.state.fault,
      battery: message.state.battery,
      registers: message.state.registers,
      flags: message.state.flags,
    };
  if (message.type === 'serial')
    return { type: 'serial', port: message.port, length: message.bytes.length };
  if (message.type === 'protocol')
    return {
      type: 'protocol',
      direction: message.direction,
      endpoint: message.endpoint,
      hex: Buffer.from(message.bytes).toString('hex'),
    };
  if (message.type === 'installed')
    return {
      type: 'installed',
      uuid: message.uuid,
      appId: message.appId,
      scriptBytes: message.script.length,
    };
  return message;
}
async function boot(h) {
  assert.ok(
    microPath && flashPath && pbwPath,
    'Real worker tests require PEBBLE_FIRMWARE_DIR (or PEBBLE_MICRO/PEBBLE_FLASH) and PEBBLE_PBW.',
  );
  await h.wait((m) => m.type === 'harness-ready');
  h.send({ type: 'init', wasmUrl: pathToFileURL(wasmPath).href });
  await h.wait((m) => m.type === 'ready');
  const [micro, flash] = await Promise.all([readFile(microPath), readFile(flashPath)]);
  h.send({
    type: 'firmware',
    micro: new Uint8Array(micro),
    flash: new Uint8Array(flash),
    name: 'Official 4.37 QEMU Emery',
  });
  await h.wait((m) => m.type === 'state' && m.state.loaded);
  h.send({ type: 'run' });
  await h.wait((m) => m.type === 'firmware-ready', { timeout: 120000 });
  return h.messages.filter((m) => m.type === 'session').at(-1).generation;
}

test(
  'phone stop during engine loading must cancel the pending start',
  { timeout: 30000 },
  async () => {
    const h = new Harness('src/app/phone.worker.ts', { blockFetch: true });
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.send({
        type: 'start',
        wasmUrl: pathToFileURL(resolve(repo, 'public/wasm/quickjs.wasm')).href,
        appId: '00112233-4455-6677-8899-aabbccddeeff',
        source: `Pebble.addEventListener('ready',()=>console.log('UNEXPECTED RESURRECTION'));`,
        name: 'test.js',
        coordinates: { latitude: 0, longitude: 0 },
      });
      await h.wait((m) => m.type === 'harness-fetch-blocked');
      const mark = h.mark();
      h.send({ type: 'stop' });
      await h.wait((m) => m.type === 'status' && m.status === 'Stopped', { after: mark });
      h.send({ type: 'harness-release-fetch' });
      await sleep(1000);
      assert.deepEqual(h.errors(), []);
      assert.equal(
        h.messages.slice(mark).some((m) => m.type === 'status' && m.status === 'Running'),
        false,
        'A stop command was superseded by an old async start',
      );
    } finally {
      await h.close();
    }
  },
);

test(
  'latest phone start wins while the shared engine download is pending',
  { timeout: 30000 },
  async () => {
    const h = new Harness('src/app/phone.worker.ts', { blockFetch: true });
    try {
      await h.wait((m) => m.type === 'harness-ready');
      const start = {
        type: 'start',
        wasmUrl: pathToFileURL(resolve(repo, 'public/wasm/quickjs.wasm')).href,
        name: 'test.js',
        coordinates: { latitude: 0, longitude: 0 },
      };
      h.send({ ...start, appId: 'first', source: `console.log('FIRST SHOULD NEVER RUN');` });
      await h.wait((m) => m.type === 'harness-fetch-blocked');
      h.send({ ...start, appId: 'second', source: `console.log('SECOND RUNS');` });
      h.send({ type: 'harness-release-fetch' });
      await h.wait((m) => m.type === 'status' && m.status === 'Running');
      await sleep(50);
      assert.deepEqual(h.errors(), []);
      assert.equal(
        h.messages.some((m) => m.type === 'event' && m.event.text === 'FIRST SHOULD NEVER RUN'),
        false,
      );
      assert.equal(
        h.messages.filter((m) => m.type === 'event' && m.event.text === 'SECOND RUNS').length,
        1,
      );
      assert.equal(
        h.messages.filter((m) => m.type === 'status' && m.status === 'Running').length,
        1,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  'phone ready uses the latest connection state received during engine loading',
  { timeout: 30000 },
  async () => {
    for (const connected of [false, true]) {
      const h = new Harness('src/app/phone.worker.ts', { blockFetch: true });
      try {
        await h.wait((m) => m.type === 'harness-ready');
        h.send({
          type: 'start',
          wasmUrl: pathToFileURL(resolve(repo, 'public/wasm/quickjs.wasm')).href,
          appId: 'connection-race',
          connected: !connected,
          name: 'connection.js',
          coordinates: { latitude: 0, longitude: 0 },
          source: `Pebble.addEventListener('ready',()=>Pebble.sendAppMessage({0:'ready'},()=>console.log('ACK'),e=>console.log(e.error.code)));`,
        });
        await h.wait((m) => m.type === 'harness-fetch-blocked');
        h.send({ type: 'connection', connected });
        h.send({ type: 'harness-release-fetch' });
        const message = await h.wait((m) => m.type === 'event' && m.event.type === 'outbound');
        await h.wait((m) => m.type === 'status' && m.status === 'Running');
        if (connected) {
          h.send({ type: 'ack', transactionId: message.event.transactionId, accepted: true });
          await h.wait((m) => m.type === 'event' && m.event.text === 'ACK');
        } else await h.wait((m) => m.type === 'event' && m.event.text === 'NOT_CONNECTED');
        assert.deepEqual(h.errors(), []);
      } finally {
        await h.close();
      }
    }
  },
);

test('a late acknowledgement after stopping the phone is ignored', { timeout: 30000 }, async () => {
  const h = new Harness('src/app/phone.worker.ts');
  try {
    await h.wait((m) => m.type === 'harness-ready');
    h.send({ type: 'stop' });
    await h.wait((m) => m.type === 'status' && m.status === 'Stopped');
    const mark = h.mark();
    h.send({ type: 'ack', transactionId: 1, accepted: true });
    await sleep(50);
    assert.deepEqual(h.errors(mark), []);
    assert.equal(
      h.messages.slice(mark).some((m) => m.type === 'status' && m.status === 'Running'),
      false,
    );
  } finally {
    await h.close();
  }
});

test(
  'inbound phone delivery echoes watch session and NACKs a stopped phone without error',
  { timeout: 30000 },
  async () => {
    const h = new Harness('src/app/phone.worker.ts');
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.send({
        type: 'appmessage',
        transportGeneration: 37,
        transactionId: 8,
        payload: { 0: 'late' },
      });
      const nack = await h.wait((m) => m.type === 'inbound-result');
      assert.equal(nack.transportGeneration, 37);
      assert.equal(nack.transactionId, 8);
      assert.equal(nack.accepted, false);
      assert.deepEqual(h.errors(), []);
      h.send({
        type: 'start',
        wasmUrl: pathToFileURL(resolve(repo, 'public/wasm/quickjs.wasm')).href,
        appId: 'inbox-generation',
        source: `Pebble.addEventListener('appmessage',e=>console.log(e.payload[0]));`,
        name: 'inbox.js',
        coordinates: { latitude: 0, longitude: 0 },
      });
      await h.wait((m) => m.type === 'status' && m.status === 'Running');
      const mark = h.mark();
      h.send({
        type: 'appmessage',
        transportGeneration: 38,
        transactionId: 9,
        payload: { 0: 'received' },
      });
      const ack = await h.wait((m) => m.type === 'inbound-result', { after: mark });
      assert.equal(ack.transportGeneration, 38);
      assert.equal(ack.transactionId, 9);
      assert.equal(ack.accepted, true);
      assert.deepEqual(h.errors(), []);
    } finally {
      await h.close();
    }
  },
);

test(
  'watch reset rejects old-generation outbound AppMessages and inbox ACKs',
  { timeout: 30000 },
  async () => {
    const h = new Harness('src/app/qemu.worker.ts');
    try {
      await h.wait((m) => m.type === 'harness-ready');
      h.send({ type: 'init', wasmUrl: pathToFileURL(wasmPath).href });
      await h.wait((m) => m.type === 'ready');
      const micro = new Uint8Array(0x104),
        v = new DataView(micro.buffer);
      v.setUint32(0, 0x20080000, true);
      v.setUint32(4, 0x101, true);
      v.setUint16(0x100, 0x222a, true);
      v.setUint16(0x102, 0xe7fe, true);
      h.send({
        type: 'firmware',
        micro,
        flash: new Uint8Array(32 * 1024 * 1024).fill(255),
        name: 'Synthetic reset fixture',
      });
      const original = await h.wait((m) => m.type === 'session');
      await h.wait((m) => m.type === 'state' && m.state.loaded);
      const mark = h.mark();
      h.send({ type: 'reset' });
      const reset = await h.wait((m) => m.type === 'session', { after: mark });
      assert.notEqual(reset.generation, original.generation);
      const after = h.mark();
      h.send({
        type: 'appmessage',
        generation: original.generation,
        uuid: '00112233-4455-6677-8899-aabbccddeeff',
        transactionId: 1,
        payload: { 0: 'stale' },
      });
      h.send({
        type: 'appmessage-ack',
        generation: original.generation,
        transactionId: 2,
        accepted: true,
      });
      await sleep(50);
      assert.deepEqual(h.errors(after), []);
      assert.equal(
        h.messages.slice(after).some((m) => m.type === 'protocol' && m.direction === 'phone'),
        false,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  'actual QEMU Worker boots, installs PBW, accepts AppMessage, battery and link',
  { skip: process.env.PEBBLE_REAL_WORKER !== '1', timeout: 180000 },
  async () => {
    const h = new Harness('src/app/qemu.worker.ts');
    try {
      const generation = await boot(h);
      let mark = h.mark();
      h.send({ type: 'battery', percent: 57, charging: true });
      await h.wait((m) => m.type === 'state' && m.state.battery === 57, { after: mark });
      h.send({
        type: 'install',
        bytes: new Uint8Array(await readFile(pbwPath)),
        name: 'browser-demo.pbw',
      });
      const install = await h.wait((m) => m.type === 'installed', { after: mark, timeout: 60000 });
      await h.wait((m) => m.type === 'install-status' && m.busy === false, { after: mark });
      h.send({
        type: 'appmessage',
        generation,
        uuid: install.uuid,
        transactionId: 42,
        payload: { 0: 'WORKER QA' },
      });
      await h.wait(
        (m) =>
          m.type === 'appmessage' && m.message.kind === 'ack' && m.message.transactionId === 42,
        { after: mark },
      );
      mark = h.mark();
      h.send({
        type: 'install',
        bytes: new Uint8Array(await readFile(pbwPath)),
        name: 'browser-demo-reinstall.pbw',
      });
      const repeated = await h.wait((m) => m.type === 'installed', { after: mark, timeout: 60000 });
      assert.equal(repeated.uuid, install.uuid);
      await h.wait((m) => m.type === 'install-status' && m.busy === false, { after: mark });
      mark = h.mark();
      h.send({ type: 'connection', connected: false });
      await h.wait((m) => m.type === 'connection' && m.connected === false, { after: mark });
      mark = h.mark();
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && m.state.running === false, { after: mark });
      assert.deepEqual(h.errors(), []);
      const state = h.messages.filter((m) => m.type === 'state').at(-1);
      assert.equal(state.state.fault, '');
    } finally {
      await sleep(20);
      await h.saveTrace('qemu-worker-trace');
      await h.close();
    }
  },
);

test(
  'reset cancels fragmented UART writes and queued controls without stopping the new run',
  { skip: process.env.PEBBLE_REAL_WORKER !== '1', timeout: 180000 },
  async () => {
    const h = new Harness('src/app/qemu.worker.ts');
    try {
      await boot(h);
      const mark = h.mark();
      h.send({ type: 'packet', endpoint: 6000, bytes: new Uint8Array(8192) });
      h.send({ type: 'battery', percent: 12, charging: false });
      h.send({ type: 'connection', connected: true });
      h.send({ type: 'reset' });
      h.send({ type: 'run' });
      await h.wait((m) => m.type === 'connection' && m.connected === false, { after: mark });
      await sleep(500);
      assert.deepEqual(h.errors(mark), []);
      const state = h.messages.filter((m) => m.type === 'state').at(-1);
      assert.equal(state.state.running, true);
      assert.equal(state.state.battery, 100);
      assert.equal(state.linked, false);
      assert.equal(
        h.messages.slice(mark).some((m) => m.type === 'connection' && m.connected === true),
        false,
        'Old queued link command leaked into the new boot',
      );
    } finally {
      await h.close();
    }
  },
);

test(
  'reset cancels installation and cannot emit stale success or stop a new run',
  { skip: process.env.PEBBLE_REAL_WORKER !== '1', timeout: 180000 },
  async () => {
    const h = new Harness('src/app/qemu.worker.ts');
    try {
      await boot(h);
      const installMark = h.mark();
      h.send({
        type: 'install',
        bytes: new Uint8Array(await readFile(pbwPath)),
        name: 'cancel.pbw',
      });
      await h.wait((m) => m.type === 'install-status' && m.busy, { after: installMark });
      const resetMark = h.mark();
      h.send({ type: 'reset' });
      h.send({ type: 'run' });
      await h.wait((m) => m.type === 'connection' && m.connected === false, { after: resetMark });
      await sleep(500);
      assert.equal(
        h.messages.slice(resetMark).some((m) => m.type === 'installed'),
        false,
        'Canceled installation emitted success',
      );
      assert.deepEqual(
        h.errors(resetMark),
        [],
        'Canceled work must not report an error or stop the new generation',
      );
      assert.equal(
        h.messages.filter((m) => m.type === 'state').at(-1).state.running,
        true,
        'Reset run stopped unexpectedly',
      );
    } finally {
      await h.close();
    }
  },
);

test(
  'step is rejected during install without pausing the active transfer',
  { skip: process.env.PEBBLE_REAL_WORKER !== '1', timeout: 180000 },
  async () => {
    const h = new Harness('src/app/qemu.worker.ts');
    try {
      await boot(h);
      const mark = h.mark();
      h.send({ type: 'install', bytes: new Uint8Array(await readFile(pbwPath)), name: 'step.pbw' });
      await h.wait((m) => m.type === 'install-status' && m.busy, { after: mark });
      h.send({ type: 'step' });
      await h.wait((m) => m.type === 'installed', {
        after: mark,
        timeout: 60000,
        allowErrors: true,
      });
      await h.wait((m) => m.type === 'install-status' && m.busy === false, {
        after: mark,
        allowErrors: true,
      });
      await sleep(100);
      const state = h.messages.filter((m) => m.type === 'state').at(-1);
      assert.equal(state.state.running, true, 'Step silently left installed firmware paused');
    } finally {
      await h.close();
    }
  },
);

// Pin only this oracle test to the reference demo; other firmware tests accept any PBW.
test(
  'actual QEMU Worker matches every framebuffer byte from native QEMU',
  { skip: process.env.PEBBLE_REFERENCE_FRAME !== '1', timeout: 180000 },
  async () => {
    const expectedPbw = '4e218776f099ae7fd74dd5e18ec725c12c1f204f6f45475368cccd8139ac831f';
    const expectedFrame = 'ff5e62857b3d6e14c4a2d7cbc57a57e64f3f89471c483f09c599c4d3ea3b470b';
    const epoch = 1789545600;
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.ok(pbwPath, 'PEBBLE_REFERENCE_FRAME=1 requires PEBBLE_PBW.');
    const pbw = new Uint8Array(await readFile(pbwPath));
    assert.equal(hash(pbw), expectedPbw, 'The framebuffer oracle requires the reference demo PBW.');
    const h = new Harness('src/app/qemu.worker.ts');
    const frameHashes = new WeakMap();
    const frameHash = (message) => {
      let value = frameHashes.get(message);
      if (!value) {
        value = hash(message.state.framebuffer);
        frameHashes.set(message, value);
      }
      return value;
    };
    try {
      const generation = await boot(h);
      let mark = h.mark();
      h.send({ type: 'epoch', epoch });
      h.send({ type: 'battery', percent: 57, charging: false });
      await h.wait((m) => m.type === 'state' && m.state.battery === 57 && !m.charging, {
        after: mark,
      });
      h.send({ type: 'install', bytes: pbw, name: 'reference-browser-demo.pbw' });
      const installed = await h.wait((m) => m.type === 'installed', {
        after: mark,
        timeout: 60000,
      });
      await h.wait((m) => m.type === 'install-status' && m.busy === false, { after: mark });
      mark = h.mark();
      h.send({ type: 'pause' });
      await h.wait((m) => m.type === 'state' && !m.state.running, { after: mark });
      // Installation advances virtual time. Pin the clock again immediately before
      // the app callback so host scheduling cannot move the displayed minute.
      mark = h.mark();
      h.send({ type: 'epoch', epoch });
      await h.wait((m) => m.type === 'state' && !m.state.running, { after: mark });
      mark = h.mark();
      h.send({
        type: 'appmessage',
        generation,
        uuid: installed.uuid,
        transactionId: 1,
        payload: { 0: 'GPS 40.71' },
      });
      h.send({ type: 'run' });
      await h.wait(
        (m) =>
          m.type === 'appmessage' &&
          m.generation === generation &&
          m.message.kind === 'ack' &&
          m.message.transactionId === 1,
        { after: mark },
      );
      // Search actual committed frames, including one received before the ACK.
      const matched = await h.wait((m) => m.type === 'state' && frameHash(m) === expectedFrame, {
        after: mark,
        timeout: 30000,
      });
      assert.equal(matched.state.framebuffer.length, 200 * 228);
      assert.equal(matched.state.battery, 57);
      assert.equal(matched.charging, false);
      assert.equal(matched.state.fault, '');
      assert.deepEqual(h.errors(), []);
      h.send({ type: 'pause' });
      if (process.env.PEBBLE_TRACE_DIR) {
        await writeFile(
          resolve(process.env.PEBBLE_TRACE_DIR, 'qemu-reference-frame.bin'),
          matched.state.framebuffer,
        );
        await writeFile(
          resolve(process.env.PEBBLE_TRACE_DIR, 'qemu-reference-frame-evidence.json'),
          JSON.stringify(
            {
              pbwSha256: expectedPbw,
              framebufferSha256: expectedFrame,
              wasmSha256: hash(await readFile(wasmPath)),
              microSha256: hash(await readFile(microPath)),
              flashSha256: hash(await readFile(flashPath)),
              epoch,
              battery: 57,
              charging: false,
              appMessage: { 0: 'GPS 40.71' },
              generation,
              instructions: matched.state.instructions,
              virtualSeconds: matched.virtualSeconds,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await h.saveTrace('qemu-reference-frame-trace');
      await h.close();
    }
  },
);
