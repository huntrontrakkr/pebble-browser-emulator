import { fileProfile } from './watch-profiles.ts';
import { githubJson } from './projects.ts';
export interface FirmwareAsset {
  id: number;
  name: string;
  url: string;
  bytes: number;
  sha256: string | null;
  board: string;
  kind: 'qemu-code' | 'qemu-flash' | 'production' | 'other';
}
export interface FirmwareRelease {
  tag: string;
  published: string;
  url: string;
  prerelease: boolean;
  assets: FirmwareAsset[];
}
export function describeAsset(asset: {
  id: number;
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}): FirmwareAsset {
  const name = asset.name.toLowerCase();
  const board =
    fileProfile(name) ??
    name.match(/(?:normal|recovery)_([a-z0-9]+)/)?.[1] ??
    name.match(/(?:^|[_-])(obelix|asterix|getafix)(?:[_\-.]|$)/)?.[1] ??
    'other';
  const kind = name.includes('micro_flash')
    ? 'qemu-code'
    : name.includes('spi_flash')
      ? 'qemu-flash'
      : name.endsWith('.pbz')
        ? 'production'
        : 'other';
  return {
    id: asset.id,
    name: asset.name,
    url: asset.browser_download_url,
    bytes: asset.size,
    sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
    board,
    kind,
  };
}
export async function fetchFirmwareReleases(
  page = 1,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<FirmwareRelease[]> {
  const data = await githubJson(
    `/repos/coredevices/PebbleOS/releases?per_page=30&page=${page}`,
    signal,
    request,
  );
  if (!Array.isArray(data)) throw new Error('Unexpected firmware release response.');
  return data.filter((r) => !r.draft).map(releaseInfo);
}
function releaseInfo(r: any): FirmwareRelease {
  return {
    tag: r.tag_name,
    published: r.published_at,
    url: r.html_url,
    prerelease: r.prerelease,
    assets: r.assets.map(describeAsset).filter((a: FirmwareAsset) => a.kind !== 'other'),
  };
}
export async function fetchFirmwareRelease(tag: string): Promise<FirmwareRelease> {
  tag = tag.trim();
  if (!/^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(tag))
    throw new Error('Enter a release tag such as v4.37.0.');
  if (!tag.startsWith('v')) tag = 'v' + tag;
  return releaseInfo(
    await githubJson(`/repos/coredevices/PebbleOS/releases/tags/${encodeURIComponent(tag)}`),
  );
}
