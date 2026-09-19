import { stm32Crc } from '../src/app/pebble-transport.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { unzipBounded, inspectPackage, appPackage } from '../src/app/archives.ts';
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

test('PBW selection validates worker platform, UUID, presence and header before transfer', () => {
  const binary = (platform, flags = 0x10) => {
    const bytes = new Uint8Array(140);
    bytes.set([80, 66, 76, 65, 80, 80, 0, 0]);
    new DataView(bytes.buffer).setUint32(96, (platform << 6) | flags, true);
    bytes[104] = 42;
    return bytes;
  };
  const pack = (app, worker) => {
    const descriptor = (name, bytes) => ({ name, size: bytes.length, crc: stm32Crc(bytes) });
    return zipSync({
      'flint/manifest.json': strToU8(
        JSON.stringify({
          application: descriptor('app.bin', app),
          ...(worker ? { worker: descriptor('worker.bin', worker) } : {}),
        }),
      ),
      'flint/app.bin': app,
      ...(worker ? { 'flint/worker.bin': worker } : {}),
    });
  };
  assert.equal(appPackage(pack(binary(6), binary(6)), 'flint').worker.length, 140);
  assert.throws(() => appPackage(pack(binary(6), binary(5)), 'flint'), /different watch platform/);
  const mismatch = binary(6);
  mismatch[104] = 43;
  assert.throws(() => appPackage(pack(binary(6), mismatch), 'flint'), /does not belong/);
  assert.throws(() => appPackage(pack(binary(6), null), 'flint'), /flag/);
  assert.throws(() => appPackage(pack(binary(6, 0), binary(6)), 'flint'), /flag/);
  assert.throws(() => appPackage(pack(binary(6), new Uint8Array(140)), 'flint'), /header/);
  const impossible = binary(6, 0);
  const impossibleHeader = new DataView(impossible.buffer);
  impossibleHeader.setUint16(0x0e, 140, true);
  impossibleHeader.setUint16(0x80, 139, true);
  assert.throws(
    () => appPackage(pack(impossible, null), 'flint'),
    /load size 140 exceeds virtual size 139/,
  );
});

test('Emery selects intact legacy Basalt/Aplite builds without rewriting their binary headers', () => {
  const binary = (flag) => {
    const bytes = new Uint8Array(140);
    bytes.set([80, 66, 76, 65, 80, 80, 0, 0]);
    new DataView(bytes.buffer).setUint32(96, flag << 6, true);
    return bytes;
  };
  const pack = (target, flag, sdk = '3', declared = [target]) => {
    const app = binary(flag),
      prefix = target === 'root' ? '' : target + '/';
    return zipSync({
      'appinfo.json': strToU8(JSON.stringify({ sdkVersion: sdk, targetPlatforms: declared })),
      [prefix + 'manifest.json']: strToU8(
        JSON.stringify({ application: { name: 'app.bin', size: app.length, crc: stm32Crc(app) } }),
      ),
      [prefix + 'app.bin']: app,
    });
  };
  const old = pack('basalt', 0);
  const selected = appPackage(old, 'emery');
  assert.equal(selected.selectedPlatform, 'basalt');
  assert.equal(selected.compatibility, 'legacy');
  assert.deepEqual(selected.app, binary(0));
  assert.equal(appPackage(pack('basalt', 2), 'emery').selectedPlatform, 'basalt');
  assert.equal(appPackage(pack('aplite', 1), 'emery').selectedPlatform, 'aplite');
  assert.equal(appPackage(pack('root', 0, '2', []), 'emery').selectedPlatform, 'root');
  assert.equal(appPackage(pack('root', 0, '2', []), 'flint').selectedPlatform, 'root');
  assert.throws(() => appPackage(pack('root', 0, '2', []), 'gabbro'), /no gabbro manifest/);
  assert.equal(appPackage(old, 'flint').selectedPlatform, 'basalt');
  assert.throws(() => appPackage(pack('chalk', 3), 'flint'), /no flint manifest/);
  assert.throws(() => appPackage(pack('basalt', 5), 'emery'), /different watch platform/);
  assert.throws(() => appPackage(pack('basalt', 0, '4'), 'emery'), /SDK 2\/3/);
  assert.throws(() => appPackage(pack('basalt', 0, '3', ['aplite']), 'emery'), /conflicts/);
});
