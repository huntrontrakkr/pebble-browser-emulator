import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Group,
  Mesh,
  SphereGeometry,
  BoxGeometry,
  BufferGeometry,
  BufferAttribute,
  Box3,
} from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { prepareModelGeometry, MODEL_ERROR_LIMIT } from '../src/app/watch-model-geometry.ts';
import { loadModelGeometry } from '../src/app/watch-model-loader.ts';
import { WATCH_MODELS } from '../src/app/watch-model-specs.ts';

test('decimation keeps a small separate button, bounds and valid shading attributes', async () => {
  const source = new Group();
  source.add(new Mesh(new SphereGeometry(20, 128, 64)));
  const button = new Mesh(new BoxGeometry(1, 2, 2));
  button.position.set(21, 0, 0);
  source.add(button);
  source.updateMatrixWorld(true);
  const original = new Box3().setFromObject(source);
  const stl = new STLExporter().parse(source, { binary: true });
  const result = await prepareModelGeometry(stl.buffer, {
    ...WATCH_MODELS.qemu_emery,
    center: [0, 0, 0],
  });
  assert.ok(
    result.indices.length / 3 < result.sourceTriangles,
    'Error limit takes priority over target ratio',
  );
  assert.ok(result.estimatedError <= MODEL_ERROR_LIMIT);
  assert.equal(result.normals.length, result.positions.length);
  assert.ok(result.positions.every(Number.isFinite));
  assert.ok(result.normals.every(Number.isFinite));
  assert.ok(result.indices.every((i) => i < result.positions.length / 3));
  const reduced = new BufferGeometry();
  reduced.setAttribute('position', new BufferAttribute(result.positions, 3));
  reduced.computeBoundingBox();
  assert.ok(original.min.distanceTo(reduced.boundingBox.min) < MODEL_ERROR_LIMIT);
  assert.ok(original.max.distanceTo(reduced.boundingBox.max) < MODEL_ERROR_LIMIT);
  assert.ok(
    result.indices.some((i) => result.positions[i * 3] >= 21.5),
    'Small button remains',
  );
});

test('model loading cancels its Worker, rejects errors and reuses successful CPU geometry', async () => {
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    terminated = false;
    constructor() {
      workers.push(this);
    }
    postMessage(data) {
      this.request = data;
    }
    terminate() {
      this.terminated = true;
    }
  };
  try {
    const controller = new AbortController();
    const pending = loadModelGeometry(WATCH_MODELS.qemu_emery, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(workers[0].terminated, true);
    const failed = loadModelGeometry(WATCH_MODELS.qemu_emery, new AbortController().signal);
    workers[1].onmessage({ data: { error: 'checksum did not match' } });
    await assert.rejects(failed, /checksum/);
    assert.equal(workers[1].terminated, true);
    const geometry = {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
    };
    const successful = loadModelGeometry(WATCH_MODELS.qemu_emery, new AbortController().signal);
    workers[2].onmessage({ data: { geometry } });
    assert.equal(await successful, geometry);
    assert.equal(workers[2].terminated, true);
    assert.equal(
      await loadModelGeometry(WATCH_MODELS.qemu_emery, new AbortController().signal),
      geometry,
    );
    assert.equal(workers.length, 3);
    await assert.rejects(loadModelGeometry(WATCH_MODELS.qemu_emery, controller.signal), {
      name: 'AbortError',
    });
  } finally {
    globalThis.Worker = previous;
  }
});
