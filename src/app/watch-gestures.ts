import type { SignalScenario } from './signals.ts';

/** A repeatable synthetic wrist movement, not a recording or a physical sensor model. */
export function wristShake(): SignalScenario {
  const events: SignalScenario['events'] = [];
  for (let i = 0; i <= 30; i++) {
    const envelope = Math.sin((Math.PI * i) / 30);
    events.push({
      atUs: i * 20000,
      signal: {
        kind: 'acceleration',
        x: Math.round(1800 * envelope * Math.sin((Math.PI * i) / 3)) || 0,
        y: Math.round(600 * envelope * Math.sin((Math.PI * i) / 5)) || 0,
        z: -1000 + Math.round(900 * envelope * Math.sin((Math.PI * i) / 3)),
      },
    });
    if (i === 5) events.push({ atUs: 100000, signal: { kind: 'tap', axis: 2, direction: 1 } });
  }
  return { version: 1, name: 'Wrist shake', seed: 1, events };
}

/** Map a pointer to native display pixels, excluding the corners of a round screen. */
export function screenPoint(
  u: number,
  v: number,
  display: { width: number; height: number; round: boolean },
): { x: number; y: number } | null {
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (display.round && (u - 0.5) ** 2 + (v - 0.5) ** 2 > 0.25) return null;
  return {
    x: Math.min(display.width - 1, Math.floor(u * display.width)),
    y: Math.min(display.height - 1, Math.floor(v * display.height)),
  };
}
