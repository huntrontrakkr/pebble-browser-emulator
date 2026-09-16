/** App platforms and emulator boards are different compatibility boundaries. */
export type AppPlatform = 'aplite' | 'basalt' | 'chalk' | 'diorite' | 'emery' | 'flint' | 'gabbro';
export type FirmwareProfile = 'qemu_flint' | 'qemu_emery' | 'qemu_gabbro';
export type MachineProfile = 'diagnostic-v1' | FirmwareProfile;
export const APP_PLATFORMS: Record<
  AppPlatform,
  {
    id: number;
    width: number;
    height: number;
    colors: number;
    round: boolean;
  }
> = {
  aplite: { id: 1, width: 144, height: 168, colors: 2, round: false },
  basalt: { id: 2, width: 144, height: 168, colors: 64, round: false },
  chalk: { id: 3, width: 180, height: 180, colors: 64, round: true },
  diorite: { id: 4, width: 144, height: 168, colors: 2, round: false },
  emery: { id: 5, width: 200, height: 228, colors: 64, round: false },
  flint: { id: 6, width: 144, height: 168, colors: 2, round: false },
  gabbro: { id: 7, width: 260, height: 260, colors: 64, round: true },
};
export const FIRMWARE_PROFILES: Record<
  FirmwareProfile,
  { id: number; platform: AppPlatform; label: string; model: string }
> = {
  qemu_flint: {
    id: 1,
    platform: 'flint',
    model: 'pebble_2_duo_black',
    label: 'Pebble 2 Duo · QEMU Flint',
  },
  qemu_emery: {
    id: 2,
    platform: 'emery',
    model: 'pebble_time_2_silver_gray',
    label: 'Pebble Time 2 · QEMU Emery',
  },
  qemu_gabbro: {
    id: 3,
    platform: 'gabbro',
    model: 'pebble_round_2_black',
    label: 'Pebble Round 2 · QEMU Gabbro',
  },
};
export interface WatchProduct {
  id: string;
  name: string;
  platform: AppPlatform;
  runtime?: FirmwareProfile;
  note: string;
}
export const WATCH_PRODUCTS: readonly WatchProduct[] = [
  { id: 'pebble', name: 'Pebble', platform: 'aplite', note: 'Original hardware profile pending.' },
  {
    id: 'steel',
    name: 'Pebble Steel',
    platform: 'aplite',
    note: 'Original hardware profile pending.',
  },
  {
    id: 'time',
    name: 'Pebble Time',
    platform: 'basalt',
    note: 'Original hardware profile pending.',
  },
  {
    id: 'time-steel',
    name: 'Pebble Time Steel',
    platform: 'basalt',
    note: 'Original hardware profile pending.',
  },
  {
    id: 'time-round',
    name: 'Pebble Time Round',
    platform: 'chalk',
    note: 'Original hardware profile pending.',
  },
  {
    id: 'pebble-2-hr',
    name: 'Pebble 2 + Heart Rate',
    platform: 'diorite',
    note: 'Original hardware profile pending.',
  },
  {
    id: 'pebble-2-se',
    name: 'Pebble 2 SE',
    platform: 'diorite',
    note: 'Original hardware profile pending.',
  },
  {
    id: 'time-2-2016',
    name: 'Pebble Time 2 (2016 prototype)',
    platform: 'emery',
    note: 'Distinct unreleased hardware; no verified firmware runtime.',
  },
  {
    id: '2-duo',
    name: 'Pebble 2 Duo',
    platform: 'flint',
    runtime: 'qemu_flint',
    note: 'Runs the official emulator firmware. Physical watch firmware is a separate target.',
  },
  {
    id: 'time-2',
    name: 'Pebble Time 2',
    platform: 'emery',
    runtime: 'qemu_emery',
    note: 'Runs the official emulator firmware. Physical Obelix firmware is a separate target.',
  },
  {
    id: 'round-2',
    name: 'Pebble Round 2',
    platform: 'gabbro',
    runtime: 'qemu_gabbro',
    note: 'Runs the official emulator firmware. Physical watch firmware is a separate target.',
  },
];
export function isFirmwareProfile(value: unknown): value is FirmwareProfile {
  return typeof value === 'string' && Object.hasOwn(FIRMWARE_PROFILES, value);
}
export function profileDisplay(profile: MachineProfile) {
  return APP_PLATFORMS[profile === 'diagnostic-v1' ? 'emery' : FIRMWARE_PROFILES[profile].platform];
}
export function fileProfile(name: string): FirmwareProfile | undefined {
  return Object.keys(FIRMWARE_PROFILES).find((id) => name.toLowerCase().includes(id)) as
    FirmwareProfile | undefined;
}
