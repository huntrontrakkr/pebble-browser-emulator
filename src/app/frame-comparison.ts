/** Compare canonical guest display bytes, before optical rendering or CSS clipping. */
export interface FrameComparison {
  width: number;
  height: number;
  pixels: number;
  differentPixels: number;
  firstDifference: { x: number; y: number; expected: number; actual: number } | null;
  expectedHash: string;
  actualHash: string;
  differences: Uint8Array;
}
export async function compareFrames(
  expected: Uint8Array,
  actual: Uint8Array,
  width: number,
  height: number,
): Promise<FrameComparison> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 1048576
  )
    throw new Error('Invalid framebuffer dimensions.');
  if (expected.length !== width * height || actual.length !== width * height)
    throw new Error(`Expected ${width * height} bytes for a ${width} × ${height} ARGB2222 frame.`);
  // Capture both sides before asynchronous hashing; callers may change their buffers.
  const a = expected.slice(),
    b = actual.slice(),
    differences = new Uint8Array(a.length);
  let differentPixels = 0,
    firstDifference: FrameComparison['firstDifference'] = null;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      differentPixels++;
      differences[i] = 255;
      firstDifference ??= {
        x: i % width,
        y: Math.floor(i / width),
        expected: a[i]!,
        actual: b[i]!,
      };
    }
  const hash = async (bytes: Uint8Array) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('');
  const [expectedHash, actualHash] = await Promise.all([hash(a), hash(b)]);
  return {
    width,
    height,
    pixels: a.length,
    differentPixels,
    firstDifference,
    expectedHash,
    actualHash,
    differences,
  };
}
export function encodeFrame(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 1024 ||
    height > 1024 ||
    bytes.length !== width * height
  )
    throw new Error('Invalid framebuffer.');
  const out = new Uint8Array(12 + bytes.length);
  out.set([80, 66, 70, 49]);
  const v = new DataView(out.buffer);
  v.setUint16(4, width, true);
  v.setUint16(6, height, true);
  v.setUint32(8, 8, true);
  out.set(bytes, 12);
  return out;
}
export function decodeFrame(bytes: Uint8Array): {
  width: number;
  height: number;
  bytes: Uint8Array;
} {
  if (bytes.length < 12 || bytes[0] !== 80 || bytes[1] !== 66 || bytes[2] !== 70 || bytes[3] !== 49)
    throw new Error('Expected a PBF1 framebuffer file.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = v.getUint16(4, true),
    height = v.getUint16(6, true);
  if (
    width < 1 ||
    height < 1 ||
    width > 1024 ||
    height > 1024 ||
    v.getUint32(8, true) !== 8 ||
    bytes.length !== width * height + 12
  )
    throw new Error('Invalid PBF dimensions, format or payload.');
  return { width, height, bytes: bytes.slice(12) };
}
