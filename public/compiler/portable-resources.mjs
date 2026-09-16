// SPDX-FileCopyrightText: 2024 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Port of SDK 4.33.1 pbpack.py, bitmapgen.py, png2pblpng.py and resource conventions.
import { stm32crc, emptyResourcePack } from './portable-pbw.mjs';
import { decodePng, encodePng, concat } from './png.mjs';
import { getPlatform } from './platforms.mjs';
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export function resourcePack(resources) {
  if (resources.length > 256) throw new Error('At most 256 resources can be packed');
  if (!resources.length) return emptyResourcePack();
  const unique = [],
    entries = resources.map((bytes) => {
      let index = unique.findIndex((b) => equal(b, bytes));
      if (index < 0) {
        index = unique.length;
        unique.push(bytes);
      }
      return { index, bytes };
    }),
    offsets = new Map();
  let size = unique.reduce((n, b) => n + b.length, 0);
  for (const e of [...entries].reverse())
    if (!offsets.has(e.index)) {
      size -= e.bytes.length;
      offsets.set(e.index, size);
    }
  const content = concat([...offsets].sort((a, b) => a[1] - b[1]).map(([i]) => unique[i]));
  const pack = new Uint8Array(4108 + content.length),
    v = new DataView(pack.buffer);
  v.setUint32(0, entries.length, true);
  v.setUint32(4, stm32crc(content), true);
  entries.forEach((e, i) => {
    const at = 12 + i * 16;
    v.setUint32(at, i + 1, true);
    v.setUint32(at + 4, offsets.get(e.index), true);
    v.setUint32(at + 8, e.bytes.length, true);
    v.setUint32(at + 12, stm32crc(e.bytes), true);
  });
  pack.set(content, 4108);
  return pack;
}
function reducePixel(r, g, b, a, color) {
  if (color) {
    a = Math.floor((a + 42) / 85) * 85;
    return a ? [r, g, b].map((v) => Math.floor((v + 42) / 85) * 85).concat(a) : [0, 0, 0, 0];
  }
  const l = r * 0.2126 + g * 0.7152 + b * 0.11 > 127.5 ? 255 : 0;
  return [l, l, l, a > 127.5 ? 255 : 0];
}
const bitsFor = (n) => (n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8);
export function pngPalette(image, color = true) {
  const palette = [],
    pixels = [];
  let grey = true,
    alpha = false;
  for (let i = 0; i < image.rgba.length; i += 4) {
    const p = reducePixel(...image.rgba.subarray(i, i + 4), color);
    pixels.push(p);
    if (!palette.some((v) => equal(v, p))) {
      palette.push(p);
      alpha ||= p[3] !== 255;
      grey &&= (p[3] === 255 && p[0] === p[1] && p[1] === p[2]) || p.every((v) => v === 0);
    }
  }
  let bits = bitsFor(palette.length);
  if (grey) {
    const middle = palette.some((p) => p[3] === 255 && (p[0] === 85 || p[0] === 170));
    const needed = middle ? (palette.length >= 5 ? 4 : 2) : palette.length >= 3 ? 2 : 1;
    if (needed > bits) grey = false;
    else bits = needed;
  }
  return { palette, pixels, grey, alpha, bits };
}
export function pebblePng(image, { color = true, bitdepth } = {}) {
  const p = pngPalette(image, color);
  if (bitdepth !== undefined) {
    if (p.bits > bitdepth) throw new Error(`PNG requires ${p.bits} bits`);
    if (p.bits !== bitdepth) p.grey = false;
    p.bits = bitdepth;
  }
  let transparent = null;
  if (p.grey && p.alpha)
    transparent =
      p.bits === 4
        ? 12
        : [0, 255, 85, 170].find((v) => !p.palette.some((c) => equal(c, [v, v, v, 255]))) >>
          (8 - p.bits);
  return encodePng({
    width: image.width,
    height: image.height,
    bitdepth: p.bits,
    palette: p.grey ? null : p.palette.map((c) => (p.alpha ? c : c.slice(0, 3))),
    transparent,
    pixels: p.pixels.map((c) =>
      p.grey
        ? c[3] === 0
          ? transparent
          : c[0] >> (8 - p.bits)
        : p.palette.findIndex((v) => equal(c, v)),
    ),
  });
}
// Match the integer-set palette ordering observed in CPython 3.11's SDK tools.
// A bounded open-addressed table is used solely for byte-stable palette indices.
export function sdkIntegerSet(values) {
  let table = new Array(8),
    used = 0;
  function insert(t, n) {
    const mask = t.length - 1;
    let slot = n & mask,
      perturb = n;
    for (;;) {
      const probes = slot + 9 <= mask ? 9 : 0;
      for (let j = 0; j <= probes; j++) {
        if (t[slot + j] === n) return false;
        if (t[slot + j] === undefined) {
          t[slot + j] = n;
          return true;
        }
      }
      perturb >>>= 5;
      slot = (slot * 5 + 1 + perturb) & mask;
    }
  }
  for (const n of values) {
    if (!insert(table, n)) continue;
    used++;
    if (used * 5 >= (table.length - 1) * 3) {
      let size = 8;
      while (size <= used * 4) size *= 2;
      const next = new Array(size);
      for (const v of table) if (v !== undefined) insert(next, v);
      table = next;
    }
  }
  return table.filter((v) => v !== undefined);
}
export function pebblePbi(
  image,
  { format = 'bw', crop = true, color = true, bitdepth, black = false } = {},
) {
  const { width, height, rgba } = image;
  const alpha = (x, y) => rgba[(y * width + x) * 4 + 3];
  let left = 0,
    top = 0,
    right = width,
    bottom = height;
  if (crop) {
    while (top < height && !Array.from({ length: width }, (_, x) => alpha(x, top)).some(Boolean))
      top++;
    while (
      bottom > 0 &&
      !Array.from({ length: width }, (_, x) => alpha(x, bottom - 1)).some(Boolean)
    )
      bottom--;
    while (left < width && !Array.from({ length: height }, (_, y) => alpha(left, y)).some(Boolean))
      left++;
    // Preserve SDK4.33.1 bitmapgen's bottom-row based right cropping, including
    // its legacy asymmetry; reject invalid resulting dimensions explicitly.
    let y = height - 1;
    while (y >= 0 && !Array.from({ length: width }, (_, x) => alpha(x, y)).some(Boolean)) {
      right--;
      y--;
    }
  }
  const w = right - left,
    h = bottom - top;
  if (w <= 0 || h <= 0) throw new Error('SDK cropping produces empty or invalid bitmap bounds');
  const colors = [];
  if (format !== 'bw')
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        let [r, g, b, a] = reducePixel(
          ...rgba.subarray((y * width + x) * 4, (y * width + x + 1) * 4),
          color,
        );
        if (!a) r = g = b = 0;
        colors.push(((a >> 6) << 6) | ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6));
      }
  const palette = format === 'color' ? sdkIntegerSet(colors) : null;
  let bits =
    format === 'bw' ? 0 : format === 'color_raw' ? 8 : (bitdepth ?? bitsFor(palette.length));
  if (palette && bits < bitsFor(palette.length))
    throw new Error('PBI palette does not fit requested bit depth');
  if (![0, 1, 2, 4, 8].includes(bits)) throw new Error('Invalid PBI bit depth');
  const stride = format === 'bw' ? Math.ceil(w / 32) * 4 : Math.ceil((w * bits) / 8),
    out = new Uint8Array(12 + stride * h + (palette && bits < 8 ? 2 ** bits : 0)),
    v = new DataView(out.buffer);
  v.setUint16(0, stride, true);
  v.setUint16(2, 4096 | ({ 0: 0, 8: 1, 1: 2, 2: 3, 4: 4 }[bits] << 1), true);
  [left, top, w, h].forEach((n, i) => v.setInt16(4 + i * 2, n, true));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < (format === 'bw' ? stride * 8 : w); x++) {
      let value;
      if (format === 'bw') {
        if (x + left >= width) continue;
        const i = ((y + top) * width + x + left) * 4;
        const white = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 >= 127;
        value = rgba[i + 3] < 127 ? 0 : Number(black ? !white : white);
        out[12 + y * stride + (x >> 3)] |= value << (x % 8);
      } else {
        value = colors[y * w + x];
        if (bits < 8) value = palette.indexOf(value);
        out[12 + y * stride + Math.floor((x * bits) / 8)] |= value << (8 - bits - ((x * bits) % 8));
      }
    }
  if (palette && bits < 8) out.set(palette, 12 + stride * h);
  return out;
}
function safePath(path) {
  if (
    typeof path !== 'string' ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.includes('\0')
  )
    throw new Error('Invalid resource path');
  const parts = [];
  for (const p of path.split('/')) {
    if (p === '..') {
      if (!parts.length) throw new Error('Resource escapes project');
      parts.pop();
    } else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}
export function selectResourceFile(files, file, platform) {
  const p = getPlatform(platform),
    path = safePath('resources/' + file);
  if (path.includes('~')) throw new Error('Generic resource paths cannot contain ~');
  const dot = path.lastIndexOf('.'),
    base = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path,
    ext = path.slice(base.length);
  let best = -1,
    choices = [];
  for (const candidate of Object.keys(files)) {
    if (!candidate.startsWith(base + '~') || !candidate.endsWith(ext)) continue;
    const stem = candidate.slice(0, candidate.length - ext.length),
      tags = new Set(stem.slice(base.length + 1).split('~'));
    if ([...tags].some((t) => !p.tags.includes(t))) continue;
    if (tags.size > best) {
      best = tags.size;
      choices = [candidate];
    } else if (tags.size === best) choices.push(candidate);
  }
  if (choices.length > 1) throw new Error(`Ambiguous ${platform} resource: ${choices.join(', ')}`);
  const selected = choices[0] ?? path;
  if (!files[selected]) throw new Error('Missing resource ' + selected);
  return selected;
}
const identifier = (n) => typeof n === 'string' && /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(n);
export function prepareResources(sourceFiles, appinfo, platform = 'emery') {
  const profile = getPlatform(platform),
    color = profile.tags.includes('color'),
    media = appinfo.resources?.media ?? [];
  if (!Array.isArray(media)) throw new Error('resources.media must be an array');
  if (appinfo.resources?.publishedMedia || appinfo.publishedMedia)
    throw new Error('Published library resources are not supported');
  const entries = [],
    ids = {},
    menuIcons = media.filter((r) => r.menuIcon);
  if (menuIcons.length > 1) throw new Error('Only one menuIcon may be declared');
  const add = (name, aliases, bytes, file) => {
    const id = entries.length + 1;
    for (const n of [name, ...aliases]) {
      if (!identifier(n)) throw new Error('Invalid resource identifier ' + n);
      if (Object.hasOwn(ids, n)) throw new Error('Duplicate resource identifier ' + n);
      Object.defineProperty(ids, n, {
        value: id,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    entries.push({ name, id, file, bytes });
  };
  for (const r of media) {
    if (r.targetPlatforms !== undefined) {
      if (!Array.isArray(r.targetPlatforms))
        throw new Error('Resource targetPlatforms must be an array');
      if (!r.targetPlatforms.includes(platform)) continue;
    }
    if (r.builtin) throw new Error('Built-in resources are not supported');
    if (!Array.isArray(r.aliases ?? [])) throw new Error('Resource aliases must be an array');
    if (!['raw', 'png', 'pbi', 'pbi8', 'png-trans', 'bitmap'].includes(r.type))
      throw new Error(`Unsupported resource type ${r.type}: ${r.name}`);
    const path = selectResourceFile(sourceFiles, r.file, platform),
      source = sourceFiles[path];
    if (r.type === 'raw') {
      add(r.name, r.aliases ?? [], source, path);
      continue;
    }
    if (/\.svg$/i.test(path)) throw new Error('SVG resources require an SVG conversion profile');
    const image = decodePng(source, { ignoreSbit: r.type === 'png' || r.type === 'bitmap' });
    if (r.menuIcon && (image.width > 25 || image.height > 25))
      throw new Error('Menu icons may be at most 25 by 25 pixels');
    let bytes;
    if (r.type === 'png') bytes = pebblePng(image, { color });
    else if (r.type === 'pbi' || r.type === 'pbi8')
      bytes = pebblePbi(image, { format: r.type === 'pbi8' && color ? 'color' : 'bw' });
    else if (r.type === 'png-trans') {
      if (r.aliases?.length)
        throw new Error(
          'png-trans aliases collide in SDK-generated IDs; use explicit pbi resources',
        );
      for (const suffix of ['WHITE', 'BLACK'])
        add(
          r.name + '_' + suffix,
          (r.aliases ?? []).map((a) => a + '_' + suffix),
          pebblePbi(image, { black: suffix === 'BLACK' }),
          path,
        );
      continue;
    } else {
      let memory = (r.memoryFormat ?? 'smallest').toLowerCase(),
        storage = r.storageFormat;
      if (storage !== undefined && !['png', 'pbi'].includes(storage))
        throw new Error('Invalid bitmap storageFormat');
      if (r.spaceOptimization !== undefined && !['memory', 'storage'].includes(r.spaceOptimization))
        throw new Error('Invalid bitmap spaceOptimization');
      if (
        (r.spaceOptimization === 'memory' && storage === 'png') ||
        (r.spaceOptimization === 'storage' && storage === 'pbi')
      )
        throw new Error('Conflicting bitmap storage choices');
      storage ??=
        r.spaceOptimization === 'memory'
          ? 'pbi'
          : r.spaceOptimization === 'storage'
            ? 'png'
            : profile.maxAppMemory < 32768
              ? 'pbi'
              : 'png';
      if (
        ![
          '1bit',
          '8bit',
          'smallest',
          'smallestpalette',
          '1bitpalette',
          '2bitpalette',
          '4bitpalette',
        ].includes(memory)
      )
        throw new Error('Invalid bitmap memoryFormat');
      const bits = pngPalette(image, color).bits;
      if (memory === 'smallest') memory = bits <= 4 ? 'smallestpalette' : '8bit';
      if (memory === 'smallestpalette') {
        if (bits > 4) throw new Error('Bitmap exceeds 16-color palette');
        memory = bits + 'bitpalette';
      }
      if (memory === '1bit') {
        if (r.storageFormat === 'png') throw new Error('1bit bitmap cannot use PNG storage');
        bytes = pebblePbi(decodePng(source, { ignoreSbit: false }), { crop: false });
      } else {
        const selected = Number.parseInt(memory);
        if (selected < bits || (!color && selected > 2))
          throw new Error('Bitmap memoryFormat cannot represent image on ' + platform);
        bytes =
          storage === 'png'
            ? pebblePng(image, { color, bitdepth: selected })
            : pebblePbi(decodePng(source, { ignoreSbit: false }), {
                format: selected === 8 ? 'color_raw' : 'color',
                color,
                crop: false,
                bitdepth: selected,
              });
      }
    }
    add(r.name, r.aliases ?? [], bytes, path);
  }
  const pack = resourcePack(entries.map((e) => e.bytes));
  if (pack.length > profile.maxResources)
    throw new Error('Resource pack exceeds ' + platform + ' limit');
  if (menuIcons.length && !Object.hasOwn(ids, menuIcons[0].name))
    throw new Error('Menu icon is unavailable on selected platform');
  return {
    pack,
    entries,
    ids,
    menuIcon: menuIcons.length ? 'RESOURCE_ID_' + menuIcons[0].name : 'DEFAULT_MENU_ICON',
    header:
      '#pragma once\n#define DEFAULT_MENU_ICON 0\n' +
      Object.entries(ids)
        .map(([n, id]) => `#define RESOURCE_ID_${n} ${id}\n`)
        .join(''),
  };
}
