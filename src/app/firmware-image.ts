/** Normalize SDK ELF load segments into the QEMU board's physical micro-flash address space. */
export function microFlashImage(input: Uint8Array): Uint8Array {
  if (input.length < 8) throw new Error('Firmware is missing its vector table.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46) return input;
  if (input.length < 52 || input[4] !== 1 || input[5] !== 1 || view.getUint16(18, true) !== 40)
    throw new Error('Expected a little-endian ARM ELF32 image.');
  const start = view.getUint32(28, true),
    size = view.getUint16(42, true),
    count = view.getUint16(44, true);
  if (size !== 32 || count > 256 || start + size * count > input.length)
    throw new Error('Invalid ELF program table.');
  const segments: { at: number; address: number; length: number }[] = [];
  let end = 0;
  for (let i = 0; i < count; i++) {
    const p = start + i * size;
    if (view.getUint32(p, true) !== 1) continue;
    const at = view.getUint32(p + 4, true),
      address = view.getUint32(p + 12, true),
      length = view.getUint32(p + 16, true);
    if (!length) continue;
    if (at + length > input.length || address + length > 4 * 1048576)
      throw new Error('ELF segment falls outside micro flash.');
    if (segments.some((s) => address < s.address + s.length && s.address < address + length))
      throw new Error('Overlapping ELF flash segments.');
    segments.push({ at, address, length });
    end = Math.max(end, address + length);
  }
  if (end < 8 || !segments.some((s) => s.address === 0 && s.length >= 8))
    throw new Error('ELF has no flash vector table at address zero.');
  const bytes = new Uint8Array(end);
  for (const s of segments) bytes.set(input.subarray(s.at, s.at + s.length), s.address);
  return bytes;
}
