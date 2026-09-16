import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
globalThis.self = globalThis;
globalThis.location = { href: pathToFileURL(workerData.source).href };
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
let release;
globalThis.__testGate = () => new Promise((resolve) => (release = resolve));
globalThis.fetch = async (input) => {
  const url = String(input);
  if (!url.startsWith('file:')) throw new Error('Unexpected external request: ' + url);
  return new Response(await readFile(new URL(url)), {
    headers: { 'content-type': 'application/wasm' },
  });
};
globalThis.caches = {
  open: async () => ({
    match: async () =>
      workerData.oversizedCache
        ? {
            ok: true,
            body: new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(800));
              },
              cancel() {
                postMessage({ type: 'harness-cache-canceled' });
              },
            }),
            arrayBuffer() {
              throw new Error('Unbounded cached arrayBuffer read');
            },
          }
        : null,
    delete: async () => {
      postMessage({ type: 'harness-cache-deleted' });
      return true;
    },
    put: async () => {},
  }),
};
await import(pathToFileURL(workerData.source));
parentPort.on('message', (data) => {
  if (data.type === 'harness-release') {
    release?.();
    return;
  }
  Promise.resolve(globalThis.onmessage?.({ data })).catch((error) =>
    postMessage({ type: 'harness-error', message: String(error) }),
  );
});
postMessage({ type: 'harness-ready' });
