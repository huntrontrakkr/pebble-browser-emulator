import { readLocal, writeLocal } from './local-store.ts';
import { fileProfile, type FirmwareProfile } from './watch-profiles.ts';
import { microFlashImage } from './firmware-image.ts';

export interface PreviewFirmware {
  profile: FirmwareProfile;
  micro: Uint8Array;
  flash: Uint8Array;
  name: string;
}
interface SavedFirmware {
  version: 1;
  profile: FirmwareProfile;
  name: string;
  micro: Blob | Uint8Array;
  flash: Blob | Uint8Array;
}
export const DEFAULT_FIRMWARE = 'v4.37.0';
// Official release digests, not hashes inferred from filenames or repository text.
const DIGESTS: Record<FirmwareProfile, [string, string]> = {
  qemu_emery: [
    '6783255bd4efc4053176936cffebaf8bf7ba7beed572e11ae99aa187e0e41b02',
    'd8a622dd54a41e03d10049b102971ec51f1457c9d718dc260968fbcdb47300b5',
  ],
  qemu_flint: [
    'd4c9094ddc750393e61cdab1fbdb5cd8ace5eeb4a149f76c9ee780c10e0bd1ee',
    'ff32ba50ba869bc02130910a4f399437e7b2a2708d43f2eb2f0739edcfd7f315',
  ],
  qemu_gabbro: [
    'c58e3670cd7cd0a80788761d80274c3684a59e17fef28c3c3706280edae1cd2c',
    '0e25a15062465a33470be6136c85a9ac39429c8277db30b28f34a02db57273ed',
  ],
};
const MICRO_BYTES: Record<FirmwareProfile, number> = {
  qemu_emery: 1698816,
  qemu_flint: 864768,
  qemu_gabbro: 1682944,
};

/** Same-origin, unchanged upstream images. Only the transport is compressed. */
export async function bundledFirmware(
  profile: FirmwareProfile,
  signal: AbortSignal,
  base = document.baseURI,
  request: typeof fetch = fetch,
): Promise<PreviewFirmware> {
  signal.throwIfAborted();
  const images: Uint8Array[] = [];
  // Sequential expansion bounds temporary memory on phones.
  for (const [index, role] of ['micro', 'spi'].entries()) {
    const response = await request(
      new URL(
        `firmware/${DEFAULT_FIRMWARE}/${profile}_${DEFAULT_FIRMWARE}_${role}_flash.bin.gz`,
        base,
      ),
      { signal, credentials: 'same-origin' },
    );
    if (!response.ok || !response.body)
      throw new Error(
        'Default firmware could not be downloaded. Retry or open firmware files below.',
      );
    if (typeof DecompressionStream === 'undefined')
      throw new Error(
        'This browser needs firmware files opened manually. Use the downloads below.',
      );
    const bytes = new Uint8Array(index === 0 ? MICRO_BYTES[profile] : 32 * 1048576);
    const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    let offset = 0;
    try {
      signal.throwIfAborted();
      for (;;) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        if (offset + value.byteLength > bytes.length)
          throw new Error('Default firmware exceeds its expected size.');
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      if (offset !== bytes.length) throw new Error('Default firmware download is incomplete.');
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== DIGESTS[profile][index])
        throw new Error('Default firmware checksum does not match the official release.');
      signal.throwIfAborted();
      images.push(bytes);
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return { profile, name: `${profile}_${DEFAULT_FIRMWARE}`, micro: images[0], flash: images[1] };
}
export function firmwareDownload(profile: FirmwareProfile, role: 'micro' | 'spi'): string {
  return `https://github.com/coredevices/PebbleOS/releases/download/${DEFAULT_FIRMWARE}/${profile}_${DEFAULT_FIRMWARE}_${role}_flash.bin`;
}
export async function savedFirmware(
  profile: FirmwareProfile,
): Promise<PreviewFirmware | undefined> {
  const saved = await readLocal<SavedFirmware>('firmware:' + profile);
  if (!saved || saved.version !== 1 || saved.profile !== profile) return;
  const size = (value: Blob | Uint8Array) =>
    value instanceof Blob ? value.size : value instanceof Uint8Array ? value.byteLength : -1;
  if (
    size(saved.micro) < 8 ||
    size(saved.micro) > 4 * 1048576 ||
    size(saved.flash) !== 32 * 1048576
  )
    return;
  const bytes = async (value: Blob | Uint8Array) =>
    value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
  return {
    profile,
    name: saved.name,
    micro: await bytes(saved.micro),
    flash: await bytes(saved.flash),
  };
}
export async function saveFirmware(value: PreviewFirmware): Promise<void> {
  // Blobs avoid browser structured-clone serialization limits for large typed arrays.
  const record = {
    version: 1,
    profile: value.profile,
    name: value.name,
    micro: new Blob([value.micro.slice().buffer]),
    flash: new Blob([value.flash.slice().buffer]),
  } satisfies SavedFirmware;
  try {
    await writeLocal('firmware:' + value.profile, record);
  } catch {
    // Some WebKit environments cannot persist Blobs in IndexedDB. This pair
    // is at most 36 MiB, below typed-array serialization limits in Chromium.
    await writeLocal('firmware:' + value.profile, {
      ...record,
      micro: value.micro,
      flash: value.flash,
    });
  }
}
export async function previewFirmwareFiles(
  files: File[],
  profile: FirmwareProfile,
): Promise<PreviewFirmware> {
  const micro = files.find((f) => /micro_flash\.(bin|elf)$/i.test(f.name));
  const flash = files.find((f) => /spi_flash\.bin$/i.test(f.name));
  if (files.length !== 2 || !micro || !flash)
    throw new Error('Select both downloaded files: micro_flash.bin and spi_flash.bin.');
  if ([micro, flash].some((f) => fileProfile(f.name) !== profile))
    throw new Error('These firmware files do not match the selected watch.');
  if (
    micro.name.replace(/_micro_flash\.(bin|elf)$/i, '') !==
    flash.name.replace(/_spi_flash\.bin$/i, '')
  )
    throw new Error('Choose micro flash and SPI flash from the same firmware version.');
  if (micro.size > 4 * 1048576 || flash.size !== 32 * 1048576)
    throw new Error('Firmware file sizes do not match this emulator board.');
  const microBytes = new Uint8Array(await micro.arrayBuffer());
  const flashBytes = new Uint8Array(await flash.arrayBuffer());
  if (micro.name === `${profile}_${DEFAULT_FIRMWARE}_micro_flash.bin`) {
    for (const [i, bytes] of [microBytes, flashBytes].entries()) {
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== DIGESTS[profile][i])
        throw new Error(
          'Firmware checksum does not match the official 4.37.0 release. Download the files again.',
        );
    }
  }
  return {
    profile,
    name: micro.name.replace(/_micro_flash\.(bin|elf)$/i, ''),
    micro: microFlashImage(microBytes),
    flash: flashBytes,
  };
}
