/// <reference lib="webworker" />
import { runLinuxBuild } from './linux-build-runtime.ts';
let busy = false;
self.onmessage = async ({ data }) => {
  if (busy || data.type !== 'build') return;
  busy = true;
  try {
    const result = await runLinuxBuild(data, (text) =>
      postMessage({ id: data.id, type: 'log', message: text }),
    );
    postMessage({ id: data.id, type: 'done', ...result });
  } catch (e) {
    postMessage({ id: data.id, type: 'error', message: String(e) });
  } finally {
    busy = false;
  }
};
