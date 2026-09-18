import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFidelityRun,
  compareFidelityRuns,
  canonicalJson,
  decodeCoreTrace,
} from '../src/app/fidelity-evidence.ts';
const h = 'a'.repeat(64);
function run() {
  return {
    format: 'pebble-fidelity-run',
    version: 1,
    identity: {
      board: 'qemu_emery',
      revision: 'generic',
      firmwareVersion: '4.37.0',
      firmware: { micro: h, spi: h },
      appSha256: h,
      scenarioSha256: h,
      seed: 1,
      initialState: 'cold boot; fixed RTC',
    },
    implementation: { name: 'native QEMU', version: 'pinned', sha256: h },
    referenceTarget: 'native-qemu',
    captureMethod: 'committed frames',
    outcome: 'passed',
    complete: true,
    droppedEvents: 0,
    observations: [
      { checkpoint: 'boot', virtualUs: 100, values: { frame: h, connected: true } },
      { checkpoint: 'touch', virtualUs: 200, values: { frame: h } },
    ],
  };
}
test('comparison checks identities and first observable divergence, independent of key order', () => {
  const a = run(),
    b = run();
  b.identity.firmware = { spi: h, micro: h };
  assert.equal(compareFidelityRuns(a, b).outcome, 'match');
  b.observations[1].values.frame = 'b'.repeat(64);
  assert.deepEqual(compareFidelityRuns(a, b), {
    outcome: 'mismatch',
    checkpoint: 'touch',
    field: 'frame',
    reference: h,
    candidate: 'b'.repeat(64),
  });
  b.identity.seed = 2;
  assert.equal(compareFidelityRuns(a, b).outcome, 'not-comparable');
  assert.throws(() => canonicalJson({ value: NaN }));
});
test('timing requires a declared tolerance and actual virtual timestamps', () => {
  const a = run(),
    b = run();
  b.observations[1].virtualUs += 10;
  assert.equal(compareFidelityRuns(a, b).timingCompared, false);
  assert.equal(compareFidelityRuns(a, b, 10).outcome, 'match');
  assert.equal(compareFidelityRuns(a, b, 9).field, 'virtualUs');
  b.observations[0].virtualUs = null;
  assert.equal(compareFidelityRuns(a, b, 10).outcome, 'not-comparable');
  assert.throws(() => compareFidelityRuns(a, b, NaN));
});
test('missing observations and changed shape cannot pass', () => {
  const a = run(),
    b = run();
  b.observations.pop();
  assert.equal(compareFidelityRuns(a, b).field, 'checkpoint');
  b.observations[0].values.extra = null;
  assert.equal(compareFidelityRuns(a, b).field, 'extra');
});
test('empty, truncated, failed, and unavailable captures cannot be promoted to passing evidence', () => {
  for (const change of [
    { observations: [] },
    { droppedEvents: 1 },
    { complete: false },
    { outcome: 'failed' },
    { outcome: 'not-run' },
  ])
    assert.throws(() => validateFidelityRun({ ...run(), ...change }));
  const absent = {
    ...run(),
    outcome: 'not-run',
    complete: false,
    observations: [],
    reason: 'No physical watch available.',
  };
  assert.equal(validateFidelityRun(absent).outcome, 'not-run');
  assert.equal(compareFidelityRuns(run(), absent).outcome, 'not-comparable');
  for (const modify of [
    (r) => (r.identity.appSha256 = 'bad'),
    (r) => (r.observations[1].checkpoint = 'boot'),
    (r) => (r.observations[1].virtualUs = 0),
    (r) => (r.observations[0].values.x = Infinity),
  ]) {
    const r = run();
    modify(r);
    assert.throws(() => validateFidelityRun(r));
  }
});
test('trace decoding preserves high time words and separates estimates from MMIO samples', () => {
  const b = new Uint8Array(80),
    v = new DataView(b.buffer);
  [1, 10, 1, 256, 0x40000000, 69, 4, 0, 0, 0, 3, 20, 1, 260, 264, 0x100000f, 0, 8, 45, 0].forEach(
    (x, i) => v.setUint32(i * 4, x, true),
  );
  const records = decodeCoreTrace(b, 1);
  assert.equal(records[0].ticks, 4294967306);
  assert.equal(records[0].estimatedCpuCycles, null);
  assert.equal(records[1].estimatedCpuCycles, 45);
  assert.equal(records[1].kind, 'exception');
  assert.throws(() => decodeCoreTrace(b, 2));
  assert.throws(() => decodeCoreTrace(b.subarray(0, 79), 1));
  v.setUint32(8, 0xffffffff, true);
  assert.throws(() => decodeCoreTrace(b, 1));
});
