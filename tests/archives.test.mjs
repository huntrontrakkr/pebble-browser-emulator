import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { unzipBounded, inspectPackage } from '../src/app/archives.ts';
test('archive extraction keeps binaries and rejects path traversal and size overflow', () => {
  const zip = zipSync({ 'data.bin': new Uint8Array([0, 255, 128]) });
  assert.deepEqual(unzipBounded(zip)['data.bin'], new Uint8Array([0, 255, 128]));
  assert.throws(() => unzipBounded(zip, 2), /limit/);
  assert.throws(() => unzipBounded(zipSync({ '../escape': strToU8('x') })), /unsafe/);
});
test('package inspection distinguishes firmware manifest from app package', () => {
  const fw = zipSync({
    'manifest.json': strToU8(JSON.stringify({ firmware: { friendlyVersion: '4.37.0' } })),
  });
  assert.equal(inspectPackage(fw).kind, 'firmware');
  const app = zipSync({
    'appinfo.json': strToU8('{"shortName":"Demo"}'),
    'emery/manifest.json': strToU8('{"application":{}}'),
  });
  assert.equal(inspectPackage(app).name, 'Demo');
  assert.deepEqual(inspectPackage(app).platforms, ['emery']);
});

test('incomplete ZIP directory and corrupt content are rejected', () => {
  const bytes = zipSync({ 'app.txt': new TextEncoder().encode('verified') }, { level: 0 });
  assert.throws(() => unzipBounded(bytes.subarray(0, -4)), /incomplete/);
  const corrupt = bytes.slice();
  const offset = new DataView(corrupt.buffer).getUint16(26, true) + 30;
  corrupt[offset] ^= 1;
  assert.throws(() => unzipBounded(corrupt), /CRC/);
});
