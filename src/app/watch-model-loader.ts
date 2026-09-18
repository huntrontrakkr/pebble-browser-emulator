import type { ModelGeometry } from './watch-model-geometry.ts';
import type { WatchModelSpec } from './watch-model-specs.ts';

// CPU arrays only. Inactive GPU buffers are disposed by the renderer. All three
// current models fit; future models evict the least recently used entries.
const cache = new Map<string, ModelGeometry>();
const limit = 12 * 1024 * 1024;
const size = (geometry: ModelGeometry) =>
  geometry.positions.byteLength + geometry.normals.byteLength + geometry.indices.byteLength;
let cachedBytes = 0;

export async function loadModelGeometry(
  spec: WatchModelSpec,
  signal: AbortSignal,
): Promise<ModelGeometry> {
  signal.throwIfAborted();
  const key = spec.profile + ':' + spec.sha256;
  const saved = cache.get(key);
  if (saved) {
    cache.delete(key);
    cache.set(key, saved);
    return saved;
  }
  const geometry = await new Promise<ModelGeometry>((resolve, reject) => {
    const worker = new Worker(new URL('./watch-model.worker', import.meta.url), { type: 'module' });
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data.geometry);
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message));
    };
    worker.postMessage({ profile: spec.profile });
  });
  signal.throwIfAborted();
  const bytes = size(geometry);
  if (bytes <= limit) {
    if (cache.has(key)) cachedBytes -= size(cache.get(key)!);
    cache.delete(key);
    while (cachedBytes + bytes > limit && cache.size) {
      const oldest = cache.keys().next().value!;
      cachedBytes -= size(cache.get(oldest)!);
      cache.delete(oldest);
    }
    cache.set(key, geometry);
    cachedBytes += bytes;
  }
  return geometry;
}
