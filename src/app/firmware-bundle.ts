import { boardDescriptor, type BoardId } from './board-registry.ts';
import { microFlashImage } from './firmware-image.ts';
import { safePath } from './projects.ts';
export interface FirmwareBundle {
  format: 'pebble-firmware-bundle';
  version: 1;
  board: BoardId;
  revision: string;
  firmwareVersion: string;
  assets: { role: string; path: string; sha256: string }[];
}
export function parseFirmwareBundle(value: unknown): FirmwareBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Firmware bundle must be an object.');
  const v = value as FirmwareBundle;
  if (v.format !== 'pebble-firmware-bundle' || v.version !== 1)
    throw new Error('Unsupported firmware bundle format.');
  const board = boardDescriptor(v.board);
  for (const [name, text] of Object.entries({
    revision: v.revision,
    firmwareVersion: v.firmwareVersion,
  }))
    if (
      typeof text !== 'string' ||
      !text.length ||
      text.length > 200 ||
      /[\x00-\x1f\x7f]/.test(text)
    )
      throw new Error('Invalid bundle ' + name + '.');
  if (!Array.isArray(v.assets) || !v.assets.length || v.assets.length > 16)
    throw new Error('Firmware bundle must declare 1–16 assets.');
  const seen = new Set<string>();
  const assets = v.assets.map((a) => {
    if (
      !a ||
      !board.firmwareRoles.includes(a.role) ||
      !safePath(a.path) ||
      !/^[a-f0-9]{64}$/.test(a.sha256)
    )
      throw new Error('Invalid firmware asset declaration.');
    if (seen.has(a.role)) throw new Error('Duplicate firmware role: ' + a.role);
    seen.add(a.role);
    return { role: a.role, path: a.path, sha256: a.sha256 };
  });
  if (board.runtime && (!seen.has('micro-flash') || !seen.has('spi-flash')))
    throw new Error('Generic firmware needs matching micro-flash and spi-flash assets.');
  return {
    format: 'pebble-firmware-bundle',
    version: 1,
    board: board.id,
    revision: v.revision,
    firmwareVersion: v.firmwareVersion,
    assets,
  };
}
export async function inspectFirmwareBundle(value: unknown, files: Record<string, Uint8Array>) {
  const manifest = parseFirmwareBundle(value),
    board = boardDescriptor(manifest.board);
  const assets: Record<string, Uint8Array> = Object.create(null);
  for (const item of manifest.assets) {
    const bytes = files[item.path];
    if (!bytes) throw new Error('Missing firmware asset: ' + item.path);
    if (bytes.length > 80 * 1048576) throw new Error('Firmware asset exceeds 80 MiB.');
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== item.sha256) throw new Error('Firmware SHA-256 mismatch: ' + item.path);
    assets[item.role] = bytes;
  }
  if (!board.runtime) return { manifest, board, loadable: null, reason: board.unavailableReason };
  const micro = microFlashImage(assets['micro-flash']!),
    flash = assets['spi-flash']!;
  if (micro.length > 4 * 1048576 || flash.length !== 32 * 1048576)
    throw new Error('Firmware image sizes do not match the generic board.');
  return {
    manifest,
    board,
    reason: null,
    loadable: {
      profile: board.runtime,
      micro,
      flash,
      name: `${manifest.board} ${manifest.firmwareVersion} (${manifest.revision})`,
    },
  };
}
