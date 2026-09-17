import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClockBarrier } from '../src/app/clock-barrier.ts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('clock barriers require the matching phase and discard stale acknowledgements', async () => {
  const barrier = new ClockBarrier(),
    a = barrier.begin();
  let done = false;
  a.done.then(() => (done = true));
  assert.equal(barrier.acknowledge(a.sequence + 1), false);
  await Promise.resolve();
  assert.equal(done, false);
  barrier.clear();
  await a.done;
  const b = barrier.begin();
  assert.equal(barrier.acknowledge(a.sequence), false);
  assert.equal(barrier.acknowledge(b.sequence), true);
  await b.done;
});
test(
  'phone clock waits for engine startup, stays paused, and applies timed location before the next phase',
  { timeout: 20000 },
  async () => {
    const worker = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source: resolve('src/app/phone.worker.ts'), blockFetch: true },
    });
    const messages = [];
    let failure;
    worker.on('message', (m) => messages.push(m));
    worker.on('error', (e) => (failure = e));
    const wait = async (predicate) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (failure) throw failure;
        const error = messages.find((m) => m.type === 'error');
        if (error) throw new Error(error.message);
        const match = messages.find(predicate);
        if (match) return match;
        await sleep(5);
      }
      throw new Error(JSON.stringify(messages));
    };
    try {
      await wait((m) => m.type === 'harness-ready');
      worker.postMessage({
        type: 'start',
        appId: 'clock-test',
        name: 'clock.js',
        wasmUrl: pathToFileURL(resolve('public/wasm/quickjs.wasm')).href,
        clock: 'watch',
        nowMs: 1700000000000,
        virtualUs: 0,
        source: `setTimeout(()=>console.log('timer',Date.now()),100);navigator.geolocation.watchPosition(p=>console.log('location',p.coords.latitude,Date.now()));`,
        coordinates: { latitude: 1, longitude: 2, accuracy: 3 },
        randomSeed: 1,
      });
      await wait((m) => m.type === 'harness-fetch-blocked');
      worker.postMessage({
        type: 'location',
        virtualUs: 25000,
        coordinates: { latitude: 5, longitude: 2, accuracy: 3 },
      });
      worker.postMessage({ type: 'clock', virtualUs: 50000, sequence: 1, transportGeneration: 7 });
      await sleep(30);
      assert.equal(
        messages.some((m) => m.type === 'clock-ack'),
        false,
      );
      worker.postMessage({ type: 'harness-release-fetch' });
      const ack = await wait((m) => m.type === 'clock-ack' && m.sequence === 1);
      assert.equal(ack.transportGeneration, 7);
      await sleep(150);
      assert.equal(
        messages.some((m) => m.event?.text?.startsWith('timer')),
        false,
      );
      worker.postMessage({
        type: 'location',
        virtualUs: 75000,
        coordinates: { latitude: 9, longitude: 2, accuracy: 3 },
      });
      worker.postMessage({ type: 'clock', virtualUs: 100000, sequence: 2, transportGeneration: 7 });
      await wait((m) => m.type === 'clock-ack' && m.sequence === 2);
      const texts = messages.filter((m) => m.type === 'event').map((m) => m.event.text);
      assert.ok(texts.includes('location 5 1700000000025'));
      assert.ok(texts.includes('location 9 1700000000075'));
      assert.ok(texts.includes('timer 1700000000100'));
      assert.ok(texts.indexOf('location 9 1700000000075') < texts.indexOf('timer 1700000000100'));
    } finally {
      await worker.terminate();
    }
  },
);
