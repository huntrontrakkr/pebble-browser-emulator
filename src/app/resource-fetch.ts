/** Optional public-download assistance. Guest networking never uses this implicitly. */
export const RESOURCE_SETTINGS_KEY = 'pebble:resource-service:v1';
export interface ResourceSettings {
  enabled: boolean;
  endpoint: string;
}
export function normalizeResourceSettings(value: unknown): ResourceSettings {
  const input = value as Partial<ResourceSettings> | null;
  const enabled = input?.enabled === true;
  let endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint) {
    const url = new URL(endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Use an HTTPS service URL, or HTTP on localhost.');
    endpoint = url.href.replace(/\/$/, '');
  }
  if (enabled && !endpoint) throw new Error('Enter the download service URL.');
  return { enabled, endpoint };
}
export function resourceSettings(): ResourceSettings {
  try {
    return normalizeResourceSettings(
      JSON.parse(localStorage.getItem(RESOURCE_SETTINGS_KEY) ?? 'null'),
    );
  } catch {
    return { enabled: false, endpoint: '' };
  }
}
export function saveResourceSettings(value: ResourceSettings): void {
  localStorage.setItem(RESOURCE_SETTINGS_KEY, JSON.stringify(normalizeResourceSettings(value)));
}
export function isPublicResource(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return false;
    if (url.hostname === 'github.com')
      return /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname) && !url.search;
    if (url.hostname === 'raw.githubusercontent.com')
      return /^\/[^/]+\/[^/]+\/[^/]+\/.+/.test(url.pathname) && !url.search;
    if (url.hostname === 'api.github.com')
      return /^\/repos\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname);
    if (url.hostname === 'appstore-api.repebble.com')
      return /^\/api\/(?:v1\/(?:apps|home)\/|assets\/(?:pbw|apps)\/)/.test(url.pathname);
    if (url.hostname === 'assets.repebble.com') return !url.search;
    return false;
  } catch {
    return false;
  }
}
export function createResourceFetch(
  settings: () => ResourceSettings,
  request: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // Only explicitly public GETs may be relayed. No credentials, request bodies or guest APIs.
    const eligible =
      method === 'GET' &&
      !init?.body &&
      !headers.has('authorization') &&
      !headers.has('cookie') &&
      (init?.credentials ?? (input instanceof Request ? input.credentials : undefined)) !==
        'include' &&
      isPublicResource(url);
    let original: Response | undefined, failure: unknown;
    try {
      original = await request(input, eligible ? { ...init, credentials: 'omit' } : init);
      if (!eligible || ![403, 429, 502, 503, 504].includes(original.status)) return original;
    } catch (error) {
      failure = error;
    }
    signal?.throwIfAborted();
    const config = settings();
    if (!eligible || !config.enabled) {
      if (original) return original;
      if (eligible)
        throw new Error(
          'Could not fetch this public download. Retry, open a local file, or configure an optional download service in Preferences.',
          { cause: failure },
        );
      throw failure;
    }
    const relay = new URL(config.endpoint + '/v1/resource');
    relay.searchParams.set('url', url);
    try {
      const response = await request(relay.href, {
        signal,
        credentials: 'omit',
        headers: { Accept: '*/*' },
      });
      if (!response.ok)
        throw new Error(
          `Download service returned ${response.status}. Direct downloads and local files remain available.`,
        );
      await original?.body?.cancel();
      return response;
    } catch (error) {
      signal?.throwIfAborted();
      if (original) return original;
      throw error;
    }
  };
}
export const resourceFetch: typeof fetch = (...args) =>
  createResourceFetch(resourceSettings)(...args);
