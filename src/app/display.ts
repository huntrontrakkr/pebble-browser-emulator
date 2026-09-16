export type DisplayMode = 'pixels' | 'reflective' | 'model';
export interface DisplayOptions {
  mode: DisplayMode;
  ambient: number;
  backlight: number;
}
const clamp = (v: number) => Math.min(1, Math.max(0, v));
/** ARGB2222 conversion; the optical preview is explicitly uncalibrated, never changes guest pixels. */
export function renderPixels(source: Uint8Array, options: DisplayOptions): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(source.length * 4);
  const reflective = options.mode !== 'pixels';
  const light = clamp(options.ambient),
    back = clamp(options.backlight);
  const paper = [212, 218, 199];
  const ink = [31, 38, 35];
  for (let i = 0; i < source.length; i++) {
    const p = source[i];
    const components = [(p >> 4) & 3, (p >> 2) & 3, p & 3];
    for (let c = 0; c < 3; c++) {
      const raw = components[c] / 3;
      rgba[i * 4 + c] = reflective
        ? (ink[c] + (paper[c] - ink[c]) * raw) * (0.25 + 0.75 * light) * (1 - back) +
          raw * 255 * back
        : raw * 255;
    }
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
