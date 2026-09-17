import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFrames, encodeFrame, decodeFrame } from '../src/app/frame-comparison.ts';
test('frame comparisons inspect every byte including round corners and copy inputs', async () => {
  const a = Uint8Array.of(0xc0, 255, 0xc3, 0xf0),
    b = a.slice();
  b[3] = 255;
  const pending = compareFrames(a, b, 2, 2);
  a[0] = 1;
  b[0] = 2;
  const result = await pending;
  assert.equal(result.differentPixels, 1);
  assert.deepEqual(result.firstDifference, { x: 1, y: 1, expected: 240, actual: 255 });
  assert.deepEqual(result.differences, Uint8Array.of(0, 0, 0, 255));
  assert.notEqual(result.expectedHash, result.actualHash);
  const same = await compareFrames(a, a, 2, 2);
  assert.equal(same.differentPixels, 0);
  assert.equal(same.expectedHash, same.actualHash);
});
test('frame interchange validates dimensions, trailing bytes and format', () => {
  const frame = { width: 2, height: 1, bytes: Uint8Array.of(0xc0, 255) };
  const bytes = encodeFrame(frame.bytes, 2, 1);
  assert.deepEqual(decodeFrame(bytes), frame);
  assert.throws(() => decodeFrame(bytes.subarray(0, 13)));
  bytes[8] = 1;
  assert.throws(() => decodeFrame(bytes));
  assert.throws(() => encodeFrame(frame.bytes, 1, 1));
});
