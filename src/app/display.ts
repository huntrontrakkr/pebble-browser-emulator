export type DisplayMode = 'pixels' | 'reflective' | 'model';
export interface DisplayOptions {
  mode: DisplayMode;
  ambient: number;
  backlight: number;
}
const clamp = (v: number) => Math.min(1, Math.max(0, v));
let paletteKey = '';
const palette = new Uint8ClampedArray(256 * 4);
const words = new Uint32Array(palette.buffer);
/** ARGB2222 conversion; the optical preview is explicitly uncalibrated, never changes guest pixels. */
export function renderPixels(
  source: Uint8Array,
  options: DisplayOptions,
  destination?: Uint8ClampedArray,
): Uint8ClampedArray {
  const rgba = destination ?? new Uint8ClampedArray(source.length * 4);
  if (rgba.length !== source.length * 4 || rgba.byteOffset % 4 !== 0)
    throw new Error('Pixel destination must have matching size and word alignment.');
  const reflective = options.mode !== 'pixels';
  const light = clamp(options.ambient),
    back = clamp(options.backlight);
  const paper = [212, 218, 199];
  const ink = [31, 38, 35];
  const key = reflective ? `${light}/${back}` : 'pixels';
  if (key !== paletteKey) {
    paletteKey = key;
    for (let p = 0; p < 256; p++) {
      const components = [(p >> 4) & 3, (p >> 2) & 3, p & 3];
      for (let c = 0; c < 3; c++) {
        const raw = components[c] / 3;
        palette[p * 4 + c] = reflective
          ? (ink[c] + (paper[c] - ink[c]) * raw) * (0.25 + 0.75 * light) * (1 - back) +
            raw * 255 * back
          : raw * 255;
      }
      palette[p * 4 + 3] = 255;
    }
  }
  const output = new Uint32Array(rgba.buffer, rgba.byteOffset, source.length);
  for (let i = 0; i < source.length; i++) output[i] = words[source[i]];
  return rgba;
}
