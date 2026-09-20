/**
 * Deployment-supplied service defaults.
 *
 * A hosted copy can serve `service-config.json` beside the application to point
 * visitors at its own relay without anyone configuring it. The file is absent
 * from the repository and from any build that does not add it, so the static
 * application keeps working with no service at all, which is the contract the
 * optional service is held to.
 *
 * The relay key in this file reaches every visitor's browser. It is a deterrent
 * and a revocation handle, not a secret: serving a new file rotates it without
 * rebuilding. A visitor's own Preferences entry always wins over it.
 */
export interface ServiceDefaults {
  endpoint: string;
  relayKey: string;
}

const EMPTY: ServiceDefaults = { endpoint: '', relayKey: '' };

/** Accepts only a well-formed HTTPS endpoint, or localhost over HTTP. */
export function normalizeServiceDefaults(value: unknown): ServiceDefaults {
  const input = value as Partial<ServiceDefaults> | null;
  const relayKey = typeof input?.relayKey === 'string' ? input.relayKey.trim() : '';
  let endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return EMPTY;
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return EMPTY;
    endpoint = url.href.replace(/\/$/, '');
  }
  // A key without somewhere to send it, or an endpoint that failed validation,
  // configures nothing rather than half a service.
  if (!endpoint) return EMPTY;
  return { endpoint, relayKey: relayKey.length >= 16 ? relayKey : '' };
}

let cached: Promise<ServiceDefaults> | undefined;

/** Reads the deployment's defaults once. A missing or invalid file means none. */
export function serviceDefaults(
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  base = document.baseURI,
): Promise<ServiceDefaults> {
  cached ??= (async () => {
    try {
      const response = await fetcher(new URL('service-config.json', base).href, {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) return EMPTY;
      return normalizeServiceDefaults(await response.json());
    } catch {
      return EMPTY;
    }
  })();
  return cached;
}

/** Test seam: forgets what was read so a later call reads again. */
export function resetServiceDefaults(): void {
  cached = undefined;
}
