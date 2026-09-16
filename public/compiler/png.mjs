// SPDX-License-Identifier: Apache-2.0
// PNG container and scanline decoding; compression uses vendored MIT pako.
import { Inflate, deflate } from './vendor/pako.esm.mjs';
export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  read = new TextDecoder(),
  text = new TextEncoder();
function chunk(type, bytes) {
  const out = new Uint8Array(bytes.length + 12),
    v = new DataView(out.buffer);
  v.setUint32(0, bytes.length);
  out.set(text.encode(type), 4);
  out.set(bytes, 8);
  v.setUint32(bytes.length + 8, crc32(out.subarray(4, bytes.length + 8)));
  return out;
}
export function encodePng({ width, height, bitdepth, palette, transparent, pixels }) {
  const header = new Uint8Array(13),
    h = new DataView(header.buffer);
  h.setUint32(0, width);
  h.setUint32(4, height);
  header[8] = bitdepth;
  header[9] = palette ? 3 : 0;
  const chunks = [signature, chunk('IHDR', header)];
  if (palette) {
    chunks.push(chunk('PLTE', Uint8Array.from(palette.flatMap((p) => p.slice(0, 3)))));
    if (palette.some((p) => p.length === 4))
      chunks.push(chunk('tRNS', Uint8Array.from(palette.map((p) => p[3] ?? 255))));
  } else if (transparent !== null && transparent !== undefined) {
    const tr = new Uint8Array(2);
    new DataView(tr.buffer).setUint16(0, transparent);
    chunks.push(chunk('tRNS', tr));
  }
  const stride = Math.ceil((width * bitdepth) / 8),
    data = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[y * (stride + 1) + 1 + Math.floor((x * bitdepth) / 8)] |=
        pixels[y * width + x] << (8 - bitdepth - ((x * bitdepth) % 8));
  chunks.push(chunk('IDAT', deflate(data, { level: 9 })), chunk('IEND', new Uint8Array()));
  return concat(chunks);
}
export function decodePng(bytes, { ignoreSbit = true, maxPixels = 4 * 1024 * 1024 } = {}) {
  if (bytes.length < 33 || !signature.every((b, i) => b === bytes[i]))
    throw new Error('Resource is not a PNG');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width,
    height,
    depth,
    type,
    interlace,
    palette,
    alpha,
    sbit,
    ended = false;
  const idat = [];
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const n = v.getUint32(at),
      name = read.decode(bytes.subarray(at + 4, at + 8));
    if (n > bytes.length - at - 12) throw new Error('Truncated PNG data');
    const body = bytes.subarray(at + 8, at + 8 + n);
    if (crc32(bytes.subarray(at + 4, at + 8 + n)) !== v.getUint32(at + 8 + n))
      throw new Error('PNG checksum mismatch');
    if (name === 'IHDR') {
      if (width !== undefined || at !== 8 || n !== 13) throw new Error('Invalid PNG header');
      width = v.getUint32(at + 8);
      height = v.getUint32(at + 12);
      depth = body[8];
      type = body[9];
      interlace = body[12];
      if (!width || !height || width * height > maxPixels || width > 32767 || height > 32767)
        throw new Error('PNG dimensions exceed resource limits');
      if (body[10] || body[11] || interlace > 1) throw new Error('Unsupported PNG coding');
    } else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') alpha = body;
    else if (name === 'sBIT') sbit = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') {
      ended = true;
      break;
    } else if (name[0] === name[0].toUpperCase())
      throw new Error('Unsupported critical PNG chunk ' + name);
    at += 12 + n;
  }
  if (!ended || !idat.length) throw new Error('Incomplete PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (
    !channels ||
    ![1, 2, 4, 8, 16].includes(depth) ||
    (type === 3 && depth === 16) ||
    ([2, 4, 6].includes(type) && depth < 8)
  )
    throw new Error('Invalid PNG color format');
  if (type === 3 && (!palette || palette.length % 3)) throw new Error('Missing PNG palette');
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)),
      h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) expected += (Math.ceil((w * channels * depth) / 8) + 1) * h;
  }
  const inflator = new Inflate({ chunkSize: 16384 });
  let total = 0;
  const chunks = [];
  inflator.onData = (c) => {
    total += c.length;
    if (total > expected) throw new Error('PNG decompression exceeds declared dimensions');
    chunks.push(c);
  };
  inflator.push(concat(idat), true);
  if (inflator.err || total !== expected) throw new Error('Invalid PNG compression');
  const data = concat(chunks),
    rgba = new Uint8Array(width * height * 4);
  let at = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x0) / dx)),
      h = Math.max(0, Math.ceil((height - y0) / dy));
    if (!w || !h) continue;
    const stride = Math.ceil((w * channels * depth) / 8),
      bpp = Math.max(1, Math.ceil((channels * depth) / 8));
    let prev = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
      const f = data[at++],
        row = data.slice(at, at + stride);
      at += stride;
      if (f > 4) throw new Error('Invalid PNG filter');
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0,
          b = prev[i],
          c = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (row[i] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][f]) & 255;
      }
      const sample = (i) =>
        depth === 16
          ? (row[i * 2] << 8) | row[i * 2 + 1]
          : depth === 8
            ? row[i]
            : (row[Math.floor((i * depth) / 8)] >> (8 - depth - ((i * depth) % 8))) &
              ((1 << depth) - 1);
      for (let x = 0; x < w; x++) {
        const s = Array.from({ length: channels }, (_, c) => sample(x * channels + c));
        let raw,
          al = (1 << depth) - 1;
        if (type === 3) {
          const idx = s[0];
          if (idx * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range');
          raw = [...palette.subarray(idx * 3, idx * 3 + 3), alpha?.[idx] ?? 255];
        } else {
          if (type === 0 || type === 4) raw = [s[0], s[0], s[0], type === 4 ? s[1] : al];
          else raw = [s[0], s[1], s[2], type === 6 ? s[3] : al];
          if (alpha && type === 0 && s[0] === ((alpha[0] << 8) | alpha[1])) raw[3] = 0;
          if (
            alpha &&
            type === 2 &&
            s.every((n, c) => n === ((alpha[c * 2] << 8) | alpha[c * 2 + 1]))
          )
            raw[3] = 0;
        }
        const sourceDepth = type === 3 ? 8 : depth;
        let targetDepth = sourceDepth;
        if (sbit && !ignoreSbit) {
          targetDepth = Math.max(...sbit);
          if (targetDepth > sourceDepth || Math.min(...sbit) < 1)
            throw new Error('Invalid PNG significant bits');
        }
        const shift = sourceDepth - targetDepth,
          max = (1 << targetDepth) - 1;
        raw = raw.map((n) => Math.round(((n >> shift) * 255) / max));
        rgba.set(raw, ((y0 + y * dy) * width + x0 + x * dx) * 4);
      }
      prev = row;
    }
  }
  return { width, height, rgba };
}
