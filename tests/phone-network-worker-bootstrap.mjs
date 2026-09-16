import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const requests = new Map();
let next = 1;
globalThis.self = globalThis;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (url.startsWith('file:')) return new Response(await readFile(new URL(url)));
  if (!url.startsWith('https://fixture.invalid/'))
    throw new Error('Tests never access the network.');
  const id = next++;
  options.signal.addEventListener('abort', () => postMessage({ type: 'harness-abort', id }), {
    once: true,
  });
  postMessage({
    type: 'harness-network',
    id,
    url,
    mode: options.mode,
    credentials: options.credentials,
  });
  return new Promise((resolve) => requests.set(id, resolve));
};
await import(pathToFileURL(workerData.source));
parentPort.on('message', (data) => {
  if (data.type === 'harness-response') {
    requests.get(data.id)?.(new Response(data.body, { status: data.status ?? 200 }));
    requests.delete(data.id);
    return;
  }
  Promise.resolve(globalThis.onmessage?.({ data })).catch((error) =>
    postMessage({ type: 'harness-unhandled', message: String(error) }),
  );
});
postMessage({ type: 'harness-ready' });
