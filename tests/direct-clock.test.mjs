import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, MessageChannel } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  'direct phone clock preserves startup, outbound ordering, relayed inputs and port ownership',
  { timeout: 20000 },
  async () => {
    const worker = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source: resolve('src/app/phone.worker.ts'), blockFetch: true },
    });
    const channel = new MessageChannel(),
      replacement = new MessageChannel();
    const ui = [],
      direct = [],
      next = [];
    let failure;
    worker.on('message', (m) => ui.push(m));
    worker.on('error', (e) => {
      failure = e;
    });
    channel.port2.on('message', (m) => direct.push(m));
    replacement.port2.on('message', (m) => next.push(m));
    async function wait(predicate) {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (failure) throw failure;
        const error = ui.find((m) => m.type === 'error' || m.type === 'harness-unhandled');
        if (error) throw new Error(error.message);
        if (Date.now() > deadline) throw new Error(JSON.stringify({ ui, direct, next }));
        await sleep(5);
      }
    }
    const clock = (virtualUs, sequence) => ({
      type: 'clock',
      virtualUs,
      sequence,
      transportGeneration: 7,
    });
    const start = (port, source) =>
      worker.postMessage(
        {
          type: 'start',
          appId: 'direct-clock',
          name: 'clock.js',
          clock: 'watch',
          clockPort: port,
          nowMs: 1700000000000,
          virtualUs: 0,
          connected: true,
          wasmUrl: pathToFileURL(resolve('public/wasm/quickjs.wasm')).href,
          source,
        },
        [port],
      );
    try {
      await wait(() => ui.some((m) => m.type === 'harness-ready'));
      start(
        channel.port1,
        `setTimeout(()=>Pebble.sendAppMessage({0:'ordered'}),30);
        navigator.geolocation.watchPosition(p=>console.log('LOCATION',p.coords.latitude,Date.now()));`,
      );
      await wait(() => ui.some((m) => m.type === 'harness-fetch-blocked'));
      channel.port2.postMessage(clock(10000, 1));
      await sleep(30);
      assert.equal(direct.length, 0);
      assert.equal(
        ui.some((m) => m.type === 'clock-ack'),
        false,
      );
      worker.postMessage({ type: 'harness-release-fetch' });
      await wait(() => direct.some((m) => m.sequence === 1));
      channel.port2.postMessage(clock(30000, 2));
      await wait(() => ui.some((m) => m.type === 'clock-ack' && m.sequence === 2));
      const outbound = ui.findIndex((m) => m.event?.type === 'outbound');
      assert.ok(
        outbound >= 0 && outbound < ui.findIndex((m) => m.type === 'clock-ack' && m.sequence === 2),
      );
      assert.equal(
        direct.some((m) => m.sequence === 2),
        false,
      );
      channel.port2.postMessage(clock(40000, 3));
      await wait(() => direct.some((m) => m.sequence === 3));
      worker.postMessage({
        type: 'location',
        virtualUs: 45000,
        coordinates: { latitude: 9, longitude: 2 },
      });
      worker.postMessage(clock(50000, 4));
      await wait(() => ui.some((m) => m.type === 'clock-ack' && m.sequence === 4));
      assert.ok(ui.some((m) => m.event?.text === 'LOCATION 9 1700000000045'));
      assert.equal(
        direct.some((m) => m.sequence === 4),
        false,
      );
      start(replacement.port1, `console.log('NEW');`);
      await wait(() => ui.some((m) => m.event?.text === 'NEW'));
      const previous = direct.length;
      channel.port2.postMessage(clock(60000, 99));
      replacement.port2.postMessage(clock(10000, 1));
      await wait(() => next.some((m) => m.sequence === 1));
      await sleep(30);
      assert.equal(direct.length, previous);
      assert.ok(next[0].phoneGeneration > direct[0].phoneGeneration);
    } finally {
      channel.port2.close();
      replacement.port2.close();
      await worker.terminate();
    }
  },
);
