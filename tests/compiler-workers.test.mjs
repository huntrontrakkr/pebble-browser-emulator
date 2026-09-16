import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packagePbw,
  stm32crc,
  injectMetadata,
  parseElf,
  flattenElf,
} from '../public/compiler/portable-pbw.mjs';
const enc = new TextEncoder();
function fixtureElf() {
  const header = new Uint8Array(130);
  header.set(enc.encode('PBLAPP'));
  header.set([0x12, 0, 5, 106, 1, 2], 8);
  new DataView(header.buffer).setUint32(0x60, 321, true);
  const strtab = enc.encode('\0main\0pbl_table_addr\0'),
    symtab = new Uint8Array(48),
    sv = new DataView(symtab.buffer);
  for (const [at, name, value, info, section] of [
    [16, 1, 0x85, 0x12, 2],
    [32, 6, 0x90, 0x11, 3],
  ]) {
    sv.setUint32(at, name, true);
    sv.setUint32(at + 4, value, true);
    symtab[at + 12] = info;
    sv.setUint16(at + 14, section, true);
  }
  const rel = new Uint8Array(8),
    rv = new DataView(rel.buffer);
  rv.setUint32(0, 0x8c, true);
  rv.setUint32(4, 0x102, true);
  const entries = [
    { name: '', type: 0, bytes: new Uint8Array() },
    { name: '.header', type: 1, flags: 2, address: 0, bytes: header },
    {
      name: '.text',
      type: 1,
      flags: 6,
      address: 0x84,
      bytes: Uint8Array.of(0, 0xbf, 0, 0xbf, 0, 0xbf, 0, 0xbf),
    },
    {
      name: '.data',
      type: 1,
      flags: 3,
      address: 0x8c,
      bytes: Uint8Array.of(0x84, 0, 0, 0, 0, 0, 0, 0),
    },
    { name: '.bss', type: 8, flags: 3, address: 0x94, size: 16, bytes: new Uint8Array() },
    { name: '.symtab', type: 2, link: 6, entrySize: 16, bytes: symtab },
    { name: '.strtab', type: 3, bytes: strtab },
    { name: '.rel.data', type: 9, link: 5, info: 3, entrySize: 8, bytes: rel },
    { name: '.shstrtab', type: 3, bytes: new Uint8Array() },
  ];
  let names = '';
  for (const entry of entries) {
    entry.nameOffset = names.length;
    names += entry.name + '\0';
  }
  entries[8].bytes = enc.encode(names);
  let offset = 52;
  for (const entry of entries) {
    entry.offset = offset;
    offset = (offset + entry.bytes.length + 3) & ~3;
  }
  const sectionOffset = offset;
  const bytes = new Uint8Array(sectionOffset + 40 * entries.length),
    v = new DataView(bytes.buffer);
  bytes.set([0x7f, 69, 76, 70, 1, 1, 1]);
  v.setUint16(16, 2, true);
  v.setUint16(18, 40, true);
  v.setUint32(20, 1, true);
  v.setUint32(24, 0x85, true);
  v.setUint32(32, sectionOffset, true);
  v.setUint16(40, 52, true);
  v.setUint16(46, 40, true);
  v.setUint16(48, entries.length, true);
  v.setUint16(50, 8, true);
  entries.forEach((e, i) => {
    bytes.set(e.bytes, e.offset);
    const at = sectionOffset + i * 40;
    for (const [pos, value] of [
      [0, e.nameOffset],
      [4, e.type],
      [8, e.flags ?? 0],
      [12, e.address ?? 0],
      [16, e.offset],
      [20, e.size ?? e.bytes.length],
      [24, e.link ?? 0],
      [28, e.info ?? 0],
      [32, 4],
      [36, e.entrySize ?? 0],
    ])
      v.setUint32(at + pos, value, true);
  });
  return bytes;
}
test('worker packaging marks both binaries and keeps worker resource CRC zero', () => {
  const result = packagePbw({
    elf: fixtureElf(),
    workerElf: fixtureElf(),
    appinfo: {},
    js: 'void 0;',
    timestamp: 1700000000,
    platform: 'flint',
  });
  assert.equal(result.manifest.type, 'worker');
  assert.equal(result.manifest.worker.name, 'pebble-worker.bin');
  assert.equal(result.manifest.worker.size, 152);
  assert.equal(result.manifest.worker.crc, stm32crc(result.workerMetadata.binary));
  for (const kind of ['app', 'worker'])
    assert.equal(
      new DataView(result.files[`flint/pebble-${kind}.bin`].buffer).getUint32(0x60, true),
      345,
    );
  assert.equal(new DataView(result.workerMetadata.binary.buffer).getUint32(0x78, true), 0);
  assert.equal(new DataView(result.metadata.binary.buffer).getUint32(0x78, true), 0xffffffff);
  assert.equal(result.files['flint/pebble-worker.bin'].length, 152);
});
test('worker memory limit enforced independently of application allowance', () => {
  assert.throws(
    () =>
      packagePbw({
        elf: fixtureElf(),
        workerElf: fixtureElf(),
        appinfo: {},
        timestamp: 0,
        maxWorkerMemory: 163,
      }),
    /exceeds/,
  );
  assert.doesNotThrow(() =>
    packagePbw({
      elf: fixtureElf(),
      workerElf: fixtureElf(),
      appinfo: {},
      timestamp: 0,
      maxWorkerMemory: 164,
    }),
  );
});
test('application without worker retains original type and flags', () => {
  const result = packagePbw({
    elf: fixtureElf(),
    appinfo: {},
    js: 'void 0;',
    timestamp: 1700000000,
  });
  assert.equal(result.manifest.type, 'application');
  assert.equal(result.manifest.worker, undefined);
  assert.equal(result.workerMetadata, undefined);
  assert.equal(new DataView(result.metadata.binary.buffer).getUint32(0x60, true), 329);
});
