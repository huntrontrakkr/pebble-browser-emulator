/** Fixed watch-side inputs shared by the Wasm census and native QEMU reference. */
export function compatibilitySignals(second, platform, width, height) {
  return second === 0
    ? [{ kind: 'battery', percent: 69, charging: false }]
    : second === 2
      ? [
          { kind: 'acceleration', x: 1800, y: -450, z: 900 },
          { kind: 'tap', axis: 0, direction: 1 },
        ]
      : second === 3
        ? [
            { kind: 'acceleration', x: 0, y: 0, z: -1000 },
            { kind: 'compass', heading: 90, calibration: 2 },
          ]
        : second === 4
          ? [
              { kind: 'heart-rate', bpm: 72, quality: 3 },
              ...Array.from({ length: 7 }, (_, metric) => ({
                kind: 'health',
                metric,
                value: [3200, 900, 1200, 130, 2100, 25200, 18000][metric],
              })),
            ]
          : second === 5
            ? [{ kind: 'location', latitude: 51.5072, longitude: -0.1276, accuracy: 10 }]
            : second === 6
              ? [{ kind: 'battery', percent: 15, charging: false }]
              : second === 7
                ? [{ kind: 'battery', percent: 85, charging: true }]
                : second === 8
                  ? [{ kind: 'buttons', mask: 2 }]
                  : second === 9
                    ? [{ kind: 'buttons', mask: 0 }]
                    : second === 10
                      ? [{ kind: 'buttons', mask: 8 }]
                      : second === 11
                        ? [{ kind: 'buttons', mask: 0 }]
                        : second === 12 && platform !== 'flint'
                          ? [
                              {
                                kind: 'touch',
                                down: true,
                                x: Math.floor(width / 2),
                                y: Math.floor(height / 2),
                              },
                            ]
                          : second === 13 && platform !== 'flint'
                            ? [
                                {
                                  kind: 'touch',
                                  down: false,
                                  x: Math.floor(width / 2),
                                  y: Math.floor(height / 2),
                                },
                              ]
                            : second === 16
                              ? [{ kind: 'connection', connected: false }]
                              : second === 17
                                ? [{ kind: 'connection', connected: true }]
                                : [];
}
