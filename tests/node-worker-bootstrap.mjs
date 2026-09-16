import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// A deliberately thin Worker shim: message handlers may overlap at awaits, just
// like browser workers. Transfer lists remain real structured-clone transfers.
globalThis.self = globalThis;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
const nativeFetch = globalThis.fetch;
let releaseFetch;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (workerData.blockFetch) {
    workerData.blockFetch = false;
    postMessage({ type: 'harness-fetch-blocked' });
    await new Promise((resolve) => (releaseFetch = resolve));
  }
  if (url.startsWith('file:')) return new Response(await readFile(new URL(url)));
  return nativeFetch(input, options);
};
await import(pathToFileURL(workerData.source));
parentPort.on('message', (data) => {
  if (data.type === 'harness-release-fetch') {
    releaseFetch?.();
    return;
  }
  const result = globalThis.onmessage?.({ data });
  Promise.resolve(result).catch((error) =>
    postMessage({ type: 'harness-unhandled', message: String(error) }),
  );
});
postMessage({ type: 'harness-ready' });
