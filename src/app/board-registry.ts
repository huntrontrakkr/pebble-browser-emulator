import {
  FIRMWARE_PROFILES,
  APP_PLATFORMS,
  type AppPlatform,
  type FirmwareProfile,
} from './watch-profiles.ts';
export type BoardId = FirmwareProfile | 'asterix' | 'obelix' | 'getafix';
export type InputRoute = 'qemu-uart' | 'gpio' | 'touch-controller' | 'phone-service';
export interface BoardDescriptor {
  id: BoardId;
  family: 'generic-qemu' | 'nrf52840' | 'sifli';
  platform: AppPlatform;
  runtime: FirmwareProfile | null;
  inputs: Readonly<Record<string, InputRoute>>;
  unavailableReason?: string;
  firmwareRoles: readonly string[];
}
const genericInputs = {
  acceleration: 'qemu-uart',
  tap: 'qemu-uart',
  compass: 'qemu-uart',
  health: 'qemu-uart',
  battery: 'qemu-uart',
  connection: 'qemu-uart',
  buttons: 'gpio',
  'time-format': 'qemu-uart',
  'content-size': 'qemu-uart',
  'timeline-peek': 'qemu-uart',
  location: 'phone-service',
  'location-error': 'phone-service',
} as const;
function generic(id: FirmwareProfile): BoardDescriptor {
  const inputs: Record<string, InputRoute> = { ...genericInputs };
  if (id !== 'qemu_flint') inputs['touch'] = 'touch-controller';
  if (id === 'qemu_emery') inputs['heart-rate'] = 'qemu-uart';
  return {
    id,
    family: 'generic-qemu',
    platform: FIRMWARE_PROFILES[id].platform,
    runtime: id,
    inputs,
    firmwareRoles: ['micro-flash', 'spi-flash'],
  };
}
export const BOARDS: Readonly<Record<BoardId, BoardDescriptor>> = {
  qemu_flint: generic('qemu_flint'),
  qemu_emery: generic('qemu_emery'),
  qemu_gabbro: generic('qemu_gabbro'),
  asterix: {
    id: 'asterix',
    family: 'nrf52840',
    platform: 'flint',
    runtime: null,
    inputs: {},
    firmwareRoles: [
      'firmware-package',
      'bootloader',
      'controller',
      'internal-flash',
      'external-flash',
    ],
    unavailableReason:
      'Asterix requires an nRF52840 board implementation and verified bootloader/controller state. Generic Flint firmware uses a different memory map.',
  },
  obelix: {
    id: 'obelix',
    family: 'sifli',
    platform: 'emery',
    runtime: null,
    inputs: {},
    firmwareRoles: [
      'firmware-package',
      'bootloader',
      'rom',
      'controller',
      'internal-flash',
      'external-flash',
    ],
    unavailableReason:
      'Obelix requires the SiFli board, boot ROM and HCPU/LCPU interfaces. Generic Emery cannot execute stock Obelix firmware.',
  },
  getafix: {
    id: 'getafix',
    family: 'sifli',
    platform: 'gabbro',
    runtime: null,
    inputs: {},
    firmwareRoles: [
      'firmware-package',
      'bootloader',
      'rom',
      'controller',
      'internal-flash',
      'external-flash',
    ],
    unavailableReason:
      'Getafix requires its SiFli board and boot/controller dependencies. Generic Gabbro cannot execute stock Getafix firmware.',
  },
};
export function boardDescriptor(id: string): BoardDescriptor {
  if (!Object.hasOwn(BOARDS, id)) throw new Error('No board descriptor for ' + id + '.');
  return BOARDS[id as BoardId];
}
export function boardDisplay(id: BoardId) {
  return APP_PLATFORMS[BOARDS[id].platform];
}
export function signalRoute(id: BoardId, kind: string): InputRoute {
  const route = BOARDS[id].inputs[kind];
  if (!route) throw new Error(`${kind} has no implemented input route on ${id}.`);
  return route;
}
