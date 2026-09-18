import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeCoreTrace } from '../src/app/fidelity-evidence.ts';

test('compiled Wasm trace ABI observes MMIO, handles overflow, and preserves checkpoint identity', async () => {
  const api = (
    await WebAssembly.instantiate(
      await readFile(new URL('../public/wasm/qemu-emery.wasm', import.meta.url)),
      {},
    )
  ).instance.exports;
  const code = new Uint8Array(0x120);
  const view = new DataView(code.buffer);
  view.setUint32(0, 0x20080000, true);
  view.setUint32(4, 0x101, true);
  // ldr r0,[pc,#4]; ldr r1,[r0]; b .-2; nop; literal generic RTC ticks.
  code.set([1, 0x48, 1, 0x68, 0xfd, 0xe7, 0, 0xbf, 0x10, 0x50, 0, 0x40], 0x100);
  const ptr = api.spike_upload(code.length + 32 * 1024 * 1024);
  new Uint8Array(api.memory.buffer, ptr, code.length).set(code);
  assert.equal(api.spike_boot_profile(2, code.length, 32 * 1024 * 1024), 1);
  assert.equal(api.spike_trace_version(), 1);
  function snapshot() {
    const length = api.spike_checkpoint_save();
    const bytes = new Uint8Array(api.memory.buffer, api.spike_checkpoint_ptr(), length).slice();
    api.spike_checkpoint_clear();
    return bytes;
  }
  const before = snapshot();
  assert.equal(api.spike_trace_configure(7, 32), 1);
  assert.deepEqual(snapshot(), before);
  assert.equal(api.spike_run_until(10, 640000), 10);
  const length = api.spike_trace_export();
  const records = decodeCoreTrace(
    new Uint8Array(api.memory.buffer, api.spike_trace_ptr(), length),
    api.spike_trace_version(),
  );
  assert.equal(records.filter((e) => e.kind === 'read').length, 5);
  assert.equal(records.find((e) => e.kind === 'read').address, 0x40005010);
  assert.equal(records.filter((e) => e.kind === 'step').length, 10);
  assert.ok(api.spike_estimated_cpu_cycles() > 0);
  assert.equal(api.spike_trace_configure(7, 0), 0);
  assert.equal(api.spike_trace_configure(7, 32769), 0);
  api.spike_run_until(100, 640000);
  assert.ok(api.spike_trace_dropped() > 0);
  assert.equal(api.spike_trace_export(), 32 * 40);
  const after = snapshot();
  assert.equal(api.spike_trace_configure(0, 0), 1);
  assert.deepEqual(snapshot(), after);
});
