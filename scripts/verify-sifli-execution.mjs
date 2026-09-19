// Runs the browser-target Wasm against locally supplied, unchanged physical images.
// Missing inputs are NOT a pass. This gate establishes reset execution, never full boot.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { auditSifliImage, inspectSifliResetStartup } from '../src/app/sifli-image-audit.ts';

const [revision, elfPath, imagePath, reportPath] = process.argv.slice(2);
if (!['obelix_pvt', 'getafix_dvt2'].includes(revision) || !elfPath || !imagePath) {
  console.error(
    'Usage: node scripts/verify-sifli-execution.mjs REVISION SLOT0.elf SLOT0.bin [report.json]',
  );
  process.exit(2);
}
const report = {
  format: 'pebble-sifli-reset-execution',
  version: 6,
  revision,
  outcome: 'not-run',
  bootComplete: false,
  referenceTarget: 'ELF-initializers-and-reset-binary',
  entryState: 'assumed-secure-reset-probe-v2',
};
try {
  const [elf, image, wasm] = await Promise.all([
    readFile(elfPath),
    readFile(imagePath),
    readFile('public/wasm/sifli-probe.wasm'),
  ]);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  report.identity = { elfSha256: sha(elf), imageSha256: sha(image), wasmSha256: sha(wasm) };
  const audit = auditSifliImage(revision, elf, image);
  const reset = inspectSifliResetStartup(audit, image);
  if (!reset) throw new Error('Reset pattern is not audited; no execution acceptance claim');
  // Targets from the audited, exact branch encodings and published ELF symbols.
  const systemInit = revision === 'obelix_pvt' ? 0x1211521c : 0x12100d9c;
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const e = instance.exports;
  assert.equal(e.sifli_abi_version(), 5);
  const output = () =>
    JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(e.memory.buffer, e.sifli_output_ptr(), e.sifli_output_len()),
      ),
    );
  const input = e.sifli_input(image.length);
  if (!input) throw new Error('Input allocation rejected');
  new Uint8Array(e.memory.buffer, input, image.length).set(image);
  if (!e.sifli_load(revision === 'obelix_pvt' ? 0 : 1)) throw new Error(JSON.stringify(output()));
  let state;
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, systemInit);
    state = output();
    if (state.stop || state.registers[15] === systemInit) break;
  }
  report.startup = state;
  if (state.stop || state.registers[15] !== systemInit)
    throw new Error('Reset did not reach SystemInit');
  if (state.msplim !== reset.mainStackLimit || state.psplim !== 0)
    throw new Error('Stack limits mismatch');
  const ramBytes = (address, count) =>
    Uint8Array.from({ length: count }, (_, i) => {
      const b = e.sifli_read_byte(address + i) >>> 0;
      if (b > 255) throw new Error(`Uninitialized byte at 0x${(address + i).toString(16)}`);
      return b;
    });
  report.copies = reset.copies.map((r) => {
    const actual = ramBytes(r.destination, r.bytes);
    const expected = image.subarray(
      r.source - audit.flashBase,
      r.source - audit.flashBase + r.bytes,
    );
    if (sha(actual) !== sha(expected)) throw new Error('RAM initializer mismatch');
    return { ...r, sha256: sha(actual), matches: true };
  });
  const zero = ramBytes(reset.zeroFill.destination, reset.zeroFill.bytes);
  if (zero.some((b) => b !== 0)) throw new Error('BSS not cleared');
  report.zeroFill = { ...reset.zeroFill, sha256: sha(zero), matches: true };
  const main = revision === 'obelix_pvt' ? 0x120b1c4c : 0x120a7c40;
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, main);
    state = output();
    if (state.stop || state.registers[15] === main) break;
  }
  if (state.stop || state.registers[15] !== main) throw new Error('SystemInit did not reach main');
  report.mainEntry = state;
  // Derived independently from the pinned SystemInit source and linker ranges.
  assert.equal(state.system.mpuControl, 7);
  assert.equal(state.system.ccr, 0x30200);
  assert.equal(state.system.cpacr, 0x00f0003f);
  assert.equal(state.system.shcsr, 0x10000);
  assert.deepEqual(state.system.mair, [0x4422, 0]);
  assert.deepEqual(state.system.mpuRegions, [
    [0x12000006, 0x13ffffe1],
    [0x40000001, 0x5fffffe5],
    [0x20000004, 0x20004503],
    [0x203fc000, 0x204fffe3],
    [0x2007fc01, 0x2007ffe3],
    ...Array.from({ length: 7 }, () => [0, 0]),
  ]);
  // Both pinned ELFs locate HAL_RCC_Reset_and_Halt_LCPU in shared ramfunc.
  // Reaching it requires the real crystal switch and 230us + 30us DWT waits.
  const resetLcpu = 0x200025e8;
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, resetLcpu);
    state = output();
    if (state.stop || state.registers[15] === resetLcpu) break;
  }
  assert.equal(state.stop, null);
  assert.equal(state.registers[15], resetLcpu);
  assert.equal(state.clock.hxtReady, true);
  assert.equal(state.clock.timingVerified, false);
  assert.ok(
    state.clock.estimatedCoreCycles - report.mainEntry.clock.estimatedCoreCycles >= 48 * 260,
  );
  report.clockStartup = state;
  report.outcome = 'lcpu-reset-sequence-matched';
  // Continue without inventing the hardware state to identify the next blocker.
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, 0);
    state = output();
    if (state.stop) break;
  }
  report.hardwareBoundary = state;
  assert.equal(state.lcpuReset.cpuWait, true);
  assert.equal(state.lcpuReset.assertedMask, 0);
  assert.equal(state.lcpuReset.assertions, 1);
  assert.equal(state.lcpuReset.releases, 1);
  assert.equal(state.factoryData.loadedBankMask, 0);
  assert.equal(state.stop?.kind, 'MissingFactoryCalibration');
  assert.equal(state.stop.address, 0x5000c000);
  if (!state.stop)
    throw new Error('Instruction budget exhausted before a classified hardware boundary');
  // Separate synthetic fixture: tests transport of bank bytes through the real
  // firmware HAL into conf_sys. This is NOT factory calibration or a boot claim.
  const again = e.sifli_input(image.length);
  new Uint8Array(e.memory.buffer, again, image.length).set(image);
  assert.equal(e.sifli_load(revision === 'obelix_pvt' ? 0 : 1), 1);
  const fixture = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
  new Uint8Array(e.memory.buffer, e.sifli_efuse_input(), 32).set(fixture);
  assert.equal(e.sifli_load_efuse_bank(1), 1);
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, 0);
    state = output();
    if (state.stop) break;
  }
  assert.equal(state.factoryData.readsCompleted, 1);
  // Pinned ELF local conf_sys symbols; compare every copied byte.
  const destination = revision === 'obelix_pvt' ? 0x20026678 : 0x2001c538;
  const visible = Uint8Array.from({ length: 32 }, (_, i) => {
    const b = e.sifli_read_cpu_byte(destination + i) >>> 0;
    assert.ok(b <= 255);
    return b;
  });
  assert.deepEqual(visible, fixture);
  assert.equal(state.stop?.address, 0x5000b004); // unknown chip identity remains explicit
  report.syntheticEfuse = {
    source: 'synthetic-controller-test-only',
    bytesMatched: 32,
    destination,
    fixtureSha256: sha(fixture),
    state,
    physicalCalibrationVerified: false,
  };
  // Numeric-series identity is deliberately synthetic. It exercises the HAL
  // trim path, not the identity or calibrated voltage of either target watch.
  const third = e.sifli_input(image.length);
  new Uint8Array(e.memory.buffer, third, image.length).set(image);
  assert.equal(e.sifli_load(revision === 'obelix_pvt' ? 0 : 1), 1);
  new Uint8Array(e.memory.buffer, e.sifli_efuse_input(), 32).set(fixture);
  assert.equal(e.sifli_load_efuse_bank(1), 1);
  assert.equal(e.sifli_set_chip_id(0), 1);
  for (let i = 0; i < 100; i++) {
    e.sifli_run(100000, 0);
    state = output();
    if (state.stop) break;
  }
  // Independently decoded from pinned BSP_CONFIG_get bank1 byte fields.
  assert.equal(state.calibration.lpVout, fixture[1] & 15);
  assert.equal(state.calibration.vret, (0x20 << 16) | ((fixture[1] >> 4) << 10) | (7 << 2) | 1);
  assert.equal(
    state.calibration.aonBg,
    (3 << 3) | ((fixture[3] >> 4) & 7) | ((fixture[3] & 128) >> 2),
  );
  assert.equal(
    state.calibration.periLdo,
    ((fixture[2] >> 4) << 9) | ((fixture[3] & 15) << 17) | ((fixture[2] & 15) << 1),
  );
  assert.equal(state.calibration.hpVout, 11); // EFUSE read restored supply setting
  assert.equal(state.stop?.address, 0x50042018);
  assert.equal(state.stop.kind, 'MissingNorState'); // no fabricated flash identity
  report.syntheticTrim = {
    source: 'synthetic-controller-test-only',
    state,
    registersMatched: true,
    physicalCalibrationVerified: false,
  };
  // Fourth fixture: explicit W25Q128JV, three distinct synthetic OTP pages.
  // FF terminates the optional settings list; remaining bytes test exact copying.
  const reload = () => {
    const p = e.sifli_input(image.length);
    new Uint8Array(e.memory.buffer, p, image.length).set(image);
    assert.equal(e.sifli_load(revision === 'obelix_pvt' ? 0 : 1), 1);
    new Uint8Array(e.memory.buffer, e.sifli_efuse_input(), 32).set(fixture);
    assert.equal(e.sifli_load_efuse_bank(1), 1);
    assert.equal(e.sifli_set_chip_id(0), 1);
    assert.equal(e.sifli_configure_nor(0xef4018, 0, 0), 1);
  };
  const until = (pc = 0) => {
    for (let i = 0; i < 100; i++) {
      e.sifli_run(100000, pc);
      state = output();
      if (state.stop || state.registers[15] === pc) return state;
    }
    throw new Error('NOR phase exhausted instruction budget');
  };
  reload();
  until();
  assert.equal(state.stop?.kind, 'MissingFlashOtp');
  assert.equal(state.nor.otpBytesRead, 0);
  report.missingOtp = { rejected: true, state };
  reload();
  const pages = [1, 2, 3].map((n) =>
    Uint8Array.from({ length: 256 }, (_, i) => (i === 0 ? 255 : (n * 53 + i) & 255)),
  );
  for (let i = 0; i < 3; i++) {
    new Uint8Array(e.memory.buffer, e.sifli_otp_input(), 256).set(pages[i]);
    assert.equal(e.sifli_load_otp(i + 1), 1);
  }
  until(0x200019ee); // pinned HAL_QSPI_READ_OTP entry before first system-page read
  assert.equal(state.stop, null);
  assert.equal(state.registers[1], 0x1000);
  assert.equal(state.registers[3], 32);
  const systemBuffer = state.registers[2];
  until(0x20002f7c); // pinned HAL_HPAON_StartGTimer, after BSP_System_Config returns
  assert.equal(state.stop, null);
  assert.equal(state.nor.otpBytesRead, 544);
  assert.equal(state.nor.commandsCompleted, 14);
  const destinations = [
    systemBuffer,
    revision === 'obelix_pvt' ? 0x20026798 : 0x2001c658,
    revision === 'obelix_pvt' ? 0x20026698 : 0x2001c558,
  ];
  const copies = destinations.map((destination, i) => {
    const length = i === 0 ? 32 : 256;
    const actual = Uint8Array.from({ length }, (_, j) => {
      const b = e.sifli_read_cpu_byte(destination + j) >>> 0;
      assert.ok(b <= 255);
      return b;
    });
    assert.deepEqual(actual, pages[i].subarray(0, length));
    return { page: i + 1, destination, bytesMatched: length, sha256: sha(actual) };
  });
  const boardConfigComplete = state;
  until();
  assert.equal(state.stop?.address, 0x50084000); // USART1 begins application peripheral setup
  assert.equal(state.stop?.kind, 'UnmodeledMmio');
  assert.deepEqual(state.globalTimer.enabled, [true, true]);
  assert.equal(state.globalTimer.synchronizations, 1);
  assert.equal(state.pmucClock.rc32Ready, true);
  assert.equal(state.pmucClock.lowPowerHz, 32000);
  assert.equal(state.lpsysClock.peripheralSource, 'hxt48');
  assert.equal(state.hrcCalibration.measurementsCompleted, 1, 'HRC measurement count');
  assert.equal(state.dll.dll1Ready, true);
  assert.equal(state.dll.locksCompleted, 1, 'DLL lock count');
  assert.equal(state.sipPins.analogTransitions, 13);
  assert.equal(state.wakeupSources.enabledMask, 0xc6);
  assert.equal(state.watchdog.active, true);
  assert.equal(state.watchdog.starts, 1, 'watchdog start count');
  assert.equal(state.watchdog.stops, 2, 'watchdog stop count');
  report.syntheticNor = {
    source: 'synthetic-controller-test-only',
    profile: 'W25Q128JV',
    copies,
    boardConfigComplete,
    nextBoundary: state,
    physicalCalibrationVerified: false,
  };
  report.outcome = 'physical-early-init-reached-usart1';
  report.limits = [
    'No verified bootloader handoff state; LCPU controls assume an active domain awaiting reset',
    'No factory calibration supplied; synthetic bank transfer is not hardware calibration',
    'No physical reference or calibrated timing',
    'Limited architectural registers, MPU, functional caches and early boot register model',
    'HXT settling defaults to an assumed 48000 reference ticks; DWT uses estimated engine cycles',
    'LCPU power-active POR status is not evidence of a running Bluetooth controller',
    'Bounded early clocks, PMU, watchdog, pin and wake controls only; no complete SiFli peripheral, ROM, LCPU or coprocessor model',
    'Cache replacement and allocation flags are model assumptions, not silicon measurements',
    'No full firmware boot, display, installation or phone exchange',
  ];
} catch (error) {
  report.error = error.message;
  if (report.identity) report.outcome = 'failed';
  process.exitCode = report.outcome === 'not-run' ? 2 : 1;
}
const json = JSON.stringify(report, null, 2) + '\n';
if (reportPath) await writeFile(reportPath, json);
else process.stdout.write(json);
