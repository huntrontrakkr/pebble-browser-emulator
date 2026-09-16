// Browser Worker transport shim for exercising the actual TypeScript worker in Node.
// This does not claim browser rendering/compatibility validation.
import { parentPort } from 'node:worker_threads';
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (name, handler) => {
  if (name === 'message') parentPort.on('message', (data) => handler({ data }));
};
await import('../src/app/emulator.worker.ts');
parentPort.postMessage({ type: 'harness-ready' });
