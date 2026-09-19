import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isWasmRunFailure } from '../src/app/wasm-abi.ts';
const wasmPath =
  process.env.PEBBLE_RESTART_WASM ?? new URL('../public/wasm/qemu-emery.wasm', import.meta.url);
test('restart export retains a flash write performed by a synthetic Thumb program', async () => {
  const module = await WebAssembly.compile(await readFile(wasmPath));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const { exports: e } = await WebAssembly.instantiate(module, {});
  assert.equal(typeof e.spike_restart, 'function');
  assert.equal(e.spike_restart(), 0);
  const code = new Uint8Array(0x11c),
    v = new DataView(code.buffer);
  v.setUint32(0, 0x20080000, true);
  v.setUint32(4, 0x101, true);
  // Load previous flash word into r3, then persist 0x1234abcd and set r2=42.
  [0x4804, 0x6803, 0x4904, 0x6001, 0x222a, 0xe7fe].forEach((w, i) =>
    v.setUint16(0x100 + 2 * i, w, true),
  );
  v.setUint32(0x114, 0x10004000, true);
  v.setUint32(0x118, 0x1234abcd, true);
  const flash = new Uint8Array(32 * 1024 * 1024).fill(0xa5);
  let ptr = e.spike_upload(code.length + flash.length);
  new Uint8Array(e.memory.buffer, ptr, code.length).set(code);
  new Uint8Array(e.memory.buffer, ptr + code.length, flash.length).set(flash);
  assert.equal(e.spike_boot(code.length, flash.length), 1);
  assert.equal(isWasmRunFailure(e.spike_run(6)), false);
  assert.equal(e.spike_register(2), 42);
  assert.equal(e.spike_register(3) >>> 0, 0xa5a5a5a5);
  const before = e.spike_ticks();
  assert.ok(before > 0);
  assert.equal(e.spike_restart(), 1);
  assert.equal(e.spike_ticks(), before);
  assert.equal(e.spike_register(2), 0);
  assert.equal(e.spike_pc(), 0x100);
  assert.equal(isWasmRunFailure(e.spike_run(2)), false);
  assert.equal(
    e.spike_register(3) >>> 0,
    0x1234abcd,
    'Restart must retain the emulated program flash write',
  );
  assert.equal(e.spike_fault(), 0);
});
