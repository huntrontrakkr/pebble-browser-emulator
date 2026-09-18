import * as THREE from 'three';

export type LightingEnvironment = 'studio' | 'daylight' | 'warm-room';
export interface WatchLighting {
  environment: LightingEnvironment;
  ambient: number;
  backlight: number;
  azimuth: number;
}
export const LIGHTING_ENVIRONMENTS = {
  studio: { sky: 0xb8c4d1, ground: 0x30343b, lamp: 0xffffff, direct: 2.2, fill: 0.65 },
  daylight: { sky: 0xa8c6ee, ground: 0x474b40, lamp: 0xfff3dd, direct: 3.4, fill: 0.9 },
  'warm-room': { sky: 0xb0a298, ground: 0x332e29, lamp: 0xffc38a, direct: 1.6, fill: 0.45 },
} satisfies Record<LightingEnvironment, unknown>;

/** Small procedural reflection maps: no HDR download or per-frame environment passes. */
export function createWatchEnvironment(renderer: THREE.WebGLRenderer, kind: LightingEnvironment) {
  const preset = LIGHTING_ENVIRONMENTS[kind];
  const room = new THREE.Scene();
  room.background = new THREE.Color(preset.sky).multiplyScalar(0.35);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const materials: THREE.MeshBasicMaterial[] = [];
  const panel = (
    color: number,
    intensity: number,
    position: [number, number, number],
    width: number,
    height: number,
  ) => {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      side: THREE.DoubleSide,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(width, height, 1);
    mesh.lookAt(0, 0, 0);
    room.add(mesh);
  };
  panel(preset.ground, 0.35, [0, -8, 0], 30, 30);
  // A broad window/softbox, a narrow fill and a dim ceiling. The different shapes
  // make moving glass reflections legible without animated noise or bloom.
  panel(preset.lamp, kind === 'daylight' ? 5 : 3, [-6, 5, 7], kind === 'studio' ? 4 : 7, 9);
  panel(preset.sky, 1.6, [7, 2, 4], 2, 8);
  panel(preset.lamp, 1.2, [0, 8, -3], 8, 5);
  const generator = new THREE.PMREMGenerator(renderer);
  try {
    return generator.fromScene(room, 0.015, 0.1, 50, { size: 128 });
  } finally {
    generator.dispose();
    geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
