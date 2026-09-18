import { profileDisplay, type MachineProfile, type FirmwareProfile } from './watch-profiles.ts';
import type { OpticalProfile } from './watch-optics.ts';
const revision = 'cb50db8e68c053e7dd595188313dd54aba693bc9';
export interface WatchModelSpec {
  profile: FirmwareProfile;
  name: string;
  path: string;
  sha256: string;
  center: [number, number, number];
  rotateX: number;
  screen: { width: number; height: number; radius: number; x: number; y: number; z: number };
  buttons: { mask: number; position: [number, number, number]; top: number }[];
  plastic: boolean;
  optics?: OpticalProfile;
}
export const WATCH_MODELS: Record<FirmwareProfile, WatchModelSpec> = {
  qemu_emery: {
    profile: 'qemu_emery',
    name: 'Pebble Time 2',
    optics: 'time2',
    path: 'watch/Pebble Time 2 (obelix)/2026-04-08 Pebble Time 2 - 3D CAD Solid Model.STL',
    sha256: 'fb7c75e955e26de21611c81f73eb72bfe24a89df8b0b5064c730c88cecfa6311',
    center: [127.9631424, 128.0000381, 6.2],
    rotateX: 0,
    screen: { width: 25.6, height: 29.184, radius: 2.5, x: 0, y: 0, z: 6.215 },
    buttons: [
      { mask: 1, position: [-19, 7.5, 0], top: 29 },
      { mask: 2, position: [19, 12.8, 0], top: 17 },
      { mask: 4, position: [19, 0, 0], top: 50 },
      { mask: 8, position: [19, -12.8, 0], top: 83 },
    ],
    plastic: false,
  },
  qemu_flint: {
    profile: 'qemu_flint',
    name: 'Pebble 2 Duo',
    path: 'watch/Pebble 2 Duo (asterix)/20250918 Pebble 2 Duo - Solid model.STL',
    sha256: 'fa9b42bf877c0012eb3d4dd05425ae1e89f5af8d72e876446a62f3b1f23edb5a',
    center: [16.325, 23.822235, 5.23321],
    rotateX: 0,
    screen: { width: 20.4, height: 23.8, radius: 0, x: 0, y: 1.3, z: 5.3 },
    buttons: [
      { mask: 1, position: [-16.3, 9, 0], top: 24 },
      { mask: 2, position: [16.3, 10.8, 0], top: 19 },
      { mask: 4, position: [16.3, 0, 0], top: 50 },
      { mask: 8, position: [16.3, -10.8, 0], top: 81 },
    ],
    plastic: true,
  },
  qemu_gabbro: {
    profile: 'qemu_gabbro',
    name: 'Pebble Round 2',
    path: 'watch/Pebble Round 2 (getafix)/Pebble Round 2 - External 3D CAD - 20mm.stl',
    sha256: 'df4be31aeb930c3ee3d2abd7ef06cc4c6e7bcbd79331e636e0ec081244b6a3d6',
    center: [21.58, 22.1336, 5.09],
    rotateX: 0,
    screen: { width: 33, height: 33, radius: 16.5, x: 0, y: 0, z: 5.1 },
    buttons: [
      { mask: 1, position: [-21.4, 0, 0], top: 50 },
      { mask: 2, position: [18.2, 9, 0], top: 23 },
      { mask: 4, position: [21.4, 0, 0], top: 50 },
      { mask: 8, position: [18.2, -9, 0], top: 77 },
    ],
    plastic: false,
  },
};
export function watchModelSpec(profile: MachineProfile) {
  return profile === 'diagnostic-v1' ? WATCH_MODELS.qemu_emery : WATCH_MODELS[profile];
}
export function modelSource(spec: WatchModelSpec) {
  return `https://github.com/coredevices/hardware/blob/${revision}/${encodeURI(spec.path)}`;
}
export function modelUrl(spec: WatchModelSpec) {
  return `https://raw.githubusercontent.com/coredevices/hardware/${revision}/${encodeURI(spec.path)}`;
}
export function modelDisplay(spec: WatchModelSpec) {
  return profileDisplay(spec.profile);
}
