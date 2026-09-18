import { FIRMWARE_PROFILES, type FirmwareProfile } from './watch-profiles.ts';
import { cachedResource } from './resource-cache.ts';

export const STORE_API = 'https://appstore-api.repebble.com';
export type StoreCategory = 'watchfaces' | 'watchapps-and-companions';
export interface StoreApp {
  id: string;
  title: string;
  author: string;
  version: string;
  packageUrl: string;
  screenshot: string;
  source: string;
  listing: string;
  platforms: string[];
}
export function storeAppId(value: string): string {
  value = value.trim();
  if (/^[a-f0-9]{24}$/.test(value)) return value;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'apps.repebble.com' ||
    url.username ||
    url.password
  )
    throw new Error('Paste a Pebble store link or app ID.');
  const id = url.pathname.match(/(?:_|\/)([a-f0-9]{24})\/?$/)?.[1];
  if (!id) throw new Error('This store link does not identify an app.');
  return id;
}
export function storePackageUrl(value: string, appId: string): string {
  const url = new URL(value);
  const modern =
    url.pathname.startsWith(`/api/assets/pbw/${appId}/`) &&
    /^\/api\/assets\/pbw\/[a-f0-9]{24}\/[^/]+\/[a-f0-9-]+\.pbw$/.test(url.pathname);
  const rebuilt =
    url.pathname.startsWith(`/api/assets/apps/${appId}/releases/`) &&
    /^\/api\/assets\/apps\/[a-f0-9]{24}\/releases\/[a-zA-Z0-9_.-]+\.pbw$/.test(url.pathname);
  const archived = /^\/api\/assets\/pbw\/[a-f0-9]{24}\.pbw$/.test(url.pathname);
  if (
    url.origin !== STORE_API ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{24}$/.test(appId) ||
    !(modern || rebuilt || archived)
  )
    throw new Error('Invalid store package URL.');
  return url.href;
}
function webUrl(value: unknown, host?: string): string {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!host || url.hostname === host)
      ? url.href
      : '';
  } catch {
    return '';
  }
}
export function describeStoreApp(value: any, profile: FirmwareProfile): StoreApp {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{24}$/.test(value.id) ||
    typeof value.title !== 'string' ||
    typeof value.latest_release?.version !== 'string'
  )
    throw new Error('Unexpected store app metadata.');
  const platform = FIRMWARE_PROFILES[profile].platform;
  const platforms = Array.isArray(value.hardware_platforms) ? value.hardware_platforms : [];
  const hardware = platforms.find((p: any) => p?.name === platform);
  return {
    id: value.id,
    title: value.title.slice(0, 200),
    author: String(value.author ?? '').slice(0, 200),
    version: value.latest_release.version.slice(0, 100),
    packageUrl: storePackageUrl(value.latest_release.pbw_file, value.id),
    screenshot: webUrl(hardware?.images?.screenshot, 'assets.repebble.com'),
    source: webUrl(value.source, 'github.com'),
    listing: `https://apps.repebble.com/app_${value.id}`,
    platforms: platforms.map((p: any) => p?.name).filter((p: unknown) => typeof p === 'string'),
  };
}
async function metadata(url: string, signal: AbortSignal, request?: typeof fetch) {
  const result = await cachedResource(url, {
    maximum: 2 * 1048576,
    signal,
    ttlMs: 5 * 60000,
    request,
  });
  return { data: JSON.parse(new TextDecoder().decode(result.bytes)), cached: result.cached };
}
export async function storeApp(
  id: string,
  profile: FirmwareProfile,
  signal: AbortSignal,
  request?: typeof fetch,
) {
  id = storeAppId(id);
  const result = await metadata(
    `${STORE_API}/api/v1/apps/id/${storeAppId(id)}?hardware=${FIRMWARE_PROFILES[profile].platform}`,
    signal,
    request,
  );
  const app = result.data.data?.find((a: any) => a.id === id);
  if (!app) throw new Error('This app is unavailable in the store.');
  return describeStoreApp(app, profile);
}
export async function storePage(
  profile: FirmwareProfile,
  collection: 'all' | 'most-loved',
  offset: number,
  signal: AbortSignal,
  request?: typeof fetch,
  category: StoreCategory = 'watchfaces',
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000 ||
    !['all', 'most-loved'].includes(collection)
  )
    throw new Error('Invalid catalog page.');
  if (!['watchfaces', 'watchapps-and-companions'].includes(category))
    throw new Error('Invalid store category.');
  const result = await metadata(
    `${STORE_API}/api/v1/apps/collection/${collection}/${category}?hardware=${FIRMWARE_PROFILES[profile].platform}&limit=20&offset=${offset}`,
    signal,
    request,
  );
  if (!Array.isArray(result.data.data) || result.data.data.length > 100)
    throw new Error('Unexpected store catalog response.');
  const apps: StoreApp[] = [];
  let unavailable = 0,
    incompatible = 0;
  for (const item of result.data.data) {
    try {
      const app = describeStoreApp(item, profile);
      // The upstream catalog may ignore its hardware filter, especially for older apps.
      if (app.platforms.includes(FIRMWARE_PROFILES[profile].platform)) apps.push(app);
      else incompatible++;
    } catch {
      unavailable++;
    }
  }
  return {
    apps,
    unavailable,
    incompatible,
    more: !!result.data.links?.nextPage,
    cached: result.cached,
    count: result.data.data.length,
  };
}
