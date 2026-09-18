/// <reference lib="webworker" />
import { readLimited } from './projects.ts';
import { WATCH_MODELS, modelUrl } from './watch-model-specs.ts';
import { isFirmwareProfile } from './watch-profiles.ts';
import { readLocal, writeLocal } from './local-store.ts';
import {
  prepareModelGeometry,
  MODEL_ERROR_LIMIT,
  MODEL_TRIANGLE_RATIO,
  type ModelGeometry,
} from './watch-model-geometry.ts';

function validGeometry(geometry: ModelGeometry) {
  return (
    geometry.positions instanceof Float32Array &&
    geometry.normals instanceof Float32Array &&
    geometry.indices instanceof Uint32Array &&
    geometry.positions.length === geometry.normals.length &&
    geometry.positions.length > 0 &&
    geometry.positions.length % 3 === 0 &&
    geometry.indices.length > 0 &&
    geometry.indices.length % 3 === 0 &&
    geometry.positions.byteLength + geometry.normals.byteLength + geometry.indices.byteLength <=
      12 * 1024 * 1024 &&
    geometry.positions.every(Number.isFinite) &&
    geometry.normals.every(Number.isFinite) &&
    geometry.indices.every((index) => index < geometry.positions.length / 3) &&
    Number.isFinite(geometry.estimatedError) &&
    geometry.estimatedError <= MODEL_ERROR_LIMIT
  );
}

function deliver(geometry: ModelGeometry) {
  postMessage({ geometry }, [
    geometry.positions.buffer,
    geometry.normals.buffer,
    geometry.indices.buffer,
  ]);
}

self.onmessage = async ({ data }) => {
  try {
    const profile: unknown = data.profile;
    if (!isFirmwareProfile(profile)) throw new Error('Unsupported watch model.');
    const spec = WATCH_MODELS[profile];
    // One derived entry per profile; updates replace it rather than growing history.
    // Bump the algorithm version when weld/normal handling or simplifier changes.
    const key = JSON.stringify([spec, MODEL_ERROR_LIMIT, MODEL_TRIANGLE_RATIO, 'meshopt-1.1-v2']);
    const cacheKey = 'watch-model:' + profile;
    try {
      const saved = await readLocal<{ key: string; geometry: ModelGeometry }>(cacheKey);
      if (saved?.key === key && validGeometry(saved.geometry)) {
        deliver(saved.geometry);
        return;
      }
    } catch {
      /* Private browsing or corrupt optional cache: verify the source again. */
    }
    const response = await fetch(modelUrl(spec));
    if (!response.ok)
      throw new Error(`CAD download failed (${response.status}). Try again online.`);
    const bytes = await readLimited(response, 11 * 1024 * 1024);
    const buffer = bytes.buffer as ArrayBuffer;
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== spec.sha256)
      throw new Error('CAD model checksum did not match the pinned official revision.');
    const geometry = await prepareModelGeometry(buffer, spec);
    try {
      await writeLocal(cacheKey, { key, geometry });
    } catch {
      /* Cache is optional. */
    }
    deliver(geometry);
  } catch (error) {
    postMessage({ error: String(error) });
  }
};
