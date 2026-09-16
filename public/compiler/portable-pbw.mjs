// SPDX-FileCopyrightText: 2024 Google LLC
// SPDX-License-Identifier: Apache-2.0
// SDK format/CRC behavior follows Apache-2.0 PebbleOS tools by Google LLC (2024).
// SDK 4.33.1 platform-specific native app packaging.
const text = new TextEncoder();
const read = new TextDecoder();
const cstring = (bytes, at) => {
  let end = at;
  while (end < bytes.length && bytes[end]) end++;
  return read.decode(bytes.subarray(at, end));
};
export function stm32crc(bytes) {
  let crc = 0xffffffff;
  const consume = (byte) => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc >>> 31 ? 0x04c11db7 : 0)) >>> 0;
  };
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    if (n === 4) for (let j = 3; j >= 0; j--) consume(bytes[i + j]);
    else {
      for (let j = 0; j < 4 - n; j++) consume(0);
      for (let j = 0; j < n; j++) consume(bytes[i + j]);
    }
  }
  return crc >>> 0;
}
export function parseElf(elf) {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (
    elf.length < 52 ||
    view.getUint32(0, false) !== 0x7f454c46 ||
    elf[4] !== 1 ||
    elf[5] !== 1 ||
    view.getUint16(18, true) !== 40
  )
    throw new Error('Expected little-endian ELF32 ARM');
  const start = view.getUint32(32, true),
    entrySize = view.getUint16(46, true),
    count = view.getUint16(48, true);
  if (entrySize !== 40 || start + count * entrySize > elf.length)
    throw new Error('Invalid ELF section table');
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * entrySize;
    const section = {
      nameOffset: view.getUint32(at, true),
      type: view.getUint32(at + 4, true),
      flags: view.getUint32(at + 8, true),
      address: view.getUint32(at + 12, true),
      offset: view.getUint32(at + 16, true),
      size: view.getUint32(at + 20, true),
      link: view.getUint32(at + 24, true),
      info: view.getUint32(at + 28, true),
      entrySize: view.getUint32(at + 36, true),
    };
    if (section.type !== 8 && section.offset + section.size > elf.length)
      throw new Error('ELF section is out of bounds');
    sections.push(section);
  }
  const names = sections[view.getUint16(50, true)];
  if (!names) throw new Error('ELF names missing');
  for (const s of sections) s.name = cstring(elf, names.offset + s.nameOffset);
  const symbols = new Map();
  for (const section of sections.filter((s) => s.type === 2)) {
    const strings = sections[section.link];
    if (!strings || section.entrySize !== 16) throw new Error('Invalid ELF symbols');
    for (let at = section.offset; at < section.offset + section.size; at += section.entrySize) {
      const name = cstring(elf, strings.offset + view.getUint32(at, true));
      symbols.set(name, {
        value: view.getUint32(at + 4, true),
        type: elf[at + 12] & 15,
        section: view.getUint16(at + 14, true),
      });
    }
  }
  return { elf, view, sections, symbols };
}
export function flattenElf(parsed) {
  const allocated = parsed.sections.filter((s) => s.flags & 2 && s.type !== 8 && s.size);
  const size = Math.max(...allocated.map((s) => s.address + s.size));
  if (!(size > 130 && size <= 65535)) throw new Error('Invalid Pebble load size');
  const raw = new Uint8Array(size);
  for (const section of allocated)
    raw.set(parsed.elf.subarray(section.offset, section.offset + section.size), section.address);
  return raw;
}
export function emptyResourcePack() {
  // Exact empty-pack output of SDK 4.33.1 ResourcePack.serialize_table().
  const pack = new Uint8Array(4092);
  new DataView(pack.buffer).setUint32(4, 0xffffffff, true);
  return pack;
}
export function injectMetadata(
  parsed,
  raw,
  resources,
  timestamp,
  hasJs,
  { maxAppMemory = 131072, maxAppBinary = 131072, hasWorker = false } = {},
) {
  const relocations = [];
  for (const section of parsed.sections) {
    if (section.name.startsWith('.rel.data') && section.type === 9) {
      if (section.entrySize !== 8) throw new Error('Invalid REL section');
      for (let at = section.offset; at < section.offset + section.size; at += 8)
        relocations.push(parsed.view.getUint32(at, true));
    }
    if (section.name === '.got')
      for (let at = section.address; at < section.address + section.size; at += 4)
        relocations.push(at);
  }
  for (const at of relocations)
    if (at + 4 > raw.length || at % 4) throw new Error('Invalid relocation target');
  const main = parsed.symbols.get('main'),
    table = parsed.symbols.get('pbl_table_addr');
  if (!main || !table || !main.section || !table.section)
    throw new Error('Missing app entry or API jump table');
  const bss =
    parsed.sections.find((s) => s.name === '.bss') ||
    parsed.sections.find((s) => s.name === '.data');
  const virtualSize = bss ? bss.address + bss.size : raw.length;
  if (
    virtualSize > Math.min(65535, maxAppMemory) ||
    raw.length + 4 * relocations.length > maxAppBinary
  )
    throw new Error('Pebble app exceeds process size fields');
  const out = new Uint8Array(raw.length + 4 * relocations.length);
  out.set(raw);
  const view = new DataView(out.buffer);
  if (cstring(out, 0) !== 'PBLAPP') throw new Error('Missing PBLAPP header');
  view.setUint16(0x0e, raw.length, true);
  // ARM nm prints a Thumb STT_FUNC without its instruction-set selector bit.
  view.setUint32(0x10, main.type === 2 ? main.value & ~1 : main.value, true);
  view.setUint32(0x14, stm32crc(raw.subarray(0x82)), true);
  view.setUint32(0x5c, table.value, true);
  view.setUint32(0x60, view.getUint32(0x60, true) | (hasJs ? 8 : 0) | (hasWorker ? 16 : 0), true);
  view.setUint32(0x64, relocations.length, true);
  if (resources && resources.length < 12) throw new Error('Invalid resource pack');
  view.setUint32(
    0x78,
    resources
      ? new DataView(resources.buffer, resources.byteOffset, resources.byteLength).getUint32(
          4,
          true,
        )
      : 0,
    true,
  );
  view.setUint32(0x7c, timestamp, true);
  view.setUint16(0x80, virtualSize, true);
  relocations.forEach((offset, i) => view.setUint32(raw.length + 4 * i, offset, true));
  return {
    binary: out,
    loadSize: raw.length,
    virtualSize,
    relocations,
    entry: view.getUint32(0x10, true),
  };
}
function zipcrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function storedZip(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [path, bytes] of Object.entries(files)) {
    const name = text.encode(path),
      crc = zipcrc(bytes);
    const header = new Uint8Array(30 + name.length),
      view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    const dir = new Uint8Array(46 + name.length),
      dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x800, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, bytes.length, true);
    dv.setUint32(24, bytes.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    local.push(header, bytes);
    central.push(dir);
    offset += header.length + bytes.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0),
    end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const chunk of [...local, ...central, end]) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
export function packagePbw({
  elf,
  appinfo,
  js,
  timestamp,
  platform = 'emery',
  resources = emptyResourcePack(),
  maxAppMemory,
  maxAppBinary,
  workerElf,
  maxWorkerMemory = 10240,
}) {
  const parsed = parseElf(elf),
    raw = flattenElf(parsed);
  const metadata = injectMetadata(parsed, raw, resources, timestamp, Boolean(js), {
    maxAppMemory,
    maxAppBinary,
    hasWorker: Boolean(workerElf),
  });
  const workerParsed = workerElf ? parseElf(workerElf) : null;
  const workerMetadata = workerParsed
    ? injectMetadata(workerParsed, flattenElf(workerParsed), null, timestamp, Boolean(js), {
        maxAppMemory: maxWorkerMemory,
        maxAppBinary,
        hasWorker: true,
      })
    : null;
  const binary = metadata.binary;
  const manifest = {
    manifestVersion: 2,
    generatedAt: timestamp,
    generatedBy: '',
    debug: {},
    application: {
      timestamp,
      sdk_version: { major: binary[10], minor: binary[11] },
      name: 'pebble-app.bin',
      size: binary.length,
      crc: stm32crc(binary),
    },
    resources: {
      name: 'app_resources.pbpack',
      timestamp,
      size: resources.length,
      crc: stm32crc(resources),
    },
    type: workerMetadata ? 'worker' : 'application',
    ...(workerMetadata
      ? {
          worker: {
            timestamp,
            sdk_version: { major: workerMetadata.binary[10], minor: workerMetadata.binary[11] },
            name: 'pebble-worker.bin',
            size: workerMetadata.binary.length,
            crc: stm32crc(workerMetadata.binary),
          },
        }
      : {}),
  };
  const files = {
    'appinfo.json': text.encode(JSON.stringify(appinfo)),
    ...(js ? { 'pebble-js-app.js': text.encode(js) } : {}),
    [`${platform}/pebble-app.bin`]: binary,
    [`${platform}/app_resources.pbpack`]: resources,
    ...(workerMetadata ? { [`${platform}/pebble-worker.bin`]: workerMetadata.binary } : {}),
    [`${platform}/manifest.json`]: text.encode(JSON.stringify(manifest)),
  };
  return {
    pbw: storedZip(files),
    files,
    metadata,
    manifest,
    elf,
    ...(workerMetadata ? { workerMetadata, workerElf } : {}),
  };
}
