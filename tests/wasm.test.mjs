import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const binary = await readFile(new URL('../public/wasm/emulator.wasm', import.meta.url));
async function machine() {
  return (await WebAssembly.instantiate(binary, {})).instance.exports;
}
function output(m) {
  return new Uint8Array(m.memory.buffer, m.output_ptr(), m.output_len()).slice();
}
function input(m, bytes) {
  const ptr = m.input_reserve(bytes.length);
  assert.notEqual(ptr, 0);
  new Uint8Array(m.memory.buffer, ptr, bytes.length).set(bytes);
}

test('the deployed Wasm module requires no host imports', async () => {
  assert.deepEqual(WebAssembly.Module.imports(await WebAssembly.compile(binary)), []);
});
test('Wasm ABI executes actual Thumb instructions and writes all 45600 pixels', async () => {
  const m = await machine();
  assert.equal(m.abi_version(), 1);
  m.load_diagnostic();
  assert.equal(m.register(15), 8);
  assert.equal(m.run(1), 1);
  assert.equal(m.register(0) >>> 0, 0x50000000);
  assert.equal(m.run(300000), 228003);
  assert.equal(m.halted(), 1);
  assert.equal(m.instructions(), 228004);
  m.fault();
  assert.equal(output(m).length, 0);
  const pixels = new Uint8Array(m.memory.buffer, m.framebuffer_ptr(), 45600);
  for (let i = 0; i < pixels.length; i++) assert.equal(pixels[i], (0xc0 + i) & 255);
});
test('Wasm snapshot restore reproduces complete machine state', async () => {
  const m = await machine();
  m.load_diagnostic();
  m.run(2345);
  m.set_inputs(5, 42);
  m.snapshot();
  const saved = output(m);
  m.run(300000);
  m.snapshot();
  const expected = output(m);
  input(m, saved);
  assert.equal(m.restore(), 1);
  assert.equal(m.buttons(), 5);
  assert.equal(m.battery(), 42);
  m.run(300000);
  m.snapshot();
  assert.deepEqual(output(m), expected);
});
test('invalid upload is rejected without replacing valid machine', async () => {
  const m = await machine();
  m.load_diagnostic();
  m.run(100);
  const pc = m.register(15);
  input(m, new Uint8Array(16));
  assert.equal(m.load_image(), 0);
  assert.equal(m.register(15), pc);
  assert.equal(m.instructions(), 100);
  assert.match(new TextDecoder().decode(output(m)), /stack pointer/);
  assert.equal(m.input_reserve(25 * 1024 * 1024), 0);
});
test('Rust ping encoding matches independent libpebble2 golden bytes', async () => {
  const m = await machine();
  m.encode_ping(0x12345678);
  assert.equal(Buffer.from(output(m)).toString('hex'), '000607d1001234567800');
});
test('wasm32 reset vector address overflow cannot bypass validation', async () => {
  const m = await machine();
  m.load_diagnostic();
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20080000, true);
  view.setUint32(4, 0xffffffff, true);
  input(m, bytes);
  assert.equal(m.load_image(), 0);
  assert.equal(m.register(15), 8);
});
test('snapshot instruction count remains exactly representable and never wraps', async () => {
  const m = await machine();
  m.load_diagnostic();
  m.snapshot();
  const original = new TextDecoder().decode(output(m));
  const excessive = original.replace('"instructions":0', '"instructions":18446744073709551615');
  input(m, new TextEncoder().encode(excessive));
  assert.equal(m.restore(), 0);
  const limit = original.replace('"instructions":0', '"instructions":9007199254740991');
  input(m, new TextEncoder().encode(limit));
  assert.equal(m.restore(), 1);
  assert.equal(m.run(1), 0);
  assert.equal(m.instructions(), 9007199254740991);
  assert.equal(m.halted(), 1);
  m.fault();
  assert.match(new TextDecoder().decode(output(m)), /counter limit/);
});
