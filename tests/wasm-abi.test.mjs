import test from 'node:test';
import assert from 'node:assert/strict';
import { isWasmRunFailure, wasmU32 } from '../src/app/wasm-abi.ts';

test('recognizes Rust u32::MAX after the WebAssembly i32 boundary', async () => {
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
    0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04,
    0x00, 0x41, 0x7f, 0x0b,
  ]);
  const { instance } = await WebAssembly.instantiate(bytes);
  const result = instance.exports.run();
  assert.equal(result, -1);
  assert.equal(isWasmRunFailure(result), true);
  assert.equal(isWasmRunFailure(0xffff_ffff), true);
  assert.equal(isWasmRunFailure(0), false);
  assert.equal(isWasmRunFailure(1_000_000), false);
  assert.equal(wasmU32(-12832), 0xffff_cde0);
});
