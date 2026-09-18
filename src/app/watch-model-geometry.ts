import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import type { WatchModelSpec } from './watch-model-specs.ts';

export interface ModelGeometry {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  sourceTriangles: number;
  estimatedError: number;
}

// The official CAD uses millimetres. This is meshoptimizer's combined position/
// normal error metric, not a guaranteed point-to-surface distance. The live screen
// is a separate mesh and is never simplified. Do not prune small components.
export const MODEL_ERROR_LIMIT = 0.025;
export const MODEL_TRIANGLE_RATIO = 0.1;

/** Parse, simplify and compact verified CAD entirely off the UI thread. */
export async function prepareModelGeometry(
  bytes: ArrayBuffer,
  spec: WatchModelSpec,
): Promise<ModelGeometry> {
  await MeshoptSimplifier.ready;
  let geometry = new STLLoader().parse(bytes);
  geometry.translate(...(spec.center.map((n) => -n) as [number, number, number]));
  geometry.rotateX(spec.rotateX);
  geometry.computeVertexNormals();
  const sourceTriangles = geometry.getAttribute('position').count / 3;
  geometry = mergeVertices(geometry, 0.00001);
  const positions = geometry.getAttribute('position').array as Float32Array<ArrayBuffer>;
  const normals = geometry.getAttribute('normal').array as Float32Array<ArrayBuffer>;
  const [indices, estimatedError] = MeshoptSimplifier.simplifyWithAttributes(
    new Uint32Array(geometry.index!.array),
    positions,
    3,
    normals,
    3,
    [0.5, 0.5, 0.5],
    null,
    Math.max(3, Math.floor(sourceTriangles * MODEL_TRIANGLE_RATIO) * 3),
    MODEL_ERROR_LIMIT,
    ['Permissive', 'ErrorAbsolute'],
  ) as [Uint32Array<ArrayBuffer>, number];
  const [remap, count] = MeshoptSimplifier.compactMesh(indices) as [Uint32Array, number];
  const compactPositions = new Float32Array(count * 3);
  const compactNormals = new Float32Array(count * 3);
  for (let i = 0; i < remap.length; i++) {
    const next = remap[i];
    if (next === 0xffffffff) continue;
    compactPositions.set(positions.subarray(i * 3, i * 3 + 3), next * 3);
    compactNormals.set(normals.subarray(i * 3, i * 3 + 3), next * 3);
  }
  return {
    positions: compactPositions,
    normals: compactNormals,
    indices,
    sourceTriangles,
    estimatedError,
  };
}
