import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bootFailureReason, bootDiagnostics } from '../scripts/firmware-boot-diagnostics.mjs';

const api = (overrides = {}) => ({
  spike_faulted: () => 0,
  spike_cfsr: () => 0,
  spike_hfsr: () => 0,
  spike_bfar: () => 0,
  spike_pc: () => 0x100,
  spike_xpsr: () => 0x1000000,
  spike_fault: () => 0,
  spike_fault_pc: () => 0,
  spike_register: (i) => i,
  spike_ticks: () => 64000,
  spike_frame_counter: () => 0,
  ...overrides,
});

test('accepted guest HardFault fails boot even after the adapter fault latch clears', () => {
  const fault = api({
    spike_cfsr: () => 0x8200,
    spike_hfsr: () => 0x40000000,
    spike_bfar: () => 0x40013c03,
  });
  assert.equal(bootFailureReason(fault, 50000, 17), 'Firmware CPU fault during boot');
  const report = bootDiagnostics(fault, {
    profile: 'qemu_flint',
    firmware: { tag: 'v4.39.0' },
    coreSha256: 'test-core',
    steps: 50000,
    elapsedMs: 17.3,
    serial: 'x'.repeat(9000) + '\0fault',
    reason: bootFailureReason(fault, 50000, 17),
  });
  assert.equal(report.busFault, false);
  assert.equal(report.bfarValid, true);
  assert.equal(report.bfar, '0x40013c03');
  assert.equal(report.hfsr, '0x40000000');
  assert.equal(report.uartTail.length, 8000);
  assert.equal(report.registers.length, 16);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('boot distinguishes faults, timeout and normal progress without changing state', () => {
  assert.equal(bootFailureReason(api(), 50000, 119999), null);
  assert.equal(bootFailureReason(api(), 50000, 120000), 'Firmware boot exceeded two minutes');
  for (const done of [-1, 0xffffffff])
    assert.equal(bootFailureReason(api(), done, 1), 'Firmware bus fault');
  assert.equal(bootFailureReason(api({ spike_faulted: () => 1 }), 0, 1), 'Firmware bus fault');
});

test('compiled core exposes an accepted guest bus fault to boot diagnostics', async () => {
  const {
    instance: { exports: e },
  } = await WebAssembly.instantiate(
    await readFile(new URL('../public/wasm/qemu-emery.wasm', import.meta.url)),
    {},
  );
  const code = new Uint8Array(0x114),
    view = new DataView(code.buffer);
  view.setUint32(0, 0x20080000, true);
  view.setUint32(4, 0x101, true);
  view.setUint32(12, 0x109, true); // HardFault loops without clearing CFSR
  [0x4803, 0x6801, 0xe7fe, 0xe7fe, 0xe7fe].forEach((w, i) =>
    view.setUint16(0x100 + 2 * i, w, true),
  );
  view.setUint32(0x110, 0x60000000, true); // deliberately unmapped
  const flashLength = 32 * 1024 * 1024;
  const p = e.spike_upload(code.length + flashLength);
  new Uint8Array(e.memory.buffer, p, code.length).set(code);
  assert.equal(e.spike_boot(code.length, flashLength), 1);
  const done = e.spike_run(100);
  assert.equal(e.spike_faulted(), 0); // guest exception accepted
  assert.equal(bootFailureReason(e, done, 1), 'Firmware CPU fault during boot');
  assert.equal(e.spike_cfsr() & 0x8200, 0x8200);
  assert.equal(e.spike_bfar() >>> 0, 0x60000003);
});
