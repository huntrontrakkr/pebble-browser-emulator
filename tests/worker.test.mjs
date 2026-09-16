import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
const wasm = await readFile(new URL('../public/wasm/emulator.wasm', import.meta.url));
async function harness(t) {
  const worker = new Worker(new URL('./worker-harness.mjs', import.meta.url));
  t.after(() => worker.terminate());
  function wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.off('message', handler);
        reject(new Error('Worker response timeout'));
      }, 5000);
      function handler(message) {
        if (predicate(message)) {
          clearTimeout(timer);
          worker.off('message', handler);
          resolve(message);
        }
      }
      worker.on('message', handler);
    });
  }
  await wait((m) => m.type === 'harness-ready');
  const initialized = wait((m) => m.type === 'state');
  worker.postMessage({
    type: 'init',
    wasmUrl: 'data:application/wasm;base64,' + wasm.toString('base64'),
  });
  await initialized;
  return {
    worker,
    wait,
    async command(command, predicate = (m) => m.type === 'state') {
      const response = wait(predicate);
      worker.postMessage(command);
      return response;
    },
  };
}
test('Worker metadata and running state reflect committed operations', async (t) => {
  const h = await harness(t);
  let result = await h.command({ type: 'diagnostic' });
  assert.equal(result.state.programName, 'Framebuffer diagnostic');
  result = await h.command({ type: 'run' });
  assert.equal(result.state.running, true);
  result = await h.command({ type: 'step' }, (m) => m.type === 'state' && !m.state.running);
  assert.equal(result.state.running, false);
  const snapshot = await h.command({ type: 'snapshot' }, (m) => m.type === 'snapshot');
  assert.equal(snapshot.name, 'Framebuffer diagnostic');
  const invalid = h.wait((m) => m.type === 'error');
  h.worker.postMessage({ type: 'image', bytes: new Uint8Array(16), name: 'invalid.bin' });
  await invalid;
  result = await h.command({ type: 'pause' });
  assert.equal(result.state.programName, 'Framebuffer diagnostic');
  assert.equal(result.state.loaded, true);
  result = await h.command({
    type: 'restore',
    bytes: snapshot.bytes,
    name: snapshot.name,
    inputRevision: 3,
  });
  assert.equal(result.state.inputRevision, 3);
  assert.equal(result.state.running, false);
});
test('Worker preserves acknowledged inputs across program reload', async (t) => {
  const h = await harness(t);
  let result = await h.command({ type: 'inputs', buttons: 5, battery: 42, inputRevision: 9 });
  assert.equal(result.state.inputRevision, 9);
  result = await h.command({ type: 'diagnostic' });
  assert.equal(result.state.buttons, 5);
  assert.equal(result.state.battery, 42);
  assert.equal(result.state.inputRevision, 9);
});
