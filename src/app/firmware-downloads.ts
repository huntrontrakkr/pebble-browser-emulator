import type { FirmwareRelease } from './firmware-catalog.ts';
import type { FirmwareProfile } from './watch-profiles.ts';
import type { PreviewFirmware } from './preview-firmware.ts';
import { microFlashImage } from './firmware-image.ts';
import { cachedResource } from './resource-cache.ts';
import { parseRepository } from './projects.ts';

export async function downloadFirmwareRelease(
  release: FirmwareRelease,
  profile: FirmwareProfile,
  repository: string,
  signal: AbortSignal,
  request?: typeof fetch,
): Promise<PreviewFirmware> {
  const spec = parseRepository(repository);
  const pair = ['qemu-code', 'qemu-flash'].map((kind) => {
    const items = release.assets.filter(
      (a) =>
        a.board === profile &&
        a.kind === kind &&
        a.name.startsWith(profile + '_') &&
        a.name.endsWith('.bin'),
    );
    if (items.length !== 1)
      throw new Error('This release does not contain one matching emulator firmware pair.');
    const asset = items[0];
    const expected = `https://github.com/${spec.owner}/${spec.repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset.name)}`;
    if (
      asset.url !== expected ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 8 ||
      asset.bytes > 32 * 1048576
    )
      throw new Error('Invalid firmware download metadata.');
    return asset;
  });
  const controller = new AbortController();
  signal = AbortSignal.any([signal, controller.signal]);
  try {
    const [micro, flash] = await Promise.all(
      pair.map(async (asset, index) => {
        const result = await cachedResource(asset.url, {
          maximum: (index ? 32 : 24) * 1048576,
          signal,
          sha256: asset.sha256 ?? undefined,
          request,
          ttlMs: asset.sha256 ? Infinity : 0,
        });
        if (result.bytes.length !== asset.bytes)
          throw new Error('Firmware download size does not match its release metadata.');
        return result.bytes;
      }),
    );
    const normalized = microFlashImage(micro);
    if (normalized.length > 4 * 1048576 || flash.length !== 32 * 1048576)
      throw new Error('Firmware images do not match this emulator board.');
    signal.throwIfAborted();
    return { profile, micro: normalized, flash, name: `${profile} ${release.tag}` };
  } catch (error) {
    controller.abort();
    throw error;
  }
}
