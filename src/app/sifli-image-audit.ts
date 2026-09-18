/** Read-only inspection for SF32LB52J production payloads. This never boots a guest. */
export type SifliRevision = 'obelix_pvt' | 'getafix_dvt2';

export interface SifliSegment {
  virtualAddress: number;
  physicalAddress: number;
  fileOffset: number;
  fileBytes: number;
  memoryBytes: number;
  flags: number;
  category: 'flash' | 'ram-initializer' | 'zero-initialized-ram';
}

export interface SifliImageAudit {
  format: 'pebble-sifli-image-audit';
  version: 1;
  boardRevision: SifliRevision;
  loadable: false;
  flashBase: number;
  vectorAddress: number;
  initialStackPointer: number;
  resetHandler: number;
  elfEntry: number;
  binBytes: number;
  segments: SifliSegment[];
  copiedRamBytes: number;
  zeroInitializedRamBytes: number;
  missingBootState: readonly string[];
}

export interface SifliResetStartup {
  pattern: 'sf32lb52x-slot0-reset-v1';
  resetHandler: number;
  initialStackPointer: number;
  mainStackLimit: number;
  copies: { source: number; destination: number; bytes: number }[];
  zeroFill: { destination: number; bytes: number };
  ramSegmentsNotClearedByReset: { destination: number; bytes: number }[];
  postMainAssertionHash: number;
  postBootloaderStateKnown: false;
}

const FLASH_BASE = 0x12020000; // QSPI2 image origin for the audited slot-0 builds.
const VECTOR = 0x12021000;
const RAM_BASE = 0x20000000;
const RAM_END = 0x20080000;
const MAX_IMAGE = 64 * 1024 * 1024;

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error('SiFli image audit: ' + message);
}

/** Confirms the ELF load image is byte-identical to its raw slot-0 image.
 * Virtual addresses describe execution, physical addresses describe stored
 * bytes. RAM initializer copying, BSS setup, caches, ROM and controllers are
 * deliberately outside this read-only check.
 */
export function auditSifliImage(
  revision: SifliRevision,
  elf: Uint8Array,
  image: Uint8Array,
): SifliImageAudit {
  check(revision === 'obelix_pvt' || revision === 'getafix_dvt2', 'unsupported board revision');
  check(elf.byteLength >= 52 && elf.byteLength <= MAX_IMAGE, 'invalid ELF size');
  check(image.byteLength >= 0x1008 && image.byteLength <= MAX_IMAGE, 'invalid slot image size');
  const v = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  check(
    v.getUint32(0, false) === 0x7f454c46 && elf[4] === 1 && elf[5] === 1,
    'expected little-endian ELF32',
  );
  check(v.getUint16(16, true) === 2 && v.getUint16(18, true) === 40, 'expected ARM executable');
  check(v.getUint32(20, true) === 1, 'invalid ELF version');
  const entry = v.getUint32(24, true);
  const phoff = v.getUint32(28, true);
  const entsize = v.getUint16(42, true);
  const count = v.getUint16(44, true);
  check(entsize === 32 && count > 0 && count <= 256, 'invalid program header table');
  check(phoff >= 52 && phoff + entsize * count <= elf.byteLength, 'truncated program header table');
  const segments: SifliSegment[] = [];
  const flashRanges: [number, number][] = [];
  const executionRanges: [number, number][] = [];
  let vectorCovered = false;
  for (let i = 0; i < count; i++) {
    const at = phoff + i * entsize;
    if (v.getUint32(at, true) !== 1) continue; // PT_LOAD only.
    const offset = v.getUint32(at + 4, true);
    const virtualAddress = v.getUint32(at + 8, true);
    const physicalAddress = v.getUint32(at + 12, true);
    const fileBytes = v.getUint32(at + 16, true);
    const memoryBytes = v.getUint32(at + 20, true);
    const flags = v.getUint32(at + 24, true);
    check(memoryBytes >= fileBytes && memoryBytes > 0, 'invalid PT_LOAD sizes');
    const inRam = virtualAddress >= RAM_BASE && virtualAddress + memoryBytes <= RAM_END;
    const inFlash =
      virtualAddress >= FLASH_BASE && virtualAddress + memoryBytes <= FLASH_BASE + MAX_IMAGE;
    check(inRam || inFlash, 'segment executes outside audited flash/RAM ranges');
    for (const [start, end] of executionRanges)
      check(
        virtualAddress >= end || virtualAddress + memoryBytes <= start,
        'overlapping execution segments',
      );
    executionRanges.push([virtualAddress, virtualAddress + memoryBytes]);
    check(offset + fileBytes <= elf.byteLength, 'truncated PT_LOAD data');
    if (fileBytes) {
      check(physicalAddress >= FLASH_BASE, 'initializer is not stored in audited flash');
      const imageOffset = physicalAddress - FLASH_BASE;
      check(imageOffset + fileBytes <= image.byteLength, 'segment exceeds raw slot image');
      for (const [start, end] of flashRanges)
        check(
          imageOffset >= end || imageOffset + fileBytes <= start,
          'overlapping stored segments',
        );
      flashRanges.push([imageOffset, imageOffset + fileBytes]);
      for (let j = 0; j < fileBytes; j++)
        check(elf[offset + j] === image[imageOffset + j], 'ELF/raw slot bytes differ');
      if (virtualAddress <= VECTOR && virtualAddress + fileBytes >= VECTOR + 8)
        vectorCovered = true;
    }
    segments.push({
      virtualAddress,
      physicalAddress,
      fileOffset: offset,
      fileBytes,
      memoryBytes,
      flags,
      category: inRam ? (fileBytes ? 'ram-initializer' : 'zero-initialized-ram') : 'flash',
    });
  }
  check(vectorCovered, 'no load segment contains the HCPU vector table');
  check(segments.length > 0, 'no load segments');
  const vectorOffset = VECTOR - FLASH_BASE;
  const raw = new DataView(image.buffer, image.byteOffset + vectorOffset, 8);
  const sp = raw.getUint32(0, true);
  const reset = raw.getUint32(4, true);
  check(sp >= RAM_BASE && sp <= RAM_END && (sp & 7) === 0, 'initial stack pointer is invalid');
  check((reset & 1) !== 0, 'reset vector is not Thumb');
  check(
    segments.some(
      (s) =>
        s.virtualAddress <= (reset & ~1) &&
        s.virtualAddress + s.memoryBytes > (reset & ~1) &&
        (s.flags & 1) !== 0,
    ),
    'reset handler is outside executable load segments',
  );
  // The ELF entry is metadata and is not substituted for the reset vector.
  return {
    format: 'pebble-sifli-image-audit',
    version: 1,
    boardRevision: revision,
    loadable: false,
    flashBase: FLASH_BASE,
    vectorAddress: VECTOR,
    initialStackPointer: sp,
    resetHandler: reset,
    elfEntry: entry,
    binBytes: image.byteLength,
    segments,
    copiedRamBytes: segments
      .filter((s) => s.category === 'ram-initializer')
      .reduce((n, s) => n + s.fileBytes, 0),
    zeroInitializedRamBytes: segments
      .filter((s) => s.category === 'zero-initialized-ram')
      .reduce((n, s) => n + s.memoryBytes, 0),
    missingBootState: [
      'verified post-bootloader CPU registers and SRAM',
      'clock, flash-controller and cache state',
      'SiFli ROM and LCPU/controller dependencies',
      'board-specific peripheral behavior',
    ],
  };
}

/** Recognizes the reset prologue in the audited 4.37.0 SF32LB52J slot images.
 * An unknown prologue is left unknown; it is never treated as equivalent.
 * This describes bytes and initializer ranges, not a bootable CPU state.
 */
export function inspectSifliResetStartup(
  audit: SifliImageAudit,
  image: Uint8Array,
): SifliResetStartup | null {
  const reset = audit.resetHandler & ~1;
  const offset = reset - FLASH_BASE;
  if (offset < 0 || offset + 128 > image.byteLength) return null;
  const prologue = Uint8Array.from(
    '15 4b 83 f3 0a 88 00 23 83 f3 0b 88 13 49 14 4a 14 48 52 1a 9a 42 13 dc 00 23 13 49 13 4a 14 48 52 1a 9a 42 12 dc 13 48 13 4a 00 21 12 1a'
      .split(' ')
      .map((x) => parseInt(x, 16)),
  );
  const copyLoops = Uint8Array.from(
    '10 f8 01 4b 01 33 01 f8 01 4b e3 e7 10 f8 01 4b 01 33 01 f8 01 4b e4 e7'
      .split(' ')
      .map((x) => parseInt(x, 16)),
  );
  // The branch encodings pin memset, SystemInit, main, and the assertion
  // reached only if main returns in these exact published payloads.
  const callSequence = Uint8Array.from(
    (audit.boardRevision === 'obelix_pvt'
      ? 'e3 f7 af f9 ce f0 17 fb 6b f0 2d f8 10 48 51 f0 68 f8'
      : 'e9 f7 0d f8 bf f0 53 ff 66 f0 a3 fe 10 48 4d f0 72 f9')
      .split(' ')
      .map((x) => parseInt(x, 16)),
  );
  if (
    prologue.some((b, i) => image[offset + i] !== b) ||
    callSequence.some((b, i) => image[offset + 46 + i] !== b) ||
    copyLoops.some((b, i) => image[offset + 64 + i] !== b)
  )
    return null;
  const word = (at: number) =>
    new DataView(image.buffer, image.byteOffset + offset + at, 4).getUint32(0, true);
  const [mainStackLimit, dataStart, dataEnd, dataSource, codeStart, codeEnd, codeSource, bssStart,
    bssEnd, postMainAssertionHash] = Array.from({ length: 10 }, (_, i) => word(88 + i * 4));
  const copies = [
    { source: dataSource, destination: dataStart, bytes: dataEnd - dataStart },
    { source: codeSource, destination: codeStart, bytes: codeEnd - codeStart },
  ];
  const initializerSegments = audit.segments.filter((s) => s.category === 'ram-initializer');
  const zeroSegments = audit.segments.filter((s) => s.category === 'zero-initialized-ram');
  const matchesCopy = ({ source, destination, bytes }: (typeof copies)[number]) =>
    bytes > 0 &&
    initializerSegments.some(
      (s) =>
        s.physicalAddress === source && s.virtualAddress === destination && s.fileBytes === bytes,
    );
  const clearedSegments = zeroSegments.filter(
    (s) => s.virtualAddress >= bssStart && s.virtualAddress + s.memoryBytes <= bssEnd,
  );
  if (
    copies.length !== initializerSegments.length ||
    !copies.every(matchesCopy) ||
    bssStart !== dataEnd ||
    bssEnd < bssStart ||
    clearedSegments.reduce((n, s) => n + s.memoryBytes, 0) !== bssEnd - bssStart ||
    zeroSegments.some(
      (s) => s.virtualAddress < bssEnd && s.virtualAddress + s.memoryBytes > bssEnd,
    ) ||
    mainStackLimit < bssEnd ||
    mainStackLimit >= audit.initialStackPointer ||
    postMainAssertionHash !== 0x2a57
  )
    return null;
  return {
    pattern: 'sf32lb52x-slot0-reset-v1',
    resetHandler: audit.resetHandler,
    initialStackPointer: audit.initialStackPointer,
    mainStackLimit,
    copies,
    zeroFill: { destination: bssStart, bytes: bssEnd - bssStart },
    ramSegmentsNotClearedByReset: zeroSegments
      .filter((s) => !clearedSegments.includes(s))
      .map((s) => ({ destination: s.virtualAddress, bytes: s.memoryBytes })),
    postMainAssertionHash,
    postBootloaderStateKnown: false,
  };
}
