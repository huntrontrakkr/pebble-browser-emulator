import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microFlashImage } from '../src/app/firmware-image.ts';
test('SDK ELF uses physical load addresses, not SRAM virtual addresses', () => {
  const bytes = new Uint8Array(128),
    v = new DataView(bytes.buffer);
  v.setUint32(0, 0x7f454c46);
  bytes[4] = 1;
  bytes[5] = 1;
  v.setUint16(18, 40, true);
  v.setUint32(28, 52, true);
  v.setUint16(42, 32, true);
  v.setUint16(44, 1, true);
  v.setUint32(52, 1, true);
  v.setUint32(56, 100, true);
  v.setUint32(60, 0x20000000, true);
  v.setUint32(64, 0, true);
  v.setUint32(68, 12, true);
  bytes.set([0, 0, 8, 32, 9, 0, 0, 0, 0, 191, 254, 231], 100);
  assert.deepEqual(microFlashImage(bytes), bytes.slice(100, 112));
  v.setUint32(64, 0x20000000, true);
  assert.throws(() => microFlashImage(bytes), /outside micro flash/);
});
