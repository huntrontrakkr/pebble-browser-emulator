import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wasm = await readFile('public/wasm/sifli-probe.wasm');
function image() {
  const b = new Uint8Array(0x1200);
  const v = new DataView(b.buffer);
  v.setUint32(0x1000, 0x20080000, true);
  v.setUint32(0x1004, 0x12021101, true);
  // Load CPUID address then attempt LDR. The strict board must reject it.
  v.setUint16(0x1100, 0x4801, true);
  v.setUint16(0x1102, 0x6801, true);
  v.setUint32(0x1108, 0xe000ed00, true);
  return b;
}
async function core() {
  const { instance, module } = await WebAssembly.instantiate(wasm, {});
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const e = instance.exports;
  return {
    e,
    upload(b) {
      const p = e.sifli_input(b.length);
      assert.notEqual(p, 0);
      new Uint8Array(e.memory.buffer, p, b.length).set(b);
    },
    report() {
      return JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(e.memory.buffer, e.sifli_output_ptr(), e.sifli_output_len()),
        ),
      );
    },
  };
}

test('physical Wasm is self-contained and records the first hardware boundary', async () => {
  for (const revision of [0, 1]) {
    const { e, upload, report } = await core();
    assert.equal(e.sifli_abi_version(), 5);
    upload(image());
    assert.equal(e.sifli_load(revision), 1);
    assert.equal(e.sifli_run(100, 0), 2);
    const r = report();
    assert.equal(r.instructionsCompleted, 1);
    assert.equal(r.stepsAttempted, 2);
    assert.equal(r.bootComplete, false);
    assert.equal(r.registers[15], 0x12021102);
    assert.deepEqual(r.stop, {
      type: 'access',
      pc: 0x12021102,
      address: 0xe000ed00,
      width: 4,
      operation: 'Read',
      kind: 'UnsupportedSystemRegister',
    });
    e.sifli_run(100, 0);
    assert.deepEqual(report(), r);
    assert.equal(e.sifli_read_byte(0x20000000) >>> 0, 0xffffffff);
    assert.equal(e.sifli_read_byte(0x12021100), 1);
  }
});

test('invalid loads and allocations cannot reuse an earlier physical session or image', async () => {
  const { e, upload, report } = await core();
  assert.equal(e.sifli_run(100, 0), 0);
  upload(image());
  assert.equal(e.sifli_load(0), 1);
  assert.equal(e.sifli_load(2), 0);
  assert.equal(e.sifli_run(100, 0), 0);
  assert.equal(report().error, 'no probe loaded');
  upload(image());
  assert.equal(e.sifli_input(0xffffffff), 0);
  assert.equal(e.sifli_load(0), 0);
  const invalid = image();
  invalid[0x1004] = 0;
  upload(invalid);
  assert.equal(e.sifli_load(1), 0);
  assert.match(report().error, /InvalidVector/);
});

test('physical Wasm batches stop before breakpoints and instances are isolated', async () => {
  const first = await core();
  const second = await core();
  first.upload(image());
  assert.equal(first.e.sifli_load(0), 1);
  first.e.sifli_run(100, 0x12021102);
  assert.equal(first.report().stop, null);
  assert.equal(first.report().instructionsCompleted, 1);
  assert.equal(second.e.sifli_run(100, 0), 0);
  first.e.sifli_run(100, 0);
  assert.equal(first.report().stop.address, 0xe000ed00);
});

test('physical oscillator failure stays in the guest polling loop and is bounded', async () => {
  const b = image();
  const v = new DataView(b.buffer);
  // ldr r0,ACR; ldr r1,[r0]; cmp r1,#0; bpl polling; b .
  for (const [i, word] of [0x4802, 0x6801, 0x2900, 0xd5fc, 0xe7fe].entries())
    v.setUint16(0x1100 + i * 2, word, true);
  v.setUint32(0x110c, 0x500c0010, true);
  for (const delay of [48000, 800000, 0xffffffff]) {
    const { e, upload, report } = await core();
    assert.equal(e.sifli_configure_hxt(delay), 0);
    upload(b);
    assert.equal(e.sifli_load(0), 1);
    assert.equal(e.sifli_configure_hxt(delay), 1);
    for (let i = 0; i < 10; i++) e.sifli_run(100000, 0x12021108);
    const r = report();
    assert.equal(r.stop, null);
    assert.equal(r.clock.timingVerified, false);
    assert.ok(r.clock.estimatedCoreCycles >= r.instructionsCompleted);
    assert.equal(r.clock.hxtReady, delay !== 0xffffffff);
    if (delay === 0xffffffff) {
      assert.equal(r.instructionsCompleted, 1000000);
      assert.notEqual(r.registers[15], 0x12021108);
    } else {
      assert.equal(r.registers[15], 0x12021108);
      assert.ok(r.clock.referenceTicks48MHz >= delay);
    }
    assert.equal(e.sifli_configure_hxt(0), 0);
  }
});

test('factory bank staging is single-use, bounded and cannot replace live calibration', async () => {
  const { e, upload, report } = await core();
  assert.equal(e.sifli_load_efuse_bank(1), 0);
  e.sifli_efuse_input();
  assert.equal(e.sifli_load_efuse_bank(1), 0); // no loaded firmware
  upload(image());
  assert.equal(e.sifli_load(0), 1);
  let p = e.sifli_efuse_input();
  new Uint8Array(e.memory.buffer, p, 32).fill(0x69);
  assert.equal(e.sifli_load_efuse_bank(4), 0);
  assert.equal(e.sifli_load_efuse_bank(1), 0); // invalid commit consumed staging
  p = e.sifli_efuse_input();
  new Uint8Array(e.memory.buffer, p, 32).fill(0x69);
  assert.equal(e.sifli_load_efuse_bank(1), 1);
  assert.equal(e.sifli_set_chip_id(0x12345678), 1);
  assert.equal(e.sifli_load_efuse_bank(2), 0);
  e.sifli_run(1, 0);
  assert.equal(report().factoryData.loadedBankMask, 2);
  assert.equal(report().calibration.chipId, 0x12345678);
  assert.equal(e.sifli_set_chip_id(0), 0);
  e.sifli_efuse_input();
  assert.equal(e.sifli_load_efuse_bank(2), 0); // cannot edit running instance
  upload(image());
  assert.equal(e.sifli_load(1), 1);
  e.sifli_run(0, 0);
  assert.equal(report().factoryData.loadedBankMask, 0);
  assert.equal(report().calibration.chipId, null);
});

test('NOR profile and OTP imports are explicit, single-use and reset between images', async () => {
  const { e, upload, report } = await core();
  assert.equal(e.sifli_configure_nor(0xef4018, 0, 0), 0);
  upload(image());
  assert.equal(e.sifli_load(0), 1);
  e.sifli_otp_input();
  assert.equal(e.sifli_load_otp(1), 0);
  assert.equal(e.sifli_configure_nor(0x123456, 0, 0), 0);
  assert.equal(e.sifli_configure_nor(0xef4018, 0, 0), 1);
  const p = e.sifli_otp_input();
  new Uint8Array(e.memory.buffer, p, 256).fill(0x69);
  assert.equal(e.sifli_load_otp(0), 0);
  assert.equal(e.sifli_load_otp(1), 0);
  new Uint8Array(e.memory.buffer, e.sifli_otp_input(), 256).fill(0x69);
  assert.equal(e.sifli_load_otp(1), 1);
  assert.equal(e.sifli_load_otp(2), 0);
  e.sifli_run(1, 0);
  assert.equal(report().nor.otpLoadedMask, 1);
  assert.equal(e.sifli_configure_nor(0xef4018, 0, 0), 0);
  e.sifli_otp_input();
  assert.equal(e.sifli_load_otp(2), 0);
  e.sifli_otp_input();
  upload(image());
  assert.equal(e.sifli_load(1), 1);
  assert.equal(e.sifli_configure_nor(0xef4018, 0, 0), 1);
  assert.equal(e.sifli_load_otp(1), 0);
  e.sifli_run(0, 0);
  assert.equal(report().nor.otpLoadedMask, 0);
});
