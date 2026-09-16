import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import {
  stm32crc,
  parseElf,
  flattenElf,
  emptyResourcePack,
  injectMetadata,
  storedZip,
  packagePbw,
} from '../public/compiler/portable-pbw.mjs';
import {
  normalizePackage,
  generateAppinfoC,
  buildPebbleApp,
} from '../public/compiler/portable-builder.mjs';
const enc = new TextEncoder();
const pkg = {
  name: 'format-fixture',
  author: 'Test author',
  version: '1.2.3',
  pebble: {
    displayName: 'Format fixture',
    uuid: '00000000-0000-4000-8000-000000000001',
    sdkVersion: '3',
    projectType: 'native',
    targetPlatforms: ['emery'],
    watchapp: { watchface: true },
    messageKeys: { status: 0 },
    resources: { media: [] },
  },
};
// Synthetic ELF only: no SDK bytes or third-party app code are included.
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
test('STM32 CRC agrees with SDK golden vectors, including non-word tails', () => {
  assert.equal(stm32crc(enc.encode('123456789')), 0xaff19057);
  assert.equal(stm32crc(new Uint8Array()), 0xffffffff);
  assert.equal(stm32crc(Uint8Array.of(0xfe, 0xff, 0xfe, 0xff, 0x88)), 0x495e02ca);
});
test('empty resource pack preserves exact SDK4.33.1 output', () => {
  const pack = emptyResourcePack();
  assert.equal(pack.length, 4092);
  assert.equal(new DataView(pack.buffer).getUint32(4, true), 0xffffffff);
  assert(pack.subarray(8).every((x) => x === 0));
  assert(pack.subarray(0, 4).every((x) => x === 0));
  assert.equal(
    createHash('sha256').update(pack).digest('hex'),
    'b58d8f0fc04367f823045aafa7724dee47b1fe6674411d117e32909b3f527a31',
  );
});
test('ELF packaging clears Thumb selector and appends absolute pointer relocation', () => {
  const parsed = parseElf(fixtureElf()),
    raw = flattenElf(parsed);
  assert.equal(raw.length, 148);
  assert.equal(raw[0x8c], 0x84);
  const result = injectMetadata(parsed, raw, emptyResourcePack(), 1700000000, true),
    v = new DataView(result.binary.buffer);
  assert.equal(result.loadSize, 148);
  assert.equal(result.virtualSize, 164);
  assert.equal(result.entry, 0x84);
  assert.deepEqual(result.relocations, [0x8c]);
  assert.equal(result.binary.length, 152);
  assert.equal(v.getUint16(0x0e, true), 148);
  assert.equal(v.getUint32(0x5c, true), 0x90);
  assert.equal(v.getUint32(0x60, true), 329);
  assert.equal(v.getUint32(0x64, true), 1);
  assert.equal(v.getUint32(0x78, true), 0xffffffff);
  assert.equal(v.getUint32(0x7c, true), 1700000000);
  assert.equal(v.getUint16(0x80, true), 164);
  assert.equal(v.getUint32(148, true), 0x8c);
  assert.equal(v.getUint32(0x14, true), 0xbd78fb28);
  assert.equal(
    createHash('sha256').update(result.binary).digest('hex'),
    'fb237566c00411b6d05168ab0ce634f4b4fbdc0f4593f90ec0c80e5027d341d9',
  );
});
test('PBW has readable ZIP entries, platform manifest and companion source', () => {
  const result = packagePbw({
      elf: fixtureElf(),
      appinfo: { shortName: 'Format fixture' },
      js: 'void 0;',
      timestamp: 1700000000,
    }),
    files = unzipSync(result.pbw);
  assert.deepEqual(Object.keys(files).sort(), [
    'appinfo.json',
    'emery/app_resources.pbpack',
    'emery/manifest.json',
    'emery/pebble-app.bin',
    'pebble-js-app.js',
  ]);
  const m = JSON.parse(new TextDecoder().decode(files['emery/manifest.json']));
  assert.equal(m.manifestVersion, 2);
  assert.deepEqual(m.application.sdk_version, { major: 5, minor: 106 });
  assert.equal(m.application.size, 152);
  assert.equal(m.application.crc, 0x225a7b62);
  assert.equal(m.resources.size, 4092);
  assert.equal(m.resources.crc, 0xf0d1b123);
  assert.deepEqual(files['emery/pebble-app.bin'], result.metadata.binary);
  assert.deepEqual(
    unzipSync(storedZip({ 'hello.txt': enc.encode('hello') }))['hello.txt'],
    enc.encode('hello'),
  );
});
test('malformed ELF and missing app entry are rejected', () => {
  assert.throws(() => parseElf(new Uint8Array(52)), /ELF32 ARM/);
  const invalid = fixtureElf();
  new DataView(invalid.buffer).setUint32(32, invalid.length, true);
  assert.throws(() => parseElf(invalid), /section table/);
  const parsed = parseElf(fixtureElf());
  parsed.symbols.delete('main');
  assert.throws(
    () => injectMetadata(parsed, flattenElf(parsed), emptyResourcePack(), 0, false),
    /entry/,
  );
});
test('metadata rejects unsupported features and escapes C strings', () => {
  assert.equal(normalizePackage(pkg).companyName, 'Test author');
  for (const [mutate, pattern] of [
    [(p) => (p.dependencies = { example: '1.0.0' }), /dependencies/],
    [
      (p) => (p.pebble.resources.media = [{ name: 'IMAGE', type: 'bitmap', file: 'x.png' }]),
      /resources/,
    ],
    [(p) => (p.author = 'x'.repeat(32)), /31 UTF-8/],
    [(p) => (p.pebble.messageKeys = ['status']), /numbered/],
    [(p) => (p.pebble.uuid = 'bad'), /UUID/],
    [(p) => (p.pebble.targetPlatforms = ['basalt']), /emery/],
  ]) {
    const value = structuredClone(pkg);
    mutate(value);
    assert.throws(() => normalizePackage(value), pattern);
  }
  const escaped = generateAppinfoC(normalizePackage({ ...pkg, author: 'A"\\\n' }));
  assert(escaped.includes('\\101\\042\\134\\012'));
  assert(escaped.includes('PROCESS_INFO_WATCH_FACE'));
});
test('unsupported Waf, JS modules and SDK fail before executing compiler', async () => {
  const sourceFiles = {
      'package.json': enc.encode(JSON.stringify(pkg)),
      'src/c/main.c': enc.encode('int main(void){return 0;}'),
    },
    session = {
      writeFile() {
        assert.fail('compiler must not run');
      },
      run() {
        assert.fail('compiler must not run');
      },
      readFile() {
        assert.fail('compiler must not run');
      },
    };
  await assert.rejects(
    buildPebbleApp({
      sourceFiles: {
        ...sourceFiles,
        wscript: enc.encode('import subprocess\nsubprocess.run(["untrusted"])'),
      },
      sdkFiles: {},
      session,
    }),
    /Custom wscript/,
  );
  await assert.rejects(
    buildPebbleApp({
      sourceFiles: {
        ...sourceFiles,
        'src/pkjs/index.js': enc.encode('void 0;'),
        'src/pkjs/extra.js': enc.encode('void 0;'),
      },
      sdkFiles: {},
      session,
    }),
    /one PebbleKit JS/,
  );
  await assert.rejects(
    buildPebbleApp({
      sourceFiles,
      sdkFiles: { 'manifest.json': enc.encode('{"version":"different"}') },
      session,
    }),
    /4.33.1/,
  );
});
