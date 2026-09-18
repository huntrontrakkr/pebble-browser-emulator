import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { auditSifliImage, inspectSifliResetStartup } from '../src/app/sifli-image-audit.ts';

const FLASH = 0x12020000;
const VECTOR = 0x12021000;

function fixture() {
  const elf = new Uint8Array(0x300);
  const bin = new Uint8Array(0x1200);
  const h = new DataView(elf.buffer);
  const b = new DataView(bin.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  h.setUint16(16, 2, true); // ET_EXEC
  h.setUint16(18, 40, true); // EM_ARM
  h.setUint32(20, 1, true);
  h.setUint32(24, VECTOR + 0x100, true); // Metadata, not reset state.
  h.setUint32(28, 52, true);
  h.setUint16(42, 32, true);
  h.setUint16(44, 2, true);
  const segment = (at, offset, address, bytes, flags) => {
    h.setUint32(at, 1, true);
    h.setUint32(at + 4, offset, true);
    h.setUint32(at + 8, address, true);
    h.setUint32(at + 12, address, true);
    h.setUint32(at + 16, bytes, true);
    h.setUint32(at + 20, bytes, true);
    h.setUint32(at + 24, flags, true);
  };
  segment(52, 0x100, VECTOR, 8, 4);
  segment(84, 0x200, VECTOR + 0x100, 4, 5);
  b.setUint32(0x1000, 0x20040000, true);
  b.setUint32(0x1004, VECTOR + 0x101, true);
  bin.set([0x00, 0xbf, 0x00, 0xbf], 0x1100);
  elf.set(bin.subarray(0x1000, 0x1008), 0x100);
  elf.set(bin.subarray(0x1100, 0x1104), 0x200);
  return { elf, bin };
}

test('audits a split vector/code image without mistaking ELF entry for reset', () => {
  const { elf, bin } = fixture();
  const report = auditSifliImage('obelix_pvt', elf, bin);
  assert.equal(report.loadable, false);
  assert.equal(report.flashBase, FLASH);
  assert.equal(report.initialStackPointer, 0x20040000);
  assert.equal(report.resetHandler, VECTOR + 0x101);
  assert.equal(report.elfEntry, VECTOR + 0x100);
  assert.equal(report.segments.length, 2);
  assert.equal(inspectSifliResetStartup(report, bin), null);
});

test('rejects payload mismatch, invalid vectors and incomplete load segments', () => {
  const { elf, bin } = fixture();
  bin[0x1100] ^= 1;
  assert.throws(() => auditSifliImage('obelix_pvt', elf, bin), /ELF\/raw slot bytes differ/);
  bin[0x1100] ^= 1;
  new DataView(elf.buffer).setUint32(0x104, VECTOR + 0x100, true);
  new DataView(bin.buffer).setUint32(0x1004, VECTOR + 0x100, true);
  assert.throws(() => auditSifliImage('obelix_pvt', elf, bin), /not Thumb/);
  new DataView(elf.buffer).setUint32(0x104, VECTOR + 0x101, true);
  new DataView(bin.buffer).setUint32(0x1004, VECTOR + 0x101, true);
  new DataView(elf.buffer).setUint32(84 + 16, 0x200, true);
  new DataView(elf.buffer).setUint32(84 + 20, 0x200, true);
  assert.throws(() => auditSifliImage('obelix_pvt', elf, bin), /truncated PT_LOAD data/);
});

test('rejects unsupported revision and overlap in virtual execution', () => {
  const { elf, bin } = fixture();
  assert.throws(() => auditSifliImage('qemu_emery', elf, bin), /unsupported board/);
  new DataView(elf.buffer).setUint32(84 + 8, VECTOR + 4, true);
  assert.throws(() => auditSifliImage('obelix_pvt', elf, bin), /overlapping execution segments/);
});

for (const [revision, expectedSp, expectedReset] of [
  ['obelix_pvt', 0x20034d40, 0x12046bb9],
  ['getafix_dvt2', 0x2002ec60, 0x12040ec1],
]) {
  test(`official ${revision} slot/ELF pair when locally available`, async (t) => {
    const prefix = `tmp/physical-audit/firmware_${revision}_v4.37.0_slot0`;
    let elf, bin;
    try {
      [elf, bin] = await Promise.all([readFile(prefix + '.elf'), readFile(prefix + '.bin')]);
    } catch {
      t.skip('optional official release artifacts are absent');
      return;
    }
    const report = auditSifliImage(revision, elf, bin);
    const evidence = JSON.parse(await readFile('docs/evidence/sifli-image-audit.json'));
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256(elf), evidence.boards[revision].elf.sha256);
    assert.equal(sha256(bin), evidence.boards[revision].bin.sha256);
    assert.equal(report.initialStackPointer, expectedSp);
    assert.equal(report.resetHandler, expectedReset);
    assert.equal(report.segments.length, 11);
    assert.equal(report.copiedRamBytes, evidence.boards[revision].ramInitializerBytes);
    assert.equal(report.zeroInitializedRamBytes, evidence.boards[revision].zeroInitializedRamBytes);
    assert.equal(report.loadable, false);
    const reset = inspectSifliResetStartup(report, bin);
    assert.equal(reset?.initialStackPointer, expectedSp);
    assert.equal(reset?.resetHandler, expectedReset);
    assert.equal(reset?.copies.length, 2);
    assert.equal(reset?.copies.reduce((n, copy) => n + copy.bytes, 0), report.copiedRamBytes);
    assert.equal(
      reset?.zeroFill.bytes + reset?.ramSegmentsNotClearedByReset.reduce((n, s) => n + s.bytes, 0),
      report.zeroInitializedRamBytes,
    );
    assert.equal(reset?.postBootloaderStateKnown, false);
    const changed = bin.slice();
    changed[(expectedReset & ~1) - FLASH + 46] ^= 1;
    assert.equal(inspectSifliResetStartup(report, changed), null);
  });
}
