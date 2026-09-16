const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
export interface ZipEntry {
  name: string;
  crc: number;
  size: number;
  compressed: number;
  offset: number;
  method: number;
}
/** Central directory + matching local headers, bounded ZIP32, with no links or encryption. */
export function zipDirectory(bytes: Uint8Array, limit: number): Map<string, ZipEntry> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (
      v.getUint32(p, true) === 0x06054b50 &&
      p + 22 + v.getUint16(p + 20, true) === bytes.length
    ) {
      end = p;
      break;
    }
  if (end < 0) throw new Error('ZIP is incomplete: end-of-directory record is missing.');
  const count = v.getUint16(end + 10, true),
    length = v.getUint32(end + 12, true),
    start = v.getUint32(end + 16, true);
  if (
    v.getUint16(end + 4, true) ||
    v.getUint16(end + 6, true) ||
    v.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    count > 4096 ||
    start + length !== end
  )
    throw new Error('Unsupported ZIP directory, disk layout, or entry count.');
  const entries = new Map<string, ZipEntry>(),
    ranges: { start: number; end: number }[] = [];
  let at = start,
    total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || v.getUint32(at, true) !== 0x02014b50)
      throw new Error('Malformed ZIP central directory.');
    const flags = v.getUint16(at + 8, true),
      method = v.getUint16(at + 10, true),
      nameSize = v.getUint16(at + 28, true),
      extra = v.getUint16(at + 30, true),
      comment = v.getUint16(at + 32, true),
      offset = v.getUint32(at + 42, true),
      size = v.getUint32(at + 24, true),
      compressed = v.getUint32(at + 20, true);
    if (
      at + 46 + nameSize + extra + comment > end ||
      offset + 30 > start ||
      v.getUint32(offset, true) !== 0x04034b50
    )
      throw new Error('ZIP entry points outside its archive.');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameSize);
    if (!(flags & 0x800) && nameBytes.some((b) => b > 127))
      throw new Error('ZIP filenames must use UTF-8 or ASCII.');
    const name = decoder.decode(nameBytes),
      localNameSize = v.getUint16(offset + 26, true),
      dataStart = offset + 30 + localNameSize + v.getUint16(offset + 28, true);
    const mode = v.getUint32(at + 38, true) >>> 16;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      (mode & 0xf000) === 0xa000 ||
      entries.has(name) ||
      v.getUint16(at + 34, true) !== 0
    )
      throw new Error(
        'ZIP contains encryption, links, duplicate paths, or an unsupported compression method.',
      );
    if (
      dataStart + compressed > start ||
      localNameSize !== nameSize ||
      !nameBytes.every((b, j) => b === bytes[offset + 30 + j]) ||
      v.getUint16(offset + 6, true) !== flags ||
      v.getUint16(offset + 8, true) !== method
    )
      throw new Error('ZIP local header does not match its directory.');
    if (
      !(flags & 8) &&
      (v.getUint32(offset + 14, true) !== v.getUint32(at + 16, true) ||
        v.getUint32(offset + 18, true) !== compressed ||
        v.getUint32(offset + 22, true) !== size)
    )
      throw new Error('ZIP local size or checksum disagrees with its directory.');
    if (ranges.some((r) => offset < r.end && r.start < dataStart + compressed))
      throw new Error('ZIP entries overlap.');
    ranges.push({ start: offset, end: dataStart + compressed });
    total += size;
    if (total > limit) throw new Error('Expanded archive exceeds size limit.');
    entries.set(name, { name, crc: v.getUint32(at + 16, true), size, compressed, offset, method });
    at += 46 + nameSize + extra + comment;
  }
  if (at !== end) throw new Error('ZIP directory has extra or missing entries.');
  return entries;
}
