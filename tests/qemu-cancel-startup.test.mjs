import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wasmUrl = pathToFileURL(resolve('public/wasm/qemu-emery.wasm')).href;

// Cancelling a preview posts cancel-startup, and then pause, as soon as the user
// taps. Both can reach the Worker while `init` is still fetching and compiling
// the core. Rejecting them posted an error the preview never cleared, so the
// next start did nothing and the watch stayed blank until a reload.
test(
  'cancelling before the core finishes loading reports no error',
  { timeout: 30000 },
  async () => {
    const worker = new Worker(new URL('./node-worker-bootstrap.mjs', import.meta.url), {
      workerData: { source: resolve('src/app/qemu.worker.ts'), blockFetch: true },
    });
    const messages = [];
    let failure;
    worker.on('message', (m) => messages.push(m));
    worker.on('error', (e) => (failure = e));
    const wait = async (predicate) => {
      const deadline = Date.now() + 15000;
      while (!predicate()) {
        if (failure) throw failure;
        if (Date.now() > deadline) throw new Error(JSON.stringify(messages));
        await sleep(5);
      }
    };
    try {
      worker.postMessage({ type: 'init', wasmUrl });
      await wait(() => messages.some((m) => m.type === 'harness-fetch-blocked'));
      // The core is provably still loading here: `init` is parked inside fetch.
      worker.postMessage({ type: 'cancel-startup' });
      worker.postMessage({ type: 'pause' });
      await sleep(50);
      assert.deepEqual(
        messages.filter((m) => m.type === 'error' || m.type === 'harness-unhandled'),
        [],
        'Cancelling while the core loads must not report an error',
      );
      // The core still finishes loading and stays usable after the cancel.
      worker.postMessage({ type: 'harness-release-fetch' });
      await wait(() => messages.some((m) => m.type === 'ready'));
      assert.deepEqual(
        messages.filter((m) => m.type === 'error' || m.type === 'harness-unhandled'),
        [],
      );
    } finally {
      await worker.terminate();
    }
  },
);
